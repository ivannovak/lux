// intelephense can answer documentSymbol successfully and say nothing: `null` for a document it
// does not hold open, `[]` for one closed under the request. Neither may be stored as "this file
// has no symbols". The file is asked once more with the document opened afresh, and if the answer
// is still not believable the enrichment fails, so the caller records the file.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhpLspEnricher, withStableAnonymousNames } from '../php.js';
import { classifyLspEnrichmentError, fileFailure } from '../enrichment-failures.js';

// argv: mode, log file. Every message received is appended to the log as "method uri".
//   null         documentSymbol is always answered null
//   null-once    the first documentSymbol for a document is answered null, later ones properly
//   empty        documentSymbol is always answered []
//   empty-once   the first documentSymbol for a document is answered [], later ones properly
//   healthy      documentSymbol is answered with one class
//   def-null     definition is always answered null; def-null-once only the first time
const FAKE_SERVER = String.raw`
const [mode, logFile] = [process.argv[1], process.argv[2]];
const fs = require('fs');
let buffer = Buffer.alloc(0);
const asked = new Set();
let definitionsAsked = 0;
const reply = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
const range = (line) => ({ start: { line, character: 0 }, end: { line, character: 5 } });
const symbols = [{ name: 'Thing', kind: 5, range: range(2), selectionRange: range(2) }];
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
    if (uri) fs.appendFileSync(logFile, message.method.split('/')[1] + ' ' + uri.split('/').pop() + '\n');
    if (message.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, referencesProvider: true, definitionProvider: true } } });
    } else if (message.method === 'initialized') {
      reply({ jsonrpc: '2.0', method: 'indexingEnded' });
    } else if (message.method === 'textDocument/documentSymbol') {
      const first = !asked.has(uri);
      asked.add(uri);
      const unbelievable = mode === 'null' || mode === 'empty' || (first && (mode === 'null-once' || mode === 'empty-once'));
      reply({ jsonrpc: '2.0', id: message.id, result: !unbelievable ? symbols : mode.startsWith('null') ? null : [] });
    } else if (message.method === 'textDocument/definition') {
      definitionsAsked++;
      const unanswered = mode === 'def-null' || (mode === 'def-null-once' && definitionsAsked === 1);
      reply({ jsonrpc: '2.0', id: message.id, result: unanswered ? null : [{ uri: 'file:///Other.php', range: range(4) }] });

    } else if (message.id !== undefined && message.method) {
      reply({ jsonrpc: '2.0', id: message.id, result: message.method === 'shutdown' ? null : [] });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

const WITH_CLASS = '<?php\n\nclass Thing\n{\n    public function go(): void {}\n}\n';
const WITHOUT_DECLARATIONS = "<?php\n\nreturn ['a' => 1];\n";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function start(mode: string, name: string, source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lux-php-empty-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  const log = join(dir, 'server.log');
  writeFileSync(file, source);
  writeFileSync(log, '');
  const enricher = new PhpLspEnricher({
    serverCommand: process.execPath,
    serverArgs: ['-e', FAKE_SERVER, mode, log],
    requestTimeoutMs: 2_000,
    initTimeoutMs: 5_000,
  });
  await enricher.initialize(dir);
  cleanup.push(() => enricher.shutdown());
  return { enricher, file, log };
}

async function enrich(mode: string, name: string, source: string) {
  const { enricher, file, log } = await start(mode, name, source);
  const outcome = await enricher.enrich(file).then(
    (result) => ({ symbols: result?.symbols.map((symbol) => symbol.name) }),
    (error: Error) => ({ error })
  );
  const seen = readFileSync(log, 'utf-8').trim().split('\n');
  return { outcome, seen, emptyAnswers: enricher.emptyAnswers };
}

const ONE_VISIT = ['didOpen Thing.php', 'documentSymbol Thing.php'];

describe('a documentSymbol answer that says nothing', () => {
  it('is a failure when it is null, also after the document is opened afresh', async () => {
    const { outcome, seen, emptyAnswers } = await enrich('null', 'Thing.php', WITH_CLASS);
    const message = (outcome as { error: Error }).error.message;
    expect(message).toBe(
      'textDocument/documentSymbol answered null: the server did not have the document open'
    );
    expect(classifyLspEnrichmentError(message)).toBe('empty');
    expect(fileFailure('src/Thing.php', 'symbols', message)).toEqual({
      filePath: 'src/Thing.php',
      stage: 'symbols',
      reason: 'empty',
      method: 'textDocument/documentSymbol',
    });
    // Closed and opened again between the two attempts. (The last didClose may not have reached
    // the server's log yet.)
    expect(seen.slice(0, 5)).toEqual([...ONE_VISIT, 'didClose Thing.php', ...ONE_VISIT]);
    expect(emptyAnswers).toEqual({ reasked: 1, recovered: 0 });
  });

  it('is null even for a file with nothing to declare: null is never "no symbols"', async () => {
    const { outcome } = await enrich('null', 'config.php', WITHOUT_DECLARATIONS);
    expect((outcome as { error: Error }).error.message).toMatch(/answered null/);
  });

  it('is recovered when the second visit answers', async () => {
    for (const mode of ['null-once', 'empty-once']) {
      const { outcome, seen, emptyAnswers } = await enrich(mode, 'Thing.php', WITH_CLASS);
      expect(outcome).toEqual({ symbols: ['Thing'] });
      expect(seen.filter((entry) => entry.startsWith('documentSymbol'))).toHaveLength(2);
      expect(seen.filter((entry) => entry.startsWith('didOpen'))).toHaveLength(2);
      expect(emptyAnswers).toEqual({ reasked: 1, recovered: 1 });
    }
  });

  it('is a failure when it is empty twice for a source that declares a class', async () => {
    const { outcome, emptyAnswers } = await enrich('empty', 'Thing.php', WITH_CLASS);
    const message = (outcome as { error: Error }).error.message;
    expect(message).toBe(
      'textDocument/documentSymbol answered empty for a file that declares symbols'
    );
    expect(classifyLspEnrichmentError(message)).toBe('empty');
    expect(emptyAnswers).toEqual({ reasked: 1, recovered: 0 });
  });

  it('is believed, and asked once, when the source declares nothing', async () => {
    const { outcome, seen, emptyAnswers } = await enrich(
      'empty',
      'config.php',
      WITHOUT_DECLARATIONS
    );
    expect(outcome).toEqual({ symbols: [] });
    expect(seen.filter((entry) => entry.startsWith('documentSymbol'))).toHaveLength(1);
    expect(emptyAnswers).toEqual({ reasked: 0, recovered: 0 });
  });

  it('is believed for a Blade template, whose markup the PHP grammar cannot vouch for', async () => {
    const { outcome, emptyAnswers } = await enrich(
      'empty',
      'card.blade.php',
      '<div>@php function helper() {} @endphp</div>\n<?php function other() {} ?>\n'
    );
    expect(outcome).toEqual({ symbols: [] });
    expect(emptyAnswers.reasked).toBe(0);
  });

  it('leaves a healthy answer alone', async () => {
    const { outcome, seen, emptyAnswers } = await enrich('healthy', 'Thing.php', WITH_CLASS);
    expect(outcome).toEqual({ symbols: ['Thing'] });
    expect(seen.filter((entry) => entry.startsWith('didOpen'))).toHaveLength(1);
    expect(emptyAnswers).toEqual({ reasked: 0, recovered: 0 });
  });
});

describe("intelephense's names for anonymous classes", () => {
  const named = (name: string) =>
    withStableAnonymousNames({
      name,
      kind: 5,
      range: { start: { line: 6, character: 0 }, end: { line: 6, character: 1 } },
      selectionRange: { start: { line: 6, character: 0 }, end: { line: 6, character: 1 } },
    }).name;

  it('are replaced whatever the length of the hex number', () => {
    for (const name of [
      '*0',
      '*a3',
      '*fff',
      '*1b2c3',
      '*1b2c3d',
      '*1b2c3d4',
      '*1b2c3d4e',
      '*1b2c3d4e5f6',
    ]) {
      expect(named(name)).toBe('*anonymous@6');
    }
  });

  it('leave every other name alone', () => {
    for (const name of ['Thing', '*', '*anonymous@6', '*xyz', 'a*1b2c3d', '$value']) {
      expect(named(name)).toBe(name);
    }
  });
});

describe('a definition answer of null', () => {
  const positions = [
    { line: 4, character: 20 },
    { line: 4, character: 30 },
  ];

  it('is a failure for the file, after one more visit, not a call without a target', async () => {
    const { enricher, file, log } = await start('def-null', 'Thing.php', WITH_CLASS);
    const error = await enricher.resolveDefinitionsInFile(file, positions).then(
      () => null,
      (rejection: Error) => rejection
    );
    expect(error?.message).toBe(
      'textDocument/definition answered null: the server did not have the document open'
    );
    expect(fileFailure('src/Thing.php', 'calls', error!.message)).toEqual({
      filePath: 'src/Thing.php',
      stage: 'calls',
      reason: 'empty',
      method: 'textDocument/definition',
    });
    const seen = readFileSync(log, 'utf-8').trim().split('\n');
    expect(seen.filter((entry) => entry.startsWith('didOpen'))).toHaveLength(2);
    expect(enricher.emptyAnswers).toEqual({ reasked: 1, recovered: 0 });
  });

  it('is recovered when the second visit answers', async () => {
    const { enricher, file } = await start('def-null-once', 'Thing.php', WITH_CLASS);
    const targets = await enricher.resolveDefinitionsInFile(file, positions);
    expect(targets).toEqual([
      { filePath: '/Other.php', line: 4 },
      { filePath: '/Other.php', line: 4 },
    ]);
    expect(enricher.emptyAnswers).toEqual({ reasked: 1, recovered: 1 });
  });

  it('is the same for a single definition lookup', async () => {
    const { enricher, file } = await start('def-null', 'Thing.php', WITH_CLASS);
    await expect(enricher.resolveDefinition(file, 4, 20)).rejects.toThrow(/answered null/);
  });
});
