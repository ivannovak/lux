// intelephense indexes the workspace in the background and keeps that index in a storage
// directory between runs. Answers given before indexing ends see a partial index, and a stale
// storage directory carries one run's state into the next. The enricher must wait for
// indexingEnded (bounded), say when it ran out of time, answer the settings request itself, and
// give each run its own storage.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhpLspEnricher } from '../php.js';

// argv: record file, then "ends" (indexingEnded after 300ms) or "never".
const FAKE_SERVER = String.raw`
const fs = require('fs');
const [out, mode] = [process.argv[1], process.argv[2]];
const record = {};
const save = () => fs.writeFileSync(out, JSON.stringify(record));
let buffer = Buffer.alloc(0);
let indexed = false;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
const range = { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } };
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
      record.initialize = message.params;
      save();
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true, typeHierarchyProvider: true } } });
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', id: 9001, method: 'workspace/configuration', params: { items: [{ section: 'intelephense' }] } });
      send({ jsonrpc: '2.0', method: 'indexingStarted' });
      if (mode === 'ends') setTimeout(() => { indexed = true; send({ jsonrpc: '2.0', method: 'indexingEnded' }); }, 300);
    } else if (message.id === 9001 && !message.method) {
      record.configuration = message.result;
      save();
    } else if (message.method === 'textDocument/documentSymbol') {
      send({ jsonrpc: '2.0', id: message.id, result: indexed ? [{ name: 'Thing', kind: 5, range, selectionRange: range }] : [] });
    } else if (message.id !== undefined && message.method) {
      send({ jsonrpc: '2.0', id: message.id, result: null });
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

async function start(mode: 'ends' | 'never', initTimeoutMs = 5_000) {
  const dir = mkdtempSync(join(tmpdir(), 'lux-php-ready-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'record.json');
  const file = join(dir, 'Thing.php');
  writeFileSync(file, '<?php\n\nclass Thing {}\n');
  const enricher = new PhpLspEnricher({
    serverCommand: process.execPath,
    serverArgs: ['-e', FAKE_SERVER, out, mode],
    initTimeoutMs,
  });
  await enricher.initialize(dir);
  cleanup.push(() => enricher.shutdown());
  const record = () =>
    JSON.parse(readFileSync(out, 'utf-8')) as {
      initialize: {
        capabilities: { workspace?: { configuration?: boolean } };
        initializationOptions?: { storagePath?: string; clearCache?: boolean };
      };
      configuration?: unknown[];
    };
  return { enricher, file, record };
}

describe('PhpLspEnricher index readiness', () => {
  it('waits for indexingEnded before enriching', async () => {
    const { enricher, file } = await start('ends');
    expect(enricher.indexIncomplete).toBe(false);
    const result = await enricher.enrich(file);
    expect(result?.symbols.map((symbol) => symbol.name)).toEqual(['Thing']);
  });

  it('reports an incomplete index when indexing outlasts the bound', async () => {
    const { enricher } = await start('never', 300);
    expect(enricher.indexIncomplete).toBe(true);
    expect(enricher.isReady).toBe(true);
  });

  it('answers the settings request with pinned excludes', async () => {
    const { record } = await start('ends');
    const { initialize, configuration } = record();
    expect(initialize.capabilities.workspace?.configuration).toBe(true);
    const [settings] = configuration as Array<{ files: { exclude: string[] } }>;
    expect(settings.files.exclude).toEqual(
      expect.arrayContaining(['**/node_modules/**', '**/.git/**'])
    );
  });

  it('gives each run a fresh storage directory and removes it at shutdown', async () => {
    const first = await start('ends');
    const second = await start('ends');
    const a = first.record().initialize.initializationOptions;
    const b = second.record().initialize.initializationOptions;
    expect(a?.clearCache).toBe(true);
    expect(a?.storagePath).toBeTruthy();
    expect(a?.storagePath).not.toBe(b?.storagePath);
    expect(existsSync(a!.storagePath!)).toBe(true);
    await first.enricher.shutdown();
    expect(existsSync(a!.storagePath!)).toBe(false);
  });
});
