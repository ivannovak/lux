// intelephense answers a request for a document it does not hold open with nothing, and a request
// that is still queued when the document's didClose arrives the same way. Twelve documents are
// open at once and requests are sent one at a time, so a document's requests can wait behind
// other files' requests: the document must stay open until every one of them has been answered.

import { afterEach, describe, expect, it } from 'vitest';
import { LspClient } from '../client.js';

// Keeps the set of open documents, works on one request at a time with a small cost, and answers
// each `test/ask` with whether its document was open when the request was read.
const SERVER = String.raw`
let buffer = Buffer.alloc(0);
const open = new Set();
const queue = [];
let busy = false;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
const next = () => {
  if (busy || queue.length === 0) return;
  busy = true;
  const { id, wasOpen } = queue.shift();
  setTimeout(() => { send({ jsonrpc: '2.0', id, result: { wasOpen } }); busy = false; next(); }, 3);
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
    const uri = message.params && message.params.textDocument && message.params.textDocument.uri;
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    else if (message.method === 'textDocument/didOpen') open.add(uri);
    else if (message.method === 'textDocument/didClose') open.delete(uri);
    else if (message.method === 'test/ask') { queue.push({ id: message.id, wasOpen: open.has(uri) }); next(); }
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.method === 'exit') process.exit(0);
  }
});
`;

let client: LspClient | undefined;

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
});

describe('a document with requests still to be answered', () => {
  it('stays open until the last of them is answered, with 12 documents in progress', async () => {
    client = new LspClient({
      serverCommand: process.execPath,
      serverArgs: ['-e', SERVER],
      requestTimeoutMs: 5_000,
      maxOpenDocuments: 12,
    });
    await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });

    const answers: boolean[] = [];
    await Promise.all(
      Array.from({ length: 40 }, (_, n) => {
        const uri = `file:///doc${n}.php`;
        return client!.withDocument(uri, 'php', '<?php\n', async () => {
          for (let i = 0; i < 3; i++) {
            const answer = await client!.request<{ wasOpen: boolean }>('test/ask', {
              textDocument: { uri },
            });
            answers.push(answer.wasOpen);
          }
        });
      })
    );

    expect(answers).toHaveLength(120);
    expect(answers.every((wasOpen) => wasOpen)).toBe(true);
  });
});
