import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import type {
  Database as WasmDatabase,
  Statement as WasmStatement,
  BindValues,
} from 'node-sqlite3-wasm';

// node-sqlite3-wasm ships a CommonJS Emscripten bundle whose exports are attached at
// runtime, so `cjs-module-lexer` cannot see them and native-ESM `import { Database }`
// fails ("no export named 'Database'"). Load it via createRequire (works under native
// ESM, tsx, and vitest alike); the value is the class, typed from the type-only import.
const require = createRequire(import.meta.url);
const { Database: WasmDb } = require('node-sqlite3-wasm') as { Database: typeof WasmDatabase };

/**
 * `LuxSqlite` — a thin, synchronous, better-sqlite3-shaped adapter over
 * `node-sqlite3-wasm` (a WASM SQLite with FTS5, no native dependency).
 *
 * It replicates the exact slice of the better-sqlite3 surface Lux uses so the DB
 * consumers change minimally. See the payload
 * `payloads/2026-07-20-wasm-sqlite-migration/10-ADAPTER-SPEC.md` for the full
 * contract and the reconciliations, each verified against node-sqlite3-wasm@0.8.59.
 */

/**
 * (1) Named-param reconciliation. better-sqlite3 binds bare keys (`{name}`) against
 * `@name` in SQL; node-sqlite3-wasm requires the prefixed key (`{'@name'}`). Prefix
 * bare keys deterministically. Arrays / scalars / null pass through untouched.
 */
function adaptParams(p: unknown): BindValues | undefined {
  if (p && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      out[/^[@:$]/.test(k) ? k : '@' + k] = v;
    }
    return out as BindValues;
  }
  return p as BindValues | undefined;
}

/**
 * (2) Variadic-bind reconciliation. better-sqlite3's statement methods are variadic
 * (`stmt.run(a, b)` binds `?1=a, ?2=b`); node-sqlite3-wasm takes a single `values`.
 * Collapse: 0 args → undefined; 1 → `adaptParams` (object→prefixed / array / scalar);
 * ≥2 → the positional array.
 */
function bindArgs(p: unknown[]): BindValues | undefined {
  if (p.length === 0) return undefined;
  if (p.length === 1) return adaptParams(p[0]);
  return p as BindValues;
}

/** better-sqlite3 `.get()` returns `undefined` for a missing row; node-sqlite3-wasm
 *  returns `null`. Normalise to `undefined` so `... as T | undefined` casts hold. */
function normalizeGet<T>(row: T | null): T | undefined {
  return row === null ? undefined : row;
}

// ── Crash-lock recovery ────────────────────────────────────────────────────────
// node-sqlite3-wasm's VFS implements SQLite locking as a `${path}.lock` *directory*
// (mkdir/rmdir), freed only on graceful close — the OS never reclaims it on process
// death (better-sqlite3 used POSIX fcntl locks, which the kernel drops). So a hard
// crash mid-write leaves a stale `.lock` that wedges every reopen in SQLITE_BUSY.
// Mitigation: (a) close open DBs on SIGINT/SIGTERM/exit so the common Ctrl-C case
// releases the lock; (b) a per-PID owner registry so a deliberate `index rebuild` can
// reclaim a lock whose owner is provably dead, without racing a live writer.

const openInstances = new Set<LuxSqlite>();
let cleanupHooked = false;

function hookProcessCleanup(): void {
  if (cleanupHooked) return;
  cleanupHooked = true;
  const closeAll = (): void => {
    for (const inst of [...openInstances]) {
      try {
        inst.close();
      } catch {
        /* best-effort on shutdown */
      }
    }
  };
  process.on('exit', closeAll);
  process.on('SIGINT', () => {
    closeAll();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    closeAll();
    process.exit(143);
  });
}

function ownersDir(path: string): string {
  return `${path}.owners`;
}

/** Record this process as an owner of the DB at `path` (a per-PID marker; best-effort). */
function registerOwner(path: string): void {
  try {
    mkdirSync(ownersDir(path), { recursive: true });
    writeFileSync(`${ownersDir(path)}/${process.pid}`, hostname());
  } catch {
    /* best-effort; the registry only assists stale-lock recovery */
  }
}

function deregisterOwner(path: string): void {
  try {
    rmSync(`${ownersDir(path)}/${process.pid}`, { force: true });
    rmdirSync(ownersDir(path)); // remove the registry dir iff now empty (last owner out); throws otherwise
  } catch {
    /* best-effort: a live co-owner keeps the dir non-empty (rmdir throws) — fine */
  }
}

/**
 * node-sqlite3-wasm CANNOT open a WAL-mode database (WAL needs shared-memory the WASM VFS
 * can't provide). Lux indexes built under v2.0.0 (better-sqlite3) are WAL, so this engine
 * fails to read them ("unable to open database file" on the first statement). When the WAL
 * has been checkpointed (no `${path}-wal` sidecar) the `.db` file is already complete, and it
 * is a lossless format change away from rollback mode: the header's write/read-version bytes
 * (offsets 18/19: 2 = WAL) become 1 = rollback. Flip them in place so the file opens. Called
 * for writable file-backed opens only; a pending `-wal` (uncommitted frames) is refused loudly.
 */
function ensureRollbackJournal(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch {
    return; // absent / not writable — let the open proceed (or fail with the engine's own error)
  }
  try {
    const hdr = Buffer.alloc(20);
    if (readSync(fd, hdr, 0, 20, 0) < 20) return; // too small to be a SQLite header
    if (hdr.toString('latin1', 0, 16) !== 'SQLite format 3\0') return; // not a SQLite file
    if (hdr[18] !== 2 && hdr[19] !== 2) return; // already rollback (or freshly created) — nothing to do
    if (existsSync(`${path}-wal`)) {
      throw new Error(
        `Cannot open ${path}: it is a WAL database with an un-checkpointed ${path}-wal sidecar. ` +
          `Checkpoint it first with a WAL-capable SQLite, e.g. \`sqlite3 ${path} 'PRAGMA wal_checkpoint(TRUNCATE)'\`.`
      );
    }
    writeSync(fd, Buffer.from([1, 1]), 0, 2, 18); // WAL (2/2) -> rollback (1/1)
  } finally {
    closeSync(fd);
  }
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** A prepared statement, reused for the life of the owning `LuxSqlite`. */
export class Stmt {
  /** Re-prepared on a failed execution (see exec), so NOT readonly. */
  raw: WasmStatement;
  constructor(
    private readonly db: WasmDatabase,
    private readonly sql: string,
    raw: WasmStatement
  ) {
    this.raw = raw;
  }

  /**
   * Run a raw statement call, self-healing on failure. node-sqlite3-wasm leaves a statement that
   * threw mid-execution (e.g. an FTS5 MATCH that hit `no such column` on a user's `col:term` query)
   * in a state where its NEXT auto-reset throws once ("Could not reset statement prior to binding
   * new values") — poisoning the following query on a long-lived handle (the MCP singleton). Finalize
   * the poisoned statement and re-prepare a clean one, then re-throw the ORIGINAL error so the caller
   * classifies it unchanged. Recovery runs only on the failure path — the success path is untouched.
   */
  private exec<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      try {
        this.raw.finalize();
      } catch {
        /* the poisoned statement may re-throw its deferred error at finalize — discard it */
      }
      try {
        this.raw = this.db.prepare(this.sql);
      } catch {
        // Re-prepare can itself fail (a dropped table, real corruption). The caller must still see the
        // ORIGINAL error `e` — never let a re-prepare failure mask/replace it — so swallow this one and
        // fall through to `throw e`. `this.raw` is left at the finalized handle; that is safe because
        // close() tolerates finalizing an already-finalized statement, and the next call self-heals or
        // re-throws through this same path (m5).
      }
      throw e;
    }
  }

  run(...p: unknown[]): RunResult {
    return this.exec(() => this.raw.run(bindArgs(p)));
  }
  get(...p: unknown[]): unknown {
    return this.exec(() => normalizeGet(this.raw.get(bindArgs(p))));
  }
  all(...p: unknown[]): unknown[] {
    return this.exec(() => this.raw.all(bindArgs(p)));
  }
}

export interface LuxSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export class LuxSqlite {
  private db: WasmDatabase;
  /** node-sqlite3-wasm does NOT auto-finalize on close → track reused statements and finalize them. */
  private stmts = new Set<Stmt>();
  /** Savepoint-nesting depth → depth-unique savepoint names. (The BEGIN-vs-SAVEPOINT
   *  decision reads the engine's real `inTransaction`; depth only names savepoints.) */
  private depth = 0;
  private readonly path: string;
  /** true when this instance registered a PID owner-marker (file-backed read-write). */
  private readonly registered: boolean;

  /**
   * Reclaim a stale VFS lock left by a crashed process. Clears `${path}.lock` ONLY when
   * no live owner remains (per-PID markers in `${path}.owners`), so it never races a live
   * concurrent writer. Intended for a deliberate `index rebuild` (derived state — safe).
   * Returns true if a stale lock was cleared.
   */
  static reclaimStaleLock(path: string): boolean {
    const lockDir = `${path}.lock`;
    if (!existsSync(lockDir)) return false;
    const dir = ownersDir(path);
    let markers: string[];
    try {
      markers = readdirSync(dir);
    } catch {
      markers = [];
    }
    let liveOwner = false;
    for (const m of markers) {
      const pid = Number(m);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      let markerHost = '';
      try {
        markerHost = readFileSync(`${dir}/${m}`, 'utf8').trim();
      } catch {
        /* ignore unreadable marker */
      }
      if (markerHost && markerHost !== hostname()) {
        liveOwner = true; // different host — can't verify liveness locally; be conservative
        continue;
      }
      try {
        process.kill(pid, 0); // throws ESRCH if the process is gone
        liveOwner = true;
      } catch {
        try {
          rmSync(`${dir}/${m}`, { force: true }); // prune the dead owner's marker
        } catch {
          /* best-effort */
        }
      }
    }
    if (liveOwner) return false; // a live process holds the DB — respect the lock
    try {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  constructor(path: string, opts: LuxSqliteOptions = {}) {
    this.path = path;
    // node-sqlite3-wasm can't open a WAL-mode DB; convert a checkpointed v2.0.0 WAL index to
    // rollback in place before opening (writable, file-backed opens only — never mutate a
    // read-only target, e.g. an ATTACHed kernel).
    if (path !== ':memory:' && !opts.readonly) ensureRollbackJournal(path);
    // (7) translate option keys: better-sqlite3 `readonly` → node-sqlite3-wasm `readOnly`.
    // undefined values are falsy → engine defaults to read-write + create, matching `new Database(path)`.
    this.db = new WasmDb(path, { readOnly: opts.readonly, fileMustExist: opts.fileMustExist });
    // WAL is gone → the whole-file lock is held for a full write transaction; wait on it
    // generously (a large rebuild/vendor-pack merge can hold it several seconds) before SQLITE_BUSY.
    this.db.run('PRAGMA busy_timeout = 30000');
    this.registered = !opts.readonly && path !== ':memory:';
    if (this.registered) registerOwner(path);
    if (path !== ':memory:') {
      hookProcessCleanup();
      openInstances.add(this);
    }
  }

  /** Cached, reusable prepared statement, tracked for finalize-on-close. Carries its SQL + db so a
   *  failed execution can finalize + re-prepare it instead of poisoning the next call (see Stmt.exec). */
  prepare(sql: string): Stmt {
    const s = new Stmt(this.db, sql, this.db.prepare(sql));
    this.stmts.add(s);
    return s;
  }

  /** Multi-statement DDL (migrations). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  // ── (5) One-shot, engine-auto-finalized statements — for transient SQL that must NOT
  //    enter the finalize registry (else the never-closed MCP DB leaks a handle per call). ──

  /** One-shot parametrised write/DDL. Returns `{changes, lastInsertRowid}`. */
  run(sql: string, values?: unknown): RunResult {
    return this.db.run(sql, adaptParams(values));
  }
  /** One-shot read → all rows. */
  all(sql: string, values?: unknown): unknown[] {
    return this.db.all(sql, adaptParams(values));
  }
  /** One-shot read → first row (or `undefined`). */
  get(sql: string, values?: unknown): unknown {
    return normalizeGet(this.db.get(sql, adaptParams(values)));
  }

  /** better-sqlite3-style pragma; return value is discarded by every Lux call site.
   *  A `journal_mode = WAL` request falls back to memory/delete in-engine. */
  pragma(str: string): unknown {
    return this.db.get(`PRAGMA ${str}`);
  }

  /** Whether a transaction is open. SQLite rolls a whole transaction back on some errors (I/O, a
   *  full disk, `RAISE(ROLLBACK)`), so a caller that caught a statement error checks this before
   *  carrying on as if the rest of its transaction still stood. */
  inTransaction(): boolean {
    return this.db.inTransaction;
  }

  /** better-sqlite3 semantics: returns a callable with the same args; BEGIN/COMMIT with
   *  SAVEPOINT nesting and rollback-on-throw. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const outer = !this.db.inTransaction; // engine's real flag (better-sqlite3 parity)
      const sp = `lux_sp_${this.depth}`; // depth-unique savepoint name
      this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        if (this.db.inTransaction) {
          // guard: a failed COMMIT/RELEASE may already have torn it down
          this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
          if (!outer) this.db.exec(`RELEASE ${sp}`); // ROLLBACK TO leaves the savepoint on the stack → pop it
        }
        throw e;
      } finally {
        this.depth--;
      }
    };
  }

  /** Idempotent (better-sqlite3 parity): node-sqlite3-wasm throws on a 2nd close, so guard it. */
  close(): void {
    if (!this.db.isOpen) return;
    for (const s of this.stmts) {
      try {
        s.raw.finalize();
      } catch {
        // A cached statement's finalize can throw for two reasons, both non-actionable at teardown:
        // (1) node-sqlite3-wasm re-throws a statement's DEFERRED execution error at finalize (e.g. a
        // `searchRanked` FTS5 MATCH that failed on invalid user input — the refusal path classifies
        // that at `.all()` then closes the DB); (2) Stmt.exec already finalized this handle and a
        // re-prepare failed (m5), so it is an already-finalized handle that finalizes again here. The
        // handle is being torn down, so swallow it best-effort (mirroring the process-cleanup closeAll
        // above) rather than let one statement abort close() and crash the process AFTER the honest
        // refusal already printed.
      }
    }
    this.stmts.clear();
    this.db.close();
    openInstances.delete(this);
    if (this.registered) deregisterOwner(this.path);
  }
}
