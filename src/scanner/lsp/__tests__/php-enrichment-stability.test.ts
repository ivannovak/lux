// Two things intelephense varies between sessions must not reach the index: the order it lists a
// symbol's references in (only a prefix of them is kept), and the random name it gives an
// anonymous class.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhpLspEnricher } from '../php.js';

// documentSymbol: one function and one anonymous class named `*<seeded hex>`. references: six
// locations in an order derived from the seed.
const FAKE_SERVER = String.raw`
const seed = Number(process.argv[1]);
let buffer = Buffer.alloc(0);
const reply = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
const range = (line) => ({ start: { line, character: 0 }, end: { line, character: 5 } });
const locations = [0, 1, 2, 3, 4, 5].map((i) => ({ uri: 'file:///ref' + (i % 3) + '.php', range: range(10 + i) }));
const ordered = seed === 1 ? locations : [...locations].reverse();
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
      reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true, typeHierarchyProvider: true } } });
    } else if (message.method === 'initialized') {
      reply({ jsonrpc: '2.0', method: 'indexingEnded' });
    } else if (message.method === 'textDocument/documentSymbol') {
      reply({ jsonrpc: '2.0', id: message.id, result: [
        { name: 'helper', kind: 12, range: range(2), selectionRange: range(2) },
        { name: '*' + (seed * 2654435761 >>> 0).toString(16).slice(0, 7), kind: 5, range: range(6), selectionRange: range(6) },
      ] });
    } else if (message.method === 'textDocument/references') {
      reply({ jsonrpc: '2.0', id: message.id, result: ordered });
    } else if (message.id !== undefined && message.method === 'shutdown') {
      reply({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.id !== undefined) {
      reply({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function enrichWithSeed(seed: number) {
  const dir = mkdtempSync(join(tmpdir(), 'lux-php-stable-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'helpers.php');
  writeFileSync(file, '<?php\n\nfunction helper() {}\n\n\n\n$x = new class {};\n');
  const enricher = new PhpLspEnricher({
    serverCommand: process.execPath,
    serverArgs: ['-e', FAKE_SERVER, String(seed)],
    maxReferenceLocations: 3,
  });
  await enricher.initialize(dir);
  cleanup.push(() => enricher.shutdown());
  const result = await enricher.enrich(file);
  return { symbols: result?.symbols, references: result?.references };
}

describe('PHP enrichment is the same across server sessions', () => {
  it('keeps the same references and names the anonymous class by position', async () => {
    const first = await enrichWithSeed(1);
    const second = await enrichWithSeed(2);
    expect(second).toEqual(first);
    expect(first.symbols?.map((symbol) => symbol.name)).toEqual(['helper', '*anonymous@6']);
    expect(first.references?.[0].referenceLocations).toEqual([
      { uri: 'external:/ref0.php', line: 10 },
      { uri: 'external:/ref0.php', line: 13 },
      { uri: 'external:/ref1.php', line: 11 },
    ]);
  });
});
