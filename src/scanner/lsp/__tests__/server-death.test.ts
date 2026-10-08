// A language server that dies part-way through a run leaves every later file of its language
// without data. That is one fact about the server, not one per file: it is recorded once per
// language and stage, with the number of files, the exit status and the last lines the server
// wrote to stderr — which is where a crash says why (an out-of-memory report, a stack).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { persistCoverageProducerRuns } from '../../coverage/producer-runs.js';
import { generalScan } from '../../general.js';
import { LspClient, LspTransientError } from '../client.js';
import { loadLspEnrichmentFailures, mergeLspEnrichmentFailures } from '../enrichment-failures.js';
import { EnricherRegistry } from '../index.js';
import { STDERR_TAIL_LINES, StderrTail } from '../server-exit.js';
import { LSP_TRACE_ENV } from '../trace.js';
import { TypeScriptLspEnricher } from '../typescript.js';

// Answers `initialize` and the first `answered` documentSymbol requests; on the next one it writes
// `noise` lines and then an out-of-memory report to stderr, and exits with code 134.
const DYING_SERVER = String.raw`
const answered = Number(process.argv[1]);
const noise = Number(process.argv[2]);
let symbolRequests = 0;
let buffer = Buffer.alloc(0);
const reply = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf-8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    } else if (message.method === 'textDocument/documentSymbol') {
      symbolRequests += 1;
      if (symbolRequests <= answered) {
        reply({ jsonrpc: '2.0', id: message.id, result: [] });
        continue;
      }
      for (let i = 0; i < noise; i++) process.stderr.write('noise ' + i + '\n');
      process.stderr.write('<--- Last few GCs --->\n');
      process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
      process.stderr.write('----- Native stack trace -----\n');
      for (let i = 1; i <= 40; i++) process.stderr.write(' ' + i + ': 0x1033c8e18 v8::internal::Heap::CollectGarbage\n');
      process.exit(134);
    } else if (message.method === 'shutdown') {
      reply({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

const OOM = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

const dirs: string[] = [];
const savedTrace = process.env[LSP_TRACE_ENV];

afterEach(() => {
  if (savedTrace === undefined) delete process.env[LSP_TRACE_ENV];
  else process.env[LSP_TRACE_ENV] = savedTrace;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A repository of `files` TypeScript files, rebuilt with a server that dies after `answered`. */
async function rebuildWithDyingServer(files: number, answered: number) {
  const root = tempDir('lux-server-death-');
  writeFileSync(join(root, 'package.json'), '{}');
  for (let i = 0; i < files; i++) {
    writeFileSync(join(root, `f${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i};\n`);
  }
  const registry = new EnricherRegistry();
  registry.register(
    new TypeScriptLspEnricher({
      serverCommand: process.execPath,
      serverArgs: ['-e', DYING_SERVER, String(answered), '0'],
      requestTimeoutMs: 5_000,
      initTimeoutMs: 5_000,
    })
  );
  const scan = await generalScan(root, {
    config: { lsp: { enabled: true, enrichers: [] }, deps: { enabled: false } },
    enricherRegistry: registry,
  });
  const db = new LuxDatabase(join(tempDir('lux-server-death-db-'), 'lux.db'));
  persistCoverageProducerRuns(db, scan);
  return { scan, db };
}

describe('a language server that dies mid-run', () => {
  it('is recorded once per language and stage, with its exit status and last stderr lines', async () => {
    const { scan, db } = await rebuildWithDyingServer(10, 3);
    try {
      expect(loadLspEnrichmentFailures(db)).toEqual([
        {
          filePath: '.',
          stage: 'symbols',
          reason: 'transport',
          languageId: 'typescript',
          fileCount: 7,
          exitCode: 134,
          signal: null,
          stderr: ['<--- Last few GCs --->', OOM, '----- Native stack trace -----'],
        },
      ]);
      expect(scan.warnings.filter((line) => line.includes('LSP output incomplete'))).toEqual([
        expect.stringContaining(
          'LSP output incomplete — symbols: the typescript language server exited (code 134) ' +
            `and was not asked about 7 file(s); stderr: ${OOM};`
        ),
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps that count through a scoped run, which asks about only a few of those files', async () => {
    const { db } = await rebuildWithDyingServer(4, 1);
    try {
      const recorded = loadLspEnrichmentFailures(db);
      mergeLspEnrichmentFailures(db, ['f01.ts'], []);
      expect(loadLspEnrichmentFailures(db)).toEqual(recorded);
    } finally {
      db.close();
    }
  });

  it('fails every request with the same report, and keeps only the last stderr lines', async () => {
    const client = new LspClient({
      serverCommand: process.execPath,
      serverArgs: ['-e', DYING_SERVER, '0', '50'],
      serverLabel: 'vue',
    });
    await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
    const first = await client
      .request('textDocument/documentSymbol', {})
      .catch((error: unknown) => error);
    const later = await client
      .request('textDocument/documentSymbol', {})
      .catch((error: unknown) => error);
    await client.shutdown();

    expect(first).toBeInstanceOf(LspTransientError);
    expect((first as LspTransientError).kind).toBe('transport');
    const lines = (first as Error).message.split('\n');
    expect(lines[0]).toBe('vue language server exited unexpectedly (code 134, signal none)');
    expect(lines[1]).toBe('last stderr:');
    expect(lines.slice(2)).toHaveLength(STDERR_TAIL_LINES);
    expect(lines.slice(-2)).toEqual([OOM, '----- Native stack trace -----']);
    // Native backtrace frames are left out: the twenty lines end on the report, not on frames.
    expect(lines[2]).toBe(`noise ${50 + 3 - STDERR_TAIL_LINES}`);
    expect((later as Error).message).toBe((first as Error).message);
    expect(client.lostReason).toBe((first as Error).message);
  });

  it('traces the server stderr and its exit', async () => {
    const trace = join(tempDir('lux-server-death-trace-'), 'trace.jsonl');
    process.env[LSP_TRACE_ENV] = trace;
    const client = new LspClient({
      serverCommand: process.execPath,
      serverArgs: ['-e', DYING_SERVER, '0', '0'],
      serverLabel: 'vue',
    });
    await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
    await client.request('textDocument/documentSymbol', {}).catch(() => undefined);
    await client.shutdown();

    const records = readFileSync(trace, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map(({ t: _t, server: _s, ...rest }) => rest);
    // The trace keeps every line, the backtrace frames too.
    const stderr = records.filter((record) => record.direction === 'stderr');
    expect(stderr.slice(0, 3)).toEqual([
      { direction: 'stderr', text: '<--- Last few GCs --->' },
      { direction: 'stderr', text: OOM },
      { direction: 'stderr', text: '----- Native stack trace -----' },
    ]);
    expect(stderr).toHaveLength(3 + 40);
    expect(records.filter((record) => record.direction === 'exit')).toEqual([
      { direction: 'exit', exitCode: 134, signal: null },
    ]);
  });
});

describe('StderrTail', () => {
  it('leaves native backtrace frames out of the tail', () => {
    const tail = new StderrTail();
    tail.push(
      `${OOM}\n 1: 0x102fdf750 node::OOMErrorHandler(char const*)\n 2: 0x1031bb464 v8::Fatal\n`
    );
    expect(tail.snapshot()).toEqual([OOM]);
  });

  it('joins lines split across chunks and keeps an unterminated last line', () => {
    const tail = new StderrTail();
    expect(tail.push('first li')).toEqual([]);
    expect(tail.push('ne\nsecond\n\nthi')).toEqual(['first line', 'second']);
    expect(tail.snapshot()).toEqual(['first line', 'second', 'thi']);
  });
});
