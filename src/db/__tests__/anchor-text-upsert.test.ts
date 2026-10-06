import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LuxDatabase } from '../index.js';
import { Stmt } from '../sqlite-adapter.js';

const FTS_DELETE = 'DELETE FROM structural_node_fts WHERE node_id = ?';

function anchor(db: LuxDatabase, nodeId: string, name: string): void {
  db.upsertStructuralNode({
    id: nodeId,
    node_type: 'symbol',
    file_path: 'a.ts',
    symbol_name: name,
    updated_at: 1,
  });
  db.upsertNodeAnchorText({
    node_id: nodeId,
    prepared: `prepared ${name}`,
    content_hash: `hash-${name}`,
    name,
    identifiers: name,
    qualified: nodeId,
    path_segments: 'src services',
    context: `function ${name}()`,
  });
}

/** Node ids of the FTS rows matching `term` (one entry per row, so a duplicate row shows twice). */
function ftsMatches(db: LuxDatabase, term: string): string[] {
  return db.rankAnchorsLexical(`name:${term}`, 100).map((row) => row.node_id);
}

/**
 * structural_node_fts keys rows on an UNINDEXED node_id, so deleting a node's row scans the whole
 * table. Running that delete for every upserted node made anchor materialization quadratic in the
 * node count (issue #15); it must run only for a node that already has a row.
 */
describe('upsertNodeAnchorText', () => {
  let db: LuxDatabase;
  let ftsDeletes: number;

  beforeEach(() => {
    db = new LuxDatabase(':memory:');
    ftsDeletes = 0;
    const run = Stmt.prototype.run;
    vi.spyOn(Stmt.prototype, 'run').mockImplementation(function (this: Stmt, ...args: unknown[]) {
      if ((this as unknown as { sql: string }).sql === FTS_DELETE) ftsDeletes++;
      return run.apply(this, args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('indexes new nodes without scanning the FTS table for rows to replace', () => {
    db.transaction(() => {
      for (let i = 0; i < 50; i++) anchor(db, `symbol:ts:a.ts#f${i}`, `f${i}`);
    });

    expect(ftsDeletes).toBe(0);
    expect(ftsMatches(db, 'f7')).toEqual(['symbol:ts:a.ts#f7']);
  });

  it('replaces the FTS row of a node that already has one', () => {
    anchor(db, 'symbol:ts:a.ts#f', 'before');
    anchor(db, 'symbol:ts:a.ts#f', 'after');

    expect(ftsDeletes).toBe(1);
    expect(ftsMatches(db, 'before')).toEqual([]);
    expect(ftsMatches(db, 'after')).toEqual(['symbol:ts:a.ts#f']);
  });

  it('indexes a node again after its anchor rows were deleted, without a duplicate', () => {
    anchor(db, 'symbol:ts:a.ts#f', 'before');
    db.deleteNodeAnchorRowsForNodeIds(['symbol:ts:a.ts#f']);
    anchor(db, 'symbol:ts:a.ts#f', 'after');

    expect(ftsMatches(db, 'before')).toEqual([]);
    expect(ftsMatches(db, 'after')).toEqual(['symbol:ts:a.ts#f']);
  });

  it('indexes a node again after the overlay was cleared, without a duplicate', () => {
    anchor(db, 'symbol:ts:a.ts#f', 'before');
    db.clearOverlay();
    anchor(db, 'symbol:ts:a.ts#f', 'after');

    expect(ftsMatches(db, 'before')).toEqual([]);
    expect(ftsMatches(db, 'after')).toEqual(['symbol:ts:a.ts#f']);
  });
});
