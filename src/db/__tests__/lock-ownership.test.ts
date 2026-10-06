// Who holds `${db}.lock`, who may clear it, and who may release it.
//
// node-sqlite3-wasm's VFS takes the lock for reads as well as writes and records no owner, so a
// lock directory by itself cannot be told from a stale one, and a holder that lost its lock would
// remove its successor's on unlock. These cases pin the rules that make reclaiming safe:
//   - every lock taken through LuxSqlite names its owner inside the lock directory;
//   - a lock is cleared only when that owner is provably dead, never because no owner is recorded;
//   - the clearing step cannot remove a lock acquired after the check;
//   - a release leaves a lock it does not own alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { setDbNoticeHandler } from '../notices.js';
import { MigrationRunner } from '../migrations.js';
import { LuxSqlite } from '../sqlite-adapter.js';

/** A PID that is not running. 2^22 is above the default macOS/Linux pid_max. */
const DEAD_PID = 4194303;
/** Stands for some other process; the stubbed `kill` decides whether it is alive. */
const OTHER_PID = 424242;

const token = (pid: number, host = hostname()): string =>
  `${pid}-0123456789ab@${encodeURIComponent(host)}`;

let dir: string;
let dbPath: string;
/** Every database notice raised during the test, as `<kind>: <message>`. */
let notices: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-lock-owner-'));
  dbPath = join(dir, 'x.db');
  notices = [];
  setDbNoticeHandler((kind, message) => {
    notices.push(`${kind}: ${message}`);
  });
});
afterEach(() => {
  setDbNoticeHandler(() => {});
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function createDb(): void {
  const db = new LuxSqlite(dbPath);
  db.exec('CREATE TABLE t (a)');
  db.close();
}

/** A lock as this Lux leaves it: the directory plus one owner token per name given. */
function tokenedLock(...tokens: string[]): void {
  mkdirSync(`${dbPath}.lock`);
  for (const t of tokens) mkdirSync(`${dbPath}.lock/${t}`);
}

/** A lock as an older Lux leaves it: an empty directory, old enough not to be mid-acquire. */
function untokenedLock(ageSeconds = 60): void {
  mkdirSync(`${dbPath}.lock`);
  const then = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(`${dbPath}.lock`, then, then);
}

function registry(markers: Record<string, string>): void {
  mkdirSync(`${dbPath}.owners`, { recursive: true });
  for (const [name, host] of Object.entries(markers)) {
    writeFileSync(`${dbPath}.owners/${name}`, host);
  }
}

function killThrows(code: string, before?: () => void): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    before?.();
    throw Object.assign(new Error(`kill failed: ${code}`), { code });
  });
}

/** A read transaction that keeps the lock until `done()`. */
function holdAsReader(path = dbPath): { done: () => void } {
  const h = new LuxSqlite(path, { readonly: true, fileMustExist: true });
  h.exec('BEGIN');
  h.get('SELECT count(*) AS n FROM sqlite_master');
  return {
    done: () => {
      h.exec('COMMIT');
      h.close();
    },
  };
}

describe('every lock holder is identifiable', () => {
  const mine = new RegExp(`^${process.pid}-[0-9a-f]+@`);

  it('a reader names itself in the lock, and takes its name out again', () => {
    createDb();
    const reader = holdAsReader();
    expect(readdirSync(`${dbPath}.lock`)).toEqual([expect.stringMatching(mine)]);
    reader.done();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('a writer names itself in the lock', () => {
    createDb();
    const h = new LuxSqlite(dbPath);
    h.exec('BEGIN IMMEDIATE');
    expect(readdirSync(`${dbPath}.lock`)).toEqual([expect.stringMatching(mine)]);
    h.exec('ROLLBACK');
    h.close();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('names itself in the lock of an ATTACHed database too', () => {
    createDb();
    const other = join(dir, 'other.db');
    copyFileSync(dbPath, other);
    const h = new LuxSqlite(dbPath);
    h.run('ATTACH DATABASE ? AS other', other);
    h.exec('BEGIN');
    h.get('SELECT count(*) AS n FROM other.sqlite_master');
    expect(readdirSync(`${other}.lock`)).toEqual([expect.stringMatching(mine)]);
    h.exec('COMMIT');
    h.close();
    expect(existsSync(`${other}.lock`)).toBe(false);
  });
});

describe('a live holder keeps its lock', () => {
  it('a reader with no registry at all is not reclaimed', () => {
    createDb();
    const reader = holdAsReader();
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    reader.done();
  });

  it('a reader is not reclaimed because some other owner is dead', () => {
    createDb();
    registry({ [DEAD_PID]: hostname() });
    const reader = holdAsReader();
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    reader.done();
  });

  it('says who holds the lock when asked, without a notice for ordinary contention', () => {
    createDb();
    const reader = holdAsReader();
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(notices).toEqual([]);
    expect(LuxSqlite.describeLock(dbPath)).toMatch(new RegExp(`pid ${process.pid} is alive`));
    reader.done();
    expect(LuxSqlite.describeLock(dbPath)).toBeUndefined();
  });
});

describe('release removes only a lock this process owns', () => {
  it('leaves the lock alone when its own was removed and another now stands there', () => {
    createDb();
    const reader = holdAsReader();
    // Another process clears this reader's lock and a successor acquires the path.
    rmSync(`${dbPath}.lock`, { recursive: true });
    mkdirSync(`${dbPath}.lock`);

    reader.done();

    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    expect(notices.join('\n')).toMatch(
      /^notice: database lock .* was removed while pid \d+ held it/
    );
  });
});

describe('a lock is cleared only when its owner is provably dead', () => {
  it('clears a lock whose token names a dead pid on this host', () => {
    tokenedLock(token(DEAD_PID));
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it.each([
    ['EPERM', /pid 424242 cannot be proven dead.*EPERM/],
    ['EWHATEVER', /pid 424242 cannot be proven dead.*EWHATEVER/],
  ])('refuses when kill(pid, 0) fails with %s', (code, message) => {
    tokenedLock(token(OTHER_PID));
    killThrows(code);
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(readdirSync(`${dbPath}.lock`)).toEqual([token(OTHER_PID)]);
    expect(notices.join('\n')).toMatch(message);
  });

  it('refuses an owner on another host, naming the pid and the host', () => {
    tokenedLock(token(OTHER_PID, 'elsewhere.example'));
    killThrows('ESRCH');
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
    expect(notices.join('\n')).toMatch(/pid 424242 is on another host \(elsewhere\.example\)/);
  });

  it('refuses when one of several tokens is not provably dead', () => {
    tokenedLock(token(DEAD_PID), token(process.pid));
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(readdirSync(`${dbPath}.lock`).sort()).toEqual(
      [token(DEAD_PID), token(process.pid)].sort()
    );
  });

  it.each(['junk', `${DEAD_PID}`, `${DEAD_PID}-xyz@${hostname()}`, `0-ab@${hostname()}`])(
    'refuses a lock containing "%s", which is not an owner token',
    (entry) => {
      tokenedLock(token(DEAD_PID), entry);
      expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}.lock`)).toBe(true);
      expect(notices.join('\n')).toContain(`"${entry}", which is not an owner token`);
    }
  );
});

describe('a lock that names no owner is never stale', () => {
  const HOW_TO_CLEAR =
    /confirm that no lux process is running, then remove the directory .*x\.db\.lock/;

  // What a reader from a Lux that predates owner tokens looks like while it is alive: an empty lock
  // directory. An earlier writer of that Lux crashed and left its marker in the owner registry.
  it('refuses a live old-build reader’s lock although the registry holds only a dead marker', () => {
    untokenedLock();
    registry({ [DEAD_PID]: hostname() });

    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);

    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    expect(existsSync(`${dbPath}.owners/${DEAD_PID}`)).toBe(true);
    expect(notices.join('\n')).toMatch(/names no owner/);
    expect(notices.join('\n')).toMatch(HOW_TO_CLEAR);
  });

  it.each([
    ['no registry', undefined],
    ['an empty registry', {}],
    ['a registry of dead markers', { [DEAD_PID]: hostname(), [DEAD_PID - 1]: hostname() }],
    [
      'a registry with entries that are not pids',
      { abc: hostname(), [`${DEAD_PID}.tmp`]: hostname() },
    ],
  ])('refuses an old lock with no token and %s', (_name, markers) => {
    untokenedLock();
    if (markers) registry(markers);
    killThrows('ESRCH'); // every pid would read as dead: the registry must not be what decides
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
    expect(notices.join('\n')).toMatch(HOW_TO_CLEAR);
  });

  it('says how to clear it in the reason an open reports', () => {
    untokenedLock();
    expect(LuxSqlite.describeLock(dbPath)).toMatch(HOW_TO_CLEAR);
  });

  it('treats a fresh lock with no token as an acquire in progress, without a notice', () => {
    mkdirSync(`${dbPath}.lock`);
    registry({ [DEAD_PID]: hostname() });
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    expect(existsSync(`${dbPath}.owners/${DEAD_PID}`)).toBe(true);
    expect(notices).toEqual([]);
  });
});

describe('the clearing step cannot remove a lock acquired after the check', () => {
  /** What a second reclaimer followed by a new holder leaves at the path. */
  function replaceWithLiveLock(): void {
    rmSync(`${dbPath}.lock`, { recursive: true });
    mkdirSync(`${dbPath}.lock`);
    mkdirSync(`${dbPath}.lock/${token(process.pid)}`);
  }

  it('a lock that changed hands during the check survives', () => {
    tokenedLock(token(OTHER_PID));
    killThrows('ESRCH', replaceWithLiveLock);
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    expect(readdirSync(`${dbPath}.lock`)).toEqual([token(process.pid)]);
  });

  it('two reclaimers cannot both proceed: the one that lost the lock reports nothing cleared', () => {
    tokenedLock(token(OTHER_PID));
    killThrows('ESRCH', () => rmSync(`${dbPath}.lock`, { recursive: true }));
    expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
  });
});

describe('a read-only sibling open does no reclaim and no pruning', () => {
  function migratedIndex(): string {
    const p = join(dir, 'sibling', '.lux', 'lux.db');
    mkdirSync(join(dir, 'sibling', '.lux'), { recursive: true });
    new LuxDatabase(p).close();
    return p;
  }

  it('does not reclaim, prune or register there', () => {
    const p = migratedIndex();
    mkdirSync(`${p}.owners`);
    writeFileSync(`${p}.owners/${DEAD_PID}`, hostname());
    const reclaim = vi.spyOn(LuxSqlite, 'reclaimStaleLock');

    LuxDatabase.openSiblingReadOnly(p, MigrationRunner.latestVersion()).close();

    expect(reclaim).not.toHaveBeenCalled();
    expect(readdirSync(`${p}.owners`)).toEqual([`${DEAD_PID}`]);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('whereas a read-only open of this repository’s own index does reclaim', () => {
    const p = migratedIndex();
    const reclaim = vi.spyOn(LuxSqlite, 'reclaimStaleLock');
    new LuxDatabase(p, false, { readOnly: true }).close();
    expect(reclaim).toHaveBeenCalledWith(p);
  });
});
