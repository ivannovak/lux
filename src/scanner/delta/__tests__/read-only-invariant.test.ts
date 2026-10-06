// Fix #4 (SC-7 / Decision 14): `computeDelta` is read-only w.r.t. the primary index's structural
// tables — in BOTH analysis mode (check:false) and gate mode (check:true). This is the explicitly
// named "row-count diff test": snapshot COUNT(*) of structural_nodes / structural_edges plus a
// digest of every `structural_edges.ownership` value, run computeDelta both ways, and assert the
// snapshot is byte-identical before and after. A structural write on any path would move a count or
// the ownership digest and fail here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { computeDelta } from '../run.js';
import type { StructuralEdge } from '../../../db/types.js';

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

/** Canonical snapshot of the primary index's structural state via public getters only. The fixture
 *  seeds exactly these two node types, so enumerating them covers every node; edges are collected
 *  by walking each node (source-or-target) and deduped by id, capturing the ownership column. */
function structuralSnapshot(db: LuxDatabase): {
  nodeCount: number;
  edgeCount: number;
  ownershipDigest: string;
} {
  const nodes = [
    ...db.getStructuralNodesByType('symbol'),
    ...db.getStructuralNodesByType('capability-surface'),
  ];
  const edgeById = new Map<string, StructuralEdge>();
  for (const n of nodes) for (const e of db.getStructuralEdgesForNode(n.id)) edgeById.set(e.id, e);
  const ownershipDigest = [...edgeById.values()]
    .map((e) => `${e.id}=${(e as { ownership?: string | null }).ownership ?? 'null'}`)
    .sort()
    .join('|');
  return { nodeCount: nodes.length, edgeCount: edgeById.size, ownershipDigest };
}

describe('delta read-only structural invariant (SC-7, Decision 14 — row-count diff)', () => {
  let repo: string;
  let db: LuxDatabase;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lux-delta-readonly-'));
    git(repo, 'init -q');
    git(repo, 'config user.email test@example.com');
    git(repo, 'config user.name Test');
    git(repo, 'config commit.gpgsign false');
    git(repo, 'commit -q --allow-empty -m base');
    const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
    // a real committed change base..HEAD so the pipeline resolves a non-empty change/touch set.
    writeFileSync(join(repo, 'Handler.php'), '<?php class Handler {}');
    git(repo, 'add -A');
    git(repo, 'commit -q -m change');

    db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
    db.setIndexMetadata('last_indexed_commit', base);
    // structural state with an ownership-bearing edge (migration 013 column).
    db.upsertStructuralNode({
      id: 'symbol:Handler',
      node_type: 'symbol',
      file_path: 'Handler.php',
      updated_at: 1,
    });
    db.upsertStructuralNode({
      id: 'surface:http:GET:/h',
      node_type: 'capability-surface',
      updated_at: 1,
    });
    db.upsertStructuralEdge({
      id: 'edge:handled',
      source_node_id: 'surface:http:GET:/h',
      target_node_id: 'symbol:Handler',
      edge_type: 'handled_by',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: 1,
    });
    db.setEdgeOwnershipBatch([{ id: 'edge:handled', ownership: 'client-override' }]);
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves structural_nodes / structural_edges / ownership byte-identical across analysis AND check runs', async () => {
    const before = structuralSnapshot(db);
    // sanity: the fixture actually has the rows we intend to protect.
    expect(before.nodeCount).toBe(2);
    expect(before.edgeCount).toBe(1);
    expect(before.ownershipDigest).toBe('edge:handled=client-override');

    // analysis mode.
    const analysis = await computeDelta(db, repo, {
      depth: 6,
      maxNodes: 2000,
      maxFanout: 64,
      minConfidence: 'framework-inferred',
      json: true,
    });
    expect('report' in analysis).toBe(true);
    expect(structuralSnapshot(db)).toEqual(before);

    // gate mode (check:true) — a distinct code path (gate input building) that also must not write.
    const checked = await computeDelta(db, repo, {
      depth: 6,
      maxNodes: 2000,
      maxFanout: 64,
      minConfidence: 'framework-inferred',
      check: true,
      failOn: ['budget-truncated'],
      json: true,
    });
    expect('report' in checked).toBe(true);
    expect(structuralSnapshot(db)).toEqual(before);
  });
});
