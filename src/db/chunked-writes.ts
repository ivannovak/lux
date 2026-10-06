/**
 * Bulk writes in bounded transactions.
 *
 * Under the rollback journal a write outside a transaction pays a journal create/sync/delete, so
 * bulk writes are batched. But node-sqlite3-wasm locks the whole file with one lock for readers and
 * writers alike, taken and dropped with no queue: a reader on another connection polls for it until
 * its 30 s busy_timeout gives up. One transaction per phase held that lock for as long as the phase
 * ran, and back-to-back transactions left a reader only instants in which to get it.
 *
 * So a transaction ends after `chunkSize` items or `MAX_TRANSACTION_MS`, whichever comes first. One
 * that ran out of time is followed by `READER_WINDOW_MS` with the lock free, long enough for a
 * waiting reader's next poll to find it. Commits stay O(items / chunkSize + duration /
 * MAX_TRANSACTION_MS), never O(items).
 */

/** Longest a bulk write holds the lock before it commits and lets readers in. */
export const MAX_TRANSACTION_MS = 500;

/** How long the lock stays free after a transaction that ran out of time. */
const READER_WINDOW_MS = 20;

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

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run one transaction over `items[start..]`, ending it after `chunkSize` items or once it has held
 * the lock for MAX_TRANSACTION_MS. Returns how many items it took; `onItem` writes one and returns
 * false to stop the run.
 */
function runChunk<T>(
  db: ChunkedWriteTarget,
  items: readonly T[],
  start: number,
  chunkSize: number,
  onItem: (item: T) => boolean
): { taken: number; ranOutOfTime: boolean } {
  const end = Math.min(items.length, start + chunkSize);
  const deadline = Date.now() + MAX_TRANSACTION_MS;
  let taken = 0;
  let ranOutOfTime = false;
  db.transaction(() => {
    for (let index = start; index < end; index++) {
      taken++;
      if (!onItem(items[index])) return;
      if (index + 1 < end && Date.now() >= deadline) {
        ranOutOfTime = true;
        return;
      }
    }
  });
  return { taken, ranOutOfTime };
}

/** Let a waiting reader in after a transaction that ran out of time (a no-op inside a caller's). */
function afterChunk(db: ChunkedWriteTarget, ranOutOfTime: boolean): void {
  if (ranOutOfTime && !db.inTransaction()) pause(READER_WINDOW_MS);
}

/**
 * Call `write` for every item in bounded transactions (see above). When nested inside a caller's
 * transaction, each chunk is a savepoint of it.
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
  let start = 0;
  while (start < items.length) {
    let written = 0;
    let error: Error | undefined;
    let chunk: { taken: number; ranOutOfTime: boolean };
    try {
      chunk = runChunk(db, items, start, chunkSize, (item) => {
        try {
          write(item);
        } catch (e) {
          const failure = e instanceof Error ? e : new Error(String(e));
          if (!db.inTransaction()) throw failure;
          error = failure;
          return false;
        }
        written++;
        return true;
      });
    } catch (e) {
      // lux-intentional-swallow: returned as the result's error, which every caller reports or rethrows.
      return { committed, error: e instanceof Error ? e : new Error(String(e)) };
    }
    committed += written;
    if (error) return { committed, error };
    start += chunk.taken;
    afterChunk(db, chunk.ranOutOfTime);
  }
  return { committed };
}

/**
 * Call `write` for every item in bounded transactions, for callers that keep no partial result: a
 * chunk is all-or-nothing, so a `write` that throws rolls its chunk back (earlier chunks stay
 * committed) and the error propagates.
 */
export function writeAllInChunks<T>(
  db: ChunkedWriteTarget,
  items: readonly T[],
  chunkSize: number,
  write: (item: T) => void
): void {
  let start = 0;
  while (start < items.length) {
    const chunk = runChunk(db, items, start, chunkSize, (item) => {
      write(item);
      return true;
    });
    start += chunk.taken;
    afterChunk(db, chunk.ranOutOfTime);
  }
}
