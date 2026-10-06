import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { driver } from './driver.js';
import { dbNotice } from './notices.js';

// ── Who holds `${db}.lock` ─────────────────────────────────────────────────────────────────────
// The SQLite engine's VFS locks a database by creating the directory `${db}.lock` and unlocks by
// removing it, for readers and writers alike. Left to itself it records no owner and checks none on
// release. Two consequences follow, and this module closes both:
//
//   - A lock directory says nothing about its holder, so "is this lock stale?" cannot be answered
//     from the lock. Every acquire therefore puts an owner token inside the directory:
//     `${db}.lock/<pid>-<nonce>@<host>`.
//   - A holder whose lock was removed from under it would, on unlock, remove whatever lock is at
//     that path by then, which is its successor's. Every release therefore removes its own token
//     first and leaves the directory alone when the token is not there.
//
// The vendored engine routes its lock and unlock calls through `driver.lockHooks`; the hooks
// installed here are the only place a lock directory is created or released.

/** A lock directory with no token younger than this is an acquire in progress: refused quietly. */
const ACQUIRE_GRACE_MS = 5000;

const TOKEN = /^([1-9]\d*)-([0-9a-f]+)@(.+)$/;
const PID = /^[1-9]\d*$/;

type LockHooks = typeof driver.lockHooks;
interface OwnerHooks extends LockHooks {
  /** This process's name inside every lock it holds. */
  ownerToken: string;
}

function errno(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** An fs/process error's errno code (ESRCH, EPERM, …), or the error itself when it carries none. */
function errnoCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : String(e);
}

/**
 * Make every lock the engine takes in this process carry its owner, and be released only by its
 * owner. The engine is loaded once per process, so the hooks are too: a second copy of this module
 * finds them already in place.
 */
export function installLockOwnership(): void {
  const current = driver.lockHooks as Partial<OwnerHooks>;
  if (typeof current.ownerToken === 'string') return;

  // The nonce separates this process from an earlier one that had the same pid.
  const token = `${process.pid}-${randomBytes(6).toString('hex')}@${encodeURIComponent(hostname())}`;
  const hooks: OwnerHooks = {
    ownerToken: token,
    lock: (lockDir) => acquire(lockDir, token),
    unlock: (lockDir) => release(lockDir, token),
  };
  driver.lockHooks = hooks;
}

/** Take the lock and name its owner. Throws EEXIST (the VFS's "busy") when someone else has it. */
function acquire(lockDir: string, token: string): void {
  mkdirSync(lockDir);
  try {
    mkdirSync(`${lockDir}/${token}`);
  } catch (e) {
    // The directory went away between the two steps: report busy so SQLite retries the acquire.
    if (errnoCode(e) === 'ENOENT') throw errno('EEXIST', `lock ${lockDir} changed during acquire`);
    try {
      rmdirSync(lockDir);
    } catch {
      // lux-intentional-swallow: best-effort undo; the token error rethrown below is the one that matters.
    }
    throw e;
  }
}

/** Give the lock back, but only if the lock at that path is still the one this process took. */
function release(lockDir: string, token: string): void {
  try {
    rmdirSync(`${lockDir}/${token}`);
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw e;
    dbNotice(
      'notice',
      `database lock ${lockDir} was removed while pid ${process.pid} held it; ` +
        `leaving whatever lock is at that path now untouched.`
    );
    throw errno('ENOENT', `lock ${lockDir} is no longer held by this process`); // the VFS reads ENOENT as "unlocked"
  }
  rmdirSync(lockDir);
}

/** The owner registry of a Lux that predates tokens: one `<pid>` file per read-write open, holding
 *  its hostname. Still written, never consulted when deciding whether a lock is stale. */
export function ownersDir(dbPath: string): string {
  return `${dbPath}.owners`;
}

type Verdict = { dead: true } | { dead: false; why: string; alive?: true };

/** Only `kill(pid, 0)` failing with ESRCH, for a pid on this host, proves an owner dead. */
function judgeOwner(pid: number, host: string): Verdict {
  if (host !== hostname()) {
    return {
      dead: false,
      why: `owner pid ${pid} is on another host (${host}), so it cannot be checked from here`,
    };
  }
  try {
    process.kill(pid, 0);
    return { dead: false, alive: true, why: `owner pid ${pid} is alive` };
  } catch (e) {
    // lux-intentional-swallow: the errno is the answer; a refusal built from it is reported by reclaimStaleLock.
    const code = errnoCode(e);
    if (code === 'ESRCH') return { dead: true };
    return {
      dead: false,
      why: `owner pid ${pid} cannot be proven dead (kill(pid, 0) failed with ${code})`,
    };
  }
}

type LockState =
  | { kind: 'absent' }
  /** Held, or not provably stale. `expected` marks ordinary contention, which is not worth a line. */
  | { kind: 'held'; why: string; expected: boolean }
  | { kind: 'stale'; tokens: string[] };

function held(why: string, expected = false): LockState {
  return { kind: 'held', why, expected };
}

function inspectLock(dbPath: string): LockState {
  const lockDir = `${dbPath}.lock`;
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch (e) {
    // lux-intentional-swallow: no lock is the ordinary case; any other error becomes a refusal the caller reports.
    const code = errnoCode(e);
    return code === 'ENOENT' ? { kind: 'absent' } : held(`it cannot be listed (${code})`);
  }

  if (entries.length > 0) {
    for (const entry of entries) {
      const m = TOKEN.exec(entry);
      if (!m) return held(`it contains "${entry}", which is not an owner token`);
      let host: string;
      try {
        host = decodeURIComponent(m[3]);
      } catch {
        // lux-intentional-swallow: an undecodable host makes the entry a non-token; returned as a refusal the caller reports.
        return held(`it contains "${entry}", which is not an owner token`);
      }
      const verdict = judgeOwner(Number(m[1]), host);
      if (!verdict.dead) return held(verdict.why, verdict.alive === true);
    }
    return { kind: 'stale', tokens: entries };
  }

  // No token. Either an acquire is between its two steps, or the lock was taken by a Lux that
  // predates tokens. Neither can be told from a live holder, so neither is ever stale: the owner
  // registry cannot settle it, because such a Lux's readers never registered there.
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockDir).mtimeMs;
  } catch (e) {
    // lux-intentional-swallow: the lock went away, or the error becomes a refusal the caller reports.
    const code = errnoCode(e);
    return code === 'ENOENT' ? { kind: 'absent' } : held(`it cannot be inspected (${code})`);
  }
  if (ageMs < ACQUIRE_GRACE_MS) return held('it is being acquired', true);
  return held(
    `it names no owner, so nothing proves its holder dead. To clear it by hand, first confirm ` +
      `that no lux process is running, then remove the directory ${lockDir}`
  );
}

/** Drop registry markers whose process is provably dead, so the registry does not grow without bound. */
function pruneDeadRegistryMarkers(dbPath: string): void {
  const registry = ownersDir(dbPath);
  try {
    for (const marker of readdirSync(registry)) {
      if (!PID.test(marker)) continue;
      const host = readFileSync(`${registry}/${marker}`, 'utf8').trim();
      if (host !== '' && judgeOwner(Number(marker), host).dead) {
        rmSync(`${registry}/${marker}`, { force: true });
      }
    }
    rmdirSync(registry); // only when now empty; throws otherwise
  } catch {
    // lux-intentional-swallow: best-effort housekeeping; the reclaim it follows has already succeeded.
  }
}

/**
 * Clear `${dbPath}.lock` when, and only when, its holder is provably dead. Returns true if cleared.
 *
 * A lock taken by this Lux names its owner in a token. It is reclaimed when every token names a
 * pid on this host for which `kill(pid, 0)` fails with ESRCH. The reclaim removes the dead owner's
 * token first: that `rmdir` succeeds for one reclaimer only, and only while that same lock is still
 * there, so a lock acquired after the check is never removed, and two reclaimers cannot both proceed.
 *
 * A lock that names no owner is never stale, whatever the owner registry holds: a live reader from
 * a Lux that predates tokens looks exactly like that. It is refused, and the message says how to
 * clear it by hand.
 *
 * Everything else is left alone too: a live owner, EPERM or any other `kill` error, an owner on
 * another host, an entry that is not a token. Each refusal is reported as a notice with the pid or
 * host and the reason, except ordinary contention (a live owner on this host, or an acquire in
 * progress), which `describeLock` reports to a caller whose open then fails.
 *
 * A dead owner whose pid has since been reused by an unrelated live process reads as alive. The
 * lock is then safe but stuck until that process exits or the lock directory is removed by hand.
 */
export function reclaimStaleLock(dbPath: string): boolean {
  const lockDir = `${dbPath}.lock`;
  const found = inspectLock(dbPath);
  if (found.kind === 'absent') return false;
  if (found.kind === 'held') {
    if (!found.expected) {
      dbNotice('notice', `not clearing database lock ${lockDir}: ${found.why}.`);
    }
    return false;
  }

  try {
    for (const token of found.tokens) rmdirSync(`${lockDir}/${token}`);
    rmdirSync(lockDir);
  } catch {
    // lux-intentional-swallow: the lock changed hands after the check, so it is someone else's now and nothing was cleared.
    return false;
  }
  pruneDeadRegistryMarkers(dbPath);
  return true;
}

/** Why `${dbPath}.lock` is still there, for the message of an open that failed on it. */
export function describeLock(dbPath: string): string | undefined {
  const found = inspectLock(dbPath);
  if (found.kind === 'absent') return undefined;
  if (found.kind === 'held') return `lock ${dbPath}.lock: ${found.why}`;
  return `lock ${dbPath}.lock was left by a process that is no longer running`;
}
