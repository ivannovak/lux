// An enricher whose `initialize` request fails must leave nothing running.
//
// A language server that rejects `initialize` (vue-language-server cannot find
// the workspace's typescript, for one), or never answers it, does not exit on
// its own: it keeps reading stdin. If the client neither kills it nor closes its
// pipes, the child and its stdio handles hold the event loop open, and `lux index
// rebuild` prints its completion line and then never exits.
//
// The stub server below stays alive regardless of stdin, so only an explicit
// teardown can end it. Its flags:
//   --never-answer       ignore `initialize` instead of answering it with an error
//   --ignore-sigterm     survive SIGTERM
//   --exit-on-eof        exit cleanly when stdin closes, as vscode-jsonrpc servers do
//   --log=<file>         append the method of every message received, one per line
//   --grandchild=<file>  spawn a process that inherits stdout/stderr, writing its pid
//                        to <file> (what a server that forks a worker looks like)

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

/** client.ts's KILL_GRACE_MS: how long a server has after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;
const { VueLspEnricher } = await import('../vue.js');
const { EnricherRegistry } = await import('../index.js');
const { generalScan } = await import('../../general.js');
type LspEnricher = import('../index.js').LspEnricher;

const STUB_SERVER = String.raw`
const fs = require('fs');
const flag = (name) => process.argv.find((a) => a === name || a.startsWith(name + '='));
const value = (name) => flag(name)?.split('=').slice(1).join('=');
if (flag('--ignore-sigterm')) process.on('SIGTERM', () => {});
if (flag('--exit-on-eof')) process.stdin.on('end', () => process.exit(0));
if (flag('--grandchild')) {
  const worker = require('child_process').spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  fs.writeFileSync(value('--grandchild'), String(worker.pid));
}
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
    if (flag('--log')) fs.appendFileSync(value('--log'), msg.method + '\n');
    if (msg.method === 'initialize' && !flag('--never-answer')) {
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

/**
 * Record the timers armed for `delayMs` and every timer cleared, by handle, while leaving both
 * functions working. This identifies one specific timer; a count of active timers at an instant
 * also sees every unrelated timer in the process and changes with load.
 */
function watchTimers(delayMs: number): { armed: unknown[]; cleared: unknown[] } {
  const armed: unknown[] = [];
  const cleared: unknown[] = [];
  const setTimer = globalThis.setTimeout as (...args: unknown[]) => unknown;
  const clearTimer = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    const handle = setTimer(callback, delay, ...rest);
    if (delay === delayMs) armed.push(handle);
    return handle;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle?: unknown) => {
    cleared.push(handle);
    clearTimer(handle as Parameters<typeof clearTimeout>[0]);
  });
  return { armed, cleared };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function initializeStub(stubArgs: string[], initTimeoutMs: number): Promise<unknown> {
  const client = new LspClient({
    serverCommand: process.execPath,
    serverArgs: [stubPath, ...stubArgs],
    initTimeoutMs,
  });
  return client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
}

let dir: string;
let stubPath: string;
const grandchildPidFiles: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-init-fail-'));
  stubPath = join(dir, 'stub-lsp.cjs');
  writeFileSync(stubPath, STUB_SERVER);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Never leak a stub into the rest of the suite, whatever the assertions said.
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const file of grandchildPidFiles.splice(0)) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, 'utf8'));
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
});

describe('LspClient — initialize answered with an error', () => {
  it('rejects, then terminates the server and releases its handles', async () => {
    const killTimers = watchTimers(KILL_GRACE_MS);

    await expect(initializeStub([], 10_000)).rejects.toThrow(
      'LSP error -32603: stub refuses to initialize'
    );

    expect(spawned).toHaveLength(1);
    const child = spawned[0];
    expect(await exitsWithin(child, 5_000)).toBe(true);
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
    // The SIGKILL fallback is disarmed once the server has gone on SIGTERM.
    expect(killTimers.armed).toHaveLength(1);
    expect(killTimers.cleared).toContain(killTimers.armed[0]);
  });

  it('force-kills a server that ignores SIGTERM', async () => {
    await expect(initializeStub(['--ignore-sigterm'], 10_000)).rejects.toThrow(
      'stub refuses to initialize'
    );

    const child = spawned[0];
    expect(await exitsWithin(child, 8_000)).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
  });

  it('closes stdin, so a server that exits on EOF shuts down cleanly rather than being killed', async () => {
    // Ignoring SIGTERM isolates the EOF path: the only way out short of SIGKILL.
    await expect(initializeStub(['--exit-on-eof', '--ignore-sigterm'], 10_000)).rejects.toThrow(
      'stub refuses to initialize'
    );

    const child = spawned[0];
    expect(await exitsWithin(child, 1_000)).toBe(true);
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBe(0);
  });

  it('releases its pipes even while a process the server forked still holds them', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    grandchildPidFiles.push(pidFile);

    await expect(initializeStub([`--grandchild=${pidFile}`], 10_000)).rejects.toThrow(
      'stub refuses to initialize'
    );

    const child = spawned[0];
    expect(await exitsWithin(child, 5_000)).toBe(true);
    // The worker outlives the server and keeps the far end of stdout/stderr open,
    // so those pipes never reach EOF: only the client closing its own end frees them.
    expect(isAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
  });
});

describe('LspClient — initialize that never answers', () => {
  it('times out, then terminates the server and releases its handles', async () => {
    await expect(initializeStub(['--never-answer'], 300)).rejects.toThrow('timed out after 300ms');

    const child = spawned[0];
    expect(await exitsWithin(child, 5_000)).toBe(true);
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
  });

  it('force-kills a server that ignores SIGTERM', async () => {
    await expect(initializeStub(['--never-answer', '--ignore-sigterm'], 300)).rejects.toThrow(
      'timed out after 300ms'
    );

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
    const log = join(dir, 'scan-received.log');

    const registry = new EnricherRegistry();
    registry.register(
      new VueLspEnricher({
        serverCommand: process.execPath,
        serverArgs: [stubPath, `--log=${log}`],
        tsdk: join(repo, 'missing-typescript-lib'),
      })
    );

    const result = await generalScan(repo, {
      config: { lsp: { enabled: true, enrichers: [] }, deps: { enabled: false } },
      enricherRegistry: registry,
    });

    expect(result.stats.activeEnrichers).toBe(0);
    // The failure is one of the scan's warnings, which the caller reports and folds into trust.
    expect(result.warnings.some((m) => m.startsWith('Failed to initialize vue enricher:'))).toBe(
      true
    );

    const child = spawned[0];
    expect(await exitsWithin(child, 5_000)).toBe(true);
    expect(await handlesLeftAfter(child, 1_000)).toEqual([]);
    // Torn down where initialize failed, not left running until the end-of-scan
    // shutdown sends it a `shutdown` request it was never initialized to answer.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['initialize']);
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
