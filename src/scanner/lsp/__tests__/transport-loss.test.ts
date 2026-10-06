// After a language server dies, every further request must fail as a transport loss, so callers
// record what they could not ask; and the enricher must stop reporting itself ready.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient, LspTransientError } from '../client.js';
import { TypeScriptLspEnricher } from '../typescript.js';

// Answers initialize, then exits on the first request after it.
const FAKE_SERVER = String.raw`
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
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true, typeHierarchyProvider: true } } });
    else if (message.id !== undefined) process.exit(1);
  }
});
`;

describe('a language server that dies', () => {
  it('fails the request it died on and every later one as a transport loss', async () => {
    const client = new LspClient({
      serverCommand: process.execPath,
      serverArgs: ['-e', FAKE_SERVER],
    });
    await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
    await expect(client.request('test/first', {})).rejects.toBeInstanceOf(LspTransientError);
    await expect(client.request('test/later', {})).rejects.toBeInstanceOf(LspTransientError);
    await client.shutdown();
  });

  it('leaves the enricher not ready once its server has died', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-transport-loss-'));
    const file = join(dir, 'example.ts');
    writeFileSync(file, 'export const answer = 42;\n');
    const enricher = new TypeScriptLspEnricher({
      serverCommand: process.execPath,
      serverArgs: ['-e', FAKE_SERVER],
    });
    try {
      await enricher.initialize(dir);
      expect(enricher.isReady).toBe(true);
      await expect(enricher.enrich(file)).rejects.toBeInstanceOf(LspTransientError);
      expect(enricher.isReady).toBe(false);
    } finally {
      await enricher.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
