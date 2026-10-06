// A definition outside the workspace points into machine state: the TypeScript typings cache
// under HOME, a globally installed server's stubs. Two machines with different HOMEs must store
// the same thing for it.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TypeScriptLspEnricher } from '../typescript.js';
import { stableLocationUri } from '../index.js';

// documentSymbol: two constants. definition: the first resolves into the typings cache under the
// HOME passed in, the second to a file under HOME outside any node_modules.
const FAKE_SERVER = String.raw`
const home = process.argv[1];
let buffer = Buffer.alloc(0);
const reply = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
const range = (line) => ({ start: { line, character: 6 }, end: { line, character: 8 } });
let definitions = 0;
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
    } else if (message.method === 'textDocument/documentSymbol') {
      reply({ jsonrpc: '2.0', id: message.id, result: [
        { name: 'fs', kind: 14, range: range(0), selectionRange: range(0) },
        { name: 'notes', kind: 14, range: range(1), selectionRange: range(1) },
        { name: 'local', kind: 14, range: range(2), selectionRange: range(2) },
      ] });
    } else if (message.method === 'textDocument/definition') {
      definitions += 1;
      const path = definitions === 1
        ? home + '/Library/Caches/typescript/5.9/node_modules/@types/node/fs.d.ts'
        : definitions === 2
          ? home + '/notes/ambient.d.ts'
          : require('url').fileURLToPath(message.params.textDocument.uri).replace(/example\.ts$/, 'local.ts');
      reply({ jsonrpc: '2.0', id: message.id, result: { uri: 'file://' + path, range: range(4800) } });
    } else if (message.id !== undefined) {
      reply({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

const previousHome = process.env.HOME;
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  process.env.HOME = previousHome;
  while (cleanup.length) await cleanup.pop()!();
});

async function definitionsUnder(home: string) {
  process.env.HOME = home;
  // A different workspace root each time, as two clones of one repository would have.
  const dir = mkdtempSync(join(tmpdir(), 'lux-stable-uri-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'example.ts');
  writeFileSync(file, "import fs from 'fs';\nconst notes = 1;\nconst local = 2;\n");
  const enricher = new TypeScriptLspEnricher({
    serverCommand: process.execPath,
    serverArgs: ['-e', FAKE_SERVER, home],
  });
  await enricher.initialize(dir);
  cleanup.push(() => enricher.shutdown());
  const result = await enricher.enrich(file);
  return result?.definitions;
}

describe('locations outside the workspace', () => {
  it('are stored the same under two different HOMEs and clone roots', async () => {
    const first = await definitionsUnder('/Users/ci-runner');
    const second = await definitionsUnder('/home/developer');
    expect(second).toEqual(first);
    expect(first?.map((definition) => definition.targetUri)).toEqual([
      'external:node_modules/@types/node/fs.d.ts',
      'external:~/notes/ambient.d.ts',
      'workspace:local.ts',
    ]);
  });

  it('stores a location inside the workspace relative to it, so two clones agree', () => {
    for (const root of ['/home/ci/checkout', '/Users/dev/Code/app']) {
      expect(stableLocationUri(pathToFileURL(`${root}/src/a.ts`).toString(), root)).toBe(
        'workspace:src/a.ts'
      );
    }
    expect(stableLocationUri(pathToFileURL('/repository/x.ts').toString(), '/repo')).toBe(
      'external:/repository/x.ts'
    );
  });
});
