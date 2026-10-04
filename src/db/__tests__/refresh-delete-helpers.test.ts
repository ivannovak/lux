// Scoped overlay-refresh DB helper tests (spec 13 Part A / T3a.1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../index.js';
import type { StructuralNode, StructuralEdge, EdgeEvidence } from '../types.js';

function now(): number {
  return Math.floor(Date.now() / 1000);
}
function fileNode(path: string): StructuralNode {
  return { id: `file:${path}`, node_type: 'file', file_path: path, updated_at: now() };
}
function symNode(id: string, path: string): StructuralNode {
  return { id, node_type: 'symbol', file_path: path, symbol_name: id, updated_at: now() };
}
function edge(id: string, over: Partial<StructuralEdge>): StructuralEdge {
  return {
    id,
    source_node_id: 'x',
    target_node_id: 'y',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}
function ev(edgeId: string, filePath: string): EdgeEvidence {
  return {
    id: `${edgeId}:ev:0`,
    edge_id: edgeId,
    resolver: 'test',
    evidence_kind: 'test',
    file_path: filePath,
    recorded_at: now(),
  };
}
function statusOf(db: LuxDatabase, id: string): string | undefined {
  return db.getEdgeFreshnessByIds([id])[0]?.freshness_status;
}
function edgeExists(db: LuxDatabase, id: string): boolean {
  return db.getEdgeFreshnessByIds([id]).length > 0;
}

describe('scoped refresh DB helpers (spec 13 Part A)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-refresh-helpers-'));
    db = new LuxDatabase(join(dir, 'lux.db'));
    // a.ts declares symA; c.ts declares symC (an unchanged caller outside R).
    db.upsertStructuralNode(fileNode('a.ts'));
    db.upsertStructuralNode(symNode('symA', 'a.ts'));
    db.upsertStructuralNode(fileNode('c.ts'));
    db.upsertStructuralNode(symNode('symC', 'c.ts'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deleteEdgesBySourceNodes removes the outbound edges of the given sources', () => {
    db.upsertStructuralEdge(edge('symA→symB:calls:ast', { source_node_id: 'symA' }));
    db.upsertStructuralEdge(edge('symA→symB:calls:lsp', { source_node_id: 'symA' }));
    db.upsertStructuralEdge(edge('symC→symA:calls:ast', { source_node_id: 'symC' }));

    expect(db.deleteEdgesBySourceNodes(['symA'])).toBe(2);
    expect(edgeExists(db, 'symA→symB:calls:ast')).toBe(false);
    expect(edgeExists(db, 'symA→symB:calls:lsp')).toBe(false);
    expect(edgeExists(db, 'symC→symA:calls:ast')).toBe(true); // inbound, untouched
  });

  it('deleteEdgesByEvidencePaths never deletes an inbound edge whose evidence is outside R', () => {
    // Outbound from R (evidence at a.ts) — should be deleted.
    db.upsertStructuralEdge(
      edge('symA→ext:calls:ast-xf', { source_node_id: 'symA', target_node_id: 'ext' })
    );
    db.replaceEdgeEvidence('symA→ext:calls:ast-xf', [ev('symA→ext:calls:ast-xf', 'a.ts')]);
    // Inbound C→A: source c.ts, evidence source-side at c.ts (OUTSIDE R=['a.ts']) — must survive.
    db.upsertStructuralEdge(
      edge('symC→symA:calls:ast-xf', { source_node_id: 'symC', target_node_id: 'symA' })
    );
    db.replaceEdgeEvidence('symC→symA:calls:ast-xf', [ev('symC→symA:calls:ast-xf', 'c.ts')]);

    const removed = db.deleteEdgesByEvidencePaths(['a.ts']);
    expect(removed).toBe(1);
    expect(edgeExists(db, 'symA→ext:calls:ast-xf')).toBe(false); // evidence cites a.ts
    expect(edgeExists(db, 'symC→symA:calls:ast-xf')).toBe(true); // inbound, evidence outside R
    // Its evidence row survives too.
    expect(db.getEdgeEvidence('symC→symA:calls:ast-xf')).toHaveLength(1);
  });

  it('markEdgesStaleByTargetNodes marks surviving edges into removed ids stale (fresh & dirty-dependent)', () => {
    db.upsertStructuralEdge(
      edge('symC→symA:fresh', {
        source_node_id: 'symC',
        target_node_id: 'symA',
        freshness_status: 'fresh',
      })
    );
    db.upsertStructuralEdge(
      edge('symC→symA:dirty', {
        source_node_id: 'symC',
        target_node_id: 'symA',
        freshness_status: 'dirty-dependent',
      })
    );
    db.upsertStructuralEdge(
      edge('symC→other:fresh', {
        source_node_id: 'symC',
        target_node_id: 'other',
        freshness_status: 'fresh',
      })
    );

    const marked = db.markEdgesStaleByTargetNodes(['symA']);
    expect(marked).toBe(2); // both fresh + dirty-dependent into symA
    expect(statusOf(db, 'symC→symA:fresh')).toBe('stale');
    expect(statusOf(db, 'symC→symA:dirty')).toBe('stale');
    expect(statusOf(db, 'symC→other:fresh')).toBe('fresh'); // untouched
  });

  it('deleteStructuralNodesForFiles removes file + symbol nodes declared in the paths', () => {
    expect(db.getStructuralNodesForFilePaths(['a.ts'])).toHaveLength(2);
    const removed = db.deleteStructuralNodesForFiles(['a.ts']);
    expect(removed).toBe(2);
    expect(db.getStructuralNodesForFilePaths(['a.ts'])).toHaveLength(0);
    expect(db.getStructuralNodesForFilePaths(['c.ts'])).toHaveLength(2); // untouched
  });

  it('getSymbolNodeIdsForFiles returns only symbol node ids', () => {
    expect(db.getSymbolNodeIdsForFiles(['a.ts'])).toEqual(['symA']);
    expect(db.getSymbolNodeIdsForFiles(['a.ts', 'c.ts']).sort()).toEqual(['symA', 'symC']);
  });

  it('deleteOperationalForFiles cascades boundaries → handlers/contracts/edges', () => {
    db.upsertOperationalBoundary({
      id: 'b1',
      repo_root: dir,
      kind: 'job',
      name: 'JobX',
      trust_tier: 2,
      file_path: 'app/Jobs/JobX.php',
    });
    db.upsertOperationalHandler({
      id: 'h1',
      boundary_id: 'b1',
      symbol_id: 'symJob',
      trust_tier: 2,
    });
    db.upsertOperationalContract({
      id: 'k1',
      boundary_id: 'b1',
      payload_schema: '{}',
      trust_tier: 2,
    });
    db.upsertOperationalEdge({
      id: 'e1',
      source_id: 'b1',
      target_id: 'symJob',
      edge_type: 'DISPATCHES',
      trust_tier: 2,
    });

    const removed = db.deleteOperationalForFiles(['app/Jobs/JobX.php']);
    expect(removed).toBe(1);
    expect(db.getOperationalBoundary('b1')).toBeNull();
    expect(db.getOperationalHandlersForBoundary('b1')).toHaveLength(0);
    expect(db.getOperationalContractsForBoundary('b1')).toHaveLength(0);
    expect(db.getOperationalEdgesForSource('b1')).toHaveLength(0);
  });

  it('invalidateEdgesByEvidencePaths marks fresh evidence-cited edges dirty-dependent', () => {
    db.upsertStructuralEdge(edge('ev-edge', { source_node_id: 'symA', target_node_id: 'symC' }));
    db.replaceEdgeEvidence('ev-edge', [ev('ev-edge', 'routes/web.php')]);

    const marked = db.invalidateEdgesByEvidencePaths(['routes/web.php']);
    expect(marked).toBe(1);
    expect(statusOf(db, 'ev-edge')).toBe('dirty-dependent');
  });
});
