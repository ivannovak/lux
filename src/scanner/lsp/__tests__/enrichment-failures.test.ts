import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { EnricherRegistry, type LspEnricher } from '../index.js';
import { generalScan } from '../../general.js';
import { persistCoverageProducerRuns } from '../../coverage/producer-runs.js';
import { writeFileSync } from 'node:fs';
import {
  classifyLspEnrichmentError,
  fileFailure,
  incompleteIndexFailure,
  summarizeLspFailures,
  loadLspEnrichmentFailures,
  mergeLspEnrichmentFailures,
  persistLspEnrichmentFailures,
} from '../enrichment-failures.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDb(): LuxDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'lux-lsp-failures-'));
  dirs.push(dir);
  return new LuxDatabase(join(dir, 'lux.db'));
}

describe('LSP enrichment failure record', () => {
  it('records the files a server that stopped answering left behind as one count per stage', () => {
    const db = makeDb();
    const stopped =
      'php language server stopped answering: no response to 4 request attempts in a row';
    expect(classifyLspEnrichmentError(stopped)).toBe('unresponsive');
    persistLspEnrichmentFailures(db, [
      { filePath: 'src/Slow.php', stage: 'symbols', reason: 'timeout' },
      fileFailure('src/A.php', 'symbols', stopped),
      fileFailure('src/B.php', 'symbols', stopped),
      fileFailure('src/B.php', 'symbols', stopped),
      fileFailure('src/A.php', 'calls', stopped),
    ]);
    const stored = loadLspEnrichmentFailures(db);
    expect(stored).toEqual([
      { filePath: '.', stage: 'calls', reason: 'unresponsive', languageId: 'php', fileCount: 1 },
      { filePath: '.', stage: 'symbols', reason: 'unresponsive', languageId: 'php', fileCount: 2 },
      { filePath: 'src/Slow.php', stage: 'symbols', reason: 'timeout' },
    ]);
    // Stored again, a count stays what it is.
    persistLspEnrichmentFailures(db, stored);
    expect(loadLspEnrichmentFailures(db)).toEqual(stored);
    expect(summarizeLspFailures(stored)).toEqual([
      expect.stringContaining(
        'symbols: the php language server stopped answering and was not asked about 2 file(s);'
      ),
      expect.stringContaining('symbols: 1 file(s) (timeout), e.g. src/Slow.php;'),
      expect.stringContaining(
        'calls: the php language server stopped answering and was not asked about 1 file(s);'
      ),
    ]);
    db.close();
  });

  it('keeps that count through a scoped run, which asks about only a few of those files', () => {
    const db = makeDb();
    persistLspEnrichmentFailures(db, [
      { filePath: '.', stage: 'symbols', reason: 'unresponsive', languageId: 'php', fileCount: 40 },
      { filePath: '.', stage: 'init', reason: 'timeout', languageId: 'vue' },
    ]);
    mergeLspEnrichmentFailures(db, ['src/A.php'], []);
    expect(loadLspEnrichmentFailures(db)).toEqual([
      { filePath: '.', stage: 'symbols', reason: 'unresponsive', languageId: 'php', fileCount: 40 },
    ]);
    db.close();
  });

  it('classifies without keeping the per-run request id', () => {
    expect(
      classifyLspEnrichmentError(
        'LSP request "textDocument/documentSymbol" (id=812) timed out after 5000ms'
      )
    ).toBe('timeout');
    expect(classifyLspEnrichmentError('Language server exited unexpectedly with code 1')).toBe(
      'transport'
    );
    expect(classifyLspEnrichmentError('Client shut down')).toBe('transport');
    expect(classifyLspEnrichmentError('something else')).toBe('error');
  });

  it('stores a full run sorted by path, one entry per file', () => {
    const db = makeDb();
    persistLspEnrichmentFailures(db, [
      { filePath: 'b.test.js', stage: 'symbols', reason: 'timeout' },
      { filePath: 'a.spec.js', stage: 'symbols', reason: 'transport' },
      { filePath: 'b.test.js', stage: 'symbols', reason: 'timeout' },
    ]);
    expect(loadLspEnrichmentFailures(db)).toEqual([
      { filePath: 'a.spec.js', stage: 'symbols', reason: 'transport' },
      { filePath: 'b.test.js', stage: 'symbols', reason: 'timeout' },
    ]);
    db.close();
  });

  it('keeps one entry per file and stage', () => {
    const db = makeDb();
    persistLspEnrichmentFailures(db, [
      { filePath: 'a.php', stage: 'calls', reason: 'timeout' },
      { filePath: 'a.php', stage: 'symbols', reason: 'timeout' },
    ]);
    expect(loadLspEnrichmentFailures(db).map((failure) => failure.stage)).toEqual([
      'calls',
      'symbols',
    ]);
    db.close();
  });

  it('lets a scoped run replace only the files it re-enriched', () => {
    const db = makeDb();
    persistLspEnrichmentFailures(db, [
      { filePath: 'kept.js', stage: 'symbols', reason: 'timeout' },
      { filePath: 'refreshed.js', stage: 'symbols', reason: 'timeout' },
    ]);
    mergeLspEnrichmentFailures(
      db,
      ['refreshed.js', 'new.js'],
      [{ filePath: 'new.js', stage: 'symbols', reason: 'error' }]
    );
    expect(loadLspEnrichmentFailures(db)).toEqual([
      { filePath: 'kept.js', stage: 'symbols', reason: 'timeout' },
      { filePath: 'new.js', stage: 'symbols', reason: 'error' },
    ]);
    db.close();
  });

  it('records a server that was still indexing as one workspace-wide index entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-lsp-index-'));
    dirs.push(root);
    writeFileSync(join(root, 'composer.json'), '{}');
    writeFileSync(join(root, 'a.php'), '<?php\nclass A {}\n');
    const enricher: LspEnricher = {
      languageId: 'php',
      fileExtensions: ['.php'],
      config: { serverCommand: 'mock', serverArgs: [], initTimeoutMs: 10 },
      isReady: true,
      indexIncomplete: true,
      initialize: () => Promise.resolve(),
      enrich: () => Promise.resolve(null),
      enrichBatch: () => Promise.resolve([]),
      shutdown: () => Promise.resolve(),
    };
    const registry = new EnricherRegistry();
    registry.register(enricher);
    const scan = await generalScan(root, {
      config: { lsp: { enabled: true, enrichers: [] }, deps: { enabled: false } },
      enricherRegistry: registry,
    });
    const db = makeDb();
    persistCoverageProducerRuns(db, scan);
    expect(loadLspEnrichmentFailures(db)).toEqual([incompleteIndexFailure('php')]);
    expect(incompleteIndexFailure('php')).toEqual({
      filePath: '.',
      stage: 'index',
      reason: 'timeout',
      languageId: 'php',
    });
    db.close();
  });

  it('records a typed-receiver pass that failed outright as one workspace-wide calls entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-lsp-pass-'));
    dirs.push(root);
    writeFileSync(join(root, 'composer.json'), '{}');
    writeFileSync(
      join(root, 'a.php'),
      '<?php\nclass A {\n  public function go(B $b): void {\n    $b->run();\n  }\n}\n'
    );
    const enricher: LspEnricher = {
      languageId: 'php',
      fileExtensions: ['.php'],
      config: { serverCommand: 'mock', serverArgs: [] },
      isReady: true,
      initialize: () => Promise.resolve(),
      enrich: () => Promise.resolve(null),
      enrichBatch: () => Promise.resolve([]),
      shutdown: () => Promise.resolve(),
      resolveDefinitionsInFile: () => Promise.reject(new Error('unexpected server state')),
    };
    const registry = new EnricherRegistry();
    registry.register(enricher);
    const db = makeDb();
    const scan = await generalScan(root, {
      config: { lsp: { enabled: true, enrichers: [] }, deps: { enabled: false } },
      enricherRegistry: registry,
      overlayEnabled: true,
      db,
    });
    persistCoverageProducerRuns(db, scan);
    expect(loadLspEnrichmentFailures(db)).toEqual([
      { filePath: '.', stage: 'calls', reason: 'error', message: 'unexpected server state' },
    ]);
    // An `error` says nothing by its reason, so the summary line carries what was thrown.
    expect(summarizeLspFailures(loadLspEnrichmentFailures(db))).toEqual([
      expect.stringContaining(
        'calls: 1 file(s) (error), e.g. . — first error: unexpected server state;'
      ),
    ]);
    db.close();
  });

  it('refuses to read a record it cannot parse as "no failures"', () => {
    const db = makeDb();
    db.setIndexMetadata('lsp_enrichment_failures_v1', '{not json');
    expect(() => loadLspEnrichmentFailures(db)).toThrow(/unreadable/);
    db.setIndexMetadata('lsp_enrichment_failures_v1', JSON.stringify([{ filePath: 'a.php' }]));
    expect(() => loadLspEnrichmentFailures(db)).toThrow(/unreadable/);
    db.close();
  });

  it('summarizes one line per stage, with counts, not one per file', () => {
    const lines = summarizeLspFailures([
      incompleteIndexFailure('php'),
      { filePath: '.', stage: 'init', reason: 'timeout', languageId: 'vue' },
      { filePath: 'b.php', stage: 'calls', reason: 'transport' },
      { filePath: 'a.php', stage: 'calls', reason: 'timeout' },
      {
        filePath: 'a.php',
        stage: 'symbols',
        reason: 'response',
        method: 'textDocument/references',
        code: -32603,
      },
      {
        filePath: 'a.php',
        stage: 'symbols',
        reason: 'response',
        method: 'textDocument/documentSymbol',
        code: -32603,
      },
      {
        filePath: '.',
        stage: 'capability',
        reason: 'response',
        languageId: 'php',
        method: 'textDocument/prepareTypeHierarchy',
        code: -32601,
      },
    ]);
    expect(lines.map((line) => line.replace(/; see .*$/, ''))).toEqual([
      'LSP output incomplete — init: vue (timeout)',
      'LSP output incomplete — index: php (timeout)',
      'LSP output incomplete — capability: php textDocument/prepareTypeHierarchy (response)',
      'LSP output incomplete — symbols: 1 file(s) (response), e.g. a.php',
      'LSP output incomplete — calls: 2 file(s) (timeout, transport), e.g. a.php, b.php',
    ]);
    expect(summarizeLspFailures([])).toEqual([]);
  });
});
