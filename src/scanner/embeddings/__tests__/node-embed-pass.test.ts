// src/scanner/embeddings/__tests__/node-embed-pass.test.ts
//
// The node embed pass (spec 16 Part A / T3.4). Network-free: every case injects StubEmbedder (or a
// tiny hand-rolled Embedder) rather than loading ~34 MB of ONNX weights. Exercises the real db layer
// (a temp LuxDatabase — migrations 014/015 applied on open) so the widened freshness queue, the
// content_hash copy-through, and the model-scoped coverage read are all hit for real.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LuxDatabase } from '../../../db/index.js';
import { StubEmbedder } from './stub-embedder.js';
import { runNodeEmbedPass } from '../node-embed-pass.js';
import { decodeVector } from '../codec.js';
import { ANCHOR_EMBED_DIMS } from '../model-pin.js';
import type { Embedder } from '../embedder.js';

const MODEL = 'stub-model@sha256:deadbeef';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Seed one anchor-viable node's prepared-text row (the freshness queue's driving table). The FTS
 *  split fields are required by the insert type but irrelevant to the embed pass, which reads only
 *  { node_id, prepared, content_hash }. content_hash = sha256(prepared), mirroring materialization. */
function seedNode(db: LuxDatabase, nodeId: string, prepared: string): void {
  db.upsertNodeAnchorText({
    node_id: nodeId,
    prepared,
    content_hash: hash(prepared),
    name: nodeId,
    identifiers: nodeId,
    qualified: nodeId,
    path_segments: nodeId,
    context: '',
  });
}

/** A passage embedder that stalls `delayMs` per batch, so a small wall-clock budget stops the pass
 *  mid-set deterministically-enough (each batch costs real time). Delegates values to an inner
 *  StubEmbedder under the SAME model, so a later fast resume produces a consistent corpus. */
class SlowEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private readonly inner: StubEmbedder;
  constructor(
    private readonly delayMs: number,
    model: string
  ) {
    this.inner = new StubEmbedder({ model });
    this.model = this.inner.model;
    this.dims = this.inner.dims;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.embed(texts);
  }
  embedQuery(text: string): Promise<Float32Array> {
    return this.inner.embedQuery(text);
  }
}

describe('runNodeEmbedPass', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-node-embed-'));
    db = new LuxDatabase(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('full drain: embeds every anchor node, coverage 100%, and a second pass embeds zero (SC-SKIP)', async () => {
    for (let i = 0; i < 5; i++) seedNode(db, `n${i}`, `prepared text ${i}`);
    const embedder = new StubEmbedder({ model: MODEL });

    const r1 = await runNodeEmbedPass(db, embedder);
    expect(r1.embedded).toBe(5);
    expect(r1.budgetHit).toBe(false);
    expect(r1.coverage).toEqual({ embeddedNodes: 5, anchorViableNodes: 5, model: MODEL });

    for (let i = 0; i < 5; i++) {
      const row = db.getNodeEmbeddingByNode(`n${i}`, MODEL);
      expect(row?.model).toBe(MODEL);
      expect(row?.dims).toBe(ANCHOR_EMBED_DIMS);
      expect(decodeVector(row!.vector).length).toBe(ANCHOR_EMBED_DIMS);
      expect(row?.content_hash).toBe(hash(`prepared text ${i}`)); // R2: copied straight through
    }

    // SC-SKIP: a re-run over an already-covered overlay returns zero rows immediately.
    const r2 = await runNodeEmbedPass(db, embedder);
    expect(r2.embedded).toBe(0);
    expect(r2.budgetHit).toBe(false);
    expect(r2.coverage.embeddedNodes).toBe(5);
  });

  it('full drain across MULTIPLE batches at an unbounded budget reaches 100% (the --embeddings drain mechanic)', async () => {
    // The `lux index rebuild --embeddings` drain (cli/index.ts drainNodeEmbedQueue) runs the pass at an
    // effectively unbounded budget so the whole queue is drained in one run instead of one 30s budget's
    // worth. N=70 > 2× the 32-row internal batch, so this exercises the pass's multi-batch loop draining
    // to 100% under a large budget — the exact mechanic the drain relies on, proven network-free.
    const N = 70;
    for (let i = 0; i < N; i++) seedNode(db, `n${i}`, `prepared text ${i}`);
    const embedder = new StubEmbedder({ model: MODEL });
    const BIG_BUDGET_MS = 365 * 24 * 60 * 60 * 1000;

    const r = await runNodeEmbedPass(db, embedder, { budgetMs: BIG_BUDGET_MS });
    expect(r.budgetHit).toBe(false);
    expect(r.embedded).toBe(N);
    expect(r.coverage).toEqual({ embeddedNodes: N, anchorViableNodes: N, model: MODEL });

    // The drain loop's terminating condition: a second pass over the now-complete queue embeds zero.
    const r2 = await runNodeEmbedPass(db, embedder, { budgetMs: BIG_BUDGET_MS });
    expect(r2.embedded).toBe(0);
    expect(r2.coverage.embeddedNodes).toBe(N);
  });

  it('resume after a budget cut: two calls complete the set, each node embedded exactly once (SC-BUDGET)', async () => {
    const N = 6;
    for (let i = 0; i < N; i++) seedNode(db, `n${i}`, `prepared ${i}`);

    // 20 ms/batch under a 50 ms budget with batchSize 1 → the pass always completes at least one batch
    // (loop-top never fires at t≈0) and never all six (6×20 ms ≫ 50 ms), so 0 < embedded < N always.
    const slow = new SlowEmbedder(20, MODEL);
    const r1 = await runNodeEmbedPass(db, slow, { budgetMs: 50, batchSize: 1 });
    expect(r1.budgetHit).toBe(true);
    expect(r1.embedded).toBeGreaterThan(0);
    expect(r1.embedded).toBeLessThan(N);
    expect(r1.coverage.embeddedNodes).toBe(r1.embedded); // coverage reflects the honest partial

    // Resume: the widened queue naturally excludes the rows embedded above, so a full-budget pass
    // drains only the remainder — the union is the whole set with no double-work.
    const fast = new StubEmbedder({ model: MODEL });
    const r2 = await runNodeEmbedPass(db, fast, { batchSize: 1 });
    expect(r2.budgetHit).toBe(false);
    expect(r1.embedded + r2.embedded).toBe(N);
    expect(r2.coverage.embeddedNodes).toBe(N);
    expect(r2.coverage.anchorViableNodes).toBe(N);
  });

  it('an already-expired budget stops before the first batch — embeds nothing, still resolves', async () => {
    for (let i = 0; i < 3; i++) seedNode(db, `n${i}`, `text ${i}`);
    // budgetMs -1 → deadline is strictly in the past, so the loop-top `Date.now() > deadline` fires
    // on the first check (deterministic, unlike a 0 ms budget which races the ms clock).
    const r = await runNodeEmbedPass(db, new StubEmbedder({ model: MODEL }), { budgetMs: -1 });
    expect(r.budgetHit).toBe(true);
    expect(r.embedded).toBe(0);
    expect(r.coverage.embeddedNodes).toBe(0);
    expect(r.coverage.anchorViableNodes).toBe(3);
  });

  it('content_hash change re-queues a stable-id node and REPLACEs its vector (SC-FRESHNESS)', async () => {
    seedNode(db, 'n1', 'original prepared text');
    const embedder = new StubEmbedder({ model: MODEL });
    await runNodeEmbedPass(db, embedder);

    const before = db.getNodeEmbeddingByNode('n1', MODEL)!;
    const beforeBytes = Buffer.from(before.vector);
    const beforeHash = before.content_hash;
    expect(beforeHash).toBe(hash('original prepared text'));

    // Materialization rewrites the SAME node id's prepared text (body changed; name/container stable, so
    // the deterministic id never churned) → a new content_hash on structural_node_texts.
    seedNode(db, 'n1', 'CHANGED prepared text — different body');

    // The queue's `e.content_hash <> t.content_hash` arm re-includes the survivor.
    const queued = db.getUnembeddedAnchorNodes(MODEL, 10).map((q) => q.node_id);
    expect(queued).toContain('n1');

    const r = await runNodeEmbedPass(db, embedder);
    expect(r.embedded).toBe(1);

    const after = db.getNodeEmbeddingByNode('n1', MODEL)!;
    expect(after.content_hash).not.toBe(beforeHash);
    expect(after.content_hash).toBe(hash('CHANGED prepared text — different body'));
    // Deterministic stub: different prepared text → different bytes. The stale vector did NOT survive.
    expect(Buffer.from(after.vector).equals(beforeBytes)).toBe(false);
    expect(r.coverage.embeddedNodes).toBe(1);
  });

  it('a fully-failing embedder degrades without throwing (index not failed), coverage 0% (Decision 5)', async () => {
    for (let i = 0; i < 3; i++) seedNode(db, `n${i}`, `text ${i}`);
    const boom: Embedder = {
      model: MODEL,
      dims: ANCHOR_EMBED_DIMS,
      embed: () => Promise.reject(new Error('weights corrupt')),
      embedQuery: () => Promise.reject(new Error('weights corrupt')),
    };
    // Must resolve, not reject — a failed embed pass never fails the surrounding index.
    const r = await runNodeEmbedPass(db, boom);
    expect(r.budgetHit).toBe(false);
    expect(r.failure).toBe('weights corrupt');
    expect(r.embedded).toBe(0);
    expect(r.coverage.embeddedNodes).toBe(0);
    expect(r.coverage.anchorViableNodes).toBe(3);
  });

  it('a mid-pass embedder failure persists the partial then degrades (partial coverage + resume)', async () => {
    const N = 5;
    for (let i = 0; i < N; i++) seedNode(db, `n${i}`, `text ${i}`);
    const failAfter = 2;
    let calls = 0;
    const inner = new StubEmbedder({ model: MODEL });
    const flaky: Embedder = {
      model: MODEL,
      dims: ANCHOR_EMBED_DIMS,
      embed: async (texts) => {
        calls++;
        if (calls > failAfter) throw new Error('boom mid-pass');
        return inner.embed(texts);
      },
      embedQuery: (t) => inner.embedQuery(t),
    };

    const r = await runNodeEmbedPass(db, flaky, { batchSize: 1 });
    expect(r.budgetHit).toBe(false);
    expect(r.failure).toBe('boom mid-pass');
    expect(r.embedded).toBe(failAfter); // two single-row batches committed before the throw
    expect(r.coverage.embeddedNodes).toBe(failAfter); // the partial IS persisted (per-upsert commit)

    // A healthy embedder resumes and completes the remainder.
    const r2 = await runNodeEmbedPass(db, inner, { batchSize: 1 });
    expect(r2.budgetHit).toBe(false);
    expect(r2.embedded).toBe(N - failAfter);
    expect(r2.coverage.embeddedNodes).toBe(N);
  });

  it('vectors are tagged with embedder.model and are invisible under another model (model-scope)', async () => {
    seedNode(db, 'n1', 'text');
    const MODEL_ONE = 'model-one@sha256:aaaa';
    const MODEL_TWO = 'model-two@sha256:bbbb';

    await runNodeEmbedPass(db, new StubEmbedder({ model: MODEL_ONE }));

    expect(db.getNodeEmbeddingByNode('n1', MODEL_ONE)?.model).toBe(MODEL_ONE);
    expect(db.getNodeEmbeddingByNode('n1', MODEL_TWO)).toBeUndefined();
    expect(db.getAnchorEmbeddingCoverage(MODEL_ONE).embeddedNodes).toBe(1);
    expect(db.getAnchorEmbeddingCoverage(MODEL_TWO).embeddedNodes).toBe(0);
    // Under a different model space n1 is still un-embedded — reads never mix vector spaces.
    expect(db.getUnembeddedAnchorNodes(MODEL_TWO, 10).map((q) => q.node_id)).toContain('n1');
  });

  it('vacuous coverage: an overlay with zero anchor-viable nodes drains to embedded 0', async () => {
    const r = await runNodeEmbedPass(db, new StubEmbedder({ model: MODEL }));
    expect(r.embedded).toBe(0);
    expect(r.budgetHit).toBe(false);
    expect(r.coverage).toEqual({ embeddedNodes: 0, anchorViableNodes: 0, model: MODEL });
  });

  it('a pass stopped by its budget is no warning; one stopped by a failure is', async () => {
    for (let i = 0; i < 3; i++) seedNode(db, `n${i}`, `text ${i}`);
    const budgetWarnings: string[] = [];
    const budget = await runNodeEmbedPass(db, new StubEmbedder({ model: MODEL }), {
      budgetMs: -1,
      onWarning: (m) => budgetWarnings.push(m),
    });
    expect(budget.budgetHit).toBe(true);
    expect(budget.failure).toBeUndefined();
    expect(budgetWarnings).toEqual([]);

    const failureWarnings: string[] = [];
    const boom: Embedder = {
      model: MODEL,
      dims: ANCHOR_EMBED_DIMS,
      embed: () => Promise.reject(new Error('weights corrupt')),
      embedQuery: () => Promise.reject(new Error('weights corrupt')),
    };
    const failed = await runNodeEmbedPass(db, boom, {
      onWarning: (m) => failureWarnings.push(m),
    });
    expect(failed.budgetHit).toBe(false);
    expect(failureWarnings).toEqual([
      'anchor embed pass failed after embedding 0 node(s): weights corrupt — the remainder resumes on the next index run',
    ]);
  });
});
