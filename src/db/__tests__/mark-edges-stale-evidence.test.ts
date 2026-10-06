import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralEdge } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-mark-edges-stale-evidence-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function edge(id: string, over: Partial<StructuralEdge> = {}): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'handled_by',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}

function statusOf(db: LuxDatabase, edgeId: string): string | undefined {
  return db.getEdgeFreshnessByIds([edgeId])[0]?.freshness_status;
}

function citeEvidence(db: LuxDatabase, edgeId: string, filePath: string): void {
  db.replaceEdgeEvidence(edgeId, [
    {
      id: `ev:${edgeId}:${filePath}`,
      edge_id: edgeId,
      resolver: 'r',
      evidence_kind: 'k',
      file_path: filePath,
      recorded_at: now(),
    },
  ]);
}

describe('markEdgesStaleByEvidencePaths (spec 11 Part A / SC-3)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('marks exactly the edges whose evidence cites the changed paths, leaving the rest fresh', () => {
    db.upsertStructuralEdge(edge('edge:routed'));
    db.upsertStructuralEdge(edge('edge:unrelated'));
    citeEvidence(db, 'edge:routed', 'routes/web.php');
    citeEvidence(db, 'edge:unrelated', 'app/Other.php');

    const marked = db.markEdgesStaleByEvidencePaths(['routes/web.php']);
    expect(marked).toBe(1);
    expect(statusOf(db, 'edge:routed')).toBe('stale');
    expect(statusOf(db, 'edge:unrelated')).toBe('fresh');
  });

  it('is fresh-guarded and idempotent — a second call marks nothing more', () => {
    db.upsertStructuralEdge(edge('edge:routed'));
    citeEvidence(db, 'edge:routed', 'routes/web.php');

    expect(db.markEdgesStaleByEvidencePaths(['routes/web.php'])).toBe(1);
    // already stale → not re-counted (the fresh guard).
    expect(db.markEdgesStaleByEvidencePaths(['routes/web.php'])).toBe(0);
    expect(statusOf(db, 'edge:routed')).toBe('stale');
  });

  it('does not touch a dirty-dependent edge (guard is strictly fresh)', () => {
    db.upsertStructuralEdge(edge('edge:dd', { freshness_status: 'dirty-dependent' }));
    citeEvidence(db, 'edge:dd', 'routes/web.php');

    expect(db.markEdgesStaleByEvidencePaths(['routes/web.php'])).toBe(0);
    expect(statusOf(db, 'edge:dd')).toBe('dirty-dependent');
  });

  it('returns 0 for an empty path set', () => {
    db.upsertStructuralEdge(edge('edge:routed'));
    citeEvidence(db, 'edge:routed', 'routes/web.php');
    expect(db.markEdgesStaleByEvidencePaths([])).toBe(0);
    expect(statusOf(db, 'edge:routed')).toBe('fresh');
  });

  it('completes across a >500-path chunk boundary with no double count', () => {
    // one edge whose evidence cites a path in chunk 0 and a path in chunk 1; the fresh guard +
    // cross-chunk correctness must mark it once and count it once (never twice).
    const paths: string[] = [];
    for (let i = 0; i < 501; i++) paths.push(`routes/f${i}.php`);
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

    // a distinct fresh edge cited only in the far chunk, to prove chunk-1 paths are honored.
    db.upsertStructuralEdge(edge('edge:farchunk'));
    citeEvidence(db, 'edge:farchunk', paths[500]);

    const marked = db.markEdgesStaleByEvidencePaths(paths);
    expect(marked).toBe(2); // spanning (once, not twice) + farchunk
    expect(statusOf(db, 'edge:spanning')).toBe('stale');
    expect(statusOf(db, 'edge:farchunk')).toBe('stale');
  });
});
