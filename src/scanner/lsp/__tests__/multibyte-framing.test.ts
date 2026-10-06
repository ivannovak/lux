// Content-Length counts bytes. A response body holding a multi-byte character ("—", "✓",
// an emoji in a test name that typescript-language-server reports as a symbol) is shorter in
// UTF-16 code units than in bytes, and a chunk boundary can fall inside one character. Framing
// on decoded strings therefore cut such a body too long, swallowed the start of the next
// response, and left both requests to time out — which file lost its symbols depended on how
// responses happened to share chunks, so it differed from run to run.

import { afterEach, describe, expect, it } from 'vitest';
import { LspClient } from '../client.js';

// A minimal language server: answers `initialize`, collects `test/echo` requests, and once it
// holds `expected` of them answers all at once — written in one block, or one byte per write.
const FAKE_SERVER = String.raw`
const [mode, expected] = [process.argv[1], Number(process.argv[2])];
let buffer = Buffer.alloc(0);
const pending = [];
const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
};
const send = (bytes) => {
  if (mode !== 'bytewise') return void process.stdout.write(bytes);
  let i = 0;
  const step = () => {
    if (i >= bytes.length) return;
    process.stdout.write(bytes.subarray(i, i + 1));
    i += 1;
    setImmediate(step);
  };
  step();
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
      process.stdout.write(frame({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
    } else if (message.method === 'test/echo') {
      pending.push(message);
      if (pending.length === expected) {
        send(Buffer.concat(pending.map((m) => frame({ jsonrpc: '2.0', id: m.id, result: m.params }))));
      }
    } else if (message.method === 'shutdown') {
      process.stdout.write(frame({ jsonrpc: '2.0', id: message.id, result: null }));
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

const NAMES = [
  "describe('renders — the empty state') callback",
  'it("✓ keeps the 🧪 fixture") callback',
  'plainAsciiSymbol',
  "it('café ☕ résumé') callback",
];

const clients: LspClient[] = [];

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown();
});

async function startClient(mode: 'block' | 'bytewise'): Promise<LspClient> {
  const client = new LspClient({
    serverCommand: process.execPath,
    serverArgs: ['-e', FAKE_SERVER, mode, String(NAMES.length)],
    maxConcurrency: NAMES.length,
    requestTimeoutMs: 5_000,
  });
  clients.push(client);
  await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
  return client;
}

describe('LspClient framing of multi-byte responses', () => {
  for (const mode of ['block', 'bytewise'] as const) {
    it(`delivers every response intact when they arrive ${mode === 'block' ? 'in one chunk' : 'one byte at a time'}`, async () => {
      const client = await startClient(mode);
      const results = await Promise.allSettled(
        NAMES.map((name) => client.request<{ name: string }>('test/echo', { name }))
      );
      expect(results).toEqual(NAMES.map((name) => ({ status: 'fulfilled', value: { name } })));
    });
  }
});
