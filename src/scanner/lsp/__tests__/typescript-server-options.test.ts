// typescript-language-server answers from a syntax-only server while the project loads, and
// acquires @types into a cache under HOME in the background; both made a definition resolve in one
// rebuild and not the next. The enricher must start the server with both turned off.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptLspEnricher } from '../typescript.js';

// Writes the initialize params it receives to the file named in argv.
const FAKE_SERVER = String.raw`
const out = process.argv[1];
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
      require('fs').writeFileSync(out, JSON.stringify(message.params));
      reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    } else if (message.id !== undefined) {
      reply({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

let dir: string | undefined;
let enricher: TypeScriptLspEnricher | undefined;

afterEach(async () => {
  await enricher?.shutdown();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('TypeScriptLspEnricher server options', () => {
  it('routes every request to the semantic server and turns off type acquisition', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lux-ts-options-'));
    const out = join(dir, 'initialize.json');
    enricher = new TypeScriptLspEnricher({
      serverCommand: process.execPath,
      serverArgs: ['-e', FAKE_SERVER, out],
    });
    await enricher.initialize(dir);
    const params = JSON.parse(readFileSync(out, 'utf-8')) as { initializationOptions?: unknown };
    expect(params.initializationOptions).toEqual({
      disableAutomaticTypingAcquisition: true,
      tsserver: { useSyntaxServer: 'never' },
    });
  });
});
