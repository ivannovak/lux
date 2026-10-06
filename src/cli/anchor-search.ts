// src/cli/anchor-search.ts
//
// The shared hybrid anchor engine (Decision 2/3). Called by both cli/anchors.ts and mcp/server.ts so
// the ranking/refusal/fusion logic exists once. On the embeddings fence allowlist (03 §Layer & fence)
// — Phase 3 (spec 17) wires the semantic half in HERE, so this is where the scanner/embeddings/ read
// surface (the barrel + the semantic floor + the cached-weights probe) is imported. The read path is
// CACHED-ONLY: it never fetches model weights (it degrades to lexical-only instead), mirroring the
// index tail's stance (cli/index.ts runNodeEmbedTail).

import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig } from '../scanner/config.js';
import { rankAnchorsLexical, type LexicalAnchorHit } from '../scanner/anchors/lexical-ranker.js';
import { anchorQueryContentTokens } from '../scanner/anchors/anchor-query.js';
import { splitIdentifiers } from '../scanner/anchors/prepare-node-text.js';
import {
  fuseRrf,
  ANCHOR_MIN_FUSED_SCORE,
  ANCHOR_MIN_LEXICAL_BM25,
  type SemanticRef,
  type FusedEntry,
} from '../scanner/anchors/fusion.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import { isTestPath } from '../scanner/anchors/test-path.js';
import type {
  AnchorResultV1,
  AnchorCoverageV1,
  AnchorSemanticReason,
  AnchorFiltersV1,
} from './anchors-envelope.js';
// Semantic half (Phase 3) — the embeddings read surface. The barrel is this file's designated import
// door (scanner/embeddings/index.ts doc-comment); the semantic floor + the active-model reconciliation
// (Phase 4) come from their own fenced modules.
import { createEmbedder, topCosine, type Embedder } from '../scanner/embeddings/index.js';
import type { EmbeddingConfig } from '../scanner/embeddings/embedder.js';
import { ANCHOR_MIN_COSINE } from '../scanner/embeddings/model-pin.js';
import {
  activeEmbeddingModel,
  embeddingReadAvailable,
} from '../scanner/embeddings/active-model.js';

export interface AnchorSearchOptions {
  limit: number;
  /** Phase 4: the corpus root, so runAnchorSearch can `loadLspConfig(corpusPath).embedding` and resolve
   *  the ACTIVE model + read availability (activeEmbeddingModel/embeddingReadAvailable) — the read path's
   *  coverage filter and the embedder it builds must key on the SAME model the index tail wrote under.
   *  Both production callers pass it (cli/anchors.ts, mcp/server.ts). Absent (a caller that doesn't pass
   *  it, or a test) ⇒ fall back to the local model (undefined config); never crash. */
  corpusPath?: string;
  /** Phase 3: when false, skip the semantic half even if vectors exist. NOTE (reconciled to reality):
   *  no caller currently passes `false` — both the CLI (`lux anchors`) and the MCP mirror attempt the
   *  semantic half identically whenever the plane is populated AND the weights are cached. The
   *  cold-CLI lexical-first short-circuit that would set this false (answer lexically first, skip the
   *  model load) is a deferred follow-up, not wired yet. Default true (undefined ⇒ semantic attempted);
   *  the `semantic:false` branch exists and is exercised by tests but has no production caller. */
  semantic?: boolean;
  /** Result granularity (issue #77 item #3). `node` (default) returns one anchor per ranked node —
   *  BYTE-IDENTICAL to v2.11.0 when combined with `includeTests: true`. `file` dedupes the fused
   *  ranking by file path BEFORE the limit, keeping the best-ranked node per file as its representative
   *  (a real node id that still round-trips through `lux trace`), and stamps `fileNodeCount` per result. */
  granularity?: 'node' | 'file';
  /** Test-file inclusion (issue #77 item #3). DEFAULT excludes test files (a class exploding into
   *  method-nodes + test files flood the `--limit` cap — the consumer's measured complaint). Exclusion
   *  happens BEFORE the limit. `includeTests: true` restores every test file (and, with
   *  `granularity: 'node'`, the byte-identical v2.11.0 result set). */
  includeTests?: boolean;
}

export interface AnchorSearchResult {
  results: AnchorResultV1[];
  lowConfidence: boolean;
  /** The granularity actually applied (echoes opts.granularity ?? 'node'). */
  granularity: 'node' | 'file';
  /** What the test-file filter did on this query (default excludes tests). */
  filters: AnchorFiltersV1;
  coverage: AnchorCoverageV1;
}

/** Semantic candidate pool depth for RRF. topCosine fetches at least this many neighbours (or
 *  `opts.limit` if larger) so the semantic list carries depth to fuse below the lexical top hit — a
 *  bare `limit`-sized pool would starve RRF of cross-corroboration candidates. Internal default (03
 *  treats the pool as an internal knob), not a frozen contract name. */
const ANCHOR_SEMANTIC_POOL = 50;

/** Candidate-pool depth for the FILTERING read path (issue #77 item #3). When test-exclusion and/or
 *  file-rollup are active, exclusion + dedupe happen BEFORE the limit — so both halves must fetch a pool
 *  DEEPER than `limit`, or a page full of test files / one file's method-nodes would starve the result
 *  below `limit` real anchors. A generous but bounded depth: enough headroom for a class exploding into
 *  method-nodes and a wave of test files, without an unbounded scan. The legacy path (node granularity
 *  AND include-tests) keeps the exact v2.11.0 depths (lexical=`limit`, semantic=`max(limit,50)`) so its
 *  fused ranking — and thus its `results` — stays byte-identical. Internal knob, not a contract name. */
const ANCHOR_FILTER_POOL = 200;

/** Upper bound on the raw query length, applied ONCE at the top of runAnchorSearch before any
 *  tokenization. A real concept→anchor query is a short phrase; an unbounded multi-MB `lux_anchors`
 *  query would otherwise force O(n) tokenizer/FTS-builder work on the warm MCP server (a cheap DoS on a
 *  resident process). Truncation is gentler than refusal (the leading 8192 chars carry any genuine
 *  query intact) and is applied to the SHARED query so both the lexical and semantic halves — and any
 *  refusal message — see the bounded text. Internal knob, not a frozen contract name. */
const ANCHOR_MAX_QUERY_CHARS = 8192;

/**
 * Read-path process-shared embedder (03 §Warm vs cold). The warm MCP server reuses ONE embedder across
 * queries (the model + WASM session stay resident → the warm-p50 latency target); the cold CLI process
 * constructs it once per invocation. Mirrors the write-path memo in cli/index.ts. A REJECTED promise is
 * NOT cached — a transient weight-load failure on one query must not poison later queries in the same
 * process. PHASE 4: the `embedding` config (from `loadLspConfig(corpusPath).embedding`, resolved once in
 * runAnchorSearch) is threaded through this SAME memo, so `createEmbedder(config)` selects the
 * ApiEmbedder when `LUX_EMBEDDING_TOKEN` is set — touching only the `createEmbedder(...)` argument, not
 * the caching contract (config is process-stable, so the first call fixes the embedder).
 */
let sharedEmbedderPromise: Promise<Embedder> | null = null;

/**
 * Test seam (clearly test-only — never an operator surface). Production embeds through
 * `createEmbedder(config)`, gated cached-only by `semanticReadAvailable`. A test injects a
 * deterministic StubEmbedder factory here to exercise the semantic half network-free; setting a factory
 * ALSO makes `semanticReadAvailable` true (a stub needs no on-disk weights) and resets the memo. `null`
 * restores the production factory + the cached-only gate.
 */
let readPathEmbedderFactoryForTests: (() => Promise<Embedder>) | null = null;

export function __setReadPathEmbedderFactoryForTests(
  factory: (() => Promise<Embedder>) | null
): void {
  readPathEmbedderFactoryForTests = factory;
  sharedEmbedderPromise = null;
}

function getSharedEmbedder(config: EmbeddingConfig | undefined): Promise<Embedder> {
  if (!sharedEmbedderPromise) {
    const construct = readPathEmbedderFactoryForTests ?? (() => createEmbedder(config));
    sharedEmbedderPromise = construct().catch((error: unknown) => {
      sharedEmbedderPromise = null; // never cache a failure — allow a retry on the next query
      throw error;
    });
  }
  return sharedEmbedderPromise;
}

/**
 * Is a semantic read available WITHOUT a network fetch? A test factory (a stub — no weights) is always
 * available. Otherwise delegate to the ACTIVE-model availability (active-model.ts, mirrors
 * createEmbedder's branch): a token set ⇒ the API path is available on the token alone; tokenless ⇒ the
 * pinned bge weights must already be present in the per-machine cache. This is what keeps the READ path
 * cached-only, exactly like the index tail (cli/index.ts): a `lux anchors` query NEVER triggers a bge
 * weight fetch — a weights-absent, tokenless machine degrades to lexical-only. `lux index rebuild
 * --embeddings` is the one fetch path. Gated behind the cheap coverage>0 check in the caller, so this
 * probe runs only when there is actually a populated embedding plane to read.
 */
function semanticReadAvailable(config: EmbeddingConfig | undefined): boolean {
  if (readPathEmbedderFactoryForTests !== null) return true;
  return embeddingReadAvailable(config);
}

/**
 * A2 — cold-CLI lexical-first short-circuit predicate (SAFE, exact-identifier match ONLY). Returns true
 * iff the query IS literally the top lexical hit's symbol name: EVERY content token of the query (the
 * SAME tokenizer/stopword split the lexical query builder used — `anchorQueryContentTokens`) appears in
 * the top hit's identifier tokens (its `symbolName` split by the write-path camel/snake/space rules —
 * `splitIdentifiers`, the exact splitter that produced the stored `identifiers` column — lowercased).
 *
 * Why this narrow shape (not a "confident lexical top by bm25"): under OR-expansion a multi-term NL
 * query can hand a NOISE node a strong bm25 by matching a subset of terms; skipping the semantic half
 * there would return the wrong anchor and kill the measured mismatch-case lift. Requiring EVERY query
 * token to be a component of the top hit's identifier is only satisfiable when the query IS that
 * symbol's name — where lexical is exhaustive and the semantic half adds nothing — so no fuzzy / NL /
 * midpoint query (which always carries a token outside the identifier) can trigger it. Empty query
 * tokens (guarded) or no lexical hit ⇒ false (run semantic).
 */
function topHitIsExactIdentifierMatch(query: string, topSymbolName: string): boolean {
  const queryTokens = new Set(anchorQueryContentTokens(query));
  if (queryTokens.size === 0) return false;
  const identifierTokens = new Set(splitIdentifiers(topSymbolName).map((t) => t.toLowerCase()));
  // SET EQUALITY, not subset: the query's content tokens must be EXACTLY the top hit's identifier
  // tokens (order-independent) — i.e. the query literally IS that symbol's name. Only then is lexical
  // the definitive answer and semantic reranking provably can't improve on it, so the model load is
  // safe to skip. A subset (e.g. "user" ⊂ UserAccountManager, "get user" ⊂ getUserById) must NOT
  // short-circuit: semantic may promote a differently-named node, and skipping it would change the
  // result envelope for a non-exact-name query. Fuzzy/midpoint queries carry out-of-identifier tokens
  // and fail the size check immediately, so the measured hybrid lift is untouched.
  if (queryTokens.size !== identifierTokens.size) return false;
  for (const t of queryTokens) if (!identifierTokens.has(t)) return false;
  return true;
}

/**
 * Run the hybrid anchor search. Throws AnchorRefusalError for overlay-missing / anchor-texts-absent /
 * invalid-query / fts-unavailable (the caller renders the refusal envelope + nonzero exit). A healthy
 * populated-index zero result returns an empty `results` (exit 0, unresolved).
 */
export async function runAnchorSearch(
  db: LuxDatabase,
  query: string,
  opts: AnchorSearchOptions
): Promise<AnchorSearchResult> {
  // Bound the raw query length BEFORE anything tokenizes it (both halves do). Applied once, at the very
  // top, so the lexical ranker, the semantic embedder, AND any refusal message all carry the bounded
  // text — a pathological multi-MB query can never reach the tokenizer/FTS-builder on the warm server.
  if (query.length > ANCHOR_MAX_QUERY_CHARS) {
    query = query.slice(0, ANCHOR_MAX_QUERY_CHARS);
  }

  // Extended refusals (03 §The surface): probe the overlay/texts BEFORE any FTS MATCH, so the honest
  // "I cannot look here yet" is distinct from a genuine zero-result.
  if (!db.hasStructuralOverlay()) {
    throw new AnchorRefusalError(
      'overlay-missing',
      query,
      // A corpus with code mints anchor nodes on rebuild; a documents-only corpus has none — the
      // remediation must also point that operator at the prose surface (this message is all a --json
      // / MCP consumer sees; the text renderer adds the same hand-off line).
      'The structural overlay has not been built. Run `lux index rebuild` (a corpus with code mints ' +
        'anchor nodes); a documents-only corpus has none — search its prose with `lux search`.'
    );
  }
  const anchorViableNodes = db.getAnchorViableNodeCount();
  if (anchorViableNodes === 0) {
    throw new AnchorRefusalError(
      'anchor-texts-absent',
      query,
      'The overlay is present but carries no anchor texts (is `ast.enabled` false?). ' +
        'Enable AST materialization, or run `lux index rebuild`.'
    );
  }

  // Phase 4 active-model resolution. Load the corpus's `embedding` config (if the caller passed a
  // corpusPath — both production callers do; a test/absent caller falls back to the local model via
  // undefined config, never crashing) and resolve the ACTIVE model + read availability. Both mirror
  // createEmbedder's env-token branch (active-model.ts), so the coverage filter and the embedder built
  // below key on the SAME model the index tail wrote under — reads never mix embedding spaces (D11).
  // loadLspConfig THROWS on a malformed lux.yaml (a bad section, or an inline embedding.token). On the
  // READ path that must NOT crash `lux anchors` with a raw stacktrace where the lexical-only tier would
  // still answer — degrade to undefined config (→ the local model; lexical-first stays intact), matching
  // this path's cached-only / degrade / never-throw ethos. The index/config-WRITE paths still fail loud.
  let embeddingConfig: EmbeddingConfig | undefined;
  try {
    embeddingConfig = opts.corpusPath ? loadLspConfig(opts.corpusPath).embedding : undefined;
  } catch {
    // lux-intentional-swallow: read path: `lux anchors` answers lexically with the local model; rebuild and sync report the unreadable config as a warning.
    embeddingConfig = undefined;
  }
  const activeModel = activeEmbeddingModel(embeddingConfig);

  // Consumer-polish options (issue #77 item #3). Test files are EXCLUDED by default; file granularity
  // dedupes by file. When either is active the read path FILTERS/DEDUPES before the limit, so it fetches
  // a deeper candidate pool than `limit` (below) to avoid starving the result. The legacy combination
  // (node granularity AND include-tests) takes the exact v2.11.0 pipeline → byte-identical `results`.
  const granularity: 'node' | 'file' = opts.granularity ?? 'node';
  const includeTests = opts.includeTests ?? false;
  const excludeTests = !includeTests;
  const filteringActive = excludeTests || granularity === 'file';
  const lexicalDepth = filteringActive ? Math.max(opts.limit, ANCHOR_FILTER_POOL) : opts.limit;
  const semanticPoolDepth = filteringActive
    ? Math.max(opts.limit, ANCHOR_FILTER_POOL)
    : Math.max(opts.limit, ANCHOR_SEMANTIC_POOL);

  // Lexical half — always runs (throws its own invalid-query/fts-unavailable refusals).
  const lexical: LexicalAnchorHit[] = rankAnchorsLexical(db, query, lexicalDepth);

  // Semantic half (Phase 3, spec 17 / 03 §Fusion). CACHED-ONLY read path: attempt the semantic half
  // ONLY when it is both wanted AND free of a network fetch — the embedding plane must already be
  // populated (coverage under the active model) AND the pinned weights already cached. This mirrors the
  // index tail's cached-only stance (cli/index.ts runNodeEmbedTail): a read NEVER fetches weights. When
  // vectors or weights are absent, the surface degrades to lexical-only and says so via coverage.model
  // = null — never an error, never silent (a user opts the tier in with `lux index rebuild
  // --embeddings`). The coverage read is scoped to the ACTIVE model (Phase 4): ANCHOR_EMBED_MODEL for
  // the tokenless local default, or `openai:<model>` when LUX_EMBEDDING_TOKEN selects the API path —
  // identical to the embedder.model built below, so coverage and the cosine scan never mix spaces.
  const coverage = db.getAnchorEmbeddingCoverage(activeModel);
  let semantic: SemanticRef[] = [];
  let semanticModel: string | null = null;
  let embeddedNodes = 0;
  // A2 — cold-CLI lexical-first short-circuit (SAFE — exact-identifier match only). When the semantic
  // half is otherwise available, first check whether the query is literally the top lexical hit's symbol
  // name (every query content token is a component of that hit's identifier). If so, lexical already
  // answers it and the semantic half adds nothing, so we DON'T load the 34 MB embedder — semanticModel
  // stays null and confidence falls to the bm25 branch, exactly like a vectors-absent index. This is
  // deliberately narrow: any fuzzy/NL/midpoint query carries a token outside the identifier and still
  // runs the semantic half, so the measured hybrid lift is unchanged.
  //
  // The if/else chain below ALSO records WHY the semantic half was / was not used — coverage.query.reason
  // (issue #77 item #4). It preserves the exact runtime behavior and short-circuit ORDER of the previous
  // `semanticAvailable && !exactIdentifierTop` guard: `disabled` and `no-embedded-nodes` are checked
  // before the weights probe (so `semanticReadAvailable` still runs only when embeddings are enabled),
  // and the exact-identifier check is reached only when the half is otherwise available.
  // The A2 short-circuit must key on the lexical top hit that SURVIVES the active filters, not the raw
  // top. In default (test-excluding) mode, a query that exactly names a TEST symbol (e.g. "settlement
  // service test" → SettlementServiceTest) would otherwise short-circuit on that test node — skipping
  // the semantic half — and then have that node filtered out of results, leaving the surviving PRODUCT
  // anchors lift-less and coverage.query.reason referencing an invisible node (issue #77 review). So:
  // when excludeTests, the effective top is the first NON-test lexical hit; when includeTests, it is the
  // raw first hit (unchanged → legacy `--include-tests --granularity node` byte-identity preserved). If
  // every lexical hit is a test (excludeTests), there is no surviving top to short-circuit on ⇒ run the
  // semantic half (undefined ⇒ the `&&` below is false).
  const shortCircuitTopHit = excludeTests
    ? lexical.find((h) => !isTestPath(h.filePath))
    : lexical[0];
  let semanticReason: AnchorSemanticReason;
  if (opts.semantic === false) {
    semanticReason = 'disabled';
  } else if (coverage.embeddedNodes === 0) {
    semanticReason = 'no-embedded-nodes';
  } else if (!semanticReadAvailable(embeddingConfig)) {
    // Vectors exist, but the cached-only read path has no local weights (and no API token) — degrade to
    // lexical without a fetch (mirrors the index tail). This is the read-path cached-only stance.
    semanticReason = 'weights-not-cached';
  } else if (
    shortCircuitTopHit &&
    topHitIsExactIdentifierMatch(query, shortCircuitTopHit.symbolName)
  ) {
    // A2 — evaluated AFTER the lexical rank and BEFORE getSharedEmbedder so no model load happens here.
    semanticReason = 'exact-match-short-circuit';
  } else {
    try {
      const embedder = await getSharedEmbedder(embeddingConfig);
      // embedQuery applies BGE_QUERY_PREFIX (the passage/query asymmetry, OQ2); the passage side never
      // prefixes. topCosine scans ONLY the active model's vectors (D11), cut at ANCHOR_MIN_COSINE to
      // drop the sub-floor nearest-anything noise. Survivors keep descending order, so the 1-based
      // semanticRank is intact after the filter.
      const qVec = await embedder.embedQuery(query);
      const hits = topCosine(qVec, db, semanticPoolDepth, embedder.model);
      semantic = hits
        .filter((h) => h.score >= ANCHOR_MIN_COSINE)
        .map((h, i) => ({ nodeId: h.nodeId, semanticRank: i + 1, cosine: h.score }));
      semanticModel = embedder.model;
      embeddedNodes = coverage.embeddedNodes;
      // The half ran; it CONTRIBUTED iff at least one candidate cleared the cosine floor.
      semanticReason = semantic.length > 0 ? 'used' : 'below-cosine-floor';
    } catch {
      // lux-intentional-swallow: read path: the semantic half degrades to lexical-only and the result's semanticReason says so.
      // A weights-unavailable / mid-load failure at read time degrades to lexical-only rather than
      // failing the whole query: the semantic half is a lift, not a prerequisite (03 §Fusion, floor,
      // honesty). The rejected memo already self-cleared so a later query can retry.
      semantic = [];
      semanticModel = null;
      embeddedNodes = 0;
      semanticReason = 'load-failed';
    }
  }

  // Fuse the two rank lists. The lexical hit map resolves per-result metadata (semantic-only nodes fall
  // back to a node lookup). `fusedAll` is the WHOLE fused ranking; the slice/filter/dedupe below decide
  // what reaches the limit — kept separate so the filtering path can act on the full pool.
  const lexByNode = new Map(lexical.map((h) => [h.nodeId, h]));
  const fusedAll = fuseRrf(
    lexical.map((h) => ({ nodeId: h.nodeId, lexicalRank: h.lexicalRank })),
    semantic
  );
  const toResult = (f: FusedEntry): AnchorResultV1 => {
    const meta = lexByNode.get(f.nodeId);
    if (meta) {
      return {
        nodeId: f.nodeId,
        symbolKind: meta.symbolKind,
        symbolName: meta.symbolName,
        qualifiedName: meta.qualifiedName,
        filePath: meta.filePath,
        matchedVia: f.matchedVia,
        lexicalRank: f.lexicalRank,
        cosine: f.cosine,
        fusedScore: f.fusedScore,
      };
    }
    // Semantic-only (Phase 3): resolve metadata from structural_nodes by id.
    const node = db.getStructuralNode(f.nodeId);
    return {
      nodeId: f.nodeId,
      symbolKind: node?.symbol_kind ?? 'Unknown',
      symbolName: node?.symbol_name ?? f.nodeId,
      qualifiedName: node?.qualified_name ?? null,
      filePath: node?.file_path ?? '',
      matchedVia: f.matchedVia,
      lexicalRank: f.lexicalRank,
      cosine: f.cosine,
      fusedScore: f.fusedScore,
    };
  };

  let results: AnchorResultV1[];
  let excludedTestFiles = 0;
  if (!filteringActive) {
    // Legacy path (node granularity AND include-tests): slice to limit then map — BYTE-IDENTICAL to
    // v2.11.0. No test-exclusion, no file rollup, no widened pool.
    results = fusedAll.slice(0, opts.limit).map(toResult);
  } else {
    // Filtering path: materialize the full pool, then apply test-exclusion + file-rollup BEFORE the
    // limit so the cap means N product-code (and, in file mode, N distinct-file) anchors.
    let pool = fusedAll.map(toResult);
    if (excludeTests) {
      const droppedFiles = new Set<string>();
      pool = pool.filter((r) => {
        if (isTestPath(r.filePath)) {
          droppedFiles.add(r.filePath);
          return false;
        }
        return true;
      });
      excludedTestFiles = droppedFiles.size;
    }
    if (granularity === 'file') {
      // Roll up to one representative per file: the FIRST occurrence of a path in fused-sorted order is
      // its best-ranked node (a real node id — round-trips through `lux trace`). fileNodeCount is the
      // count of that file's ranked candidates in the POST-test-exclusion pool.
      // Rollup key = the node's raw file_path string (case-sensitive, exact): correct because within one
      // corpus a file has a single canonical path (structural_nodes.file_path is written once per file);
      // this is NOT a cross-OS path-equality normalizer.
      const fileNodeCounts = new Map<string, number>();
      for (const r of pool)
        fileNodeCounts.set(r.filePath, (fileNodeCounts.get(r.filePath) ?? 0) + 1);
      const seen = new Set<string>();
      const deduped: AnchorResultV1[] = [];
      for (const r of pool) {
        if (seen.has(r.filePath)) continue;
        seen.add(r.filePath);
        deduped.push({ ...r, fileNodeCount: fileNodeCounts.get(r.filePath) ?? 1 });
      }
      pool = deduped;
    }
    results = pool.slice(0, opts.limit);
  }

  // Confidence floor (Decision-Fusion) — two modes (T1.8), keyed on whether the semantic half
  // CONTRIBUTED, not merely whether it RAN:
  //  · Hybrid (hybridActive): the semantic half ran AND landed at least one above-floor candidate, so
  //    the fused ranking spans two rank lists and the whole-surface ANCHOR_MIN_FUSED_SCORE gates.
  //  · Lexical-shaped (else): either the semantic half never ran (lexical-only, Phase 1 / no vectors /
  //    weights absent) OR it ran but every candidate fell below ANCHOR_MIN_COSINE, so `semantic` is []
  //    and the fused list is single-list. In BOTH cases a single-list RRF top hit scores ~1/(RRF_K+1)
  //    regardless of match quality, so the fused score cannot separate a confident anchor from a thin
  //    collision — confidence derives from the top hit's raw weighted-bm25 instead (a top bm25 weaker/
  //    greater than ANCHOR_MIN_LEXICAL_BM25 is a thin match). Keying this branch on `semanticModel !==
  //    null` alone would drag a populated-but-below-floor query into the hybrid branch, where a strong
  //    exact-identifier lexical top (fused ~1/61 < 0.025) would be wrongly flagged lowConfidence purely
  //    because the vector plane exists. coverage.model still reports semanticModel (the plane IS
  //    populated); only the confidence predicate keys on the actual contribution.
  const hybridActive = semanticModel !== null && semantic.length > 0;
  let lowConfidence = false;
  const top = results[0];
  if (top) {
    if (hybridActive) {
      lowConfidence = top.fusedScore < ANCHOR_MIN_FUSED_SCORE;
    } else {
      const topBm25 = lexByNode.get(top.nodeId)?.bm25Rank ?? 0;
      lowConfidence = topBm25 > ANCHOR_MIN_LEXICAL_BM25;
    }
  }

  // Coverage split (issue #77 item #4). The frozen flat fields stay EXACTLY as-is (back-compat):
  // `embeddedNodes`/`model` are PER-QUERY (0/null when the semantic half did not contribute — e.g. the
  // A2 short-circuit), `anchorViableNodes` is the stable total. The additive `index` sub-object is the
  // STABLE corpus fact — the DB count under the active model, populated on EVERY answered query
  // INCLUDING the short-circuit (a cheap count already read above; no model load), so "is the corpus
  // embedded?" no longer reads as absent when a query answered lexically. `query` is the per-query
  // semantic-usage fact + the grounded reason. `index.model` is the active model iff ≥1 fresh vector
  // exists under it (D11 — reads never mix embedding spaces), else null.
  return {
    results,
    lowConfidence,
    granularity,
    filters: {
      tests: includeTests ? 'included' : 'excluded',
      excludedTestFiles,
    },
    coverage: {
      embeddedNodes,
      anchorViableNodes,
      model: semanticModel,
      index: {
        embeddedNodes: coverage.embeddedNodes,
        totalNodes: coverage.anchorViableNodes,
        model: coverage.embeddedNodes > 0 ? activeModel : null,
      },
      query: {
        semanticUsed: semanticReason === 'used',
        reason: semanticReason,
      },
    },
  };
}

/**
 * Coverage for a REFUSAL envelope (CLI --json / MCP). A refusal carries no ranked hits, but the
 * anchor-viable count is still real and must be reported accurately: a non-overlay refusal
 * (invalid-query / fts-unavailable) over a POPULATED index has embedded texts, so a hardcoded zero
 * would be a false statement in the frozen schemaVersion:1 `coverage` field. For overlay-missing /
 * anchor-texts-absent the count is a genuine 0 (autoMigrate keeps the table present, so the probe is
 * always safe). Embeddings are absent in Phase 1, so embeddedNodes:0 / model:null stay hardcoded.
 */
export function anchorRefusalCoverage(db: LuxDatabase): AnchorCoverageV1 {
  return { embeddedNodes: 0, anchorViableNodes: db.getAnchorViableNodeCount(), model: null };
}
