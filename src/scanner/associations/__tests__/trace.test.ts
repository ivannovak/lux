import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { ConfidenceClass, EdgeType, NodeOrigin } from '../../../db/types.js';
import {
  CONFIDENCE_RANK,
  DEFAULT_TRACE_OPTIONS,
  DISPATCH_EDGE_TYPES,
  DISPATCH_TERMINI,
  dispatchTerminusFor,
  dispatchTerminusForEdge,
  resolveStartNode,
  traceFrom,
} from '../trace.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-trace-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

/** Insert a structural symbol node. `origin: 'vendor-pack'` makes it external. */
function addNode(
  db: LuxDatabase,
  id: string,
  opts: { origin?: NodeOrigin; qualified_name?: string; symbol_name?: string } = {}
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: opts.symbol_name ?? id,
    qualified_name: opts.qualified_name,
    origin: opts.origin ?? 'local',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

/** Insert a structural edge (defaults: calls / proven / 0.9). */
function addEdge(
  db: LuxDatabase,
  source: string,
  target: string,
  opts: { edgeType?: EdgeType; confidence?: number; confidenceClass?: ConfidenceClass } = {}
): void {
  const edgeType = opts.edgeType ?? 'calls';
  db.upsertStructuralEdge({
    id: `${source}->${target}:${edgeType}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    confidence: opts.confidence ?? 0.9,
    confidence_class: opts.confidenceClass ?? 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

describe('trace primitive', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Catalog / constants contract
  // -------------------------------------------------------------------------

  describe('dispatch catalog + constants', () => {
    it('ranks confidence classes proven > artifact-backed > framework-inferred > heuristic', () => {
      expect(CONFIDENCE_RANK.proven).toBeGreaterThan(CONFIDENCE_RANK['artifact-backed']);
      expect(CONFIDENCE_RANK['artifact-backed']).toBeGreaterThan(
        CONFIDENCE_RANK['framework-inferred']
      );
      expect(CONFIDENCE_RANK['framework-inferred']).toBeGreaterThan(CONFIDENCE_RANK.heuristic);
    });

    it('defaults exclude heuristic edges and include external nodes', () => {
      expect(DEFAULT_TRACE_OPTIONS.minConfidenceClass).toBe('framework-inferred');
      expect(DEFAULT_TRACE_OPTIONS.includeExternal).toBe(true);
      expect(DEFAULT_TRACE_OPTIONS.edgeTypes).toEqual(['calls', 'references']);
    });

    it('recognises catalogued dispatch machinery by FQN', () => {
      const info = dispatchTerminusFor({ qualified_name: 'Illuminate\\Bus\\Dispatcher::dispatch' });
      expect(info).not.toBeNull();
      expect(info!.dispatchKind).toBe('job');
      expect(info!.via).toBe('catalog-symbol');
      expect(info!.reentryDeferred).toBe(true);
    });

    it('catalogs the key framework dispatch/container machinery, incl. the CONCRETE container', () => {
      const fqns = new Set(DISPATCH_TERMINI.map((e) => e.fqn));
      expect(fqns.has('Illuminate\\Bus\\Dispatcher::dispatch')).toBe(true);
      expect(fqns.has('Illuminate\\Events\\Dispatcher::dispatch')).toBe(true);
      // The reachable node on a real graph is the concrete container, not just
      // the Contracts interface — both must be catalogued (REQ-2).
      expect(fqns.has('Illuminate\\Container\\Container::make')).toBe(true);
      expect(fqns.has('Illuminate\\Contracts\\Container\\Container::make')).toBe(true);
      expect(
        dispatchTerminusFor({ qualified_name: 'Illuminate\\Container\\Container::make' })
          ?.dispatchKind
      ).toBe('container');
    });

    it('recognises bare global helpers by symbol_name', () => {
      expect(dispatchTerminusFor({ symbol_name: 'event' })?.dispatchKind).toBe('event');
      expect(dispatchTerminusFor({ symbol_name: 'dispatch' })?.dispatchKind).toBe('job');
    });

    it('recognises dispatch edge types, mapping event edges to the event kind', () => {
      expect(DISPATCH_EDGE_TYPES.has('emits_event')).toBe(true);
      expect(dispatchTerminusForEdge('emits_event')?.dispatchKind).toBe('event');
      expect(dispatchTerminusForEdge('dispatches_job')?.dispatchKind).toBe('job');
      expect(dispatchTerminusForEdge('calls')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveStartNode
  // -------------------------------------------------------------------------

  describe('resolveStartNode', () => {
    it('resolves a direct node id', () => {
      addNode(db, 'sym1', { qualified_name: 'App\\Svc\\Thing::go', symbol_name: 'go' });
      expect(resolveStartNode(db, 'sym1')).toEqual({ nodeId: 'sym1' });
    });

    it('resolves a fully-qualified name', () => {
      addNode(db, 'sym1', { qualified_name: 'App\\Svc\\Thing::go', symbol_name: 'go' });
      expect(resolveStartNode(db, 'App\\Svc\\Thing::go')).toEqual({ nodeId: 'sym1' });
    });

    it('returns notFound when nothing matches', () => {
      expect(resolveStartNode(db, 'Nope::nope')).toEqual({ notFound: true });
    });

    it('returns ambiguous candidates for a shared leaf/suffix', () => {
      addNode(db, 'n1', { qualified_name: 'App\\A\\Foo::bar', symbol_name: 'bar' });
      addNode(db, 'n2', { qualified_name: 'App\\B\\Foo::bar', symbol_name: 'bar' });
      const resolved = resolveStartNode(db, 'Foo::bar');
      expect('ambiguous' in resolved).toBe(true);
      if ('ambiguous' in resolved) {
        expect(resolved.ambiguous.map((c) => c.id).sort()).toEqual(['n1', 'n2']);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Multi-hop cross-boundary walk (REQ-1, REQ-7)
  // -------------------------------------------------------------------------

  it('walks a multi-hop path across the app→vendor boundary and labels external nodes', () => {
    addNode(db, 'A');
    addNode(db, 'B');
    addNode(db, 'C', { origin: 'vendor-pack' });
    addNode(db, 'D', { origin: 'vendor-pack' });
    addEdge(db, 'A', 'B');
    addEdge(db, 'B', 'C');
    addEdge(db, 'C', 'D');

    const result = traceFrom(db, 'A');

    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.get('A')!.depth).toBe(0);
    expect(byId.get('B')!.depth).toBe(1);
    expect(byId.get('C')!.depth).toBe(2);
    expect(byId.get('D')!.depth).toBe(3);
    expect(byId.get('A')!.external).toBe(false);
    expect(byId.get('C')!.external).toBe(true);
    expect(byId.get('D')!.external).toBe(true);
    expect(result.stats.externalCount).toBe(2);
    expect(result.stats.maxDepthReached).toBe(3);
    expect(result.stats.truncated).toBe(false);
    // Deepest node is reached and expanded with zero out-edges → terminal, and
    // carries no terminus flag (the 'leaf' marker is reserved for admitted-but-
    // unexpanded budget remnants, per the spec's traversal semantics).
    expect(byId.get('D')!.terminus).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Cycle-safety (REQ-8)
  // -------------------------------------------------------------------------

  it('terminates on a cycle and marks the closing edge revisit:true', () => {
    addNode(db, 'X');
    addNode(db, 'Y');
    addNode(db, 'Z');
    addEdge(db, 'X', 'Y');
    addEdge(db, 'Y', 'Z');
    addEdge(db, 'Z', 'X'); // closes the cycle

    const result = traceFrom(db, 'X');

    // Each node admitted exactly once despite the cycle.
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['X', 'Y', 'Z']);
    const closing = result.edges.find((e) => e.sourceId === 'Z' && e.targetId === 'X');
    expect(closing).toBeDefined();
    expect(closing!.revisit).toBe(true);
    // Non-cycle edges are not revisits.
    expect(result.edges.filter((e) => e.revisit).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Bounding: depth / node-budget / fanout (REQ-8)
  // -------------------------------------------------------------------------

  it('truncates at maxDepth and marks the frontier depth-limit', () => {
    addNode(db, 'A');
    addNode(db, 'B');
    addNode(db, 'C');
    addNode(db, 'D');
    addEdge(db, 'A', 'B');
    addEdge(db, 'B', 'C');
    addEdge(db, 'C', 'D');

    const result = traceFrom(db, 'A', { maxDepth: 2 });

    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.has('D')).toBe(false); // never reached
    expect(byId.get('C')!.terminus).toBe('depth-limit');
    expect(result.stats.truncated).toBe(true);
  });

  it('truncates at maxNodes and marks the over-budget node node-budget', () => {
    addNode(db, 'A');
    addNode(db, 'B');
    addNode(db, 'C');
    addEdge(db, 'A', 'B');
    addEdge(db, 'B', 'C');

    const result = traceFrom(db, 'A', { maxNodes: 2 });

    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.get('C')!.terminus).toBe('node-budget');
    expect(result.stats.truncated).toBe(true);
  });

  it('caps per-node fan-out and marks the source fanout-cap', () => {
    addNode(db, 'A');
    addNode(db, 't1');
    addNode(db, 't2');
    addNode(db, 't3');
    addEdge(db, 'A', 't1');
    addEdge(db, 'A', 't2');
    addEdge(db, 'A', 't3');

    const result = traceFrom(db, 'A', { maxFanout: 2 });

    expect(result.nodes.find((n) => n.id === 'A')!.terminus).toBe('fanout-cap');
    expect(result.stats.truncated).toBe(true);
    // A + exactly two walked targets.
    expect(result.stats.nodeCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Dynamic-dispatch termini (REQ-2)
  // -------------------------------------------------------------------------

  it('stops at a catalogued dispatch symbol without expanding past it', () => {
    addNode(db, 'Ctrl');
    addNode(db, 'Disp', {
      origin: 'vendor-pack',
      qualified_name: 'Illuminate\\Bus\\Dispatcher::dispatch',
    });
    addNode(db, 'Handler');
    addEdge(db, 'Ctrl', 'Disp');
    addEdge(db, 'Disp', 'Handler'); // must NOT be followed

    const result = traceFrom(db, 'Ctrl');

    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.has('Handler')).toBe(false); // not expanded past the boundary
    const disp = byId.get('Disp')!;
    expect(disp.terminus).toBe('dynamic-dispatch-boundary');
    expect(disp.dispatch?.reentryDeferred).toBe(true);
    expect(disp.dispatch?.via).toBe('catalog-symbol');
    expect(disp.dispatch?.dispatchKind).toBe('job');
    expect(result.stats.dispatchBoundaries).toBe(1);
  });

  it('recognises a dispatch boundary from a dispatch-typed edge', () => {
    addNode(db, 'P');
    addNode(db, 'Job');
    addEdge(db, 'P', 'Job', { edgeType: 'dispatches_job', confidenceClass: 'framework-inferred' });

    const result = traceFrom(db, 'P', { edgeTypes: ['calls', 'dispatches_job'] });

    const job = result.nodes.find((n) => n.id === 'Job')!;
    expect(job.terminus).toBe('dynamic-dispatch-boundary');
    expect(job.dispatch?.via).toBe('dispatch-edge');
    expect(job.dispatch?.dispatchKind).toBe('job');
  });

  it('treats a start symbol that is itself dispatch machinery as a depth-0 terminus', () => {
    addNode(db, 'evt', {
      origin: 'vendor-pack',
      qualified_name: 'Illuminate\\Events\\Dispatcher::dispatch',
    });
    addNode(db, 'downstream');
    addEdge(db, 'evt', 'downstream');

    const result = traceFrom(db, 'evt');

    expect(result.nodes.map((n) => n.id)).toEqual(['evt']);
    expect(result.nodes[0].terminus).toBe('dynamic-dispatch-boundary');
    expect(result.nodes[0].dispatch?.dispatchKind).toBe('event');
    expect(result.stats.dispatchBoundaries).toBe(1);
  });

  // -------------------------------------------------------------------------
  // External filtering (REQ-7) + confidence filtering
  // -------------------------------------------------------------------------

  it('yields an app-only trace with externalCount 0 when includeExternal is false', () => {
    addNode(db, 'A');
    addNode(db, 'B');
    addNode(db, 'C', { origin: 'vendor-pack' });
    addEdge(db, 'A', 'B');
    addEdge(db, 'B', 'C');

    const result = traceFrom(db, 'A', { includeExternal: false });

    expect(result.stats.externalCount).toBe(0);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(result.nodes.some((n) => n.external)).toBe(false);
  });

  it('excludes edges below the minimum confidence class', () => {
    addNode(db, 'A');
    addNode(db, 'B');
    addEdge(db, 'A', 'B', { confidenceClass: 'heuristic', confidence: 0.4 });

    // Default min-confidence (framework-inferred) drops the heuristic edge, so
    // A is expanded with no admitted children (terminal, no terminus flag).
    const strict = traceFrom(db, 'A');
    expect(strict.nodes.map((n) => n.id)).toEqual(['A']);
    expect(strict.nodes[0].terminus).toBeUndefined();

    // Lowering the floor admits it.
    const loose = traceFrom(db, 'A', { minConfidenceClass: 'heuristic' });
    expect(loose.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });
});
