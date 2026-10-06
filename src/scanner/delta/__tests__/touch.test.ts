import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import { resolveTouchSet } from '../touch.js';
import type { DeltaChangeSet } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-delta-touch-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function node(over: Partial<StructuralNode> & Pick<StructuralNode, 'id'>): StructuralNode {
  return { node_type: 'file', updated_at: now(), ...over };
}

const NO_CHANGES = {
  changes: [],
  precision: { fileLevelOnly: [], renamedOnly: [], cosmeticOnly: [], changedOutsideSymbols: [] },
  seeds: [],
};

describe('delta touch resolution (spec 11 Part B)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function seed(): void {
    db.upsertStructuralNode(
      node({ id: 'file:src/A.php', node_type: 'file', file_path: 'src/A.php' })
    );
    db.upsertStructuralNode(
      node({
        id: 'symbol:A::foo',
        node_type: 'symbol',
        file_path: 'src/A.php',
        qualified_name: 'A::foo',
      })
    );
    db.upsertStructuralNode(
      node({ id: 'surface:http:GET:/a', node_type: 'capability-surface', file_path: 'src/A.php' })
    );
    db.upsertStructuralNode(
      node({ id: 'symbol:Deleted::gone', node_type: 'symbol', file_path: 'src/Deleted.php' })
    );
    // an edge whose evidence cites the changed file → counted in the invalidation set.
    db.upsertStructuralEdge({
      id: 'edge:1',
      source_node_id: 'symbol:A::foo',
      target_node_id: 'symbol:X',
      edge_type: 'calls',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: now(),
    });
    db.replaceEdgeEvidence('edge:1', [
      {
        id: 'ev:1',
        edge_id: 'edge:1',
        resolver: 'r',
        evidence_kind: 'k',
        file_path: 'src/A.php',
        recorded_at: now(),
      },
    ]);
  }

  function changeSet(): DeltaChangeSet {
    return {
      base: { ref: 'base', sha: null, source: 'flag' },
      head: { sha: null, workingTreeIncluded: true },
      files: [
        { path: 'src/A.php', status: 'modified', module: null, indexTrust: 'index-stale' },
        { path: 'src/Deleted.php', status: 'deleted', module: null, indexTrust: 'index-stale' },
      ],
      indexPaths: ['src/A.php', 'src/Deleted.php'],
      warnings: [],
    };
  }

  it('resolves file + symbol nodes and populates symbolIds', () => {
    seed();
    const touch = resolveTouchSet(db, changeSet(), NO_CHANGES);
    expect(touch.nodes.map((n) => n.id).sort()).toEqual([
      'file:src/A.php',
      'surface:http:GET:/a',
      'symbol:A::foo',
      'symbol:Deleted::gone',
    ]);
    expect(touch.symbolIds).toContain('symbol:A::foo');
  });

  it("annotates a deleted file's node as orphaned", () => {
    seed();
    const touch = resolveTouchSet(db, changeSet(), NO_CHANGES);
    const gone = touch.nodes.find((n) => n.id === 'symbol:Deleted::gone');
    expect(gone?.nodeState).toBe('orphaned');
    const present = touch.nodes.find((n) => n.id === 'symbol:A::foo');
    expect(present?.nodeState).toBe('present');
    expect(touch.orphanedNodeCount).toBe(1);
  });

  it('collects declared surfaces and counts invalidated evidence edges', () => {
    seed();
    const touch = resolveTouchSet(db, changeSet(), NO_CHANGES);
    expect(touch.surfacesDeclared.map((n) => n.id)).toContain('surface:http:GET:/a');
    expect(touch.evidenceEdgeCount).toBe(1);
  });

  it('returns empty structures for an empty change-set', () => {
    const touch = resolveTouchSet(
      db,
      {
        base: { ref: 'base', sha: null, source: 'flag' },
        head: { sha: null, workingTreeIncluded: true },
        files: [],
        indexPaths: [],
        warnings: [],
      },
      NO_CHANGES
    );
    expect(touch.nodes).toHaveLength(0);
    expect(touch.symbolIds).toHaveLength(0);
    expect(touch.evidenceEdgeCount).toBe(0);
  });
});
