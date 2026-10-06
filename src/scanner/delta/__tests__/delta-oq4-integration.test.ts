import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { computeDelta } from '../run.js';
import type { DeltaOptions } from '../types.js';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q');
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name Test');
  git(dir, 'config commit.gpgsign false');
}
function headOf(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}
function now(): number {
  return Math.floor(Date.now() / 1000);
}
function node(id: string, filePath: string): StructuralNode {
  return { id, node_type: 'symbol', file_path: filePath, updated_at: now() };
}
function edge(id: string, over: Partial<StructuralEdge>): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}
function opts(over: Partial<DeltaOptions> = {}): DeltaOptions {
  return {
    depth: 6,
    maxNodes: 2000,
    maxFanout: 64,
    minConfidence: 'framework-inferred',
    json: true,
    ...over,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-delta-oq4-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('computeDelta OQ4 end-to-end (spec 12 / SC-5)', () => {
  it('reports the stale-overlay file over a pointer-at-HEAD-edges-stale overlay (default base)', async () => {
    const repo = join(root, 'app');
    initRepo(repo);
    writeFileSync(join(repo, 'app.php'), '<?php // app\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    const head = headOf(repo);

    const db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
    // --mark-only sync outcome: pointer advanced to HEAD, one file's edge marked stale, tree clean.
    db.setIndexMetadata('last_indexed_commit', head);
    db.upsertStructuralNode(node('sym:app', 'app.php'));
    db.upsertStructuralEdge(
      edge('edge:stale', {
        source_node_id: 'sym:app',
        target_node_id: 'sym:app',
        freshness_status: 'stale',
      })
    );

    const result = await computeDelta(db, repo, opts({ committedOnly: false }));
    db.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    // Without the OQ4 mark-read this would be 0 (the false "nothing changed"); it must be ≥ 1.
    expect(result.report.touched.files).toBeGreaterThanOrEqual(1);
    expect(result.report.trust.staleFiles).toBeGreaterThanOrEqual(1);
    expect(result.report.changeSet.files.some((f) => f.path === 'app.php')).toBe(true);
  });

  it('an explicit --base leaves the change-set empty (overlay marks not consulted)', async () => {
    const repo = join(root, 'app2');
    initRepo(repo);
    writeFileSync(join(repo, 'app.php'), '<?php // app\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    const head = headOf(repo);

    const db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
    db.setIndexMetadata('last_indexed_commit', head);
    db.upsertStructuralNode(node('sym:app', 'app.php'));
    db.upsertStructuralEdge(
      edge('edge:stale', {
        source_node_id: 'sym:app',
        target_node_id: 'sym:app',
        freshness_status: 'stale',
      })
    );

    // explicit base == HEAD ⇒ HEAD..HEAD empty, source:'flag' ⇒ overlay marks NOT injected.
    const result = await computeDelta(db, repo, opts({ base: head, committedOnly: true }));
    db.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    expect(result.report.touched.files).toBe(0);
  });
});
