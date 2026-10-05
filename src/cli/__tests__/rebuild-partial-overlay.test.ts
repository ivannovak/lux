// A rebuild phase that fails part-way (issue #15 follow-up). Bulk writes commit in chunks, so the
// rows written before the failure stay on disk. The trust state must count what is on disk and say
// which phase stopped, how far it got and why — not describe the overlay as absent or empty.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { rebuildWithOverlay } from '../../scanner/rebuild-orchestrator.js';
import {
  EnricherRegistry,
  type LspEnricher,
  type LspEnricherConfig,
} from '../../scanner/lsp/index.js';
import type { EnrichmentResult } from '../../scanner/lsp/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A committed TypeScript repo of `n` files, each declaring two functions. */
function repo(n: number, lspEnabled = false): string {
  const dir = tempDir('lux-partial-overlay-repo-');
  writeFileSync(
    join(dir, 'lux.yaml'),
    `lsp:\n  enabled: ${lspEnabled}\n  enrichers: []\ndeps:\n  enabled: false\n`
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'partial-overlay-fixture' }));
  mkdirSync(join(dir, 'src'));
  for (let i = 0; i < n; i++) {
    writeFileSync(
      join(dir, 'src', `m${i}.ts`),
      `export function first${i}(): number {\n  return ${i};\n}\n\n` +
        `export function second${i}(): number {\n  return first${i}();\n}\n`
    );
  }
  execSync(
    'git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -q -m init',
    {
      cwd: dir,
    }
  );
  return dir;
}

/** A migrated index whose `nodeType` inserts fail once `failAt` such nodes exist. */
function indexFailingAt(nodeType: string, failAt: number): string {
  const dbPath = join(tempDir('lux-partial-overlay-db-'), 'lux.db');
  const db = new LuxDatabase(dbPath);
  (db as unknown as { db: { exec(sql: string): void } }).db.exec(
    `CREATE TRIGGER fail_mid_phase BEFORE INSERT ON structural_nodes
       WHEN NEW.node_type = '${nodeType}'
        AND (SELECT count(*) FROM structural_nodes WHERE node_type = '${nodeType}') >= ${failAt}
     BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`
  );
  db.close();
  return dbPath;
}

/** Project nodes of a type on disk, read directly rather than through the code under test. */
function countNodes(db: LuxDatabase, nodeType: string): number {
  const raw = (db as unknown as { db: { get(sql: string, values: unknown[]): { n: number } } }).db;
  return raw.get(
    `SELECT COUNT(*) AS n FROM structural_nodes WHERE node_type = ? AND origin = 'local'`,
    [nodeType]
  ).n;
}

function persistedCounts(dbPath: string): { files: number; symbols: number; trust: TrustState } {
  const db = new LuxDatabase(dbPath);
  const trust = JSON.parse(db.getIndexMetadata('overlay_trust_state') ?? '{}') as TrustState;
  const counts = {
    files: countNodes(db, 'file'),
    symbols: countNodes(db, 'symbol'),
    trust,
  };
  db.close();
  return counts;
}

interface TrustState {
  mode: string;
  fileNodeCount: number;
  symbolNodeCount: number;
  warnings: string[];
}

class SymbolsOnlyEnricher implements LspEnricher {
  readonly languageId = 'typescript';
  readonly fileExtensions = ['.ts'];
  readonly config: LspEnricherConfig = { serverCommand: 'fake', serverArgs: [] };
  isReady = false;
  initialize(): Promise<void> {
    this.isReady = true;
    return Promise.resolve();
  }
  enrich(filePath: string): Promise<EnrichmentResult> {
    return Promise.resolve({
      filePath,
      languageId: 'typescript',
      symbols: [{ name: 'LspOnly', kind: 12, kindLabel: 'Function', startLine: 0, endLine: 0 }],
      diagnostics: [],
      definitions: [],
      enrichedAt: 1,
    });
  }
  enrichBatch(): Promise<[]> {
    return Promise.resolve([]);
  }
  shutdown(): Promise<void> {
    this.isReady = false;
    return Promise.resolve();
  }
}

describe('a rebuild phase that fails part-way', () => {
  it('reports the file nodes on disk, and the phase, progress and error, through the CLI', () => {
    // 503 .ts files plus package.json and lux.yaml: 505 source files, so the failure at the 503rd
    // file node falls in the second 500-file chunk and the first chunk is already committed.
    const dir = repo(503);
    const dbPath = indexFailingAt('file', 502);

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, '--db', dbPath, '--corpus', dir, 'index', 'rebuild'],
      { cwd: PROJECT_ROOT, encoding: 'utf-8', env: { ...process.env, HOME: tempDir('lux-home-') } }
    );
    expect(result.status, result.stderr).toBe(0);
    const { files, symbols, trust } = persistedCounts(dbPath);

    expect(trust.mode).toBe('degraded-overlay');
    expect(trust.fileNodeCount).toBe(files);
    expect(trust.symbolNodeCount).toBe(symbols);
    expect(trust.warnings, JSON.stringify(trust.warnings)).toContain(
      'Overlay rebuild failed: file-node materialization stopped after 502 of 505 files: ' +
        'injected write failure. 502 file node(s) and 0 symbol node(s) were persisted before it stopped.'
    );
    expect(files).toBe(502);
  }, 60_000);

  it('degrades and counts the symbols on disk when AST materialization stops, without LSP', async () => {
    const dir = repo(4);
    const dbPath = indexFailingAt('symbol', 3);
    const db = new LuxDatabase(dbPath);

    const { result } = await rebuildWithOverlay(db, dir, { vendorPackPath: null });
    const symbols = countNodes(db, 'symbol');
    db.close();

    expect(result.mode, JSON.stringify(result.warnings)).toBe('degraded-overlay');
    expect(result.symbolNodeCount).toBe(symbols);
    expect(result.warnings.join('\n')).not.toContain('No symbol nodes were materialized');
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /^AST symbol materialization stopped after 3 of \d+ symbol nodes: injected write failure$/
      )
    );
    expect(symbols).toBe(3);
  });

  it('degrades when AST materialization stops even though LSP supplied symbols', async () => {
    const dir = repo(4, true);
    // One LSP symbol per file goes in first (4), then the AST tier fails at its third symbol.
    const dbPath = indexFailingAt('symbol', 6);
    const db = new LuxDatabase(dbPath);
    const registry = new EnricherRegistry();
    registry.register(new SymbolsOnlyEnricher());

    const { result } = await rebuildWithOverlay(db, dir, {
      vendorPackPath: null,
      enricherRegistry: registry,
    });
    const symbols = countNodes(db, 'symbol');
    db.close();

    expect(result.mode, JSON.stringify(result.warnings)).toBe('degraded-overlay');
    expect(result.symbolNodeCount).toBe(symbols);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /^AST symbol materialization stopped after 2 of \d+ symbol nodes: injected write failure$/
      )
    );
    expect(symbols).toBe(6);
  });
});
