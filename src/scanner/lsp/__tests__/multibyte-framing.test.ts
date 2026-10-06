// Content-Length counts bytes. A response body holding a multi-byte character ("—", "✓",
// an emoji in a test name that typescript-language-server reports as a symbol) is shorter in
// UTF-16 code units than in bytes, and a chunk boundary can fall inside one character. Framing
// on decoded strings therefore cut such a body too long, swallowed the start of the next
// response, and left both requests to time out — which file lost its symbols depended on how
// responses happened to share chunks, so it differed from run to run.

import { afterEach, describe, expect, it } from 'vitest';
import { LspClient } from '../client.js';

// A minimal language server: answers `initialize`, and answers each `test/echo` with two
// notifications carrying the same text followed by the response — three frames written in one
// block, or one byte per write. A frame cut too long takes the start of the next with it, so a
// mis-framed notification loses the response.
const FAKE_SERVER = String.raw`
const mode = process.argv[1];
let buffer = Buffer.alloc(0);
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
      const note = frame({ jsonrpc: '2.0', method: 'test/note', params: message.params });
      const answer = frame({ jsonrpc: '2.0', id: message.id, result: message.params });
      send(Buffer.concat([note, note, answer]));
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
    serverArgs: ['-e', FAKE_SERVER, mode],
    requestTimeoutMs: 2_000,
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
