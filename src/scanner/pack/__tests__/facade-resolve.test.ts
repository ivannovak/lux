import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode, EdgeType } from '../../../db/types.js';
import type { AstEdge, AstNode, Extraction, ImportBinding } from '../../ast/extract.js';
import {
  resolveFacadeAndHelperEdges,
  resolveFacadeTarget,
  resolveHelperTarget,
  CORE_FACADES,
  FRAMEWORK_HELPERS,
  FACADE_BY_FQN,
  HELPER_BY_NAME,
} from '../facade-resolve.js';

// Unit tests for the step-8c facade/helper resolver. A small file-backed
// LuxDatabase stands in for the merged overlay: nodes are seeded present/absent,
// external/local, and with or without an outgoing edge so the 3-tier continuation
// branch (ADR-2) is exercised on a real graph. Covers 20-VALIDATION §D.1.

const testDir = mkdtempSync(join(tmpdir(), 'lux-facade-resolve-test-'));

// --- Source-file scaffolding -------------------------------------------------
// One wide-spanning enclosing method attributes every seeded call edge; its
// astSymbolIdentity is the (distinct-from-vendor) edge source.
const NS = 'App\\Http\\Controllers';
const SOURCE_ID = 'symbol:php:App\\Http\\Controllers\\FooController::handle';
const REL_PATH = 'app/Http/Controllers/FooController.php';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function enclosingDef(): AstNode {
  return {
    type: 'method',
    name: 'handle',
    file: REL_PATH,
    container: 'FooController',
    range: {
      startLine: 1,
      startColumn: 0,
      endLine: 9999,
      endColumn: 0,
      startByte: 0,
      endByte: 1_000_000,
    },
  };
}

function callEdge(
  callKind: 'member' | 'identifier' | 'this',
  toRaw: string,
  member?: string,
  extra?: Partial<AstEdge>
): AstEdge {
  return {
    type: 'call',
    fromFile: REL_PATH,
    toRaw,
    range: {
      startLine: 42,
      startColumn: 4,
      endLine: 42,
      endColumn: 20,
      startByte: 500,
      endByte: 520,
    },
    callKind,
    member,
    ...extra,
  };
}

function imp(local: string, imported: string): ImportBinding {
  return { local, imported };
}

const IMPORT = {
  cache: imp('Cache', 'Illuminate\\Support\\Facades\\Cache'),
  log: imp('Log', 'Illuminate\\Support\\Facades\\Log'),
  hash: imp('Hash', 'Illuminate\\Support\\Facades\\Hash'),
  context: imp('Context', 'Illuminate\\Support\\Facades\\Context'),
  request: imp('Request', 'Illuminate\\Support\\Facades\\Request'),
  redis: imp('Redis', 'Illuminate\\Support\\Facades\\Redis'),
  date: imp('Date', 'Illuminate\\Support\\Facades\\Date'),
  schema: imp('Schema', 'Illuminate\\Support\\Facades\\Schema'),
  http: imp('Http', 'Illuminate\\Support\\Facades\\Http'),
  db: imp('DB', 'Illuminate\\Support\\Facades\\DB'),
  mail: imp('Mail', 'Illuminate\\Support\\Facades\\Mail'),
  appCache: imp('Cache', 'App\\Support\\Cache'),
};

function run(
  db: LuxDatabase,
  edges: AstEdge[],
  imports?: ImportBinding[],
  nodes: AstNode[] = [enclosingDef()],
  namespace = NS
) {
  const extraction: Extraction = { nodes, edges, namespace, imports };
  return resolveFacadeAndHelperEdges([{ relPath: REL_PATH, extraction }], db, 1000);
}

// --- DB seeding --------------------------------------------------------------
function putNode(
  db: LuxDatabase,
  id: string,
  origin: StructuralNode['origin'] = 'vendor-pack'
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    language_id: 'php',
    origin,
    updated_at: now(),
  });
}

/** Seed a node AND one outgoing edge of `edgeType`, so getOutgoingStructuralEdges(id) is non-empty. */
function putWithOutEdge(
  db: LuxDatabase,
  id: string,
  edgeType: EdgeType,
  origin: StructuralNode['origin'] = 'vendor-pack'
): void {
  putNode(db, id, origin);
  db.upsertStructuralEdge({
    id: `${id}=>sink:${edgeType}`,
    source_node_id: id,
    target_node_id: 'symbol:php:__sink__',
    edge_type: edgeType,
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
  });
}

/** Seed a node with a `calls` out-edge, so it CONTINUES under the trace's default edge types. */
function putContinuing(
  db: LuxDatabase,
  id: string,
  origin: StructuralNode['origin'] = 'vendor-pack'
): void {
  putWithOutEdge(db, id, 'calls', origin);
}

const S = (fqn: string) => `symbol:php:${fqn}`;

describe('resolveFacadeAndHelperEdges (step 8c)', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(join(testDir, 'project.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Catalog 3-tier resolution (ADR-2, REQ-1) — via resolveFacadeTarget directly
  // and end-to-end through resolveFacadeAndHelperEdges.
  // -------------------------------------------------------------------------
  describe('3-tier facade resolution (ADR-2)', () => {
    const cacheEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Cache')!;
    const logEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Log')!;
    const hashEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Hash')!;
    const contextEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Context')!;
    const requestEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Request')!;
    const redisEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Redis')!;
    const dateEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Date')!;

    it('TIER 1: service method that continues — Log::info → LogManager::info', () => {
      putContinuing(db, S('Illuminate\\Log\\LogManager::info'));
      expect(resolveFacadeTarget(db, logEntry, 'info')).toBe(
        S('Illuminate\\Log\\LogManager::info')
      );
    });

    it('TIER 1: driver method when the manager method is absent — Cache::get → Repository::get', () => {
      // No CacheManager::get node exists (pure __call); the driver Repository::get continues.
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      expect(resolveFacadeTarget(db, cacheEntry, 'get')).toBe(
        S('Illuminate\\Cache\\Repository::get')
      );
    });

    it('TIER 1: skips a present-but-0-out service leaf for the continuing driver — Hash::make → BcryptHasher::make', () => {
      putNode(db, S('Illuminate\\Hashing\\HashManager::make')); // present, 0 out (leaf)
      putContinuing(db, S('Illuminate\\Hashing\\BcryptHasher::make')); // driver, continues
      expect(resolveFacadeTarget(db, hashEntry, 'make')).toBe(
        S('Illuminate\\Hashing\\BcryptHasher::make')
      );
    });

    it('TIER 2: first existing leaf method when none continue — Context::get → Repository::get (0-out)', () => {
      putNode(db, S('Illuminate\\Log\\Context\\Repository::get')); // present, 0 out
      expect(resolveFacadeTarget(db, contextEntry, 'get')).toBe(
        S('Illuminate\\Log\\Context\\Repository::get')
      );
    });

    it('TIER 2: leaf method carried on the trait in the driver slot — Request::input → InteractsWithInput::input', () => {
      // Request::input is absent on the class; the trait method (in the `driver` slot) is the leaf.
      putNode(db, S('Illuminate\\Http\\Concerns\\InteractsWithInput::input')); // present, 0 out
      expect(resolveFacadeTarget(db, requestEntry, 'input')).toBe(
        S('Illuminate\\Http\\Concerns\\InteractsWithInput::input')
      );
    });

    it('TIER 3: subsystem class node when no method resolves — Redis::get → RedisManager', () => {
      // No RedisManager::get / Factory::get method nodes; only the service class exists.
      putNode(db, S('Illuminate\\Redis\\RedisManager'));
      expect(resolveFacadeTarget(db, redisEntry, 'get')).toBe(S('Illuminate\\Redis\\RedisManager'));
    });

    it('TIER 3: subsystem class node — Date::now → DateFactory', () => {
      putNode(db, S('Illuminate\\Support\\DateFactory'));
      expect(resolveFacadeTarget(db, dateEntry, 'now')).toBe(S('Illuminate\\Support\\DateFactory'));
    });

    it('resolves via the contract candidate when only the contract method is present+continuing', () => {
      putContinuing(db, S('Illuminate\\Contracts\\Cache\\Repository::has'));
      expect(resolveFacadeTarget(db, cacheEntry, 'has')).toBe(
        S('Illuminate\\Contracts\\Cache\\Repository::has')
      );
    });

    it('does not drop a facade for non-continuation — returns the best node, never null when something is present', () => {
      putNode(db, S('Illuminate\\Log\\Context\\Repository::get')); // 0-out leaf
      expect(resolveFacadeTarget(db, contextEntry, 'get')).not.toBeNull();
    });

    it('end-to-end: emits one facade-catalog edge to the driver method (Cache::get)', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(db, [callEdge('member', 'Cache::get', 'get')], [IMPORT.cache]);
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceNodeId).toBe(SOURCE_ID);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Cache\\Repository::get'));
    });

    it('TIER-1 counts only trace-traversed edge types: driver (calls) beats a service method whose only out-edge is non-traversed', () => {
      // The SERVICE method has an out-edge, but of a type the default trace never follows
      // (`resolves_service`, not calls/references) — so it must NOT count as continuing. The
      // DRIVER method has a `calls` out-edge and wins at TIER 1. Under a plain `.length>0`
      // continuation probe the service method (0-out-degree > 0) would wrongly win here.
      putWithOutEdge(db, S('Illuminate\\Cache\\CacheManager::get'), 'resolves_service');
      putWithOutEdge(db, S('Illuminate\\Cache\\Repository::get'), 'calls');
      expect(resolveFacadeTarget(db, cacheEntry, 'get')).toBe(
        S('Illuminate\\Cache\\Repository::get')
      );
    });

    it('end-to-end TIER-3: a dynamic Redis::get with only the RedisManager class present emits one facade-catalog edge to the class', () => {
      // `get` is a normal service verb (NOT a Facade base-method), so allowClassTerminus stays
      // true and TIER-3 fires. Guards that a legit dynamic __call still emits end-to-end and
      // that no ordinary verb slipped into FACADE_BASE_METHODS.
      putNode(db, S('Illuminate\\Redis\\RedisManager'));
      const edges = run(db, [callEdge('member', 'Redis::get', 'get')], [IMPORT.redis]);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Redis\\RedisManager'));
      expect(edges[0].provenance.evidenceKind).toBe('facade-catalog');
    });
  });

  // -------------------------------------------------------------------------
  // Import-binding detection (ADR-3, REQ-3)
  // -------------------------------------------------------------------------
  describe('import-binding detection (ADR-3)', () => {
    it('matches Cache::get only when the local binds to the facade FQN', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(db, [callEdge('member', 'Cache::get', 'get')], [IMPORT.cache]);
      expect(edges).toHaveLength(1);
    });

    it('app-class-named Cache negative: local Cache bound to App\\Support\\Cache emits no edge', () => {
      // Cache::get is a real catalogued member and its target IS seeded+continuing, so a
      // short-name matcher WOULD emit here. Binding local `Cache` to App\Support\Cache must
      // suppress it — this fails iff the ADR-3 import-binding guard is removed. Mirrors the
      // positive above (which differs only in the binding FQN).
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(db, [callEdge('member', 'Cache::get', 'get')], [IMPORT.appCache]);
      expect(edges).toHaveLength(0);
    });

    it('unimported Cache:: emits no edge (no bare short-name path)', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(db, [callEdge('member', 'Cache::get', 'get')], []); // no imports at all
      expect(edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Chained-call decomposition (ADR-4, REQ-1)
  // -------------------------------------------------------------------------
  describe('chained-call decomposition (ADR-4)', () => {
    it('matches only the clean Scope::method inner segment; ignores the outer ->method()', () => {
      putContinuing(db, S('Illuminate\\Log\\LogManager::channel'));
      const edges = run(
        db,
        [
          callEdge('member', 'Log::channel', 'channel'), // inner scoped call — matched
          callEdge('member', "Log::channel('import')->info", 'info'), // faithful outer segment — has :: but also (/-> so CLEAN_STATIC rejects it (step 8b's)
        ],
        [IMPORT.log]
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Log\\LogManager::channel'));
    });

    it('ignores a chained outer segment whose toRaw carries call syntax (Cache::store(...)->get)', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(
        db,
        [callEdge('member', "Cache::store('redis')->get", 'get')],
        [IMPORT.cache]
      );
      expect(edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Helper explicit-method (ADR-8, REQ-2)
  // -------------------------------------------------------------------------
  describe('helper explicit-method (ADR-8)', () => {
    it('event() resolves to Dispatcher::dispatch via the entry method, not the absent ::event', () => {
      putNode(db, S('Illuminate\\Events\\Dispatcher::dispatch'));
      putNode(db, S('Illuminate\\Events\\Dispatcher::event')); // even if present, must not be chosen
      const edges = run(db, [callEdge('identifier', 'event', 'event')]);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Events\\Dispatcher::dispatch'));
    });

    it('dispatch() → Bus\\Dispatcher::dispatch', () => {
      putNode(db, S('Illuminate\\Bus\\Dispatcher::dispatch'));
      const edges = run(db, [callEdge('identifier', 'dispatch', 'dispatch')]);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Bus\\Dispatcher::dispatch'));
    });

    it('view() → View\\Factory::make', () => {
      putNode(db, S('Illuminate\\View\\Factory::make'));
      const edges = run(db, [callEdge('identifier', 'view', 'view')]);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\View\\Factory::make'));
    });

    it('resolveHelperTarget uses the entry method (event → dispatch)', () => {
      putNode(db, S('Illuminate\\Events\\Dispatcher::dispatch'));
      const eventEntry = HELPER_BY_NAME.get('event')!;
      expect(resolveHelperTarget(db, eventEntry)).toBe(
        S('Illuminate\\Events\\Dispatcher::dispatch')
      );
    });
  });

  // -------------------------------------------------------------------------
  // Representative method + service:null (ADR-6, REQ-7)
  // -------------------------------------------------------------------------
  describe('representative method (ADR-6)', () => {
    it('arg-dependent cache() resolves to representative Repository::get and emits an edge', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(db, [callEdge('identifier', 'cache', 'cache')]);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Cache\\Repository::get'));
    });

    it('service:null helpers emit nothing — collect(), now()', () => {
      // No DB lookup runs for service:null helpers — they're filtered before resolution
      // (he.service is null), so no seed is possible or needed; this is a pure absence.
      const edges = run(db, [
        callEdge('identifier', 'collect', 'collect'),
        callEdge('identifier', 'now', 'now'),
      ]);
      expect(edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Confidence / provenance (ADR-5, REQ-4)
  // -------------------------------------------------------------------------
  describe('confidence / provenance (ADR-5)', () => {
    it('facade edge is calls / 0.6 / framework-inferred / evidenceKind facade-catalog', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const [edge] = run(db, [callEdge('member', 'Cache::get', 'get')], [IMPORT.cache]);
      expect(edge.edgeType).toBe('calls');
      expect(edge.confidence).toBe(0.6);
      expect(edge.confidenceClass).toBe('framework-inferred');
      expect(edge.provenance.evidenceKind).toBe('facade-catalog');
      expect(edge.sourceLanguage).toBe('php');
      expect(edge.targetLanguage).toBe('php');
      expect(edge.provenance.resolver).toBe('facade-helper-catalog');
      expect(edge.provenance.evidenceLocations[0]).toMatchObject({
        filePath: REL_PATH,
        line: 42,
        note: S('Illuminate\\Cache\\Repository::get'),
      });
    });

    it('helper edge carries evidenceKind helper-catalog', () => {
      putNode(db, S('Illuminate\\Bus\\Dispatcher::dispatch'));
      const [edge] = run(db, [callEdge('identifier', 'dispatch', 'dispatch')]);
      expect(edge.provenance.evidenceKind).toBe('helper-catalog');
      expect(edge.confidenceClass).toBe('framework-inferred');
      expect(edge.confidence).toBe(0.6);
    });
  });

  // -------------------------------------------------------------------------
  // Present + external guard (ADR-2, REQ-5)
  // -------------------------------------------------------------------------
  describe('present + external guard (REQ-5)', () => {
    it('no edge when the target node is absent from the DB (never dangles)', () => {
      const edges = run(db, [callEdge('member', 'Cache::get', 'get')], [IMPORT.cache]);
      expect(edges).toHaveLength(0);
    });

    it('no edge when the node is present but LOCAL (not external)', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'), 'local');
      const edges = run(db, [callEdge('member', 'Cache::get', 'get')], [IMPORT.cache]);
      expect(edges).toHaveLength(0);
    });

    it('skips a source === target self-edge', () => {
      // Enclosing def whose identity equals the resolved target id.
      const selfDef: AstNode = {
        type: 'method',
        name: 'get',
        container: 'Repository',
        file: 'x.php',
        range: {
          startLine: 1,
          startColumn: 0,
          endLine: 9999,
          endColumn: 0,
          startByte: 0,
          endByte: 1_000_000,
        },
      };
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(
        db,
        [callEdge('member', 'Cache::get', 'get')],
        [IMPORT.cache],
        [selfDef],
        'Illuminate\\Cache'
      );
      expect(edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Real-static skip (ADR-7, REQ-6)
  // -------------------------------------------------------------------------
  describe('real-static skip (ADR-7)', () => {
    it('Schema and Facade are absent from CORE_FACADES', () => {
      const fqns = new Set(CORE_FACADES.map((e) => e.facade));
      expect(fqns.has('Illuminate\\Support\\Facades\\Schema')).toBe(false);
      expect(fqns.has('Illuminate\\Support\\Facades\\Facade')).toBe(false);
    });

    it('a Schema::connection call produces no facade-catalog edge', () => {
      putContinuing(db, S('Illuminate\\Database\\Schema\\Builder::connection'));
      const edges = run(
        db,
        [callEdge('member', 'Schema::connection', 'connection')],
        [IMPORT.schema]
      );
      expect(edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test-double / Facade base-method suppression (ADR-7, REQ-6)
  // -------------------------------------------------------------------------
  describe('test-double base-method suppression (ADR-7)', () => {
    it('suppresses the TIER-3 class terminus for base-method verbs even when the service class IS present — DB::shouldReceive, Mail::fake', () => {
      // Seed the service class nodes present+external so the 0-edge result proves SUPPRESSION,
      // not mere absence: without the guard these fall to a spurious TIER-3 class edge.
      putNode(db, S('Illuminate\\Database\\DatabaseManager'));
      putNode(db, S('Illuminate\\Mail\\MailManager'));
      expect(
        run(db, [callEdge('member', 'DB::shouldReceive', 'shouldReceive')], [IMPORT.db])
      ).toHaveLength(0);
      expect(run(db, [callEdge('member', 'Mail::fake', 'fake')], [IMPORT.mail])).toHaveLength(0);
    });

    it('KEEPS a base-method name that is a REAL service method — Http::fake → Factory::fake (TIER 1)', () => {
      // `fake` is a Facade base verb, but Illuminate\Http\Client\Factory::fake is a real
      // continuing method; suppression is TIER-3-only, so this must still emit (over-skip guard).
      putContinuing(db, S('Illuminate\\Http\\Client\\Factory::fake'));
      const edges = run(db, [callEdge('member', 'Http::fake', 'fake')], [IMPORT.http]);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetNodeId).toBe(S('Illuminate\\Http\\Client\\Factory::fake'));
    });

    it('resolveFacadeTarget: allowClassTerminus=false returns null where true returns the class node', () => {
      putNode(db, S('Illuminate\\Cache\\CacheManager')); // service class present, no method candidates
      const cacheEntry = FACADE_BY_FQN.get('Illuminate\\Support\\Facades\\Cache')!;
      expect(resolveFacadeTarget(db, cacheEntry, 'shouldReceive', false)).toBeNull();
      expect(resolveFacadeTarget(db, cacheEntry, 'shouldReceive', true)).toBe(
        S('Illuminate\\Cache\\CacheManager')
      );
    });
  });

  // -------------------------------------------------------------------------
  // Helper false-positive guards (resolvedSameFile / importedLocals)
  // -------------------------------------------------------------------------
  describe('helper false-positive guards', () => {
    it('skips an identifier that resolved to a same-file function (resolvedSameFile)', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const edges = run(db, [callEdge('identifier', 'cache', 'cache', { resolvedSameFile: true })]);
      expect(edges).toHaveLength(0);
    });

    it('skips an identifier whose name is a `use function` import shadow (importedLocals)', () => {
      putContinuing(db, S('Illuminate\\Config\\Repository::get'));
      const edges = run(
        db,
        [callEdge('identifier', 'config', 'config')],
        [imp('config', 'X\\config')]
      );
      expect(edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Dedup & evidence accumulation (the byId key; optional-9 accumulation)
  // -------------------------------------------------------------------------
  describe('dedup & evidence accumulation', () => {
    it('two identical Cache::get sites in one method → exactly 1 edge carrying both call-sites as evidence', () => {
      putContinuing(db, S('Illuminate\\Cache\\Repository::get'));
      const secondSite: Partial<AstEdge> = {
        range: {
          startLine: 43,
          startColumn: 4,
          endLine: 43,
          endColumn: 20,
          startByte: 600,
          endByte: 620,
        },
      };
      const edges = run(
        db,
        [
          callEdge('member', 'Cache::get', 'get'),
          callEdge('member', 'Cache::get', 'get', secondSite),
        ],
        [IMPORT.cache]
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].provenance.evidenceLocations).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Catalog shape guards (ADR-1) — keep the data exports honest & "used".
  // -------------------------------------------------------------------------
  describe('catalog contract (ADR-1)', () => {
    it('CORE_FACADES has ~42 rows and every facade FQN is under Illuminate\\Support\\Facades', () => {
      expect(CORE_FACADES.length).toBe(42);
      for (const e of CORE_FACADES) {
        expect(e.facade.startsWith('Illuminate\\Support\\Facades\\')).toBe(true);
        expect(e.service.length).toBeGreaterThan(0);
      }
    });

    it('FRAMEWORK_HELPERS has 34 rows; every service-backed helper has a method, every null-service has null method', () => {
      expect(FRAMEWORK_HELPERS.length).toBe(34);
      for (const h of FRAMEWORK_HELPERS) {
        if (h.service === null) expect(h.method).toBeNull();
        else expect(h.method && h.method.length > 0).toBe(true);
      }
    });

    it("event's target method is dispatch, not its own name (ADR-8)", () => {
      const eventEntry = HELPER_BY_NAME.get('event');
      expect(eventEntry).toBeDefined();
      expect(eventEntry?.method).toBe('dispatch');
      expect(eventEntry?.service).toBe('Illuminate\\Events\\Dispatcher');
    });
  });
});
