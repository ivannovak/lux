// src/scanner/pack/facade-resolve.ts
//
// Facade & bare-helper resolution (structural step 8c) — sibling of external-resolve.ts.
//
// Laravel's two most idiomatic ways of calling the framework route through container
// indirection that textDocument/definition cannot follow, so they are invisible to the
// shipped typed-receiver pass (step 8b):
//
//   - facade static calls   — `Cache::get()`, routed through Facade::__callStatic to a
//     container-bound service, then __call-forwarded to a driver.
//   - bare framework helpers — `cache()`, `config()`: global functions in the framework's
//     helpers.php that resolve a container service. Not imported, so app-side AST has no
//     binding to follow.
//
// This pass matches those two call classes against two data catalogs (CORE_FACADES /
// FRAMEWORK_HELPERS) and — resolving to the DRIVER method the call actually reaches
// (ADR-2) — emits a `framework-inferred` `calls` boundary edge into the merged vendor
// pack (origin='vendor-pack'), from which the shipped trace primitive continues into
// vendor. The edges are honestly labelled second-tier: confidence 0.6, confidenceClass
// 'framework-inferred', discriminated by provenance.evidenceKind 'facade-catalog' |
// 'helper-catalog' (ADR-5). They are never 'proven' — a default-binding inference, not
// an LSP-confirmed resolution.
//
// Purely syntactic (like ast/resolver.ts): there is nothing for LSP to follow, so a
// catalog match IS the resolution. Runs after the step 8a merge (service/driver nodes
// present) and after step 8b, so a call-site already resolved 'proven' is not re-covered
// — the __callStatic-only catalog (ADR-7) keeps the two passes disjoint by construction
// (§9).

import { LuxDatabase } from '../../db/index.js';
import { phpSymbolNodeId } from '../associations/types.js';
import type { StructuralRelationEdge } from '../associations/types.js';
import { astSymbolIdentity } from '../ast/symbols.js';
import type { SymbolIdCollisions } from '../identity/symbol-collisions.js';
import type { AstNode, Extraction } from '../ast/extract.js';

// ---------------------------------------------------------------------------
// Catalog shapes
// ---------------------------------------------------------------------------

/**
 * One __callStatic-fronted facade and the container chain a static call on it
 * traverses at runtime. `driver`/`contract` drive the resolution order (ADR-2) so
 * an edge lands on the method node that CONTINUES into vendor, not the 0-outgoing
 * manager class node.
 */
export interface FacadeEntry {
  /** The `use` import FQN — the resolution key (ADR-3). e.g. 'Illuminate\\Support\\Facades\\Cache'. */
  facade: string;
  /** getFacadeAccessor() value — documentation/keying only; NOT resolved. */
  accessor: string;
  /** Default-bound manager/singleton. e.g. 'Illuminate\\Cache\\CacheManager'. */
  service: string;
  /** Where the manager __call-forwards (or a facade-root's primary trait); the method-level continuation. Omitted when the service itself carries the methods (e.g. Log). */
  driver?: string;
  /** Interface fallback (present but usually 0-outgoing). */
  contract?: string;
}

/**
 * One bare framework helper. `method` is the TARGET method the helper invokes —
 * NOT the helper name (`event()` targets `dispatch`; ADR-8). `service: null` marks
 * a non-container utility helper (`collect()`, `now()`) that emits nothing.
 */
export interface HelperEntry {
  /** Global helper function name. e.g. 'event'. */
  helper: string;
  /** Class owning the target method, or null for a utility helper. */
  service: string | null;
  /** Target method on `service`; null iff `service` is null. */
  method: string | null;
}

// ---------------------------------------------------------------------------
// CORE_FACADES — ~42 __callStatic facades (verified against the merged pack, §3)
// ---------------------------------------------------------------------------

export const CORE_FACADES: FacadeEntry[] = [
  {
    facade: 'Illuminate\\Support\\Facades\\App',
    accessor: 'app',
    service: 'Illuminate\\Foundation\\Application',
    contract: 'Illuminate\\Contracts\\Foundation\\Application',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Artisan',
    accessor: 'artisan',
    service: 'Illuminate\\Foundation\\Console\\Kernel',
    contract: 'Illuminate\\Contracts\\Console\\Kernel',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Auth',
    accessor: 'auth',
    service: 'Illuminate\\Auth\\AuthManager',
    driver: 'Illuminate\\Auth\\SessionGuard', // default web guard (multi-driver — ADR-2 trade)
    contract: 'Illuminate\\Contracts\\Auth\\Guard',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Blade',
    accessor: 'blade.compiler',
    service: 'Illuminate\\View\\Compilers\\BladeCompiler',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Broadcast',
    accessor: 'Illuminate\\Contracts\\Broadcasting\\Factory',
    service: 'Illuminate\\Broadcasting\\BroadcastManager',
    contract: 'Illuminate\\Contracts\\Broadcasting\\Factory',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Bus',
    accessor: 'Illuminate\\Contracts\\Bus\\Dispatcher',
    service: 'Illuminate\\Bus\\Dispatcher', // dispatch → DISPATCH_TERMINI (ADR-8)
    contract: 'Illuminate\\Contracts\\Bus\\Dispatcher',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Cache',
    accessor: 'cache',
    service: 'Illuminate\\Cache\\CacheManager',
    driver: 'Illuminate\\Cache\\Repository',
    contract: 'Illuminate\\Contracts\\Cache\\Repository',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Concurrency',
    accessor: 'Illuminate\\Concurrency\\ConcurrencyManager',
    service: 'Illuminate\\Concurrency\\ConcurrencyManager',
    driver: 'Illuminate\\Concurrency\\ProcessDriver',
  }, // default `process` driver
  {
    facade: 'Illuminate\\Support\\Facades\\Config',
    accessor: 'config',
    service: 'Illuminate\\Config\\Repository',
    contract: 'Illuminate\\Contracts\\Config\\Repository',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Cookie',
    accessor: 'cookie',
    service: 'Illuminate\\Cookie\\CookieJar',
    contract: 'Illuminate\\Contracts\\Cookie\\QueueingFactory',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Crypt',
    accessor: 'encrypter',
    service: 'Illuminate\\Encryption\\Encrypter',
    contract: 'Illuminate\\Contracts\\Encryption\\Encrypter',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\DB',
    accessor: 'db',
    service: 'Illuminate\\Database\\DatabaseManager',
    driver: 'Illuminate\\Database\\Connection',
    contract: 'Illuminate\\Database\\ConnectionInterface',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Event',
    accessor: 'events',
    service: 'Illuminate\\Events\\Dispatcher', // dispatch → DISPATCH_TERMINI (ADR-8)
    contract: 'Illuminate\\Contracts\\Events\\Dispatcher',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Exceptions',
    accessor: 'Illuminate\\Contracts\\Debug\\ExceptionHandler',
    service: 'Illuminate\\Foundation\\Exceptions\\Handler',
    contract: 'Illuminate\\Contracts\\Debug\\ExceptionHandler',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\File',
    accessor: 'files',
    service: 'Illuminate\\Filesystem\\Filesystem',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Gate',
    accessor: 'Illuminate\\Contracts\\Auth\\Access\\Gate',
    service: 'Illuminate\\Auth\\Access\\Gate',
    contract: 'Illuminate\\Contracts\\Auth\\Access\\Gate',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Http',
    accessor: 'Illuminate\\Http\\Client\\Factory',
    service: 'Illuminate\\Http\\Client\\Factory',
    driver: 'Illuminate\\Http\\Client\\PendingRequest',
  }, // get/post/withHeaders forward here
  {
    facade: 'Illuminate\\Support\\Facades\\Lang',
    accessor: 'translator',
    service: 'Illuminate\\Translation\\Translator',
    contract: 'Illuminate\\Contracts\\Translation\\Translator',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Log',
    accessor: 'log',
    service: 'Illuminate\\Log\\LogManager', // LogManager declares real info/error/… (no driver hop)
    contract: 'Psr\\Log\\LoggerInterface',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Mail',
    accessor: 'mail.manager',
    service: 'Illuminate\\Mail\\MailManager',
    driver: 'Illuminate\\Mail\\Mailer',
    contract: 'Illuminate\\Contracts\\Mail\\Mailer',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Notification',
    accessor: 'Illuminate\\Contracts\\Notifications\\Dispatcher',
    service: 'Illuminate\\Notifications\\ChannelManager',
    contract: 'Illuminate\\Contracts\\Notifications\\Dispatcher',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Password',
    accessor: 'auth.password',
    service: 'Illuminate\\Auth\\Passwords\\PasswordBrokerManager',
    driver: 'Illuminate\\Auth\\Passwords\\PasswordBroker',
    contract: 'Illuminate\\Contracts\\Auth\\PasswordBroker',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Pipeline',
    accessor: 'Illuminate\\Contracts\\Pipeline\\Hub',
    service: 'Illuminate\\Pipeline\\Pipeline', // then → DISPATCH_TERMINI (ADR-8)
    contract: 'Illuminate\\Contracts\\Pipeline\\Pipeline',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Process',
    accessor: 'Illuminate\\Process\\Factory',
    service: 'Illuminate\\Process\\Factory',
    driver: 'Illuminate\\Process\\PendingProcess',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Queue',
    accessor: 'queue',
    service: 'Illuminate\\Queue\\QueueManager',
    driver: 'Illuminate\\Queue\\SyncQueue', // framework-default connection (multi-driver — ‡)
    contract: 'Illuminate\\Contracts\\Queue\\Queue',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\RateLimiter',
    accessor: 'Illuminate\\Cache\\RateLimiter',
    service: 'Illuminate\\Cache\\RateLimiter',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Redirect',
    accessor: 'redirect',
    service: 'Illuminate\\Routing\\Redirector',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Response',
    accessor: 'Illuminate\\Contracts\\Routing\\ResponseFactory',
    service: 'Illuminate\\Routing\\ResponseFactory',
    contract: 'Illuminate\\Contracts\\Routing\\ResponseFactory',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Route',
    accessor: 'router',
    service: 'Illuminate\\Routing\\Router',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Schedule',
    accessor: 'Illuminate\\Console\\Scheduling\\Schedule',
    service: 'Illuminate\\Console\\Scheduling\\Schedule',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Session',
    accessor: 'session',
    service: 'Illuminate\\Session\\SessionManager',
    driver: 'Illuminate\\Session\\Store',
    contract: 'Illuminate\\Contracts\\Session\\Session',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Storage',
    accessor: 'filesystem',
    service: 'Illuminate\\Filesystem\\FilesystemManager',
    driver: 'Illuminate\\Filesystem\\FilesystemAdapter',
    contract: 'Illuminate\\Contracts\\Filesystem\\Filesystem',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\URL',
    accessor: 'url',
    service: 'Illuminate\\Routing\\UrlGenerator',
    contract: 'Illuminate\\Contracts\\Routing\\UrlGenerator',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Validator',
    accessor: 'validator',
    service: 'Illuminate\\Validation\\Factory',
    contract: 'Illuminate\\Contracts\\Validation\\Factory',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\View',
    accessor: 'view',
    service: 'Illuminate\\View\\Factory',
    contract: 'Illuminate\\Contracts\\View\\Factory',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Vite',
    accessor: 'Illuminate\\Foundation\\Vite',
    service: 'Illuminate\\Foundation\\Vite',
  },
  // --- Re-included 2026-07-17 (never-drop correction, §4b): resolve to their best TIER 1/2/3 node. ---
  {
    facade: 'Illuminate\\Support\\Facades\\Hash',
    accessor: 'hash',
    service: 'Illuminate\\Hashing\\HashManager',
    driver: 'Illuminate\\Hashing\\BcryptHasher', // TIER 1: make(1)/check(2) continue; service HashManager::make is a 0-out leaf
    contract: 'Illuminate\\Contracts\\Hashing\\Hasher',
  },
  {
    facade: 'Illuminate\\Support\\Facades\\Request',
    accessor: 'request',
    service: 'Illuminate\\Http\\Request',
    driver: 'Illuminate\\Http\\Concerns\\InteractsWithInput',
  }, // primary trait in the driver slot: all(4)→TIER 1, input(0)→TIER 2
  {
    facade: 'Illuminate\\Support\\Facades\\Context',
    accessor: 'Illuminate\\Log\\Context\\Repository',
    service: 'Illuminate\\Log\\Context\\Repository',
  }, // get→TIER 2 leaf; push(1)→TIER 1
  {
    facade: 'Illuminate\\Support\\Facades\\Redis',
    accessor: 'redis',
    service: 'Illuminate\\Redis\\RedisManager',
    contract: 'Illuminate\\Contracts\\Redis\\Factory',
  }, // get/set dynamic __call → TIER 3 (RedisManager class); connection(2)→TIER 1
  {
    facade: 'Illuminate\\Support\\Facades\\Date',
    accessor: 'date',
    service: 'Illuminate\\Support\\DateFactory',
  }, // now/parse → Carbon (unmaterialized) → TIER 3 (DateFactory class)
  {
    facade: 'Illuminate\\Support\\Facades\\ParallelTesting',
    accessor: 'Illuminate\\Testing\\ParallelTesting',
    service: 'Illuminate\\Testing\\ParallelTesting',
  }, // test-infra, low value but not dropped: TIER 2/3 (only fires if app code calls it)
];

// ---------------------------------------------------------------------------
// FRAMEWORK_HELPERS — 34 helpers (28 service-backed, verified; 6 utility, §5)
// ---------------------------------------------------------------------------

export const FRAMEWORK_HELPERS: HelperEntry[] = [
  { helper: 'dispatch', service: 'Illuminate\\Bus\\Dispatcher', method: 'dispatch' }, // → DISPATCH_TERMINI
  { helper: 'event', service: 'Illuminate\\Events\\Dispatcher', method: 'dispatch' }, // name≠method (ADR-8)
  { helper: 'broadcast', service: 'Illuminate\\Broadcasting\\BroadcastManager', method: 'event' },
  { helper: 'view', service: 'Illuminate\\View\\Factory', method: 'make' },
  { helper: 'response', service: 'Illuminate\\Routing\\ResponseFactory', method: 'make' }, // arg-dependent (ADR-6)
  { helper: 'redirect', service: 'Illuminate\\Routing\\Redirector', method: 'to' },
  { helper: 'back', service: 'Illuminate\\Routing\\Redirector', method: 'back' },
  { helper: 'route', service: 'Illuminate\\Routing\\UrlGenerator', method: 'route' },
  { helper: 'url', service: 'Illuminate\\Routing\\UrlGenerator', method: 'to' }, // arg-dependent
  { helper: 'config', service: 'Illuminate\\Config\\Repository', method: 'get' }, // arg-dependent (ADR-6)
  { helper: 'cache', service: 'Illuminate\\Cache\\Repository', method: 'get' }, // arg-dependent (ADR-6)
  { helper: 'session', service: 'Illuminate\\Session\\Store', method: 'get' }, // arg-dependent (ADR-6)
  { helper: 'trans', service: 'Illuminate\\Translation\\Translator', method: 'get' },
  { helper: '__', service: 'Illuminate\\Translation\\Translator', method: 'get' },
  { helper: 'logger', service: 'Illuminate\\Log\\LogManager', method: 'debug' }, // arg-dependent (level)
  { helper: 'info', service: 'Illuminate\\Log\\LogManager', method: 'info' },
  { helper: 'logs', service: 'Illuminate\\Log\\LogManager', method: 'channel' },
  { helper: 'validator', service: 'Illuminate\\Validation\\Factory', method: 'make' },
  { helper: 'bcrypt', service: 'Illuminate\\Hashing\\BcryptHasher', method: 'make' }, // recovers Hash (§4b)
  { helper: 'encrypt', service: 'Illuminate\\Encryption\\Encrypter', method: 'encrypt' },
  { helper: 'decrypt', service: 'Illuminate\\Encryption\\Encrypter', method: 'decrypt' },
  { helper: 'cookie', service: 'Illuminate\\Cookie\\CookieJar', method: 'make' },
  { helper: 'app', service: 'Illuminate\\Foundation\\Application', method: 'make' }, // → DISPATCH_TERMINI
  { helper: 'resolve', service: 'Illuminate\\Foundation\\Application', method: 'make' }, // → DISPATCH_TERMINI
  { helper: 'auth', service: 'Illuminate\\Auth\\AuthManager', method: 'guard' }, // representative
  { helper: 'report', service: 'Illuminate\\Foundation\\Exceptions\\Handler', method: 'report' },
  { helper: 'policy', service: 'Illuminate\\Auth\\Access\\Gate', method: 'getPolicyFor' },
  { helper: 'gate', service: 'Illuminate\\Auth\\Access\\Gate', method: 'allows' }, // representative
  // Utility helpers — service:null ⇒ emit nothing (grounding; Decision 9 exclusions).
  { helper: 'abort', service: null, method: null }, // throws HttpException
  { helper: 'collect', service: null, method: null }, // constructs Collection
  { helper: 'now', service: null, method: null }, // constructs Carbon
  { helper: 'today', service: null, method: null }, // constructs Carbon
  { helper: 'str', service: null, method: null }, // Str helper
  { helper: 'value', service: null, method: null }, // pure utility
];

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Facade FQN → entry. Keyed on the `use` import FQN (ADR-3 — never a short name). */
export const FACADE_BY_FQN: ReadonlyMap<string, FacadeEntry> = new Map(
  CORE_FACADES.map((e) => [e.facade, e])
);

/** Helper name → entry (utility helpers included, so a name lookup can short-circuit). */
export const HELPER_BY_NAME: ReadonlyMap<string, HelperEntry> = new Map(
  FRAMEWORK_HELPERS.map((e) => [e.helper, e])
);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Confidence assigned to catalog-asserted (framework-inferred) edges (ADR-5; == AST_CONFIDENCE, resolver.ts:35). */
const CATALOG_CONFIDENCE = 0.6;

/** Resolver name recorded on every catalog edge's provenance. */
const RESOLVER_NAME = 'facade-helper-catalog';

/**
 * The clean static form `Scope::method` — a bare scope, `::`, a method, nothing else.
 * This is the guard that implements ADR-4: a chained call's OUTER segment
 * (`Cache::store('x')->get`, extracted with toRaw `Cache::store('redis')->get`) fails
 * this test, so only the INNER `Scope::method` the extractor already isolated is matched;
 * the outer `->method()` is a separate edge the shipped step 8b handles. A leading `\`
 * (bare root alias, `\Cache::`) also fails it — that 3% tail is Phase 3 (ADR-3 trade).
 */
const CLEAN_STATIC = /^[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Facade base-class methods: Mockery test-double verbs (`shouldReceive`, `spy`, …) and
 * `Facade` utilities (`fake`, `swap`, `getFacadeRoot`, …) that every catalogued facade
 * "inherits" from `Illuminate\Support\Facades\Facade` but which never route to the bound
 * service. On some facades one of these names IS a real service method — e.g.
 * `Illuminate\Http\Client\Factory::fake` (out=7), so `Http::fake()` legitimately resolves
 * TIER 1 — so this set does NOT skip the method wholesale. It only SUPPRESSES the TIER-3
 * class-terminus fallback: `Mail::fake` / `Event::fake` / `Cache::shouldReceive` / `DB::spy`
 * have no service method and would otherwise emit a spurious class edge, violating the
 * "`::fake` produces no edge" bar (ADR-7 / REQ-6). TIER-1/2 real-method resolution is
 * unaffected.
 */
const FACADE_BASE_METHODS = new Set<string>([
  'shouldReceive',
  'shouldNotReceive',
  'shouldHaveReceived',
  'shouldNotHaveReceived',
  'spy',
  'mock',
  'partialMock',
  'expects',
  'swap',
  'fake',
  'isFake',
  'getFacadeRoot',
  'resolved',
  'clearResolvedInstance',
  'clearResolvedInstances',
]);

interface DefRange {
  id: string;
  startByte: number;
  endByte: number;
}

/**
 * Emit `framework-inferred` `calls` boundary edges for facade-static and bare-helper
 * calls across the given PHP files, resolving each against the framework catalogs
 * (REQ-1, REQ-2, REQ-7). `files` are PHP extractions only (the caller filters — §8);
 * `db` is the merged overlay (step 8a); `now` stamps provenance.extractedAt.
 */
export function resolveFacadeAndHelperEdges(
  files: Array<{ relPath: string; extraction: Extraction }>,
  db: LuxDatabase,
  now: number,
  collisions?: SymbolIdCollisions
): StructuralRelationEdge[] {
  // Keyed by edge id so repeat call-sites collapse to one edge while ACCUMULATING every
  // call-site as evidence (e.g. `Redis::get` + `Redis::set` both landing on the one
  // RedisManager TIER-3 class edge keep both locations).
  const byId = new Map<string, StructuralRelationEdge>();

  for (const f of files) {
    const { extraction } = f;

    // Import bindings (ADR-3): facade locals keyed by the parsed `use` FQN — never a
    // bare short name (the measured 44% false-positive land-grab). `importedLocals`
    // additionally guards helpers against a `use function X\config;` shadow of a global
    // helper name.
    const facadeByLocal = new Map<string, FacadeEntry>();
    const importedLocals = new Set<string>();
    for (const imp of extraction.imports ?? []) {
      importedLocals.add(imp.local);
      const entry = FACADE_BY_FQN.get(imp.imported);
      if (entry) facadeByLocal.set(imp.local, entry);
    }

    const defs = defRanges(f.relPath, extraction, collisions);

    for (const edge of extraction.edges) {
      if (edge.type !== 'call') continue;

      let target: string | null;
      let evidenceKind: 'facade-catalog' | 'helper-catalog';

      if (edge.callKind === 'member') {
        // Facade static: only the clean `Scope::method` form (ADR-4). A member-CALL on a
        // value (`$obj->m`, `parent::m`) or a chain's outer segment fails CLEAN_STATIC or
        // misses facadeByLocal, and is skipped — left to step 8b.
        const raw = edge.toRaw ?? '';
        if (!CLEAN_STATIC.test(raw) || !edge.member) continue;
        const local = raw.slice(0, raw.indexOf('::'));
        const fe = facadeByLocal.get(local);
        if (!fe) continue;
        // A Facade base-method verb (`fake`/`shouldReceive`/`spy`/…) may NOT fall to a
        // TIER-3 class terminus — but if it is a real service method (`Http::fake`) TIER
        // 1/2 still resolves it (ADR-7 / REQ-6).
        target = resolveFacadeTarget(db, fe, edge.member, !FACADE_BASE_METHODS.has(edge.member));
        evidenceKind = 'facade-catalog';
      } else if (edge.callKind === 'identifier') {
        // Bare helper: a global function — never a same-file def or an imported name.
        if (edge.resolvedSameFile) continue; // resolves to a local function, not the helper
        const name = edge.member ?? edge.toRaw;
        if (!name || importedLocals.has(name)) continue;
        const he = HELPER_BY_NAME.get(name);
        if (!he || !he.service) continue; // unknown, or a utility helper (service:null)
        target = resolveHelperTarget(db, he);
        evidenceKind = 'helper-catalog';
      } else {
        continue; // `this` (self/static/$this) — never a facade or helper
      }

      if (!target) continue;

      const source = enclosingDef(defs, edge.range.startByte);
      if (!source || source.id === target) continue;

      const id = `${source.id}→${target}:calls:${evidenceKind}`;
      const existing = byId.get(id);
      if (existing) {
        existing.provenance.evidenceLocations.push({
          filePath: f.relPath,
          line: edge.range.startLine,
          note: target,
        });
        continue;
      }
      byId.set(
        id,
        makeCatalogEdge(id, source.id, target, evidenceKind, f.relPath, edge.range.startLine, now)
      );
    }
  }

  return [...byId.values()];
}

/**
 * Resolve a facade static call `<local>::<member>` to a merged vendor-pack node id in
 * THREE TIERS over the candidate classes service→driver→contract (each present+external;
 * the gate mirrors external-resolve.ts:106-107), never dropping for non-continuation (ADR-2):
 *   TIER 1 — the first candidate `<class>::<member>` that CONTINUES (>=1 outgoing within-vendor
 *            edge). The value case: `Cache::get`→`Repository::get`, and crucially `Hash::make`
 *            →`BcryptHasher::make` — the service leaf `HashManager::make` exists but is 0-out, so
 *            a plain "first that exists" would stop there; TIER 1 skips it for the continuing driver.
 *   TIER 2 — else the first candidate that EXISTS (a real leaf method, e.g. `Context::get`,
 *            `Request::input` via the trait carried in `driver`). Honest terminal visibility.
 *   TIER 3 — else the `<service>` CLASS node, a terminal edge emitted only when no method node
 *            resolves at all (`Redis::get`/`Date::now`, dynamic `__call`) AND `allowClassTerminus`
 *            is set. The caller clears it for Facade base-method verbs (`fake`/`shouldReceive`/…)
 *            so a test double like `Mail::fake()` never fabricates a spurious class edge (ADR-7 /
 *            REQ-6); a base-method name that IS a real service method (`Http::fake`) still resolves
 *            at TIER 1/2, since suppression is TIER-3-only.
 * Null only when nothing present+external is found — the pass then emits no edge (REQ-5).
 */
export function resolveFacadeTarget(
  db: LuxDatabase,
  entry: FacadeEntry,
  member: string,
  allowClassTerminus = true
): string | null {
  const methodCandidates: string[] = [
    `${entry.service}::${member}`,
    ...(entry.driver ? [`${entry.driver}::${member}`] : []),
    ...(entry.contract ? [`${entry.contract}::${member}`] : []),
  ];
  // Method nodes present + external, in service→driver→contract order.
  const present = methodCandidates
    .map((fqn) => phpSymbolNodeId(fqn))
    .filter((id) => isPresentExternal(db, id));

  // TIER 1: first candidate that continues via an edge the default trace actually follows
  // (calls/references — trace.ts:143), matching the acceptance continuation definition.
  const continuing = present.find((id) => continues(db, id));
  if (continuing) return continuing;

  // TIER 2: first existing leaf method — honest terminal, not dropped.
  if (present.length > 0) return present[0];

  // TIER 3: subsystem class node — terminal, only when no method resolved and the member is a
  // real service call (not a Facade base-method test-double verb — ADR-7 / REQ-6).
  if (!allowClassTerminus) return null;
  const classId = phpSymbolNodeId(entry.service);
  return isPresentExternal(db, classId) ? classId : null;
}

/**
 * True when `id` has ≥1 outgoing edge of a type the default trace traverses
 * (`calls`/`references` — trace.ts:143). The continuation probe for TIER 1 (ADR-2 / REQ-1):
 * a node whose only out-edges are of other types would not advance a default trace, so it is
 * not treated as continuing.
 */
function continues(db: LuxDatabase, id: string): boolean {
  return db
    .getOutgoingStructuralEdges(id)
    .some((e) => e.edge_type === 'calls' || e.edge_type === 'references');
}

/**
 * Resolve a bare helper to the merged vendor-pack node id of its TARGET method
 * (`<service>::<method>`), present+external. `method` is the catalogued target — not the
 * call token (ADR-8): `event()`'s method is `dispatch`. Null when absent or a utility
 * helper (service/method null — the caller already filters service:null).
 */
export function resolveHelperTarget(db: LuxDatabase, entry: HelperEntry): string | null {
  if (!entry.service || !entry.method) return null;
  const id = phpSymbolNodeId(`${entry.service}::${entry.method}`);
  return isPresentExternal(db, id) ? id : null;
}

/** True when `id` is a materialized node AND external (origin != 'local'). */
function isPresentExternal(db: LuxDatabase, id: string): boolean {
  const node = db.getStructuralNode(id);
  return node !== null && LuxDatabase.isExternalNode(node);
}

/**
 * Build a catalog edge in the shipped StructuralRelationEdge shape (associations/types.ts:62-81).
 * `calls` / `framework-inferred` / 0.6 / evidenceKind — the honest second-tier label
 * (ADR-5). The evidence location carries the call-site (filePath:line) and the target id
 * (note), matching makeEdge (resolver.ts:337-352) and AssociationEngine.persistEdges.
 */
function makeCatalogEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  evidenceKind: 'facade-catalog' | 'helper-catalog',
  filePath: string,
  line: number,
  now: number
): StructuralRelationEdge {
  return {
    id,
    edgeType: 'calls',
    sourceNodeId,
    targetNodeId,
    sourceLanguage: 'php',
    targetLanguage: 'php',
    confidence: CATALOG_CONFIDENCE,
    confidenceClass: 'framework-inferred',
    provenance: {
      resolver: RESOLVER_NAME,
      evidenceKind,
      evidenceLocations: [{ filePath, line, note: targetNodeId }],
      extractedAt: now,
    },
  };
}

/** PHP def ids with byte spans, for source attribution (astSymbolIdentity — symbols.ts:32). */
function defRanges(
  relPath: string,
  extraction: Extraction,
  collisions?: SymbolIdCollisions
): DefRange[] {
  return extraction.nodes.map((def: AstNode) => ({
    id: astSymbolIdentity(relPath, def, 'php', extraction.namespace, collisions).id,
    startByte: def.range.startByte,
    endByte: def.range.endByte,
  }));
}

/** Innermost def whose byte span contains `byte` (the ast/resolver.ts:308-322 attribution). */
function enclosingDef(defs: DefRange[], byte: number): DefRange | undefined {
  let best: DefRange | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.startByte <= byte && byte < d.endByte) {
      const size = d.endByte - d.startByte;
      if (size < bestSize) {
        best = d;
        bestSize = size;
      }
    }
  }
  return best;
}
