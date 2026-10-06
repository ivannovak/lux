import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralNode, StructuralEdge, EdgeEvidence } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'lux-structural-overlay-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeNode(overrides: Partial<StructuralNode> = {}): StructuralNode {
  return {
    id: 'file:src/app.ts',
    node_type: 'file',
    file_path: 'src/app.ts',
    language_id: 'typescript',
    updated_at: now(),
    ...overrides,
  };
}

function makeEdge(overrides: Partial<StructuralEdge> = {}): StructuralEdge {
  return {
    id: 'edge:test-1',
    source_node_id: 'file:src/app.ts',
    target_node_id: 'file:src/routes/api.ts',
    edge_type: 'calls_surface',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...overrides,
  };
}

function makeEvidence(edgeId: string, overrides: Partial<EdgeEvidence> = {}): EdgeEvidence {
  return {
    id: `ev:${edgeId}:1`,
    edge_id: edgeId,
    resolver: 'laravel-routes',
    evidence_kind: 'route-match',
    file_path: 'routes/api.php',
    line: 42,
    note: 'GET /api/users',
    recorded_at: now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('structural overlay — nodes', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should insert and retrieve a structural node', () => {
    const node = makeNode();
    db.upsertStructuralNode(node);

    const retrieved = db.getStructuralNode(node.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(node.id);
    expect(retrieved!.node_type).toBe('file');
    expect(retrieved!.file_path).toBe('src/app.ts');
    expect(retrieved!.language_id).toBe('typescript');
  });

  it('should upsert (update) an existing node', () => {
    const node = makeNode();
    db.upsertStructuralNode(node);

    const updated = makeNode({ language_id: 'javascript', symbol_name: 'App' });
    db.upsertStructuralNode(updated);

    const retrieved = db.getStructuralNode(node.id);
    expect(retrieved!.language_id).toBe('javascript');
    expect(retrieved!.symbol_name).toBe('App');
  });

  it('should return null for a non-existent node', () => {
    expect(db.getStructuralNode('nonexistent')).toBeNull();
  });

  it('should store symbol nodes with qualified names', () => {
    const node = makeNode({
      id: 'symbol:php:App\\Services\\InvoiceService',
      node_type: 'symbol',
      file_path: 'app/Services/InvoiceService.php',
      language_id: 'php',
      symbol_name: 'InvoiceService',
      symbol_kind: 'Class',
      qualified_name: 'App\\Services\\InvoiceService',
    });
    db.upsertStructuralNode(node);

    const retrieved = db.getStructuralNode(node.id);
    expect(retrieved!.node_type).toBe('symbol');
    expect(retrieved!.qualified_name).toBe('App\\Services\\InvoiceService');
    expect(retrieved!.symbol_kind).toBe('Class');
  });

  it('should store all supported node types', () => {
    const types: StructuralNode['node_type'][] = [
      'file',
      'symbol',
      'route',
      'template',
      'contract',
      'event',
      'artifact',
    ];

    for (const node_type of types) {
      db.upsertStructuralNode(makeNode({ id: `node:${node_type}`, node_type }));
    }

    for (const node_type of types) {
      const n = db.getStructuralNode(`node:${node_type}`);
      expect(n!.node_type).toBe(node_type);
    }
  });
});

describe('structural overlay — edges', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
    // Seed nodes that edges reference
    db.upsertStructuralNode(makeNode({ id: 'file:src/app.ts' }));
    db.upsertStructuralNode(
      makeNode({ id: 'file:src/routes/api.ts', file_path: 'src/routes/api.ts' })
    );
    db.upsertStructuralNode(makeNode({ id: 'file:src/other.ts', file_path: 'src/other.ts' }));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should insert and retrieve an edge', () => {
    const edge = makeEdge();
    db.upsertStructuralEdge(edge);

    const edges = db.getStructuralEdgesForNode(edge.source_node_id);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe(edge.id);
    expect(edges[0].edge_type).toBe('calls_surface');
    expect(edges[0].confidence).toBe(0.9);
    expect(edges[0].confidence_class).toBe('framework-inferred');
    expect(edges[0].freshness_status).toBe('fresh');
  });

  it('should upsert (update) an existing edge', () => {
    db.upsertStructuralEdge(makeEdge());
    db.upsertStructuralEdge(makeEdge({ confidence: 0.5, freshness_status: 'stale' }));

    const edges = db.getStructuralEdgesForNode('file:src/app.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBe(0.5);
    expect(edges[0].freshness_status).toBe('stale');
  });

  it('should retrieve edges for the target node too', () => {
    db.upsertStructuralEdge(makeEdge());

    const edgesForTarget = db.getStructuralEdgesForNode('file:src/routes/api.ts');
    expect(edgesForTarget).toHaveLength(1);
    expect(edgesForTarget[0].source_node_id).toBe('file:src/app.ts');
  });

  it('should store all confidence classes', () => {
    const classes: StructuralEdge['confidence_class'][] = [
      'proven',
      'artifact-backed',
      'framework-inferred',
      'heuristic',
    ];

    for (const cc of classes) {
      db.upsertStructuralEdge(makeEdge({ id: `edge:${cc}`, confidence_class: cc }));
    }

    for (const cc of classes) {
      const edges = db.getStructuralEdgesForNode('file:src/app.ts');
      const match = edges.find((e) => e.id === `edge:${cc}`);
      expect(match!.confidence_class).toBe(cc);
    }
  });

  it('should store source_commit and provenance_summary', () => {
    const edge = makeEdge({
      source_commit: 'abc123',
      provenance_summary: 'Laravel route GET /api/users → controller action',
    });
    db.upsertStructuralEdge(edge);

    const edges = db.getStructuralEdgesForNode(edge.source_node_id);
    expect(edges[0].source_commit).toBe('abc123');
    expect(edges[0].provenance_summary).toContain('GET /api/users');
  });
});

describe('structural overlay — edge evidence', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
    db.upsertStructuralNode(makeNode({ id: 'file:src/app.ts' }));
    db.upsertStructuralNode(
      makeNode({ id: 'file:src/routes/api.ts', file_path: 'src/routes/api.ts' })
    );
    db.upsertStructuralEdge(makeEdge());
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should insert and retrieve evidence for an edge', () => {
    const ev = makeEvidence('edge:test-1');
    db.replaceEdgeEvidence('edge:test-1', [ev]);

    const retrieved = db.getEdgeEvidence('edge:test-1');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].resolver).toBe('laravel-routes');
    expect(retrieved[0].evidence_kind).toBe('route-match');
    expect(retrieved[0].file_path).toBe('routes/api.php');
    expect(retrieved[0].line).toBe(42);
  });

  it('should replace evidence atomically', () => {
    const ev1 = makeEvidence('edge:test-1', { id: 'ev:1' });
    db.replaceEdgeEvidence('edge:test-1', [ev1]);

    const ev2 = makeEvidence('edge:test-1', { id: 'ev:2', note: 'updated note' });
    db.replaceEdgeEvidence('edge:test-1', [ev2]);

    const retrieved = db.getEdgeEvidence('edge:test-1');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe('ev:2');
    expect(retrieved[0].note).toBe('updated note');
  });

  it('should allow multiple evidence records for one edge', () => {
    const evs = [
      makeEvidence('edge:test-1', { id: 'ev:a', note: 'first hit' }),
      makeEvidence('edge:test-1', { id: 'ev:b', note: 'second hit', line: 99 }),
    ];
    db.replaceEdgeEvidence('edge:test-1', evs);

    const retrieved = db.getEdgeEvidence('edge:test-1');
    expect(retrieved).toHaveLength(2);
  });

  it('should return empty array for edges with no evidence', () => {
    const retrieved = db.getEdgeEvidence('edge:nonexistent');
    expect(retrieved).toEqual([]);
  });
});

describe('structural overlay — freshness invalidation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
    db.upsertStructuralNode(makeNode({ id: 'file:src/app.ts', file_path: 'src/app.ts' }));
    db.upsertStructuralNode(
      makeNode({ id: 'file:src/routes/api.ts', file_path: 'src/routes/api.ts' })
    );
    db.upsertStructuralNode(makeNode({ id: 'file:src/other.ts', file_path: 'src/other.ts' }));
    db.upsertStructuralEdge(makeEdge({ id: 'edge:1', freshness_status: 'fresh' }));
    db.upsertStructuralEdge(
      makeEdge({
        id: 'edge:2',
        source_node_id: 'file:src/other.ts',
        target_node_id: 'file:src/app.ts',
        freshness_status: 'fresh',
      })
    );
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should mark edges dirty-dependent when a referenced file changes', () => {
    const count = db.invalidateEdgesForFiles(['src/app.ts']);
    expect(count).toBeGreaterThan(0);

    const edges = db.getStructuralEdgesForNode('file:src/app.ts');
    for (const edge of edges) {
      expect(edge.freshness_status).toBe('dirty-dependent');
    }
  });

  it('should return 0 when no edges reference the file', () => {
    const count = db.invalidateEdgesForFiles(['src/nonexistent.ts']);
    expect(count).toBe(0);
  });

  it('should handle multiple files in one call', () => {
    const count = db.invalidateEdgesForFiles(['src/app.ts', 'src/other.ts']);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('operational boundary intelligence — persistence', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should insert and retrieve operational boundaries by repo root and kind', () => {
    db.upsertOperationalBoundary({
      id: 'opb:command:invoices.sync',
      repo_root: '/app',
      kind: 'command',
      name: 'invoices:sync',
      trust_tier: 5,
      file_path: 'app/Console/Commands/SyncInvoices.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:job:refresh-report',
      repo_root: '/app',
      kind: 'job',
      name: 'App\\Jobs\\RefreshReport',
      trust_tier: 4,
      file_path: 'app/Jobs/RefreshReport.php',
    });

    expect(db.getOperationalBoundary('opb:command:invoices.sync')?.name).toBe('invoices:sync');
    expect(db.getOperationalBoundaries()).toHaveLength(2);
    expect(db.getOperationalBoundariesByKind('command')).toHaveLength(1);
  });

  it('should persist handlers, edges, and contracts for an operational boundary', () => {
    db.upsertOperationalBoundary({
      id: 'opb:event:listing-imported',
      repo_root: '/app',
      kind: 'event',
      name: 'App\\Events\\ListingImported',
      trust_tier: 5,
      file_path: 'app/Providers/EventServiceProvider.php',
    });

    db.upsertOperationalHandler({
      id: 'oph:event-listener:listing-imported',
      boundary_id: 'opb:event:listing-imported',
      symbol_id: 'symbol:php:App\\Listeners\\SyncSearchIndex',
      trust_tier: 5,
    });

    db.upsertOperationalEdge({
      id: 'ope:event-listener:listing-imported',
      source_id: 'opb:event:listing-imported',
      target_id: 'symbol:php:App\\Listeners\\SyncSearchIndex',
      edge_type: 'HANDLED_BY',
      transport: 'event-bus',
      trust_tier: 5,
    });

    db.upsertOperationalContract({
      id: 'opc:event:listing-imported',
      boundary_id: 'opb:event:listing-imported',
      payload_schema: JSON.stringify({ event: 'App\\Events\\ListingImported' }),
      trust_tier: 3,
    });

    const handlers = db.getOperationalHandlersForBoundary('opb:event:listing-imported');
    const edges = db.getOperationalEdgesForSource('opb:event:listing-imported');
    const contracts = db.getOperationalContractsForBoundary('opb:event:listing-imported');

    expect(handlers).toHaveLength(1);
    expect(handlers[0].symbol_id).toBe('symbol:php:App\\Listeners\\SyncSearchIndex');

    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe('HANDLED_BY');
    expect(edges[0].transport).toBe('event-bus');

    expect(contracts).toHaveLength(1);
    expect(contracts[0].payload_schema).toContain('ListingImported');
  });

  it('should clear operational boundary tables as part of clearOverlay()', () => {
    db.upsertOperationalBoundary({
      id: 'opb:schedule:nightly-sync',
      repo_root: '/app',
      kind: 'schedule',
      name: 'nightly-sync',
      trust_tier: 5,
      file_path: 'app/Console/Kernel.php',
    });
    db.upsertOperationalHandler({
      id: 'oph:schedule:nightly-sync',
      boundary_id: 'opb:schedule:nightly-sync',
      symbol_id: 'symbol:php:App\\Console\\Commands\\SyncNightly',
      trust_tier: 5,
    });
    db.upsertOperationalEdge({
      id: 'ope:schedule:nightly-sync',
      source_id: 'opb:schedule:nightly-sync',
      target_id: 'opb:command:sync-nightly',
      edge_type: 'TRIGGERS',
      transport: 'sync',
      trust_tier: 5,
    });
    db.upsertOperationalContract({
      id: 'opc:schedule:nightly-sync',
      boundary_id: 'opb:schedule:nightly-sync',
      payload_schema: JSON.stringify({ cron: '0 1 * * *' }),
      trust_tier: 4,
    });

    db.clearOverlay();

    expect(db.getOperationalBoundaries()).toEqual([]);
    expect(db.getOperationalHandlersForBoundary('opb:schedule:nightly-sync')).toEqual([]);
    expect(db.getOperationalEdgesForSource('opb:schedule:nightly-sync')).toEqual([]);
    expect(db.getOperationalContractsForBoundary('opb:schedule:nightly-sync')).toEqual([]);
  });
});
