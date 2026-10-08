import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import {
  runAnchorSearch,
  __setReadPathEmbedderFactoryForTests,
} from '../../../cli/anchor-search.js';
import { StubEmbedder } from '../../embeddings/__tests__/stub-embedder.js';
import { encodeVector } from '../../embeddings/codec.js';
import { ANCHOR_EMBED_MODEL, ANCHOR_EMBED_MODEL_ARTIFACTS } from '../../embeddings/model-pin.js';

// Phase 3 (spec 17 / T3.6): the semantic-half wiring into runAnchorSearch. These tests drive the REAL
// read path (query embed → topCosine → cosine floor → fuseRrf) network-free by injecting a
// deterministic StubEmbedder through the read-path test seam. The stub is symmetric and hash-seeded:
// stub.embedQuery(Q) === stub.embed([Q])[0], so seeding a node's stored vector to the stub's embedding
// of text T makes that node an EXACT (cosine ~1.0) semantic neighbour of the query T, and any other
// query lands near cosine 0 (well under ANCHOR_MIN_COSINE). That is the only lever the stub gives — it
// carries no real relatedness — which is exactly enough to exercise fusion/floor/provenance.

const CH = 'a'.repeat(64); // one shared content hash — freshness is exercised elsewhere (D5 tests).

/** Split an identifier into lowercased tokens the way the index tokenizer does (mirrors the Phase-1
 *  lexical fixture) so seeded anchor text matches lexically on real terms. */
const split = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const toks = (s: string): string => split(s).join(' ').toLowerCase();

interface SeedNode {
  id: string;
  name: string;
  qualified: string;
  path: string;
  context: string;
}

function seedNode(db: LuxDatabase, n: SeedNode): void {
  db.upsertStructuralNode({
    id: n.id,
    node_type: 'symbol',
    file_path: n.path,
    language_id: 'php',
    symbol_name: n.name,
    symbol_kind: 'Class',
    qualified_name: n.qualified,
    updated_at: Math.floor(Date.now() / 1000),
  });
  db.upsertNodeAnchorText({
    node_id: n.id,
    prepared: `Class ${n.name} — ${n.qualified} (${n.path})\n${n.context}`,
    content_hash: CH,
    name: n.name,
    identifiers: split(n.name)
      .map((s) => s.toLowerCase())
      .join(' '),
    qualified: toks(n.qualified),
    path_segments: toks(n.path.replace(/\.[a-z]+$/i, '')),
    context: n.context.toLowerCase(),
  });
}

/** Seed a stored PASSAGE embedding for `nodeId` equal to the stub's embedding of `conceptText`. A read
 *  query of `conceptText` then scores this node at cosine ~1.0 (identical vectors); any other query
 *  scores it near 0. `content_hash === CH` matches the text row so coverage counts it as fresh. */
async function seedEmbeddingFor(
  db: LuxDatabase,
  stub: StubEmbedder,
  nodeId: string,
  conceptText: string
): Promise<void> {
  const [vec] = await stub.embed([conceptText]);
  db.upsertNodeEmbedding({
    node_id: nodeId,
    model: ANCHOR_EMBED_MODEL,
    dims: vec.length,
    vector: encodeVector(vec),
    content_hash: CH,
  });
}

// A realistic payment-domain corpus (mirrors anchor-search.test.ts's SEED) — enough nodes that a
// name/identifier query lands a strongly-negative bm25, the same IDF the lexical-only SC-Confidence
// test calibrates 'stripe service' → lowConfidence:false against. Used by the regression below to prove
// a populated-but-below-floor vector plane does NOT flip a strong lexical top to lowConfidence.
const PAYMENT_CORPUS: SeedNode[] = [
  {
    id: 'symbol:php:App\\Contracts\\PaymentGateway',
    name: 'PaymentGateway',
    qualified: 'App\\Contracts\\PaymentGateway',
    path: 'app/Contracts/PaymentGateway.php',
    context: 'interface PaymentGateway defines the payment contract for charge and refund',
  },
  {
    id: 'symbol:php:App\\Services\\Payments\\StripeService',
    name: 'StripeService',
    qualified: 'App\\Services\\Payments\\StripeService',
    path: 'app/Services/Payments/StripeService.php',
    context: 'class StripeService implements PaymentGateway handles stripe charge and settlement',
  },
  {
    id: 'symbol:php:App\\Services\\Payments\\BraintreeService',
    name: 'BraintreeService',
    qualified: 'App\\Services\\Payments\\BraintreeService',
    path: 'app/Services/Payments/BraintreeService.php',
    context: 'class BraintreeService implements PaymentGateway handles braintree charge',
  },
  {
    id: 'symbol:php:App\\Services\\Payments\\AnetService',
    name: 'AnetService',
    qualified: 'App\\Services\\Payments\\AnetService',
    path: 'app/Services/Payments/AnetService.php',
    context: 'class AnetService implements PaymentGateway authorize net gateway',
  },
  {
    id: 'symbol:php:App\\Services\\Settlement\\splitByPlatform',
    name: 'splitByPlatform',
    qualified: 'App\\Services\\Settlement\\SettlementService::splitByPlatform',
    path: 'app/Services/Settlement/SettlementService.php',
    context: 'public function splitByPlatform divides proceeds among sellers',
  },
  {
    id: 'symbol:php:App\\Mail\\EmailEventRegistrants',
    name: 'EmailEventRegistrants',
    qualified: 'App\\Mail\\EmailEventRegistrants',
    path: 'app/Mail/EmailEventRegistrants.php',
    context: 'class EmailEventRegistrants mailable notifies event registrants',
  },
  {
    id: 'symbol:php:App\\Models\\User',
    name: 'User',
    qualified: 'App\\Models\\User',
    path: 'app/Models/User.php',
    context: 'class User eloquent model for an application user',
  },
  {
    id: 'symbol:php:App\\Models\\Order',
    name: 'Order',
    qualified: 'App\\Models\\Order',
    path: 'app/Models/Order.php',
    context: 'class Order represents a customer order with line items',
  },
  {
    id: 'symbol:php:App\\Http\\Controllers\\OrderController',
    name: 'OrderController',
    qualified: 'App\\Http\\Controllers\\OrderController',
    path: 'app/Http/Controllers/OrderController.php',
    context: 'class OrderController handles order http requests',
  },
  {
    id: 'symbol:php:App\\Jobs\\SendInvoice',
    name: 'SendInvoice',
    qualified: 'App\\Jobs\\SendInvoice',
    path: 'app/Jobs/SendInvoice.php',
    context: 'class SendInvoice queued job emails an invoice to the customer',
  },
  {
    id: 'symbol:php:App\\Support\\Money',
    name: 'Money',
    qualified: 'App\\Support\\Money',
    path: 'app/Support/Money.php',
    context: 'class Money value object wraps an amount and currency',
  },
  {
    id: 'symbol:php:App\\Services\\Catalog\\ProductService',
    name: 'ProductService',
    qualified: 'App\\Services\\Catalog\\ProductService',
    path: 'app/Services/Catalog/ProductService.php',
    context: 'class ProductService manages the product catalog',
  },
];

// FILE-LEVEL token neutralization. Every block below asserts the LOCAL bge model is active (seeded
// vectors + the real-weights smoke all key on ANCHOR_EMBED_MODEL). A developer machine that exports
// LUX_EMBEDDING_TOKEN would otherwise flip activeModel to the API space (`openai:…`) and read 0 coverage
// against the bge-seeded vectors — failing the whole suite in one shell state. This top-level hook runs
// before EVERY test in the file (ahead of each describe's own beforeEach), so the anchors suite is green
// in BOTH shell states (token set and unset).
let __fileSavedEmbeddingToken: string | undefined;
beforeEach(() => {
  __fileSavedEmbeddingToken = process.env.LUX_EMBEDDING_TOKEN;
  delete process.env.LUX_EMBEDDING_TOKEN;
});
afterEach(() => {
  if (__fileSavedEmbeddingToken === undefined) delete process.env.LUX_EMBEDDING_TOKEN;
  else process.env.LUX_EMBEDDING_TOKEN = __fileSavedEmbeddingToken;
});

describe('runAnchorSearch — semantic half (Phase 3 / T3.6, StubEmbedder, network-free)', () => {
  let dir: string;
  let db: LuxDatabase;
  let stub: StubEmbedder;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchor-sem-'));
    db = new LuxDatabase(join(dir, 'test.db'));
    // The stub MUST report the active model id: the coverage gate reads ANCHOR_EMBED_MODEL and
    // topCosine scans embedder.model — both must line up for the seeded vectors to be found.
    stub = new StubEmbedder({ model: ANCHOR_EMBED_MODEL });
    __setReadPathEmbedderFactoryForTests(() => Promise.resolve(stub));
  });
  afterEach(() => {
    __setReadPathEmbedderFactoryForTests(null); // restore production factory + cached-only gate + memo
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fuses lexical + semantic: both-hit outranks single-modality, semantic-only surfaces, provenance flows', async () => {
    const A = 'symbol:php:App\\Contracts\\PaymentGateway'; // lexical (gateway) + semantic → BOTH
    const B = 'symbol:php:App\\Services\\Settlement\\splitByPlatform'; // semantic-only
    const C = 'symbol:php:App\\Services\\ChargeLogger'; // lexical-only (charge)
    const D = 'symbol:php:App\\Models\\User'; // neither → absent
    seedNode(db, {
      id: A,
      name: 'PaymentGateway',
      qualified: 'App\\Contracts\\PaymentGateway',
      path: 'app/Contracts/PaymentGateway.php',
      context: 'interface gateway charge and refund contract',
    });
    seedNode(db, {
      id: B,
      name: 'splitByPlatform',
      qualified: 'App\\Services\\Settlement\\SettlementService::splitByPlatform',
      path: 'app/Services/Settlement/SettlementService.php',
      context: 'divides proceeds among sellers',
    });
    seedNode(db, {
      id: C,
      name: 'ChargeLogger',
      qualified: 'App\\Services\\ChargeLogger',
      path: 'app/Services/ChargeLogger.php',
      context: 'logs a charge event to the audit trail',
    });
    seedNode(db, {
      id: D,
      name: 'User',
      qualified: 'App\\Models\\User',
      path: 'app/Models/User.php',
      context: 'eloquent user model for an application user',
    });

    const Q = 'gateway charge';
    await seedEmbeddingFor(db, stub, A, Q); // A is a perfect semantic neighbour of Q AND matches lexically
    await seedEmbeddingFor(db, stub, B, Q); // B is a perfect semantic neighbour of Q, no lexical match

    const { results, coverage, lowConfidence } = await runAnchorSearch(db, Q, { limit: 10 });
    const byId = new Map(results.map((r) => [r.nodeId, r]));

    // Both-modality top hit: highest fused score (two RRF contributions), full provenance.
    expect(results[0].nodeId).toBe(A);
    expect(results[0].matchedVia).toBe('both');
    expect(typeof results[0].lexicalRank).toBe('number');
    expect(results[0].cosine).toBeGreaterThan(0.99);

    // Semantic-only hit: present, matchedVia 'semantic', cosine populated, NO lexicalRank; its metadata
    // resolved through the (now-live) db.getStructuralNode else-branch.
    expect(byId.has(B)).toBe(true);
    expect(byId.get(B)!.matchedVia).toBe('semantic');
    expect(byId.get(B)!.cosine).toBeGreaterThan(0.99);
    expect(byId.get(B)!.lexicalRank).toBeUndefined();
    expect(byId.get(B)!.symbolName).toBe('splitByPlatform'); // real metadata, not the id fallback

    // Lexical-only hit stays lexical; the both-hit ranks strictly above every single-modality hit.
    expect(byId.get(C)!.matchedVia).toBe('lexical');
    expect(results[0].fusedScore).toBeGreaterThan(byId.get(B)!.fusedScore);
    expect(results[0].fusedScore).toBeGreaterThan(byId.get(C)!.fusedScore);

    // The un-embedded, non-matching node never appears.
    expect(byId.has(D)).toBe(false);

    // Coverage now reports the active model + the real embedded count (A, B).
    expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
    expect(coverage.embeddedNodes).toBe(2);
    expect(coverage.anchorViableNodes).toBe(4);

    // Hybrid confidence floor (ANCHOR_MIN_FUSED_SCORE=0.025) engages and a genuine both-modality top hit
    // (fused ~2/61 ≈ 0.0328) clears it — NOT flagged. Direct evidence the floor is sound for a real hit.
    expect(lowConfidence).toBe(false);
    expect(results[0].fusedScore).toBeGreaterThan(0.025);
  });

  it('hybrid floor flags a semantic-only top hit with no lexical corroboration (single-modality ~1/61 < 0.025)', async () => {
    // Only a semantic-only hit exists: its fused score is a single RRF term 1/61 ≈ 0.0164 < 0.025, so
    // the hybrid floor sets lowConfidence:true. This is the OTHER side of the 0.025 calibration — a
    // one-modality top reads as low-confidence while a both-modality top (previous test) does not.
    const B = 'symbol:php:App\\Services\\Settlement\\splitByPlatform';
    seedNode(db, {
      id: B,
      name: 'splitByPlatform',
      qualified: 'App\\Services\\Settlement\\SettlementService::splitByPlatform',
      path: 'app/Services/Settlement/SettlementService.php',
      context: 'divides proceeds among sellers',
    });
    const Q = 'seller payouts';
    await seedEmbeddingFor(db, stub, B, Q); // semantic-only (no lexical overlap with the query)

    const { results, lowConfidence } = await runAnchorSearch(db, Q, { limit: 10 });
    expect(results[0].nodeId).toBe(B);
    expect(results[0].matchedVia).toBe('semantic');
    expect(results[0].fusedScore).toBeLessThan(0.025);
    expect(lowConfidence).toBe(true);
  });

  it('cuts a below-ANCHOR_MIN_COSINE candidate from the semantic list (0.4 floor)', async () => {
    const X = 'symbol:php:App\\Support\\ZebraHelper';
    seedNode(db, {
      id: X,
      name: 'ZebraHelper',
      qualified: 'App\\Support\\ZebraHelper',
      path: 'app/Support/ZebraHelper.php',
      context: 'an unrelated internal helper',
    });
    // X's stored vector matches ONLY the concept "alpha alpha alpha".
    await seedEmbeddingFor(db, stub, X, 'alpha alpha alpha');

    // Control: querying its own concept surfaces X via semantic (cosine ~1.0 clears the floor). X does
    // not match "alpha ..." lexically (name/context carry no such token), so it is semantic-only.
    const hit = await runAnchorSearch(db, 'alpha alpha alpha', { limit: 10 });
    expect(hit.results.map((r) => r.nodeId)).toContain(X);
    expect(hit.results.find((r) => r.nodeId === X)!.matchedVia).toBe('semantic');
    expect(hit.coverage.model).toBe(ANCHOR_EMBED_MODEL); // the semantic half genuinely ran

    // An orthogonal query scores X near cosine 0 (< 0.4) → dropped from the semantic list; with no
    // lexical match either, X is absent from results. The coverage.model still proves the half ran, so
    // the drop is the cosine floor at work, not a skipped/unavailable semantic half.
    const miss = await runAnchorSearch(db, 'gamma gamma gamma', { limit: 10 });
    expect(miss.results.map((r) => r.nodeId)).not.toContain(X);
    expect(miss.coverage.model).toBe(ANCHOR_EMBED_MODEL);
  });

  it('a below-floor vector plane does NOT flip a strong lexical top to lowConfidence (mode keys on contribution, not presence)', async () => {
    // Regression for the confidence-mode selector: when the semantic half RUNS but every candidate
    // falls below ANCHOR_MIN_COSINE, the semantic list is [] and the fused ranking is pure-lexical —
    // information identical to a lexical-only run. Keying the confidence mode on `semanticModel !== null`
    // (the half RAN) instead of on actual contribution would drag it into the hybrid branch, where a
    // single-list RRF top scores ~1/61 < ANCHOR_MIN_FUSED_SCORE (0.025) and would WRONGLY flag a strong
    // exact-identifier lexical hit as lowConfidence. This asserts it stays false — and coverage.model
    // still reports the model (the plane IS populated; only the confidence predicate changes).
    for (const n of PAYMENT_CORPUS) seedNode(db, n);

    // StripeService gets a stored vector for an ORTHOGONAL concept, so the query below scores it near
    // cosine 0 (< 0.4) → the semantic list filters to []. embeddedNodes>0 so the semantic half genuinely
    // RUNS (semanticReadAvailable true via the stub factory), but it CONTRIBUTES nothing.
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    await seedEmbeddingFor(db, stub, STRIPE, 'alpha alpha alpha entirely unrelated concept');

    // NOTE (A2): the query carries a third token ('settlement', in StripeService's context but NOT in its
    // identifier {stripe, service}) precisely so it is NOT an exact-identifier match and the semantic
    // half still RUNS — this test's whole point. A bare 'stripe service' would trip the A2 cold-CLI
    // short-circuit (query IS the symbol name → lexical-only, model never loaded), which is a DIFFERENT
    // path with its own test; here we need the run-but-below-floor path that stresses the confidence mode.
    const { results, coverage, lowConfidence } = await runAnchorSearch(
      db,
      'stripe service settlement',
      {
        limit: 10,
      }
    );

    // The strong lexical top survives and is NOT wrongly flagged (pre-fix: hybrid branch on a pure-
    // lexical fused ~1/61 < 0.025 → true). matchedVia is 'lexical' — the semantic half contributed nothing.
    expect(results[0].nodeId).toBe(STRIPE);
    expect(results[0].matchedVia).toBe('lexical');
    expect(lowConfidence).toBe(false);

    // coverage.model still reports the active model — the plane IS populated; reporting stays correct.
    expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
    expect(coverage.embeddedNodes).toBe(1);
  });

  it('degrades to lexical-only when the DB has no vectors — no model, no throw, no fetch', async () => {
    // Production read path (no injected factory): with zero embeddings the coverage>0 gate short-
    // circuits BEFORE any weights probe or embedder construction, so this never fetches and never loads
    // a model regardless of whether real weights happen to be cached on this machine.
    __setReadPathEmbedderFactoryForTests(null);
    const N = 'symbol:php:App\\Services\\Payments\\StripeService';
    seedNode(db, {
      id: N,
      name: 'StripeService',
      qualified: 'App\\Services\\Payments\\StripeService',
      path: 'app/Services/Payments/StripeService.php',
      context: 'class StripeService implements PaymentGateway handles stripe charge',
    });

    const { results, coverage } = await runAnchorSearch(db, 'stripe service', { limit: 10 });
    expect(coverage.model).toBeNull();
    expect(coverage.embeddedNodes).toBe(0);
    expect(coverage.anchorViableNodes).toBe(1);
    expect(results[0].nodeId).toBe(N);
    expect(results[0].matchedVia).toBe('lexical');
  });

  it('respects opts.semantic:false — vectors present but the semantic half is skipped', async () => {
    const A = 'symbol:php:App\\Contracts\\PaymentGateway';
    seedNode(db, {
      id: A,
      name: 'PaymentGateway',
      qualified: 'App\\Contracts\\PaymentGateway',
      path: 'app/Contracts/PaymentGateway.php',
      context: 'interface gateway charge and refund contract',
    });
    await seedEmbeddingFor(db, stub, A, 'gateway charge');
    const { coverage } = await runAnchorSearch(db, 'gateway charge', {
      limit: 10,
      semantic: false,
    });
    expect(coverage.model).toBeNull(); // semantic half not attempted despite vectors + a stub factory
    expect(coverage.embeddedNodes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A2 — cold-CLI lexical-first short-circuit (SAFE, exact-identifier match only). When the query IS
// literally a symbol name, the semantic half adds nothing, so runAnchorSearch must answer lexical-only
// WITHOUT constructing the embedder (the avoidable 34 MB cold-CLI load). Proven network-free via the
// read-path factory seam: a factory that RECORDS whether it was reached (and throws) proves the exact
// path never loads the model; a working-stub factory proves a fuzzy query still runs the semantic half.
// The narrow safety property (a fuzzy/NL query does NOT short-circuit) is what keeps the measured
// hybrid lift unchanged — the live battery validates the numbers, these tests validate the mechanism.
// ---------------------------------------------------------------------------
describe('runAnchorSearch — A2 exact-identifier short-circuit (network-free)', () => {
  let dir: string;
  let db: LuxDatabase;
  let seedStub: StubEmbedder;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchor-a2-'));
    db = new LuxDatabase(join(dir, 'test.db'));
    // Used ONLY to seed stored passage vectors (so coverage.embeddedNodes > 0 — the semantic half is
    // genuinely AVAILABLE). The read-path factory is set per-test to observe whether it is reached.
    seedStub = new StubEmbedder({ model: ANCHOR_EMBED_MODEL });
  });
  afterEach(() => {
    __setReadPathEmbedderFactoryForTests(null); // restore production factory + cached-only gate + memo
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('an exact symbol-name query returns lexical-only and NEVER constructs the embedder', async () => {
    for (const n of PAYMENT_CORPUS) seedNode(db, n);
    // A stored vector makes the semantic half AVAILABLE (embeddedNodes > 0) — so it is the short-circuit,
    // not an empty vector plane, that skips it. StripeService is a perfect semantic neighbour of the
    // query text; if the semantic half ran it WOULD surface, so its absence-from-semantic is meaningful.
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    await seedEmbeddingFor(db, seedStub, STRIPE, 'stripe service');

    // Read-path factory RECORDS if reached, then throws — a working embedder is never needed on this
    // path. If the short-circuit regressed, getSharedEmbedder would call this (constructed → true).
    let constructed = false;
    __setReadPathEmbedderFactoryForTests(() => {
      constructed = true;
      throw new Error('embedder must not be constructed on an exact-identifier short-circuit');
    });

    // 'stripe service' — its content tokens {stripe, service} are exactly the identifier tokens of
    // StripeService (the top lexical hit), so the query IS the symbol name → short-circuit.
    const { results, coverage } = await runAnchorSearch(db, 'stripe service', { limit: 10 });

    // The proof the model was never loaded: the recording factory was never invoked. (coverage.model
    // being null alone would NOT prove this — a thrown factory is caught and also degrades to null.)
    expect(constructed).toBe(false);
    expect(coverage.model).toBeNull(); // lexical-only outcome (semanticModel:null → bm25 confidence)
    expect(coverage.embeddedNodes).toBe(0);
    expect(results[0].nodeId).toBe(STRIPE);
    expect(results[0].matchedVia).toBe('lexical');
  });

  it('a fuzzy (non-exact-identifier) query still runs the semantic half — the embedder IS constructed', async () => {
    for (const n of PAYMENT_CORPUS) seedNode(db, n);
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    const Q = 'charge a customer credit card'; // NL: no single top-hit identifier holds all its tokens
    await seedEmbeddingFor(db, seedStub, STRIPE, Q);

    // Read-path factory returns a WORKING stub and records that it was reached.
    let constructed = false;
    const readStub = new StubEmbedder({ model: ANCHOR_EMBED_MODEL });
    __setReadPathEmbedderFactoryForTests(() => {
      constructed = true;
      return Promise.resolve(readStub);
    });

    const { coverage } = await runAnchorSearch(db, Q, { limit: 10 });

    // The short-circuit did NOT fire (fuzzy query) → the embedder was constructed and the semantic half
    // ran, exactly as before A2. This is the invariant that keeps the hybrid lift intact.
    expect(constructed).toBe(true);
    expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
    expect(coverage.embeddedNodes).toBeGreaterThan(0);
  });

  it('a proper-SUBSET query (not the full name) does NOT short-circuit — semantic still runs (set-equality, not subset)', async () => {
    for (const n of PAYMENT_CORPUS) seedNode(db, n);
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    // 'stripe' — its content tokens {stripe} are a PROPER SUBSET of StripeService's identifier tokens
    // {stripe, service}, so the query is NOT the symbol's name. Under the fixed set-equality rule this
    // must NOT short-circuit — semantic may promote a differently-named node, so the model MUST load.
    // (A plain subset check would have wrongly skipped it, changing the envelope for a non-name query.)
    await seedEmbeddingFor(db, seedStub, STRIPE, 'stripe');
    let constructed = false;
    const readStub = new StubEmbedder({ model: ANCHOR_EMBED_MODEL });
    __setReadPathEmbedderFactoryForTests(() => {
      constructed = true;
      return Promise.resolve(readStub);
    });

    const { coverage } = await runAnchorSearch(db, 'stripe', { limit: 10 });

    expect(constructed).toBe(true); // subset ≠ exact name → semantic ran
    expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
  });

  it('A2 × test-exclusion (issue #77 review): an exact TEST-symbol query runs the semantic half in default mode, but still short-circuits under --include-tests', async () => {
    // The probe: a query whose tokens EXACTLY name a TEST symbol. The raw lexical top is that test node,
    // but the default filter removes it — so keying the short-circuit on the raw top would skip the
    // semantic lift for the surviving PRODUCT anchors and cite an invisible node. The fix keys on the
    // first SURVIVING (non-test) lexical hit.
    const PRODUCT = 'symbol:php:App\\Services\\Settlement\\SettlementService';
    const TESTN = 'symbol:php:Tests\\Unit\\SettlementServiceTest';
    const TEST_PATH = 'tests/Unit/SettlementServiceTest.php';
    seedNode(db, {
      id: PRODUCT,
      name: 'SettlementService',
      qualified: 'App\\Services\\Settlement\\SettlementService',
      path: 'app/Services/Settlement/SettlementService.php',
      context: 'orchestrates settlement of seller proceeds',
    });
    seedNode(db, {
      id: TESTN,
      name: 'SettlementServiceTest',
      qualified: 'Tests\\Unit\\SettlementServiceTest',
      path: TEST_PATH,
      context: 'asserts settlement behavior',
    });
    const Q = 'settlement service test'; // tokens {settlement,service,test} == TESTN's identifier exactly
    // Seed a vector on the PRODUCT sibling so, when the semantic half RUNS, it contributes → reason 'used'.
    await seedEmbeddingFor(db, seedStub, PRODUCT, Q);

    // DEFAULT (excludeTests): the raw top is TESTN (matches all 3 tokens) but is filtered out. The
    // short-circuit keys on the first non-test hit — SettlementService, identifier {settlement,service},
    // which is NOT the 3-token query → not exact → the semantic half RUNS. Reuse seedStub as the read
    // embedder so the seeded vector is an exact neighbour (cosine ~1.0 clears the floor → reason 'used').
    let constructed = false;
    __setReadPathEmbedderFactoryForTests(() => {
      constructed = true;
      return Promise.resolve(seedStub);
    });
    const def = await runAnchorSearch(db, Q, { limit: 10 });
    expect(constructed).toBe(true); // the fix: semantic half RAN despite the exact test-name match
    expect(def.coverage.query).toEqual({ semanticUsed: true, reason: 'used' });
    expect(def.results.map((r) => r.filePath)).not.toContain(TEST_PATH); // test node excluded
    expect(def.results.map((r) => r.nodeId)).toContain(PRODUCT); // product surfaces WITH the semantic lift

    // --include-tests: the raw top IS the test node whose identifier == the query tokens exactly → the
    // short-circuit fires as before (model never loaded), and the test node is present in results. This
    // is the legacy invariant the fix must preserve.
    constructed = false;
    __setReadPathEmbedderFactoryForTests(() => {
      constructed = true;
      throw new Error('embedder must not be constructed on the exact-identifier short-circuit');
    });
    const inc = await runAnchorSearch(db, Q, { limit: 10, includeTests: true });
    expect(constructed).toBe(false); // short-circuit still fires under include-tests → no model load
    expect(inc.coverage.query?.reason).toBe('exact-match-short-circuit');
    expect(inc.results.map((r) => r.nodeId)).toContain(TESTN); // test node present when tests included
  });

  it("reason 'load-failed': the embedder factory rejects at read time → degrade to lexical, not a query failure", async () => {
    // The read-path degrade branch (getSharedEmbedder/embed throws) — previously uncovered. A rejecting
    // factory stands in for a mid-load weight failure; the query must still answer lexically.
    for (const n of PAYMENT_CORPUS) seedNode(db, n);
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    const Q = 'charge a customer credit card'; // NL (not an exact identifier) → reaches the try/catch
    await seedEmbeddingFor(db, seedStub, STRIPE, Q); // embeddedNodes>0 so the half is attempted
    __setReadPathEmbedderFactoryForTests(() =>
      Promise.reject(new Error('weights load failed at read'))
    );

    const { results, coverage } = await runAnchorSearch(db, Q, { limit: 10 });
    expect(coverage.query).toEqual({ semanticUsed: false, reason: 'load-failed' });
    expect(coverage.model).toBeNull(); // degraded to lexical-only
    expect(coverage.embeddedNodes).toBe(0); // per-query flat field zeroed on degrade
    expect(coverage.index?.embeddedNodes).toBe(1); // but the STABLE index fact still shows the vector
    expect(results.length).toBeGreaterThan(0); // lexical still answered — a degrade, not a failure
  });
});

// ---------------------------------------------------------------------------
// Coverage split (issue #77 item #4) — the STABLE `coverage.index` (is the corpus embedded?) vs the
// PER-QUERY `coverage.query` (did THIS query use the semantic half, and why). The flat fields stay
// exactly as-is. Driven network-free through the stub seam so every branch's reason is exercised.
// ---------------------------------------------------------------------------
describe('runAnchorSearch — coverage split (index fact vs per-query reason)', () => {
  let dir: string;
  let db: LuxDatabase;
  let stub: StubEmbedder;

  // Token neutralization is handled by the file-level beforeEach/afterEach above (the local bge model
  // must be active for the seeded vectors to be found).
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchor-cov-'));
    db = new LuxDatabase(join(dir, 'test.db'));
    stub = new StubEmbedder({ model: ANCHOR_EMBED_MODEL });
    __setReadPathEmbedderFactoryForTests(() => Promise.resolve(stub));
  });
  afterEach(() => {
    __setReadPathEmbedderFactoryForTests(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exact-identifier short-circuit: index fact stays populated while the flat per-query fields read lexical-only', async () => {
    for (const n of PAYMENT_CORPUS) seedNode(db, n);
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    await seedEmbeddingFor(db, stub, STRIPE, 'stripe service');

    // 'stripe service' IS StripeService's identifier → A2 short-circuit → the model is never loaded.
    const { coverage } = await runAnchorSearch(db, 'stripe service', { limit: 10 });

    // Flat (frozen, per-query) fields: unchanged — 0/null, as before this change.
    expect(coverage.embeddedNodes).toBe(0);
    expect(coverage.model).toBeNull();
    // Stable index fact: the corpus IS embedded, reported from the DB count even on the short-circuit
    // (this is exactly the "reads as absent" detour issue #4 flagged).
    expect(coverage.index).toEqual({
      embeddedNodes: 1,
      totalNodes: PAYMENT_CORPUS.length,
      model: ANCHOR_EMBED_MODEL,
    });
    // Per-query fact: the reason the semantic half did not contribute.
    expect(coverage.query).toEqual({ semanticUsed: false, reason: 'exact-match-short-circuit' });
  });

  it("reason 'used': the semantic half ran and contributed", async () => {
    const A = 'symbol:php:App\\Contracts\\PaymentGateway';
    seedNode(db, {
      id: A,
      name: 'PaymentGateway',
      qualified: 'App\\Contracts\\PaymentGateway',
      path: 'app/Contracts/PaymentGateway.php',
      context: 'interface gateway charge and refund contract',
    });
    await seedEmbeddingFor(db, stub, A, 'gateway charge');
    const { coverage } = await runAnchorSearch(db, 'gateway charge', { limit: 10 });
    expect(coverage.query).toEqual({ semanticUsed: true, reason: 'used' });
    expect(coverage.index?.embeddedNodes).toBe(1);
    expect(coverage.index?.model).toBe(ANCHOR_EMBED_MODEL);
    // Flat model still reports the active model when the half contributed (unchanged behavior).
    expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
  });

  it("reason 'no-embedded-nodes': corpus has no vectors under the active model", async () => {
    seedNode(db, {
      id: 'symbol:php:App\\Models\\User',
      name: 'User',
      qualified: 'App\\Models\\User',
      path: 'app/Models/User.php',
      context: 'eloquent user model',
    });
    const { coverage } = await runAnchorSearch(db, 'user account', { limit: 10 });
    expect(coverage.query).toEqual({ semanticUsed: false, reason: 'no-embedded-nodes' });
    expect(coverage.index).toEqual({ embeddedNodes: 0, totalNodes: 1, model: null });
  });

  it("reason 'below-cosine-floor': the semantic half ran but every candidate fell below the floor", async () => {
    for (const n of PAYMENT_CORPUS) seedNode(db, n);
    const STRIPE = 'symbol:php:App\\Services\\Payments\\StripeService';
    // An orthogonal stored vector → the query below scores it near cosine 0 (< floor). The extra token
    // 'settlement' keeps it OFF the exact-identifier short-circuit so the half actually RUNS.
    await seedEmbeddingFor(db, stub, STRIPE, 'alpha alpha alpha entirely unrelated');
    const { coverage } = await runAnchorSearch(db, 'stripe service settlement', { limit: 10 });
    expect(coverage.query).toEqual({ semanticUsed: false, reason: 'below-cosine-floor' });
    // The half ran, so the flat model + index model both report the active model.
    expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
    expect(coverage.index?.model).toBe(ANCHOR_EMBED_MODEL);
  });

  it("reason 'disabled': semantic:false skips the half but the index fact is still reported", async () => {
    const A = 'symbol:php:App\\Contracts\\PaymentGateway';
    seedNode(db, {
      id: A,
      name: 'PaymentGateway',
      qualified: 'App\\Contracts\\PaymentGateway',
      path: 'app/Contracts/PaymentGateway.php',
      context: 'interface gateway charge and refund contract',
    });
    await seedEmbeddingFor(db, stub, A, 'gateway charge');
    const { coverage } = await runAnchorSearch(db, 'gateway charge', {
      limit: 10,
      semantic: false,
    });
    expect(coverage.query).toEqual({ semanticUsed: false, reason: 'disabled' });
    // The stable index fact is populated regardless of the per-query skip.
    expect(coverage.index).toEqual({ embeddedNodes: 1, totalNodes: 1, model: ANCHOR_EMBED_MODEL });
    // Flat per-query fields read lexical-only.
    expect(coverage.embeddedNodes).toBe(0);
    expect(coverage.model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gated real-weights smoke — runs ONLY when the pinned bge-small q8 weights are already cached on this
// machine (~/.lux/embeddings/bge-small-en-v1.5-q8/). Loads the real WasmLocalEmbedder + onnxruntime-web,
// embeds real passages, and drives the production read path end-to-end. Skipped in CI (weights absent).
// ---------------------------------------------------------------------------
const REAL_WEIGHTS_DIR = join(
  homedir(),
  '.lux',
  'embeddings',
  ANCHOR_EMBED_MODEL_ARTIFACTS.cacheKey
);
const realWeightsCached = Object.keys(ANCHOR_EMBED_MODEL_ARTIFACTS.files).every((f) =>
  existsSync(join(REAL_WEIGHTS_DIR, f))
);

describe.skipIf(!realWeightsCached)(
  'runAnchorSearch — real-weights hybrid smoke (bge-small q8)',
  () => {
    let dir: string;
    let db: LuxDatabase;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'lux-anchor-real-'));
      db = new LuxDatabase(join(dir, 'test.db'));
      __setReadPathEmbedderFactoryForTests(null); // production path — the real embedder
    });
    afterEach(() => {
      __setReadPathEmbedderFactoryForTests(null);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('a real concept query returns fused results with matchedVia including both/semantic', async () => {
      const nodes: SeedNode[] = [
        {
          id: 'symbol:php:App\\Contracts\\PaymentGateway',
          name: 'PaymentGateway',
          qualified: 'App\\Contracts\\PaymentGateway',
          path: 'app/Contracts/PaymentGateway.php',
          context: 'interface defines the payment contract for charge and refund',
        },
        {
          id: 'symbol:php:App\\Services\\Payments\\StripeService',
          name: 'StripeService',
          qualified: 'App\\Services\\Payments\\StripeService',
          path: 'app/Services/Payments/StripeService.php',
          context: 'implements PaymentGateway, charges a credit card and settles the transaction',
        },
        {
          id: 'symbol:php:App\\Services\\Settlement\\splitByPlatform',
          name: 'splitByPlatform',
          qualified: 'App\\Services\\Settlement\\SettlementService::splitByPlatform',
          path: 'app/Services/Settlement/SettlementService.php',
          context: 'divides the proceeds of a sale among the sellers on the platform',
        },
        {
          id: 'symbol:php:App\\Models\\User',
          name: 'User',
          qualified: 'App\\Models\\User',
          path: 'app/Models/User.php',
          context: 'eloquent model for an application user account',
        },
      ];
      for (const n of nodes) seedNode(db, n);

      // Populate REAL passage embeddings via the real embed pass (reads the texts queue, embeds, upserts).
      const { createEmbedder } = await import('../../embeddings/embedder.js');
      const { runNodeEmbedPass } = await import('../../embeddings/node-embed-pass.js');
      const embedder = await createEmbedder(undefined);
      const pass = await runNodeEmbedPass(db, embedder);
      expect(pass.coverage.embeddedNodes).toBe(nodes.length);

      // A query with strong lexical + semantic overlap with the payment nodes.
      const { results, coverage } = await runAnchorSearch(
        db,
        'charge a credit card through the payment gateway',
        { limit: 10 }
      );
      expect(coverage.model).toBe(ANCHOR_EMBED_MODEL);
      expect(results.length).toBeGreaterThan(0);
      const vias = new Set(results.map((r) => r.matchedVia));
      expect(vias.has('both') || vias.has('semantic')).toBe(true);
    });
  }
);
