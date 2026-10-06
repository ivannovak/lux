import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type {
  ConfidenceClass,
  EdgeType,
  OperationalBoundaryKind,
  StructuralNode,
  StructuralNodeType,
} from '../../../db/types.js';
import { walkDownstream, type DownstreamBudget } from '../downstream.js';
import type { DeltaTouchSet } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-delta-downstream-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `d-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function budget(over: Partial<DownstreamBudget> = {}): DownstreamBudget {
  return { depth: 6, maxNodes: 2000, maxFanout: 64, minConfidence: 'heuristic', ...over };
}

function touchSet(symbolIds: string[]): DeltaTouchSet {
  return {
    nodes: [],
    symbolIds,
    surfacesDeclared: [],
    evidenceEdgeCount: 0,
    operationalBoundaries: [],
    orphanedNodeCount: 0,
  };
}

describe('delta downstream — reverse-BFS HTTP walk (spec 12, Phase 2a)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function n(id: string, nodeType: StructuralNodeType = 'symbol'): void {
    const over: Partial<StructuralNode> & Pick<StructuralNode, 'id'> = { id };
    db.upsertStructuralNode({ node_type: nodeType, updated_at: now(), ...over });
  }

  function e(
    id: string,
    source: string,
    target: string,
    edgeType: EdgeType,
    confidenceClass: ConfidenceClass
  ): void {
    db.upsertStructuralEdge({
      id,
      source_node_id: source,
      target_node_id: target,
      edge_type: edgeType,
      confidence: 0.9,
      confidence_class: confidenceClass,
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: now(),
    });
  }

  it('resolves surface --handled_by--> Controller --calls--> Service seeded at Service', () => {
    n('surface:http:GET:/x', 'capability-surface');
    n('symbol:Controller');
    n('symbol:Service');
    e('edge:calls', 'symbol:Controller', 'symbol:Service', 'calls', 'proven');
    e(
      'edge:handled',
      'surface:http:GET:/x',
      'symbol:Controller',
      'handled_by',
      'framework-inferred'
    );

    const r = walkDownstream(db, touchSet(['symbol:Service']), budget());

    expect(r.entrySurfaces).toHaveLength(1);
    const s = r.entrySurfaces[0];
    expect(s.kind).toBe('http');
    expect(s.id).toBe('surface:http:GET:/x');
    expect(s.resolvedVia).toBe('structural-walk');
    expect(s.hops).toBe(2);
    expect(s.weakestConfidence).toBe('framework-inferred');
    expect(r.asyncBoundaries).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('sets truncated when incoming fanout exceeds maxFanout', () => {
    n('symbol:Hub');
    n('symbol:CallerA');
    n('symbol:CallerB');
    e('edge:a', 'symbol:CallerA', 'symbol:Hub', 'calls', 'proven');
    e('edge:b', 'symbol:CallerB', 'symbol:Hub', 'calls', 'proven');

    const r = walkDownstream(db, touchSet(['symbol:Hub']), budget({ maxFanout: 1 }));
    expect(r.truncated).toBe(true);
  });

  it('sets truncated when the depth budget is exhausted with a live frontier', () => {
    n('surface:http:GET:/x', 'capability-surface');
    n('symbol:Controller');
    n('symbol:Service');
    e('edge:calls', 'symbol:Controller', 'symbol:Service', 'calls', 'proven');
    e('edge:handled', 'surface:http:GET:/x', 'symbol:Controller', 'handled_by', 'proven');

    const r = walkDownstream(db, touchSet(['symbol:Service']), budget({ depth: 1 }));
    expect(r.truncated).toBe(true);
    expect(r.entrySurfaces).toEqual([]); // surface sits at hop 2, past the depth-1 budget
  });

  it('drops an edge below the minConfidence floor', () => {
    n('surface:http:GET:/x', 'capability-surface');
    n('symbol:Controller');
    e('edge:handled', 'surface:http:GET:/x', 'symbol:Controller', 'handled_by', 'heuristic');

    const r = walkDownstream(
      db,
      touchSet(['symbol:Controller']),
      budget({ minConfidence: 'framework-inferred' })
    );
    expect(r.entrySurfaces).toEqual([]); // heuristic edge is below the floor and never followed
  });

  it('returns empty projections when no surface is reachable (TS-repo case, SC-9)', () => {
    n('symbol:Foo');
    n('symbol:Bar');
    e('edge:calls', 'symbol:Bar', 'symbol:Foo', 'calls', 'proven');

    const r = walkDownstream(db, touchSet(['symbol:Foo']), budget());
    expect(r.entrySurfaces).toEqual([]);
    expect(r.asyncBoundaries).toEqual([]);
    expect(r.visitedSymbols).toContain('symbol:Foo');
    expect(r.visitedSymbols).toContain('symbol:Bar');
  });
});

describe('delta downstream — operational join + async boundary (spec 12, Phase 2b)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function ob(id: string, kind: OperationalBoundaryKind, name: string): void {
    db.upsertOperationalBoundary({
      id,
      repo_root: '/repo',
      kind,
      name,
      trust_tier: 3,
      file_path: `app/${name}.php`,
    });
  }
  function oh(id: string, boundaryId: string, symbolId: string): void {
    db.upsertOperationalHandler({
      id,
      boundary_id: boundaryId,
      symbol_id: symbolId,
      trust_tier: 3,
    });
  }

  it('resolves a job boundary to an operational-join surface plus an async-boundary', () => {
    ob('op:job:1', 'job', 'SendEmailJob');
    oh('oh:1', 'op:job:1', 'symbol:Job');

    const r = walkDownstream(db, touchSet(['symbol:Job']), budget());
    expect(r.entrySurfaces).toEqual([
      { kind: 'job', id: 'op:job:1', resolvedVia: 'operational-join', weakestConfidence: null },
    ]);
    expect(r.asyncBoundaries).toEqual([{ symbol: 'symbol:Job', reachedVia: 'async-boundary' }]);
  });

  it('resolves a command boundary to a surface only (no async annotation)', () => {
    ob('op:cmd:1', 'command', 'DeployCommand');
    oh('oh:1', 'op:cmd:1', 'symbol:Cmd');

    const r = walkDownstream(db, touchSet(['symbol:Cmd']), budget());
    expect(r.entrySurfaces).toEqual([
      {
        kind: 'command',
        id: 'op:cmd:1',
        resolvedVia: 'operational-join',
        weakestConfidence: null,
      },
    ]);
    expect(r.asyncBoundaries).toEqual([]);
  });

  it('resolves an http operational boundary to a surface only', () => {
    ob('op:http:1', 'http', 'WebhookRoute');
    oh('oh:1', 'op:http:1', 'symbol:Web');

    const r = walkDownstream(db, touchSet(['symbol:Web']), budget());
    expect(r.entrySurfaces).toEqual([
      { kind: 'http', id: 'op:http:1', resolvedVia: 'operational-join', weakestConfidence: null },
    ]);
    expect(r.asyncBoundaries).toEqual([]);
  });
});
