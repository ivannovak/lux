// Scoped refresh tier + residual tests (spec 13 Part F / Decision 8 / SC-9 / T3a.6).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../../db/index.js';
import { rebuildWithOverlay } from '../../rebuild-orchestrator.js';
import { loadLspConfig } from '../../config.js';
import { getHeadCommit } from '../../git.js';
import { inspectOverlayTrustState, persistRefreshTrustState } from '../../overlay-trust-state.js';
import { refreshOverlayScoped, type ChangedFile } from '../overlay-refresh.js';
import type { StructuralEdge } from '../../../db/types.js';
import { builtCli } from '../../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/scanner/associations/__tests__ → project root (four levels up).
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
const CLI_ENTRY = builtCli();

/** Run the real CLI against a repo + db (mirrors the mark-only CLI test harness). */
function runCli(repo: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repo, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}

const roots: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'lux-tiers-'));
  roots.push(repo);
  execSync('git init -q && git config user.email a@b.c && git config user.name x', { cwd: repo });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tiers-fx' }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  execSync('git add -A && git commit -q -m i', { cwd: repo });
  return repo;
}

function commit(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
  execSync(`git add -A && git commit -q -m e`, { cwd: repo });
}

async function openRebuilt(repo: string): Promise<{ db: LuxDatabase; dbPath: string }> {
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-tiers-db-'));
  roots.push(dbDir);
  const dbPath = join(dbDir, 'lux.db');
  const db = new LuxDatabase(dbPath);
  await rebuildWithOverlay(db, repo);
  return { db, dbPath };
}

async function scoped(db: LuxDatabase, repo: string, changed: ChangedFile[], opts = {}) {
  return refreshOverlayScoped(db, repo, changed, loadLspConfig(repo), opts);
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('scoped refresh tiers + residuals (spec 13 Part F / SC-9)', () => {
  it('no vendor pack → tiers.facade: skipped-no-pack', async () => {
    const repo = makeRepo({
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    });
    const { db } = await openRebuilt(repo);
    commit(
      repo,
      'a.ts',
      `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`
    );
    const result = await scoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }]);
    expect(result.tiers.facade).toBe('skipped-no-pack');
    db.close();
  });

  it("lspBudgetMs:0 → LSP tier does not run and R's :lsp edges are kept + marked stale (Decision 8)", async () => {
    const repo = makeRepo({
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    });
    const { db } = await openRebuilt(repo);
    // Pre-seed a typed-receiver (:lsp) edge on a.ts's symbol, as a prior LSP-enabled rebuild would.
    const lspEdge: StructuralEdge = {
      id: 'symbol:ts:a.ts#run→symbol:ts:a.ts#helper:calls:lsp',
      source_node_id: 'symbol:ts:a.ts#run',
      target_node_id: 'symbol:ts:a.ts#helper',
      edge_type: 'calls',
      confidence: 0.95,
      confidence_class: 'proven',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      source_commit: 'seed',
      updated_at: Math.floor(Date.now() / 1000),
    };
    db.upsertStructuralEdge(lspEdge);

    commit(
      repo,
      'a.ts',
      `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`
    );
    const result = await scoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }], {
      lspBudgetMs: 0,
    });

    expect(result.tiers.lsp).not.toBe('ran'); // skipped-budget (or unavailable without a live LSP)
    // Kept-not-deleted + marked stale (keepLsp path).
    const kept = db.getEdgeFreshnessByIds([lspEdge.id]);
    expect(kept).toHaveLength(1);
    expect(kept[0].freshness_status).toBe('stale');
    db.close();
  });

  it('a complete refresh (no removed symbols) settles residualStaleEdges: 0 and zero dirty-dependent', async () => {
    const repo = makeRepo({
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    });
    const { db } = await openRebuilt(repo);
    commit(
      repo,
      'a.ts',
      `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`
    );
    const result = await scoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }]);
    expect(result.residualStaleEdges).toBe(0);
    const counts = db.countEdgesByFreshness();
    expect(counts.stale).toBe(0);
    expect(counts['dirty-dependent']).toBe(0); // step 9b drives residual dirty-dependent to zero
    db.close();
  });

  it('a re-derived AST/detector edge carries source_commit = HEAD after a complete refresh (SC-8)', async () => {
    // An external caller c.ts→a.ts makes a.ts#run a re-derived (source ∈ R) edge with a real HEAD
    // stamp. Regressing the currentCommit wiring (context.currentCommit / runDetectors) would leave
    // source_commit NULL — the oracle's EdgeTuple excludes source_commit, so only this catches it.
    const repo = makeRepo({
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
      'c.ts': `import { run } from './a.js';\nexport function outer(): number { return run(); }\n`,
    });
    const { db } = await openRebuilt(repo);
    commit(
      repo,
      'a.ts',
      `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`
    );
    const head = getHeadCommit(repo);
    await scoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }]);

    // The re-derived intra-R edge a.ts#run→a.ts#helper (source ∈ R) must carry the repo HEAD.
    const rederived = db
      .getOutgoingStructuralEdges('symbol:ts:a.ts#run')
      .find((e) => e.target_node_id === 'symbol:ts:a.ts#helper');
    expect(rederived).toBeDefined();
    expect(rederived?.freshness_status).toBe('fresh');
    expect(rederived?.source_commit).toBe(head);

    // The propagation tier is a documented source_commit = NULL exclusion — no propagation edge may
    // carry a commit stamp (there are none in this fixture; the invariant guards a future regression).
    const propagationTypes = new Set([
      'validates_with',
      'returns_contract',
      'calls_surface',
      'derived_from',
    ]);
    const propWithCommit = db
      .getOutgoingStructuralEdges('symbol:ts:a.ts#run')
      .filter((e) => propagationTypes.has(e.edge_type) && e.source_commit != null);
    expect(propWithCommit).toEqual([]);
    db.close();
  });

  it('a symbol-removal refresh settles residualStaleEdges > 0 → overlay check exits 1; clean → exit 0 (SC-9)', async () => {
    const repo = makeRepo({
      'a.ts': `export function keep(): number { return 1; }\nexport function removed(): number { return 2; }\n`,
      'c.ts': `import { removed } from './a.js';\nexport function usesRemoved(): number { return removed(); }\n`,
    });
    const { db, dbPath } = await openRebuilt(repo);
    const prior = inspectOverlayTrustState(db).state;
    commit(repo, 'a.ts', `export function keep(): number { return 1; }\n`); // removed() deleted
    const result = await scoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }]);
    expect(result.inboundMarkedStale).toBeGreaterThan(0);
    expect(result.residualStaleEdges).toBeGreaterThan(0);
    // Settle trust exactly as the CLI does, then assert `overlay check` exits 1 (degraded overlay).
    if (prior)
      persistRefreshTrustState(db, prior, {
        lastIndexedCommit: getHeadCommit(repo),
        residualStaleEdges: result.residualStaleEdges,
      });
    db.close();
    expect(runCli(repo, dbPath, ['overlay', 'check']).status).toBe(1);
  });

  it('a clean scoped refresh settles trust so overlay check exits 0 (SC-9 complement)', async () => {
    const repo = makeRepo({
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    });
    const { db, dbPath } = await openRebuilt(repo);
    const prior = inspectOverlayTrustState(db).state;
    commit(
      repo,
      'a.ts',
      `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`
    );
    const result = await scoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }]);
    expect(result.residualStaleEdges).toBe(0);
    if (prior)
      persistRefreshTrustState(db, prior, {
        lastIndexedCommit: getHeadCommit(repo),
        residualStaleEdges: result.residualStaleEdges,
      });
    db.close();
    expect(runCli(repo, dbPath, ['overlay', 'check']).status).toBe(0);
  });
});
