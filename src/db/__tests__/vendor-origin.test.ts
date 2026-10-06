import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../index.js';
import type { StructuralNode, StructuralEdge } from '../types.js';

// Coverage for the Phase-0 DB foundation of tracing-calls-through-vendor:
// the `origin` provenance column (migration 012), origin-aware read helpers,
// the public transaction wrapper, and the ATTACH-based vendor-pack merge.

const testDir = mkdtempSync(join(tmpdir(), 'lux-vendor-origin-test-'));

function freshDir(): void {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function symbolNode(id: string, overrides: Partial<StructuralNode> = {}): StructuralNode {
  return {
    id,
    node_type: 'symbol',
    file_path: 'app/Example.php',
    language_id: 'php',
    symbol_name: 'example',
    qualified_name: id.replace(/^symbol:php:/, ''),
    updated_at: now(),
    ...overrides,
  };
}

function callsEdge(id: string, source: string, target: string): StructuralEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: 'lsp [textDocument/definition]',
    updated_at: now(),
  };
}

/**
 * Build a standalone pack DB (a LuxDatabase whose overlay tables mirror the
 * project schema) at `packPath`, populate it, close it (so the WAL is
 * checkpointed into a self-contained file), and return the path.
 */
function buildPack(packPath: string, nodes: StructuralNode[], edges: StructuralEdge[]): string {
  const pack = new LuxDatabase(packPath);
  pack.transaction(() => {
    for (const n of nodes) pack.upsertStructuralNode(n);
    for (const e of edges) pack.upsertStructuralEdge(e);
  });
  pack.close();
  return packPath;
}

describe('structural node origin — migration 012 + helpers', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    freshDir();
    db = new LuxDatabase(join(testDir, 'project.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('defaults origin to "local" for app-materialized nodes', () => {
    db.upsertStructuralNode(symbolNode('symbol:php:App\\Foo::bar'));
    const node = db.getStructuralNode('symbol:php:App\\Foo::bar');
    expect(node).not.toBeNull();
    expect(node!.origin).toBe('local');
    expect(LuxDatabase.isExternalNode(node!)).toBe(false);
  });

  it('isExternalNode is true only for vendor-pack origin', () => {
    expect(LuxDatabase.isExternalNode({ origin: 'vendor-pack' })).toBe(true);
    expect(LuxDatabase.isExternalNode({ origin: 'local' })).toBe(false);
    expect(LuxDatabase.isExternalNode({ origin: undefined })).toBe(false);
  });

  it('getLocalStructuralNodesByType excludes merged vendor-pack nodes', () => {
    db.upsertStructuralNode(symbolNode('symbol:php:App\\Foo::bar'));
    const packPath = buildPack(
      join(testDir, 'pack.db'),
      [symbolNode('symbol:php:Illuminate\\Model::save')],
      []
    );
    db.importVendorPack(packPath);

    const local = db.getLocalStructuralNodesByType('symbol').map((n) => n.id);
    const all = db.getStructuralNodesByType('symbol').map((n) => n.id);
    expect(local).toEqual(['symbol:php:App\\Foo::bar']);
    expect(all).toContain('symbol:php:App\\Foo::bar');
    expect(all).toContain('symbol:php:Illuminate\\Model::save');
  });
});

describe('transaction wrapper', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    freshDir();
    db = new LuxDatabase(join(testDir, 'project.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('commits all writes in one transaction and returns the callback result', () => {
    const count = db.transaction(() => {
      db.upsertStructuralNode(symbolNode('symbol:php:App\\A::m'));
      db.upsertStructuralNode(symbolNode('symbol:php:App\\B::m'));
      return 2;
    });
    expect(count).toBe(2);
    expect(db.getStructuralNodesByType('symbol')).toHaveLength(2);
  });

  it('rolls back all writes when the callback throws', () => {
    expect(() =>
      db.transaction(() => {
        db.upsertStructuralNode(symbolNode('symbol:php:App\\A::m'));
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(db.getStructuralNodesByType('symbol')).toHaveLength(0);
  });
});

describe('importVendorPack — ATTACH merge (ADR-2)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    freshDir();
    db = new LuxDatabase(join(testDir, 'project.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('imports pack nodes stamped vendor-pack and pack edges, returning counts', () => {
    const packPath = buildPack(
      join(testDir, 'pack.db'),
      [
        symbolNode('symbol:php:Illuminate\\Model::save'),
        symbolNode('symbol:php:Illuminate\\Model::performInsert'),
      ],
      [
        callsEdge(
          'e:save->insert',
          'symbol:php:Illuminate\\Model::save',
          'symbol:php:Illuminate\\Model::performInsert'
        ),
      ]
    );
    const result = db.importVendorPack(packPath);
    expect(result).toEqual({ nodes: 2, edges: 1 });

    const save = db.getStructuralNode('symbol:php:Illuminate\\Model::save');
    expect(save!.origin).toBe('vendor-pack');
    expect(LuxDatabase.isExternalNode(save!)).toBe(true);
    expect(db.getOutgoingStructuralEdges('symbol:php:Illuminate\\Model::save')).toHaveLength(1);
  });

  it('OR IGNORE keeps the local node on an FQN-id collision (app wins)', () => {
    const collidingId = 'symbol:php:App\\Model::save';
    db.upsertStructuralNode(
      symbolNode(collidingId, { file_path: 'app/Model.php', origin: 'local' })
    );
    const packPath = buildPack(
      join(testDir, 'pack.db'),
      [symbolNode(collidingId, { file_path: 'vendor/framework/Model.php' })],
      []
    );
    db.importVendorPack(packPath);

    const node = db.getStructuralNode(collidingId);
    expect(node!.origin).toBe('local');
    expect(node!.file_path).toBe('app/Model.php');
  });

  it('a boundary edge to a not-yet-present node inserts without error (no FK)', () => {
    // Edge whose target node is absent from the pack — mirrors an app->vendor
    // boundary edge landing before/without its pack node. Must not error.
    const packPath = buildPack(
      join(testDir, 'pack.db'),
      [symbolNode('symbol:php:Illuminate\\Model::save')],
      [
        callsEdge(
          'e:dangling',
          'symbol:php:Illuminate\\Model::save',
          'symbol:php:Illuminate\\Missing::gone'
        ),
      ]
    );
    expect(() => db.importVendorPack(packPath)).not.toThrow();
    const out = db.getOutgoingStructuralEdges('symbol:php:Illuminate\\Model::save');
    expect(out.map((e) => e.id)).toContain('e:dangling');
  });

  it('re-merges idempotently after clearOverlay (the recurring merge)', () => {
    const packPath = buildPack(
      join(testDir, 'pack.db'),
      [symbolNode('symbol:php:Illuminate\\Model::save')],
      []
    );
    db.importVendorPack(packPath);
    expect(db.getStructuralNodesByType('symbol')).toHaveLength(1);

    db.clearOverlay();
    expect(db.getStructuralNodesByType('symbol')).toHaveLength(0);

    const second = db.importVendorPack(packPath);
    expect(second.nodes).toBe(1);
    expect(db.getStructuralNode('symbol:php:Illuminate\\Model::save')!.origin).toBe('vendor-pack');
  });
});

describe('findStructuralSymbolNodes — trace start resolution (ADR-5)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    freshDir();
    db = new LuxDatabase(join(testDir, 'project.db'));
    db.upsertStructuralNode(
      symbolNode('symbol:php:App\\Http\\Controllers\\FooController::store', {
        qualified_name: 'App\\Http\\Controllers\\FooController::store',
        symbol_name: 'store',
      })
    );
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('resolves by exact id, by FQN, and by leaf name', () => {
    expect(
      db.findStructuralSymbolNodes('symbol:php:App\\Http\\Controllers\\FooController::store')
    ).toHaveLength(1);
    expect(
      db.findStructuralSymbolNodes('App\\Http\\Controllers\\FooController::store')
    ).toHaveLength(1);
    expect(db.findStructuralSymbolNodes('store').map((n) => n.symbol_name)).toContain('store');
  });

  it('ranks local nodes above vendor-pack nodes for the same leaf', () => {
    const packPath = buildPack(
      join(testDir, 'pack.db'),
      [
        symbolNode('symbol:php:Illuminate\\Other::store', {
          qualified_name: 'Illuminate\\Other::store',
          symbol_name: 'store',
        }),
      ],
      []
    );
    db.importVendorPack(packPath);
    const results = db.findStructuralSymbolNodes('store');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The local FooController::store must rank first (origin='local' tiebreak).
    expect(results[0].origin).toBe('local');
  });
});
