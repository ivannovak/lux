// `lux --lsp-trace <file>` (LUX_LSP_TRACE) records every language-server message with a timestamp:
// what was asked about which document, and whether the answer was null, empty or how long.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient } from '../client.js';
import { LSP_TRACE_ENV } from '../trace.js';

const SERVER = String.raw`
let buffer = Buffer.alloc(0);
const send = (message) => {
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
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    else if (message.method === 'test/none') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'test/three') send({ jsonrpc: '2.0', id: message.id, result: [1, 2, 3] });
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`;

const dirs: string[] = [];
const saved = process.env[LSP_TRACE_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[LSP_TRACE_ENV];
  else process.env[LSP_TRACE_ENV] = saved;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function talk(): Promise<void> {
  const client = new LspClient({
    serverCommand: process.execPath,
    serverArgs: ['-e', SERVER],
    serverLabel: 'stub',
  });
  await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
  const uri = 'file:///a.php';
  await client.withDocument(uri, 'php', '<?php\n', async () => {
    await client.request('test/none', {
      textDocument: { uri },
      position: { line: 2, character: 7 },
    });
    await client.request('test/three', { textDocument: { uri } });
  });
  await client.shutdown();
}

describe('LSP trace', () => {
  it('writes one timestamped line per message, with what was asked and how much came back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-lsp-trace-'));
    dirs.push(dir);
    const file = join(dir, 'trace.jsonl');
    process.env[LSP_TRACE_ENV] = file;
    await talk();

    const records = readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      records.every((record) => typeof record.t === 'number' && record.server === 'stub')
    ).toBe(true);
    const brief = records.map(({ t: _t, server: _s, ...rest }) => rest);
    expect(brief).toEqual([
      { direction: 'send', id: 1, method: 'initialize' },
      { direction: 'receive', id: 1, result: 'object' },
      { direction: 'send', method: 'initialized' },
      { direction: 'send', method: 'textDocument/didOpen', uri: 'file:///a.php' },
      { direction: 'send', id: 2, method: 'test/none', uri: 'file:///a.php', at: '2:7' },
      { direction: 'receive', id: 2, result: 'null' },
      { direction: 'send', id: 3, method: 'test/three', uri: 'file:///a.php' },
      { direction: 'receive', id: 3, result: 3 },
      { direction: 'send', method: 'textDocument/didClose', uri: 'file:///a.php' },
      { direction: 'send', id: 4, method: 'shutdown' },
      { direction: 'receive', id: 4, result: 'null' },
      { direction: 'send', method: 'exit' },
    ]);
  });

  it('writes nothing when it is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-lsp-trace-'));
    dirs.push(dir);
    delete process.env[LSP_TRACE_ENV];
    await talk();
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(false);
  });
});
