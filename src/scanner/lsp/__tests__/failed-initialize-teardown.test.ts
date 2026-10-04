// An enricher whose `initialize` request fails must leave nothing running.
//
// A language server that rejects `initialize` (vue-language-server cannot find
// the workspace's typescript, for one) does not exit on its own: it keeps
// reading stdin. If the client neither kills it nor closes its pipes, the child
// and its three stdio handles hold the event loop open, and `lux index rebuild`
// prints its completion line and then never exits.
//
// The stub server below answers `initialize` with an error and then stays alive
// regardless of stdin, so only an explicit teardown can end it.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawned: ChildProcess[] = [];

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawned.push(child);
      return child;
    },
  };
});

const { LspClient } = await import('../client.js');
const { VueLspEnricher } = await import('../vue.js');
const { EnricherRegistry } = await import('../index.js');
const { generalScan } = await import('../../general.js');
type LspEnricher = import('../index.js').LspEnricher;

const STUB_SERVER = String.raw`
const ignoreSigterm = process.argv.includes('--ignore-sigterm');
if (ignoreSigterm) process.on('SIGTERM', () => {});
// Stay alive whatever happens to stdin, like a real server mid-startup.
setInterval(() => {}, 1000);
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.slice(0, end))[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.slice(end + 4, end + 4 + len));
    buf = buf.slice(end + 4 + len);
    if (msg.method === 'initialize') {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'stub refuses to initialize' },
      });
      process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    }
  }
});
`;

/** Whether the child has terminated, waiting at most `boundMs` for it to do so. */
async function exitsWithin(child: ChildProcess, boundMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), boundMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Active handles that belong to `child`: the process itself or one of its stdio pipes. */
function liveHandlesOf(child: ChildProcess): unknown[] {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  const own = new Set<unknown>([child, child.stdin, child.stdout, child.stderr]);
  return handles.filter((h) => own.has(h));
}

/**
 * The handles `child` still holds once they have had `boundMs` to close. Pipes
 * close asynchronously, a tick or so after the exit, so a single sample races.
 */
async function handlesLeftAfter(child: ChildProcess, boundMs: number): Promise<unknown[]> {
  const deadline = Date.now() + boundMs;
  while (liveHandlesOf(child).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return liveHandlesOf(child);
}

let dir: string;
let stubPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-init-fail-'));
  stubPath = join(dir, 'stub-lsp.cjs');
  writeFileSync(stubPath, STUB_SERVER);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  // Never leak a stub into the rest of the suite, whatever the assertions said.
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

describe('LspClient — failed initialize', () => {
  it('rejects, then terminates the server and releases its handles', async () => {
    const client = new LspClient({
      serverCommand: process.execPath,
      serverArgs: [stubPath],
      initTimeoutMs: 10_000,
    });

    await expect(
      client.initialize({ processId: process.pid, rootUri: null, capabilities: {} })
    ).rejects.toThrow('LSP error -32603: stub refuses to initialize');

    expect(spawned).toHaveLength(1);
    const child = spawned[0];
    expect(await exitsWithin(child, 5_000)).toBe(true);
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
    expect(client.initialized).toBe(false);
  });

  it('force-kills a server that ignores SIGTERM', async () => {
    const client = new LspClient({
      serverCommand: process.execPath,
      serverArgs: [stubPath, '--ignore-sigterm'],
      initTimeoutMs: 10_000,
    });

    await expect(
      client.initialize({ processId: process.pid, rootUri: null, capabilities: {} })
    ).rejects.toThrow('stub refuses to initialize');

    const child = spawned[0];
    expect(await exitsWithin(child, 8_000)).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
  });
});

describe('generalScan — enricher that fails to initialize', () => {
  it('reports the failure, completes, and leaves no server running', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(
      join(repo, 'src', 'A.vue'),
      '<script setup>const a = 1</script><template><div>{{ a }}</div></template>'
    );

    const registry = new EnricherRegistry();
    registry.register(
      new VueLspEnricher({
        serverCommand: process.execPath,
        serverArgs: [stubPath],
        tsdk: join(repo, 'missing-typescript-lib'),
      })
    );

    const progress: string[] = [];
    const result = await generalScan(repo, {
      config: { lsp: { enabled: true, enrichers: [] }, deps: { enabled: false } },
      enricherRegistry: registry,
      onProgress: (m) => progress.push(m),
    });

    expect(result.stats.activeEnrichers).toBe(0);
    expect(progress.some((m) => m.startsWith('Failed to initialize vue enricher:'))).toBe(true);

    expect(spawned).toHaveLength(1);
    const child = spawned[0];
    expect(await exitsWithin(child, 5_000)).toBe(true);
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
  });
});

describe('EnricherRegistry.shutdownAll', () => {
  it('shuts down enrichers that never became ready', async () => {
    const shutdowns: string[] = [];
    const enricher = (languageId: string, isReady: boolean): LspEnricher => ({
      languageId,
      fileExtensions: [`.${languageId}`],
      config: { serverCommand: 'fake', serverArgs: [] },
      isReady,
      initialize: () => Promise.resolve(),
      enrich: () => Promise.resolve(null),
      enrichBatch: () => Promise.resolve([]),
      shutdown: () => {
        shutdowns.push(languageId);
        return Promise.resolve();
      },
    });

    const registry = new EnricherRegistry();
    registry.register(enricher('ready', true));
    registry.register(enricher('failed', false));

    await registry.shutdownAll();

    expect(shutdowns.sort()).toEqual(['failed', 'ready']);
  });
});
