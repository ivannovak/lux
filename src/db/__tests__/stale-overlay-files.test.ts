import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralEdge, StructuralNode } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-stale-overlay-files-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function node(id: string, filePath: string, over: Partial<StructuralNode> = {}): StructuralNode {
  return { id, node_type: 'symbol', file_path: filePath, updated_at: now(), ...over };
}

function edge(id: string, over: Partial<StructuralEdge> = {}): StructuralEdge {
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

describe('getFilePathsWithStaleEdges (spec 12 Part A / OQ4)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('returns DISTINCT files across BOTH dimensions (node-path + evidence), never a fresh file', () => {
    // node-path dimension: a stale edge whose endpoint node lives in A.php.
    db.upsertStructuralNode(node('sym:A', 'A.php'));
    db.upsertStructuralNode(node('sym:B', 'B.php'));
    db.upsertStructuralEdge(
      edge('edge:nodepath', {
        source_node_id: 'sym:A',
        target_node_id: 'sym:B',
        freshness_status: 'stale',
      })
    );
    // B.php's only edge is stale via node-path too — but we want a purely fresh file to prove
    // it is never surfaced, so give B a separate fresh edge and a fresh-only file C.php.
    db.upsertStructuralNode(node('sym:C', 'C.php'));
    db.upsertStructuralEdge(
      edge('edge:fresh', {
        source_node_id: 'sym:C',
        target_node_id: 'sym:C',
        freshness_status: 'fresh',
      })
    );

    // evidence dimension: a stale edge whose endpoints are elsewhere but whose evidence cites a
    // routes file (the handled_by-style case node-path alone would miss).
    db.upsertStructuralEdge(
      edge('edge:evidence', {
        source_node_id: 'surface:http:GET:/x',
        target_node_id: 'sym:handler',
        edge_type: 'handled_by',
        freshness_status: 'stale',
      })
    );
    db.replaceEdgeEvidence('edge:evidence', [
      {
        id: 'ev:routes',
        edge_id: 'edge:evidence',
        resolver: 'r',
        evidence_kind: 'k',
        file_path: 'routes/web.php',
        recorded_at: now(),
      },
    ]);

    const files = db.getFilePathsWithStaleEdges().sort();
    // A.php (+ B.php via the same stale node-path edge) and routes/web.php; never C.php (fresh only).
    expect(files).toEqual(['A.php', 'B.php', 'routes/web.php']);
    expect(files).not.toContain('C.php');
  });

  it('returns [] when every edge is fresh', () => {
    db.upsertStructuralNode(node('sym:A', 'A.php'));
    db.upsertStructuralEdge(
      edge('edge:fresh', { source_node_id: 'sym:A', target_node_id: 'sym:A' })
    );
    expect(db.getFilePathsWithStaleEdges()).toEqual([]);
  });
});
