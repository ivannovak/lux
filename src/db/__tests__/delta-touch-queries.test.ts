import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralEdge, StructuralNode } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-delta-touch-queries-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function node(id: string, over: Partial<StructuralNode> = {}): StructuralNode {
  return { id, node_type: 'file', file_path: id.replace(/^file:/, ''), updated_at: now(), ...over };
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

describe('delta touch-set dynamic-IN DB methods (spec 11 Part A)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('getStructuralNodesForFilePaths returns exactly the matching nodes (and empty for none)', () => {
    db.upsertStructuralNode(node('file:src/a.php'));
    db.upsertStructuralNode(node('file:src/b.php'));
    db.upsertStructuralNode(node('file:src/c.php'));

    const rows = db.getStructuralNodesForFilePaths(['src/a.php', 'src/c.php']);
    expect(rows.map((r) => r.file_path).sort()).toEqual(['src/a.php', 'src/c.php']);
    expect(db.getStructuralNodesForFilePaths([])).toHaveLength(0);
    expect(db.getStructuralNodesForFilePaths(['src/missing.php'])).toHaveLength(0);
  });

  it('completes the union across a >500-path chunk boundary', () => {
    const paths: string[] = [];
    // one transaction — 501 individual WASM inserts fsync per statement and can exceed the
    // 20s test timeout under full-suite parallel load; batching keeps this deterministic.
    db.transaction(() => {
      for (let i = 0; i < 501; i++) {
        const p = `src/f${i}.php`;
        paths.push(p);
        db.upsertStructuralNode(node(`file:${p}`));
      }
    });
    const rows = db.getStructuralNodesForFilePaths(paths);
    expect(rows).toHaveLength(501);
  });

  it('getEvidenceEdgesForFilePaths DISTINCTs one edge across the chunk boundary', () => {
    // one edge whose evidence cites p0 (chunk 0) and p500 (chunk 1). A per-chunk DISTINCT would
    // return it once per chunk (2 rows); the cross-chunk dedup must collapse it to one.
    const paths: string[] = [];
    for (let i = 0; i < 501; i++) paths.push(`src/f${i}.php`);
    db.upsertStructuralEdge(edge('edge:spanning'));
    db.replaceEdgeEvidence('edge:spanning', [
      {
        id: 'ev:span:0',
        edge_id: 'edge:spanning',
        resolver: 'r',
        evidence_kind: 'k',
        file_path: paths[0],
        recorded_at: now(),
      },
      {
        id: 'ev:span:500',
        edge_id: 'edge:spanning',
        resolver: 'r',
        evidence_kind: 'k',
        file_path: paths[500],
        recorded_at: now(),
      },
    ]);

    const rows = db.getEvidenceEdgesForFilePaths(paths);
    expect(rows.filter((r) => r.id === 'edge:spanning')).toHaveLength(1);
  });

  it('getOperationalBoundariesForFilePaths returns boundaries declared in changed files', () => {
    db.upsertOperationalBoundary({
      id: 'opb:job:refresh',
      repo_root: '/app',
      kind: 'job',
      name: 'App\\Jobs\\Refresh',
      trust_tier: 4,
      file_path: 'app/Jobs/Refresh.php',
    });
    const rows = db.getOperationalBoundariesForFilePaths(['app/Jobs/Refresh.php']);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('job');
    expect(db.getOperationalBoundariesForFilePaths(['app/Other.php'])).toHaveLength(0);
  });

  it('getOperationalBoundariesForSymbols keeps every (boundary, symbol) pairing', () => {
    db.upsertOperationalBoundary({
      id: 'opb:job:refresh',
      repo_root: '/app',
      kind: 'job',
      name: 'App\\Jobs\\Refresh',
      trust_tier: 4,
      file_path: 'app/Jobs/Refresh.php',
    });
    db.upsertOperationalHandler({
      id: 'oph:1',
      boundary_id: 'opb:job:refresh',
      symbol_id: 'symbol:php:A::handle',
      trust_tier: 4,
    });
    db.upsertOperationalHandler({
      id: 'oph:2',
      boundary_id: 'opb:job:refresh',
      symbol_id: 'symbol:php:B::handle',
      trust_tier: 4,
    });
    const rows = db.getOperationalBoundariesForSymbols([
      'symbol:php:A::handle',
      'symbol:php:B::handle',
    ]);
    // same boundary reached via two symbols → two pairings kept (composite key, not over-deduped).
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.symbol_id).sort()).toEqual([
      'symbol:php:A::handle',
      'symbol:php:B::handle',
    ]);
  });

  it('getHandlerOwnershipForSymbols reads handled_by edges targeting the handler symbols', () => {
    db.upsertStructuralEdge(
      edge('edge:handled', {
        source_node_id: 'surface:http:GET:/users',
        target_node_id: 'symbol:php:UserController::index',
        edge_type: 'handled_by',
      })
    );
    const rows = db.getHandlerOwnershipForSymbols(['symbol:php:UserController::index']);
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('surface:http:GET:/users');
    expect(rows[0].handler).toBe('symbol:php:UserController::index');
    // ownership column is NULL unless a first-party pass ran.
    expect(rows[0].ownership).toBeNull();
  });

  it('getIncomingStructuralEdges returns target-matched edges, confidence-ordered', () => {
    db.upsertStructuralEdge(
      edge('edge:low', { source_node_id: 's1', target_node_id: 'T', confidence: 0.3 })
    );
    db.upsertStructuralEdge(
      edge('edge:high', { source_node_id: 's2', target_node_id: 'T', confidence: 0.95 })
    );
    db.upsertStructuralEdge(
      edge('edge:other', { source_node_id: 's3', target_node_id: 'U', confidence: 0.9 })
    );
    const rows = db.getIncomingStructuralEdges('T');
    expect(rows.map((r) => r.id)).toEqual(['edge:high', 'edge:low']); // DESC by confidence
  });
});
