// src/scanner/embeddings/node-embed-pass.ts  (FENCED — scanner/embeddings/*)
//
// The node embed pass (T3.4): reads the needs-embedding / resume queue (persisted prepared text),
// embeds it under a wall-clock budget, upserts model-tagged vectors, and reports coverage. Runs at the
// tail of every index path (cli/index.ts, Part B of spec 16). When coverage is already complete the
// widened LEFT-JOIN queue (spec 11 db layer) returns zero rows, so the pass skips the 34 MB model load
// — not a free check (the queue read still scans structural_node_texts), but it never pays the embedder
// bring-up.
//
// It NEVER throws on a budget hit OR on an embedder/DB failure — Decision 5: a failed embed pass must
// never fail the surrounding `lux index rebuild`/`sync`. A failed pass leaves the queue exactly where
// it was (each upsert is its own committed statement) and the next index path resumes it.
//
// It prepares NOTHING and re-parses NOTHING (Re-key R1): prepareNodeText (spec 10) ran at
// MATERIALIZATION and persisted structural_node_texts.prepared + .content_hash. This pass reads that
// prepared column from the queue and embeds it. There is no node:crypto import, no scanner/anchors
// import, and no tree-sitter/LSP touch on this path.
//
// FENCED (03 §Layer & fence analysis): this module lives under src/scanner/embeddings/ and may import
// only db/*, utils/*, and its embeddings siblings. Its sole production importer is cli/index.ts
// (Part B), which is on the fence allowlist.

import type { LuxDatabase, AnchorEmbeddingCoverage } from '../../db/index.js';
import type { Embedder } from './embedder.js';
import { ANCHOR_EMBED_DIMS, ANCHOR_EMBED_BUDGET_MS } from './model-pin.js';
import { encodeVector } from './codec.js';

/**
 * Rows fetched per `getUnembeddedAnchorNodes` call and handed to `embedder.embed()` as one batch —
 * bounds both the SQL `LIMIT` and the size of each batched inference call, so a large overlay can't
 * grow an unbounded in-memory batch and the budget-deadline check (below) is never more than one batch
 * late. NOT a frozen contract name (`03` treats `batchSize` as an internal default) — a throughput
 * benchmark may retune it without a contract change. 32 amortizes `WasmLocalEmbedder`'s per-call
 * session overhead (spec 11) without holding hundreds of un-flushed rows in memory.
 */
const DEFAULT_NODE_EMBED_BATCH_SIZE = 32;

export interface NodeEmbedPassOptions {
  /** Overrides `ANCHOR_EMBED_BUDGET_MS` — a TEST SEAM only (mirrors the `lspBudgetMs: 0` fixture in
   *  `overlay-refresh.test.ts`), never operator config (Decision 5 — the budget is committed, not a
   *  knob). `{ budgetMs: -1 }` puts the deadline strictly in the past, so the loop-top
   *  `Date.now() > deadline` check fires deterministically on the first iteration (whereas `0` sets
   *  `deadline === Date.now()` and the strict `>` can miss within the same millisecond — the tests
   *  use `-1`). */
  budgetMs?: number;
  /** Rows per embed batch. Defaults to `DEFAULT_NODE_EMBED_BATCH_SIZE`. */
  batchSize?: number;
  onProgress?: (msg: string) => void;
}

export interface NodeEmbedPassResult {
  /** Anchor nodes embedded (upserted) this pass. */
  embedded: number;
  /** `true` iff the pass stopped early — the budget deadline OR any unexpected embedder/DB failure
   *  (both fold into this one flag; see the outer catch below for why). */
  budgetHit: boolean;
  /** Post-pass coverage under the ACTIVE model (always computed, even when `budgetHit`). */
  coverage: AnchorEmbeddingCoverage;
}
// NOTE (Re-key R5): the source primitive's `EmbedPassResult` carried a `skippedPrepHash` field, frozen
// but always 0 (a re-visit-already-embedded-rows path it never built). This queue only ever returns
// rows that genuinely need (re-)embedding — a never-embedded node (`e.node_id IS NULL`) or a node whose
// persisted `content_hash` changed (`e.content_hash <> t.content_hash`). There is no "visited but
// skipped because its hash still matched" outcome on this pass and no re-visit path that would produce
// one, so the field is omitted rather than shipped as a permanent 0.

/**
 * Runs at the tail of every index path (cli/index.ts, Part B). Reads needs-embedding rows in batches
 * from the persisted queue, embeds them under a wall-clock budget, upserts model-tagged vectors, and
 * reports coverage.
 *
 * Budget shape mirrors `overlay-refresh.ts`'s LSP tier (the deadline-check + throw + single outer
 * catch + degrade-and-report idiom) exactly: a deadline computed once up front, checked before
 * starting each batch and again after finishing it, and ANY failure that reaches the outer `catch` —
 * whether the deadline sentinel or a genuinely unexpected error (an `embedder.embed()` rejection, a
 * corrupt-weights crash surfacing mid-pass, an `encodeVector` dims mismatch, a DB write failure) —
 * degrades the SAME way: stop, mark `budgetHit`, report once, return whatever was embedded before the
 * failure. Never rethrown past this function (Decision 5).
 *
 * Resume (Re-key R1): a budget-interrupted pass leaves un-embedded rows in the queue and re-reads them
 * on a later index path. It re-parses NOTHING — the `prepared` text and its `content_hash` are already
 * persisted in `structural_node_texts`; resume is a pure re-read of the queue.
 */
export async function runNodeEmbedPass(
  db: LuxDatabase,
  embedder: Embedder,
  opts?: NodeEmbedPassOptions
): Promise<NodeEmbedPassResult> {
  // The ACTIVE model (Re-key R3): ANCHOR_EMBED_MODEL for the tokenless local default, or
  // '<provider>:<model>' for the API path. Resolved once and used for every queue read, every upsert,
  // and the coverage read — reads and writes never mix vector spaces.
  const model = embedder.model;
  const budgetMs = opts?.budgetMs ?? ANCHOR_EMBED_BUDGET_MS;
  const batchSize = opts?.batchSize ?? DEFAULT_NODE_EMBED_BATCH_SIZE;
  const report = opts?.onProgress ?? (() => {});
  const deadline = Date.now() + budgetMs;

  let embedded = 0;
  let budgetHit = false;

  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error('anchor-embed-budget');

      // The widened freshness queue (Decision 5, spec 11): structural_node_texts LEFT JOIN
      // structural_node_embeddings ON node_id AND model=? WHERE e.node_id IS NULL OR
      // e.content_hash <> t.content_hash. Driving table is structural_node_texts, so the pass embeds
      // exactly the anchor-viable scope (Decision 6) with no scope filter of its own. Each row carries
      // { node_id, prepared, content_hash } — all persisted at materialization (Re-key R1).
      const rows = db.getUnembeddedAnchorNodes(model, batchSize);
      if (rows.length === 0) break; // queue empty — coverage is complete under the active model.

      // Batched, per spec 11's Embedder contract — never called per-text in a loop (that is where
      // WasmLocalEmbedder's per-call session cost amortizes). The passage side (`embed`) never applies
      // the BGE query prefix — that is `embedQuery`'s job on the read path (spec 11).
      const vectors = await embedder.embed(rows.map((r) => r.prepared));

      // One transaction per batch: the batch commits once instead of once per vector, and a budget
      // stop between batches still keeps every batch committed before it.
      db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          db.upsertNodeEmbedding({
            node_id: rows[i].node_id,
            model,
            dims: ANCHOR_EMBED_DIMS,
            vector: encodeVector(vectors[i]),
            // Re-key R2 — COPY the persisted texts-hash straight through; do NOT recompute it. The
            // vector records the exact structural_node_texts.content_hash it was computed against, so on
            // the next sync the queue's `e.content_hash <> t.content_hash` arm re-queues this node iff
            // its prepared text later changes under a stable id. Recomputing here (as the primitive did
            // with prepHash) is both unnecessary — the hash is already on disk — and WRONG, because it
            // would hash the same bytes twice and could never diverge from t.content_hash.
            content_hash: rows[i].content_hash,
          });
        }
      });
      embedded += rows.length;

      if (Date.now() > deadline) throw new Error('anchor-embed-budget');
    }
  } catch (error) {
    // One catch, one degrade path (Decision 5): the deadline sentinel and a genuinely unexpected
    // failure both land here and are handled identically — stop, mark budgetHit, report once, never
    // rethrow to the caller. `embedded` already reflects every row committed before the failure;
    // each batch is its own committed transaction, not part of one pass-wide transaction, so partial
    // progress within a budget-limited pass is the intended behaviour — the queue naturally excludes
    // what was already embedded on the next run.
    budgetHit = true;
    const reason = error instanceof Error ? error.message : String(error);
    report(
      `Anchor embed pass: stopped early after embedding ${embedded} node(s) this pass ` +
        `(budget ${budgetMs}ms exceeded or embedder failed: ${reason}) — ` +
        `remainder resumes on the next index run.`
    );
  }

  // Computed unconditionally, even on a degrade — this is what lets the CLI print an honest gap
  // ("870/915 ... 45 remaining") instead of silently omitting coverage on a budget hit. If this call
  // itself were ever to throw (a wholly broken DB), it escapes uncaught by design: the CLI-level
  // wrapper (`runNodeEmbedTail`, Part B) wraps the entire `runNodeEmbedPass` call and is the final
  // backstop, so a double failure here still cannot fail the surrounding rebuild/sync.
  const coverage = db.getAnchorEmbeddingCoverage(model);
  return { embedded, budgetHit, coverage };
}
