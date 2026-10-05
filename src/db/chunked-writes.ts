/**
 * Bulk writes in bounded transactions.
 *
 * Under the rollback journal a write outside a transaction pays a journal create/sync/delete, so
 * bulk writes are batched. One transaction per phase, though, holds the database's whole-file lock
 * for as long as the phase runs, and a reader on another connection waits on it until its 30 s
 * busy_timeout gives up. `writeInChunks` commits every `chunkSize` items instead: commits stay
 * O(items / chunkSize), and no transaction outlives one chunk.
 */

/** The slice of LuxDatabase / LuxSqlite this needs, so test doubles can provide it. */
export interface ChunkedWriteTarget {
  transaction<T>(fn: () => T): T;
  inTransaction(): boolean;
}

export interface ChunkedWriteResult {
  /** Items whose writes are committed. */
  committed: number;
  /** The error that stopped the writes, if any. Nothing after the failing item was written. */
  error?: Error;
}

/** Items per commit for row-sized writes: short enough that readers are not starved. */
export const ROWS_PER_COMMIT = 2_000;

/** Files per commit for per-file writes, each of which may write several rows. */
export const FILES_PER_COMMIT = 500;

/**
 * Call `write` for every item, committing after each `chunkSize` items. When nested inside a
 * caller's transaction, each chunk is a savepoint of it.
 *
 * A `write` that throws stops the run. If its transaction is still open, the error was confined to
 * the failing statement, so the items before it in the chunk commit. If the error aborted the
 * transaction (SQLite rolls the whole transaction back on I/O errors, a full disk, `RAISE(ROLLBACK)`
 * and the like), the chunk is lost and only earlier chunks count as committed. Either way the
 * original error is returned, never a follow-on failure to commit.
 */
export function writeInChunks<T>(
  db: ChunkedWriteTarget,
  items: readonly T[],
  chunkSize: number,
  write: (item: T) => void
): ChunkedWriteResult {
  let committed = 0;
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    let written = 0;
    let error: Error | undefined;
    try {
      db.transaction(() => {
        for (const item of chunk) {
          try {
            write(item);
          } catch (e) {
            const failure = e instanceof Error ? e : new Error(String(e));
            if (!db.inTransaction()) throw failure;
            error = failure;
            return;
          }
          written++;
        }
      });
    } catch (e) {
      return { committed, error: e instanceof Error ? e : new Error(String(e)) };
    }
    committed += written;
    if (error) return { committed, error };
  }
  return { committed };
}

/**
 * Call `write` for every item, committing after each `chunkSize` items, for callers that keep no
 * partial result: a chunk is all-or-nothing, so a `write` that throws rolls its chunk back (earlier
 * chunks stay committed) and the error propagates.
 */
export function writeAllInChunks<T>(
  db: ChunkedWriteTarget,
  items: readonly T[],
  chunkSize: number,
  write: (item: T) => void
): void {
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    db.transaction(() => {
      for (const item of chunk) write(item);
    });
  }
}
