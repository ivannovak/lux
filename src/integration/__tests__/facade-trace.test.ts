import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { generalScan } from '../../scanner/general.js';
import { LuxDatabase } from '../../db/index.js';
import { loadLspConfig } from '../../scanner/config.js';
import { VendorPackWriter, PACK_FORMAT_VERSION } from '../../scanner/pack/pack-format.js';
import { resolveStartNode, traceFrom } from '../../scanner/associations/trace.js';
import type { StructuralNode, StructuralEdge } from '../../db/types.js';

// Integration coverage for the step-8c facade/helper pass (20-VALIDATION §D.2).
//
// A synthetic vendor pack (self-contained; no LSP, no example-app) stands in for the
// merged Laravel graph: it materializes the driver-method targets a facade static
// reaches (`Cache::get`→`Repository::get`, `DB::table`→`Connection::table`) each
// with one within-vendor out-edge so the trace can CONTINUE ≥1 hop. generalScan is
// then run overlay-enabled with that pack merged, exercising the real step-8c path
// (resolveFacadeAndHelperEdges → AssociationEngine.persistEdges) on the always-on
// AST tier (config default: lsp disabled, ast enabled), and the resulting overlay
// is traced to assert:
//   G1 — `Cache::get`  → `Illuminate\Cache\Repository::get`   (facade-catalog, 0.6) that continues to `Store::get`.
//   G2 — `DB::table`   → `Illuminate\Database\Connection::table` (facade-catalog, 0.6) that continues to `Query\Builder::from`.
//   G4 — `--min-confidence proven` excludes every facade-catalog edge (proven layer undiluted).

const testDir = mkdtempSync(join(tmpdir(), 'lux-facade-trace-test-'));
const S = (fqn: string): string => `symbol:php:${fqn}`;
const now = (): number => Math.floor(Date.now() / 1000);

const CACHE_GET = S('Illuminate\\Cache\\Repository::get');
const CACHE_STORE_GET = S('Illuminate\\Contracts\\Cache\\Store::get');
const DB_TABLE = S('Illuminate\\Database\\Connection::table');
const QUERY_FROM = S('Illuminate\\Database\\Query\\Builder::from');
const SOURCE = 'App\\Http\\Controllers\\FooController::index';

function vnode(id: string): StructuralNode {
  return {
    id,
    node_type: 'symbol',
    language_id: 'php',
    symbol_name: id.replace('symbol:php:', ''),
    symbol_kind: 'method',
    origin: 'vendor-pack',
    updated_at: now(),
  };
}

/** A within-vendor `calls` edge (proven) so its source node CONTINUES ≥1 hop. */
function vedge(src: string, tgt: string): StructuralEdge {
  return {
    id: `${src}=>${tgt}:calls:vendor`,
    source_node_id: src,
    target_node_id: tgt,
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
  };
}

/** Write a self-contained synthetic vendor pack with the driver-method targets. */
function buildSyntheticPack(packPath: string): void {
  const nodes = [vnode(CACHE_GET), vnode(CACHE_STORE_GET), vnode(DB_TABLE), vnode(QUERY_FROM)];
  const edges = [vedge(CACHE_GET, CACHE_STORE_GET), vedge(DB_TABLE, QUERY_FROM)];
  const writer = new VendorPackWriter(packPath);
  writer.write(nodes, edges);
  writer.finalize({
    formatVersion: PACK_FORMAT_VERSION,
    keyScheme: 'composer-lock',
    key: 'facade-trace-test',
    framework: 'laravel/framework@test',
    depth: 'ast-only',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    buildDurationMs: 0,
    builtAt: now(),
    luxVersion: 'test',
  });
}

function writeAppFixture(): void {
  mkdirSync(join(testDir, 'app', 'Http', 'Controllers'), { recursive: true });
  // Marker so the dir is a recognizable source repo.
  writeFileSync(join(testDir, 'composer.json'), '{"name":"test/facade-trace"}');
  writeFileSync(
    join(testDir, 'app', 'Http', 'Controllers', 'FooController.php'),
    `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Support\\Facades\\Cache;
use Illuminate\\Support\\Facades\\DB;

class FooController
{
    public function index()
    {
        $ttl = Cache::get('rate:limit');
        $rows = DB::table('users');

        return [$ttl, $rows];
    }
}
`
  );
}

describe('Facade/helper trace integration (step 8c, §D.2)', () => {
  const packPath = join(testDir, 'pack', 'pack-v1.db');
  const dbPath = join(testDir, 'lux.db');
  let db: LuxDatabase;

  beforeEach(async () => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeAppFixture();
    buildSyntheticPack(packPath);
    db = new LuxDatabase(dbPath);
    await generalScan(testDir, {
      config: loadLspConfig(testDir),
      db,
      overlayEnabled: true,
      vendorPackPath: packPath,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function startId(): string {
    const resolved = resolveStartNode(db, SOURCE);
    if (!('nodeId' in resolved)) throw new Error(`start symbol not materialized: ${SOURCE}`);
    return resolved.nodeId;
  }

  it('emits framework-inferred facade-catalog edges to the driver methods (REQ-1, REQ-4)', () => {
    const outs = db.getOutgoingStructuralEdges(startId());

    const cacheEdge = outs.find((e) => e.target_node_id === CACHE_GET);
    expect(cacheEdge, 'Cache::get → Repository::get edge').toBeDefined();
    expect(cacheEdge!.confidence_class).toBe('framework-inferred');
    expect(cacheEdge!.confidence).toBeCloseTo(0.6);
    expect(cacheEdge!.id).toContain('facade-catalog');

    const dbEdge = outs.find((e) => e.target_node_id === DB_TABLE);
    expect(dbEdge, 'DB::table → Connection::table edge').toBeDefined();
    expect(dbEdge!.confidence_class).toBe('framework-inferred');
    expect(dbEdge!.id).toContain('facade-catalog');

    // Every catalog edge lands on a present, external vendor node (REQ-5, no dangle).
    for (const e of outs.filter((e) => e.id.includes('facade-catalog'))) {
      const target = db.getStructuralNode(e.target_node_id);
      expect(target, `target ${e.target_node_id} present`).not.toBeNull();
      expect(LuxDatabase.isExternalNode(target!)).toBe(true);
    }
  });

  it('G1: Cache::get resolves to Repository::get and the trace continues ≥1 hop', () => {
    const result = traceFrom(db, startId(), {
      maxDepth: 5,
      minConfidenceClass: 'framework-inferred',
      includeExternal: true,
    });
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(ids.has(CACHE_GET), 'facade target Repository::get reached').toBe(true);
    expect(ids.has(CACHE_STORE_GET), 'continued ≥1 hop to Store::get').toBe(true);
  });

  it('G2: DB::table resolves to Connection::table and advances to Query\\Builder::from', () => {
    const result = traceFrom(db, startId(), {
      maxDepth: 5,
      minConfidenceClass: 'framework-inferred',
      includeExternal: true,
    });
    const ids = new Set(result.nodes.map((n) => n.id));
    expect(ids.has(DB_TABLE), 'facade target Connection::table reached').toBe(true);
    expect(ids.has(QUERY_FROM), 'advanced to Query\\Builder::from').toBe(true);
  });

  it('G4: --min-confidence proven excludes every facade-catalog edge (proven layer undiluted)', () => {
    const proven = traceFrom(db, startId(), {
      maxDepth: 5,
      minConfidenceClass: 'proven',
      includeExternal: true,
    });
    const ids = new Set(proven.nodes.map((n) => n.id));
    // The 0.6 facade edges are below the proven bar, so the driver methods are unreachable.
    expect(ids.has(CACHE_GET)).toBe(false);
    expect(ids.has(DB_TABLE)).toBe(false);
    // And no catalog edge appears in the proven edge set at all.
    expect(proven.edges.some((e) => /facade-catalog|helper-catalog/.test(e.id))).toBe(false);
  });
});
