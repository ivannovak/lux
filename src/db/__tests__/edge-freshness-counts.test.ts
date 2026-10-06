import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralEdge } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-edge-freshness-counts-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function edge(id: string, status: string): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: status as StructuralEdge['freshness_status'],
    dirty_dependency_count: 0,
    updated_at: now(),
  };
}

describe('countEdgesByFreshness (spec 10B)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('returns zeros for an empty overlay', () => {
    expect(db.countEdgesByFreshness()).toEqual({
      fresh: 0,
      'dirty-dependent': 0,
      stale: 0,
      unknown: 0,
      other: 0,
    });
  });

  it('reports exact bucket counts across the four first-class statuses', () => {
    db.upsertStructuralEdge(edge('e:f1', 'fresh'));
    db.upsertStructuralEdge(edge('e:f2', 'fresh'));
    db.upsertStructuralEdge(edge('e:f3', 'fresh'));
    db.upsertStructuralEdge(edge('e:d1', 'dirty-dependent'));
    db.upsertStructuralEdge(edge('e:d2', 'dirty-dependent'));
    db.upsertStructuralEdge(edge('e:s1', 'stale'));

    expect(db.countEdgesByFreshness()).toEqual({
      fresh: 3,
      'dirty-dependent': 2,
      stale: 1,
      unknown: 0,
      other: 0,
    });
  });

  it('a first-class `unknown` edge gets its own bucket, not the `other` sentinel', () => {
    db.upsertStructuralEdge(edge('e:f1', 'fresh'));
    db.upsertStructuralEdge(edge('e:u1', 'unknown'));
    db.upsertStructuralEdge(edge('e:u2', 'unknown'));

    const counts = db.countEdgesByFreshness();
    expect(counts.fresh).toBe(1);
    expect(counts.unknown).toBe(2);
    expect(counts.other).toBe(0); // legitimate `unknown` never reads as a false regression sentinel
    expect(counts['dirty-dependent']).toBe(0);
    expect(counts.stale).toBe(0);
  });

  it('a truly unrecognized status still lands in the `other` sentinel bucket', () => {
    db.upsertStructuralEdge(edge('e:f1', 'fresh'));
    db.upsertStructuralEdge(edge('e:weird', 'something-else'));
    db.upsertStructuralEdge(edge('e:weird2', 'nonsense-status'));

    const counts = db.countEdgesByFreshness();
    expect(counts.fresh).toBe(1);
    expect(counts.other).toBe(2);
    expect(counts.unknown).toBe(0);
    expect(counts['dirty-dependent']).toBe(0);
    expect(counts.stale).toBe(0);
  });
});
