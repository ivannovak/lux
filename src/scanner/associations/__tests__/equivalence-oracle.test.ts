// The equivalence oracle (spec 14 Parts C/D/E) — the Phase-3a correctness contract (SC-7).
//
// Each fixture is a tiny two-state source tree (before → after) copied into a temp git repo. The
// runner builds a full overlay for `after` (the truth), then a full overlay for `before`, applies
// the `after` files, runs refreshOverlayScoped(F), and compares the divergence slice. The scoped
// `fresh` slice must be id-and-tuple identical to the full rebuild; only the per-fixture enumerated
// `stale` residuals are tolerated. Decision-5 orphans (outside the slice) are verified by a direct
// id-probe. The Part-E self-test proves the oracle catches a per-file-loop regression.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { LuxDatabase } from '../../../db/index.js';
import { rebuildWithOverlay } from '../../rebuild-orchestrator.js';
import { loadLspConfig } from '../../config.js';
import { buildEntry } from '../../incremental.js';
import { buildSharedExtractions } from '../../ast/extraction-cache.js';
import { materializeNodes } from '../materializer.js';
import { materializeAstSymbols } from '../../ast/materialize.js';
import { AstStructuralResolver } from '../../ast/resolver.js';
import { AssociationEngine } from '../engine.js';
import {
  refreshOverlayScoped,
  type ChangedFile,
  type ScopedRefreshOptions,
} from '../overlay-refresh.js';
import type { ScanResult, ScannedKnowledge } from '../../types.js';
import type { AssociationContext } from '../types.js';
import {
  collectDivergenceSlice,
  compareSlices,
  type DivergenceSlice,
  type OracleVerdict,
} from './oracle-slice.js';

// ---------------------------------------------------------------------------
// Fixtures — before/after file trees + the change set + expectations.
// ---------------------------------------------------------------------------

interface FixtureDef {
  before: Record<string, string>;
  after: Record<string, string>;
  changed: ChangedFile[];
  F: string[];
  expectedStale: (full: DivergenceSlice, scoped: DivergenceSlice) => Set<string>;
  expectOrphanStale?: boolean;
  refreshOptions?: ScopedRefreshOptions;
}

const NONE = (): Set<string> => new Set<string>();

const FIXTURES: Record<string, FixtureDef> = {
  // modify — edit a function body in a leaf file (no signature change). Identical slice, ∅ stale.
  modify: {
    before: {
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    },
    after: {
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`,
    },
    changed: [{ relPath: 'a.ts', status: 'modified' }],
    F: ['a.ts'],
    expectedStale: NONE,
  },

  // add — add a new un-called function to a file. Identical slice (the new symbol has no edges).
  add: {
    before: {
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    },
    after: {
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\nexport function extra(): number { return 2; }\n`,
    },
    changed: [{ relPath: 'a.ts', status: 'modified' }],
    F: ['a.ts'],
    expectedStale: NONE,
  },

  // delete — delete file d.ts; unchanged caller c.ts (outside R) references a symbol of d.
  // The orphaned inbound edge into d's (deleted) symbol is OUTSIDE the slice — verified by probe.
  delete: {
    before: {
      'd.ts': `export function dfn(): number { return 7; }\n`,
      'c.ts': `import { dfn } from './d.js';\nexport function callsD(): number { return dfn(); }\n`,
    },
    after: {
      'c.ts': `import { dfn } from './d.js';\nexport function callsD(): number { return dfn(); }\n`,
    },
    changed: [{ relPath: 'd.ts', status: 'deleted' }],
    F: ['d.ts'],
    expectedStale: NONE, // in-slice ∅; the orphan is verified by the direct probe
    expectOrphanStale: true,
  },

  // route-file — change routes/web.php (evidence dimension); handled_by edges re-derived fresh.
  'route-file': {
    before: {
      'routes/web.php': `<?php\nRoute::get('/foo', [FooController::class, 'index']);\n`,
    },
    after: {
      'routes/web.php': `<?php\nRoute::get('/foo', [FooController::class, 'index']);\nRoute::get('/bar', [BarController::class, 'show']);\n`,
    },
    changed: [{ relPath: 'routes/web.php', status: 'modified' }],
    F: ['routes/web.php'],
    expectedStale: NONE,
  },

  // pure-removal (orphaned-inbound) — remove symbol a.ts#removed WITHOUT adding any symbol; an
  // unchanged caller c.ts (outside R) references removed. Growth gate does NOT fire ⇒ c stays out
  // of R ⇒ c→removed settles as a stale orphan (outside the slice, verified by the probe).
  'pure-removal': {
    before: {
      'a.ts': `export function keep(): number { return 1; }\nexport function removed(): number { return 2; }\n`,
      'c.ts': `import { removed } from './a.js';\nexport function usesRemoved(): number { return removed(); }\n`,
    },
    after: {
      'a.ts': `export function keep(): number { return 1; }\n`,
      'c.ts': `import { removed } from './a.js';\nexport function usesRemoved(): number { return removed(); }\n`,
    },
    changed: [{ relPath: 'a.ts', status: 'modified' }],
    F: ['a.ts'],
    expectedStale: NONE,
    expectOrphanStale: true,
  },

  // lsp-budget-without-lsp — modify with refreshOptions { lspBudgetMs: 0 } on a repo with no LSP
  // configured: there is no LSP tier to run out of budget, so the refresh completes and matches the
  // rebuild exactly. (An LSP tier over budget escalates instead; scoped-refresh-tiers covers it.)
  'lsp-budget-without-lsp': {
    before: {
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`,
    },
    after: {
      'a.ts': `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`,
    },
    changed: [{ relPath: 'a.ts', status: 'modified' }],
    F: ['a.ts'],
    expectedStale: NONE,
    refreshOptions: { lspBudgetMs: 0 },
  },

  // co-changed-mutual — two files with a mutual edge A↔B, BOTH changed. The whole-batch reason
  // (Decision 13): both A→B and B→A must settle fresh. A per-file loop drops one (Part-E self-test).
  'co-changed-mutual': {
    before: {
      'a.ts': `import { fnB } from './b.js';\nexport function fnA(): number { return fnB(); }\n`,
      'b.ts': `import { fnA } from './a.js';\nexport function fnB(): number { return fnA(); }\n`,
    },
    after: {
      'a.ts': `import { fnB } from './b.js';\nexport function fnA(): number { return fnB() + 0; }\n`,
      'b.ts': `import { fnA } from './a.js';\nexport function fnB(): number { return fnA() + 0; }\n`,
    },
    changed: [
      { relPath: 'a.ts', status: 'modified' },
      { relPath: 'b.ts', status: 'modified' },
    ],
    F: ['a.ts', 'b.ts'],
    expectedStale: NONE,
  },

  // newly-resolving-inbound — unchanged caller c.ts references a.ts#newSym which did not resolve
  // before; a.ts ADDS newSym. The reverse-import closure pulls c into R (via target-edge adjacency
  // on the co-referenced `existing` symbol) so c→newSym is produced fresh (Decision 14).
  'newly-resolving-inbound': {
    before: {
      'a.ts': `export function existing(): number { return 1; }\n`,
      'c.ts': `import { existing, newSym } from './a.js';\nexport function useThem(): number { return existing() + newSym(); }\n`,
    },
    after: {
      'a.ts': `export function existing(): number { return 1; }\nexport function newSym(): number { return 2; }\n`,
      'c.ts': `import { existing, newSym } from './a.js';\nexport function useThem(): number { return existing() + newSym(); }\n`,
    },
    changed: [{ relPath: 'a.ts', status: 'modified' }],
    F: ['a.ts'],
    expectedStale: NONE,
  },

  // body-modify-external-caller (SC-7 surviving-inbound) — an unchanged external caller c.ts calls a
  // BODY-MODIFIED surviving symbol a.ts#existing. No symbol is ADDED ⇒ the growth gate does NOT fire
  // ⇒ c stays OUT of R, so c→existing is NOT re-derived. A full rebuild leaves c→existing FRESH; the
  // scoped step-1 fence transiently marks it dirty-dependent (target a.ts#existing ∈ R), and the
  // settle's step 9b must restore it to fresh. This is the most common change shape (edit a body with
  // external callers): regressing step 9b leaves c→existing dirty-dependent ⇒ it drops out of the
  // fresh slice ⇒ missingFresh ⇒ this fixture FAILS.
  'body-modify-external-caller': {
    before: {
      'a.ts': `export function existing(): number { return 1; }\n`,
      'c.ts': `import { existing } from './a.js';\nexport function useIt(): number { return existing(); }\n`,
    },
    after: {
      'a.ts': `export function existing(): number { return 2; }\n`,
      'c.ts': `import { existing } from './a.js';\nexport function useIt(): number { return existing(); }\n`,
    },
    changed: [{ relPath: 'a.ts', status: 'modified' }],
    F: ['a.ts'],
    expectedStale: NONE,
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function git(repoPath: string, command: string): void {
  execSync(command, { cwd: repoPath, stdio: 'pipe' });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'lux-oracle-'));
  tempRoots.push(repo);
  git(repo, 'git init -q');
  git(repo, 'git config user.email oracle@lux.test');
  git(repo, 'git config user.name Oracle');
  return repo;
}

function writeTree(repo: string, tree: Record<string, string>): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
}

function commitAll(repo: string, message: string): void {
  git(repo, 'git add -A');
  git(repo, `git commit -q -m ${JSON.stringify(message)}`);
}

/** Materialize a fixture phase into a fresh temp git repo and return its path. */
function materializeFixture(name: string, phase: 'before' | 'after'): string {
  const repo = initRepo();
  // A manifest makes GeneralScanner treat the tree as a source-code repository (it only discovers
  // .ts/.php when isSourceCodeRepository() finds one); inert otherwise (not source, not markdown).
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'oracle-fixture' }), 'utf-8');
  writeTree(repo, FIXTURES[name][phase]);
  commitAll(repo, `${name}:${phase}`);
  return repo;
}

/** Open a migrated DB on a temp dir OUTSIDE the repo (so it is never scanned). */
function openTemp(): LuxDatabase {
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-oracle-db-'));
  tempRoots.push(dbDir);
  return new LuxDatabase(join(dbDir, 'lux.db'));
}

/** Apply the `after` files onto a `before` repo (write / delete) and commit. */
function applyAfterFiles(repo: string, name: string, changed: ChangedFile[]): void {
  const after = FIXTURES[name].after;
  for (const c of changed) {
    const abs = join(repo, c.relPath);
    if (c.status === 'deleted') {
      if (existsSync(abs)) rmSync(abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, after[c.relPath], 'utf-8');
    }
  }
  commitAll(repo, `${name}:apply-after`);
}

async function runOracleFixture(name: string): Promise<OracleVerdict> {
  const fx = FIXTURES[name];

  // 1. Truth: full rebuild over the `after` tree.
  const truthRepo = materializeFixture(name, 'after');
  const truthDb = openTemp();
  await rebuildWithOverlay(truthDb, truthRepo);
  const full = collectDivergenceSlice(truthDb, fx.F);
  const afterSymbolIds = new Set(truthDb.getSymbolNodeIdsForFiles(fx.F));

  // 2. Scoped: full rebuild over `before`, apply `after`, scoped refresh over F.
  const repo = materializeFixture(name, 'before');
  const db = openTemp();
  await rebuildWithOverlay(db, repo);

  // 2a. BEFORE mutating: capture the Decision-5 orphan probe OUTSIDE the slice.
  const orphanProbe = new Map<string, string[]>(); // removed symbol id → its inbound edge ids
  if (fx.expectOrphanStale) {
    const removedIds = db.getSymbolNodeIdsForFiles(fx.F).filter((id) => !afterSymbolIds.has(id));
    for (const id of removedIds) {
      const inboundIds = db.getIncomingStructuralEdges(id).map((e) => e.id);
      if (inboundIds.length > 0) orphanProbe.set(id, inboundIds);
    }
  }

  applyAfterFiles(repo, name, fx.changed);
  await refreshOverlayScoped(db, repo, fx.changed, loadLspConfig(repo), fx.refreshOptions);
  const scoped = collectDivergenceSlice(db, fx.F);

  const verdict = compareSlices(full, scoped, fx.expectedStale(full, scoped));

  // 3. Direct id-probe OUTSIDE the slice (Decision 5): each captured orphan inbound edge must STILL
  //    exist AND be `stale` (kept-not-deleted). Missing ⇒ delete-instead-of-mark bug (FAIL).
  if (fx.expectOrphanStale) {
    for (const [removedId, edgeIds] of orphanProbe) {
      const nowInbound = new Map(db.getIncomingStructuralEdges(removedId).map((e) => [e.id, e]));
      for (const edgeId of edgeIds) {
        const e = nowInbound.get(edgeId);
        if (!e) verdict.missingStaleOrphan.push(edgeId);
        else if (e.freshness_status !== 'stale') verdict.orphanNotStale.push(edgeId);
      }
    }
    verdict.ok =
      verdict.ok && verdict.missingStaleOrphan.length === 0 && verdict.orphanNotStale.length === 0;
  }

  truthDb.close();
  db.close();
  return verdict;
}

afterEach(() => {
  while (tempRoots.length) {
    const p = tempRoots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The eight fixtures (SC-7)
// ---------------------------------------------------------------------------

describe('equivalence oracle (spec 14 / SC-7)', () => {
  for (const name of Object.keys(FIXTURES)) {
    it(`fixture "${name}" — scoped refresh is equivalent to a full rebuild on the slice`, async () => {
      const verdict = await runOracleFixture(name);
      // Surface the divergences on failure for a readable diff.
      expect(
        {
          missingFresh: verdict.missingFresh.map((e) => e.id),
          extraFresh: verdict.extraFresh.map((e) => e.id),
          unexpectedStale: verdict.unexpectedStale.map((e) => e.id),
          nodeDiff: verdict.nodeDiff,
          missingStaleOrphan: verdict.missingStaleOrphan,
          orphanNotStale: verdict.orphanNotStale,
        },
        `fixture ${name} diverged`
      ).toEqual({
        missingFresh: [],
        extraFresh: [],
        unexpectedStale: [],
        nodeDiff: { missing: [], extra: [] },
        missingStaleOrphan: [],
        orphanNotStale: [],
      });
      expect(verdict.ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Part E — self-test: the oracle catches a planted per-file-loop regression.
// ---------------------------------------------------------------------------

/** entries mirror overlay-refresh.buildContextEntriesFor but over an arbitrary scan (test-only). */
function testEntries(scan: ScanResult, rootPath: string): AssociationContext['entries'] {
  return scan.knowledge
    .filter((k) => k.type === 'source-code')
    .map((k) => {
      const metadata: Record<string, unknown> = {};
      if (k.content) metadata.content = k.content;
      const relPath = k.filePath.startsWith(rootPath + '/')
        ? k.filePath.slice(rootPath.length + 1)
        : k.filePath;
      return {
        filePath: relPath,
        languageId: k.frontmatter?.language as string | undefined,
        metadata,
      };
    });
}

function scanFor(rootPath: string, relPaths: string[]): ScannedKnowledge[] {
  const out: ScannedKnowledge[] = [];
  for (const rel of relPaths) {
    const entry = buildEntry(rootPath, rel);
    if (entry && entry.type === 'source-code') out.push(entry);
  }
  return out;
}

/**
 * The Decision-13 REJECTED alternative: a per-file loop. Clears all of R, then materializes and
 * resolves ONE file at a time with the in-memory-only universe (no DB verifier). A co-changed A→B
 * fails target verification while B is not in the current pass's universe — silently dropped.
 */
async function crippledPerFileRefresh(
  db: LuxDatabase,
  rootPath: string,
  changed: ChangedFile[]
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const R = changed.map((c) => c.relPath);
  const victimNodeIds = db.getStructuralNodesForFilePaths(R).map((n) => n.id);
  db.deleteEdgesBySourceNodes(victimNodeIds);
  db.deleteEdgesByEvidencePaths(R);
  db.deleteStructuralNodesForFiles(R);
  for (const c of changed) {
    const scan: ScanResult = { knowledge: scanFor(rootPath, [c.relPath]) };
    const shared = await buildSharedExtractions(scan, rootPath);
    materializeNodes(db, scan, new Map(), rootPath);
    await materializeAstSymbols(db, scan, rootPath, now, shared);
    const context: AssociationContext = {
      rootPath,
      nodes: [],
      entries: testEntries(scan, rootPath),
      currentCommit: undefined,
      dirtyFiles: [],
      sharedExtractions: shared,
    };
    // No verifier ⇒ in-memory (one-file) universe only — the per-file-loop bug.
    const engine = new AssociationEngine(db, [new AstStructuralResolver()], {
      includeHeuristics: false,
    });
    await engine.rebuild(context);
  }
}

describe('equivalence oracle self-test (spec 14 Part E)', () => {
  it('catches a per-file-loop regression on co-changed-mutual (non-empty missingFresh)', async () => {
    const name = 'co-changed-mutual';
    const fx = FIXTURES[name];

    const truthRepo = materializeFixture(name, 'after');
    const truthDb = openTemp();
    await rebuildWithOverlay(truthDb, truthRepo);
    const full = collectDivergenceSlice(truthDb, fx.F);

    const repo = materializeFixture(name, 'before');
    const db = openTemp();
    await rebuildWithOverlay(db, repo);
    applyAfterFiles(repo, name, fx.changed);

    // The CRIPPLED refresh — a per-file loop instead of the whole batch.
    await crippledPerFileRefresh(db, repo, fx.changed);
    const scoped = collectDivergenceSlice(db, fx.F);

    const verdict = compareSlices(full, scoped, new Set());
    expect(verdict.ok).toBe(false);
    // The mutual edge (A→B and/or B→A) is dropped by the per-file loop.
    expect(verdict.missingFresh.length).toBeGreaterThan(0);

    truthDb.close();
    db.close();
  });
});
