// Tests proving capability-surface nodes persist cleanly in the existing overlay
// and that surface-specific query helpers return correct results.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralNode, StructuralEdge } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-capability-surface-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeSurfaceNode(id: string, handle: string, filePath?: string): StructuralNode {
  const meta = {
    transport: 'http',
    method: handle.split(' ')[0],
    path: handle.split(' ')[1],
  };
  return {
    id,
    node_type: 'capability-surface',
    symbol_name: handle,
    language_id: 'http',
    file_path: filePath,
    metadata: JSON.stringify(meta),
    updated_at: now(),
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  edgeType: StructuralEdge['edge_type'] = 'declares_surface'
): StructuralEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    confidence: 0.95,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
  };
}

describe('capability-surface node persistence', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should persist a capability-surface node with node_type capability-surface', () => {
    const node = makeSurfaceNode(
      'surface:http:GET:/api/invoices',
      'GET /api/invoices',
      'routes/api.php'
    );
    db.upsertStructuralNode(node);

    const stored = db.getStructuralNode('surface:http:GET:/api/invoices');
    expect(stored).not.toBeNull();
    expect(stored!.node_type).toBe('capability-surface');
    expect(stored!.symbol_name).toBe('GET /api/invoices');
    expect(stored!.language_id).toBe('http');
    expect(stored!.file_path).toBe('routes/api.php');
  });

  it('should round-trip metadata JSON correctly', () => {
    const node = makeSurfaceNode('surface:http:POST:/api/invoices', 'POST /api/invoices');
    db.upsertStructuralNode(node);

    const stored = db.getStructuralNode('surface:http:POST:/api/invoices');
    expect(stored).not.toBeNull();

    const meta = JSON.parse(stored!.metadata ?? '{}') as Record<string, unknown>;
    expect(meta.transport).toBe('http');
    expect(meta.method).toBe('POST');
    expect(meta.path).toBe('/api/invoices');
  });

  it('should upsert cleanly — re-persisting the same surface does not duplicate', () => {
    const node = makeSurfaceNode('surface:http:GET:/api/users', 'GET /api/users');
    db.upsertStructuralNode(node);
    db.upsertStructuralNode(node); // second upsert

    const surfaces = db.getCapabilitySurfaces();
    const matching = surfaces.filter((s) => s.id === 'surface:http:GET:/api/users');
    expect(matching).toHaveLength(1);
  });

  it('should return all capability-surface nodes via getCapabilitySurfaces()', () => {
    db.upsertStructuralNode(makeSurfaceNode('surface:http:GET:/api/invoices', 'GET /api/invoices'));
    db.upsertStructuralNode(
      makeSurfaceNode('surface:http:POST:/api/invoices', 'POST /api/invoices')
    );
    db.upsertStructuralNode(makeSurfaceNode('surface:http:GET:/api/users', 'GET /api/users'));
    // Also insert a non-surface node — should not appear
    db.upsertStructuralNode({
      id: 'file:routes/api.php',
      node_type: 'file',
      file_path: 'routes/api.php',
      updated_at: now(),
    });

    const surfaces = db.getCapabilitySurfaces();
    expect(surfaces).toHaveLength(3);
    expect(surfaces.every((s) => s.node_type === 'capability-surface')).toBe(true);
  });

  it('should find surfaces by handle prefix via searchSurfacesByHandle()', () => {
    db.upsertStructuralNode(makeSurfaceNode('surface:http:GET:/api/invoices', 'GET /api/invoices'));
    db.upsertStructuralNode(
      makeSurfaceNode('surface:http:POST:/api/invoices', 'POST /api/invoices')
    );
    db.upsertStructuralNode(makeSurfaceNode('surface:http:GET:/api/users', 'GET /api/users'));

    const getResults = db.searchSurfacesByHandle('GET %');
    expect(getResults).toHaveLength(2);
    expect(getResults.every((s) => s.symbol_name?.startsWith('GET'))).toBe(true);

    const invoiceResults = db.searchSurfacesByHandle('%/api/invoices');
    expect(invoiceResults).toHaveLength(2);
  });

  it('should return null from getSurfaceCenteredContext() for unknown surface', () => {
    const result = db.getSurfaceCenteredContext('surface:http:GET:/nonexistent');
    expect(result).toBeNull();
  });

  it('should return surface + edges via getSurfaceCenteredContext()', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const routeFileId = 'file:routes/api.php';
    const controllerSymId = 'symbol:php:App\\Http\\Controllers\\InvoiceController@index';

    db.upsertStructuralNode(makeSurfaceNode(surfaceId, 'GET /api/invoices', 'routes/api.php'));
    db.upsertStructuralNode({
      id: routeFileId,
      node_type: 'file',
      file_path: 'routes/api.php',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: controllerSymId,
      node_type: 'symbol',
      file_path: 'app/Http/Controllers/InvoiceController.php',
      updated_at: now(),
    });

    db.upsertStructuralEdge(makeEdge('e1', routeFileId, surfaceId, 'declares_surface'));
    db.upsertStructuralEdge(makeEdge('e2', surfaceId, controllerSymId, 'handled_by'));

    const ctx = db.getSurfaceCenteredContext(surfaceId);
    expect(ctx).not.toBeNull();
    expect(ctx!.surface.id).toBe(surfaceId);
    expect(ctx!.edges).toHaveLength(2);

    const edgeTypes = ctx!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('declares_surface');
    expect(edgeTypes).toContain('handled_by');
  });

  it('should persist declares_surface and handled_by edge types without constraint errors', () => {
    const surfaceId = 'surface:http:GET:/api/orders';
    const routeFileId = 'file:routes/api.php';

    db.upsertStructuralNode(makeSurfaceNode(surfaceId, 'GET /api/orders'));
    db.upsertStructuralNode({
      id: routeFileId,
      node_type: 'file',
      file_path: 'routes/api.php',
      updated_at: now(),
    });

    expect(() => {
      db.upsertStructuralEdge(makeEdge('e-decl', routeFileId, surfaceId, 'declares_surface'));
      db.upsertStructuralEdge(makeEdge('e-handled', surfaceId, routeFileId, 'handled_by'));
      db.upsertStructuralEdge(makeEdge('e-calls', routeFileId, surfaceId, 'calls_surface'));
    }).not.toThrow();
  });

  it('should persist all new edge types without constraint errors', () => {
    const nodeA = { id: 'file:a.ts', node_type: 'file' as const, updated_at: now() };
    const nodeB = { id: 'file:b.ts', node_type: 'file' as const, updated_at: now() };
    db.upsertStructuralNode(nodeA);
    db.upsertStructuralNode(nodeB);

    const newEdgeTypes: StructuralEdge['edge_type'][] = [
      'declares_surface',
      'handled_by',
      'calls_surface',
      'uses_contract',
      'returns_contract',
      'validates_with',
      'derived_from',
      'calls',
      'references',
      'uses_hook',
      'provides_context',
      'consumes_context',
    ];

    for (const edgeType of newEdgeTypes) {
      expect(() => {
        db.upsertStructuralEdge(makeEdge(`e-${edgeType}`, 'file:a.ts', 'file:b.ts', edgeType));
      }).not.toThrow();
    }
  });
});
