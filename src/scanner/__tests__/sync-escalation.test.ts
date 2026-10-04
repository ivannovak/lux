// Escalation-decision tests (spec 15 Part C / Decisions 7,9 / SC-10 / T3b.3). decideScopedEligibility
// routes a structural sync scoped-vs-full: the full/* reasons on the matching condition, scoped
// otherwise. decideForcedScoped (the --scoped operator override) bypasses the changed-count budget
// but none of the soundness conditions (no-overlay, pending-migration, first-party,
// config-changed, vendor-pack-changed).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { persistRebuildTrustState } from '../overlay-trust-state.js';
import type { RebuildResult } from '../rebuild-orchestrator.js';
import { persistStructuralConfigFingerprint } from '../config-fingerprint.js';
import { decideScopedEligibility, decideForcedScoped } from '../sync-escalation.js';

const cleanup: string[] = [];

function overlayCompleteResult(repoPath: string): RebuildResult {
  return {
    mode: 'overlay-complete',
    repoPath,
    configSource: 'default',
    configLspEnabled: false,
    surfaceCount: 1,
    detectorEdgeCount: 2,
    propagatedEdgeCount: 0,
    fileNodeCount: 2,
    symbolNodeCount: 2,
    controllerBackedCount: 1,
    closureBackedCount: 0,
    unknownProviderKindCount: 0,
    enrichmentStatus: 'inactive',
    propagationStatus: 'empty',
    warnings: [],
  };
}

/** Root + db with an overlay-complete trust state; fingerprint persisted iff `fingerprint`. */
function setup(yaml: string, opts: { fingerprint: boolean }): { root: string; db: LuxDatabase } {
  const root = mkdtempSync(join(tmpdir(), 'lux-esc-'));
  cleanup.push(root);
  writeFileSync(join(root, 'lux.yaml'), yaml);
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-esc-db-'));
  cleanup.push(dbDir);
  const db = new LuxDatabase(join(dbDir, 'lux.db'));
  persistRebuildTrustState(db, overlayCompleteResult(root), { lastIndexedCommit: 'seedcommit' });
  if (opts.fingerprint) persistStructuralConfigFingerprint(root, db);
  return { root, db };
}

/** A fresh db with no overlay and no trust ⇒ deriveOverlayTrustLevel === 'no-overlay'. */
function freshDb(): { root: string; db: LuxDatabase } {
  const root = mkdtempSync(join(tmpdir(), 'lux-esc-'));
  cleanup.push(root);
  writeFileSync(join(root, 'lux.yaml'), 'lsp:\n  enabled: false\n');
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-esc-db-'));
  cleanup.push(dbDir);
  return { root, db: new LuxDatabase(join(dbDir, 'lux.db')) };
}

/** Override only isSchemaUpToDate → false; delegate everything else to the real db (private
 *  fields preserved by binding methods to the real target). */
function withStaleSchema(db: LuxDatabase): LuxDatabase {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'isSchemaUpToDate') return () => false;
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const NO_FIRST_PARTY = 'lsp:\n  enabled: false\n';

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('decideScopedEligibility (spec 15 Part C)', () => {
  it('scoped when overlay-complete, schema current, no firstParty, fingerprint matches, under budget', () => {
    const { root, db } = setup(NO_FIRST_PARTY, { fingerprint: true });
    expect(decideScopedEligibility(db, root, 1)).toEqual({
      path: 'scoped',
      maxScopedFiles: 100,
      lspBudgetMs: 30000,
    });
    db.close();
  });

  it('full/no-overlay on a db with no overlay (content-only/no-overlay precondition)', () => {
    const { root, db } = freshDb();
    expect(decideScopedEligibility(db, root, 1)).toEqual({ path: 'full', reason: 'no-overlay' });
    db.close();
  });

  it('full/pending-migration when the schema is behind migrations', () => {
    const { root, db } = setup(NO_FIRST_PARTY, { fingerprint: true });
    expect(decideScopedEligibility(withStaleSchema(db), root, 1)).toEqual({
      path: 'full',
      reason: 'pending-migration',
    });
    db.close();
  });

  it('full/first-party when firstParty.packages is configured (Decision 9)', () => {
    const { root, db } = setup('firstParty:\n  packages:\n    - "acme/*"\n', { fingerprint: true });
    expect(decideScopedEligibility(db, root, 1)).toEqual({ path: 'full', reason: 'first-party' });
    db.close();
  });

  it('full/config-changed on a fingerprint mismatch (never recorded)', () => {
    const { root, db } = setup(NO_FIRST_PARTY, { fingerprint: false });
    expect(decideScopedEligibility(db, root, 1)).toEqual({
      path: 'full',
      reason: 'config-changed',
    });
    db.close();
  });

  it('full/over-budget at maxScopedFiles + 1; scoped at the boundary', () => {
    const { root, db } = setup('refresh:\n  maxScopedFiles: 3\n', { fingerprint: true });
    expect(decideScopedEligibility(db, root, 4)).toEqual({ path: 'full', reason: 'over-budget' });
    expect(decideScopedEligibility(db, root, 3)).toEqual({
      path: 'scoped',
      maxScopedFiles: 3,
      lspBudgetMs: 30000,
    });
    db.close();
  });

  it('threads the configured budgets into the scoped decision', () => {
    const { root, db } = setup('refresh:\n  maxScopedFiles: 50\n  lspBudgetMs: 8000\n', {
      fingerprint: true,
    });
    expect(decideScopedEligibility(db, root, 1)).toEqual({
      path: 'scoped',
      maxScopedFiles: 50,
      lspBudgetMs: 8000,
    });
    db.close();
  });
});

describe('decideForcedScoped (spec 15 Part E)', () => {
  it('overrides the changed-count budget → scoped', () => {
    const { root, db } = setup('refresh:\n  maxScopedFiles: 1\n', { fingerprint: true });
    expect(decideScopedEligibility(db, root, 2)).toEqual({ path: 'full', reason: 'over-budget' });
    expect(decideForcedScoped(db, root)).toEqual({
      path: 'scoped',
      maxScopedFiles: 1,
      lspBudgetMs: 30000,
    });
    db.close();
  });

  it('honors first-party promotion: the refresh does not re-scan first-party roots', () => {
    const { root, db } = setup('firstParty:\n  packages:\n    - "acme/*"\n', { fingerprint: true });
    expect(decideForcedScoped(db, root)).toEqual({ path: 'full', reason: 'first-party' });
    db.close();
  });

  it('honors a structural config change: facts outside the change set were built under the old config', () => {
    const { root, db } = setup(NO_FIRST_PARTY, { fingerprint: false });
    expect(decideForcedScoped(db, root)).toEqual({ path: 'full', reason: 'config-changed' });
    db.close();
  });

  it('honors the no-overlay hard precondition', () => {
    const { root, db } = freshDb();
    expect(decideForcedScoped(db, root)).toEqual({ path: 'full', reason: 'no-overlay' });
    db.close();
  });

  it('honors the pending-migration hard precondition', () => {
    const { root, db } = setup(NO_FIRST_PARTY, { fingerprint: true });
    expect(decideForcedScoped(withStaleSchema(db), root)).toEqual({
      path: 'full',
      reason: 'pending-migration',
    });
    db.close();
  });
});
