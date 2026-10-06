import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDbNoticeHandler } from '../notices.js';
import { LuxSqlite } from '../sqlite-adapter.js';

/** A PID that is guaranteed dead: spawn a node that exits immediately, then reuse its PID. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid ?? 2147483646;
}

/**
 * Adapter-level validation of the reconciliations that make `LuxSqlite` a faithful
 * better-sqlite3 stand-in over node-sqlite3-wasm — the crux fixes from the
 * WASM-SQLite migration payload (variadic positional binds, savepoint nesting +
 * RELEASE, get()→undefined, one-shot auto-finalized statements).
 */
function freshDb(): LuxSqlite {
  const db = new LuxSqlite(':memory:');
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)`);
  return db;
}

describe('LuxSqlite adapter', () => {
  it('binds multiple positional params on run/get (B1)', () => {
    const db = freshDb();
    const r = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 'y');
    expect(r.changes).toBe(1);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);

    const row = db.prepare('SELECT a, b FROM t WHERE a = ? AND b = ?').get('x', 'y');
    expect(row).toEqual({ a: 'x', b: 'y' });

    // the setEdgeOwnershipBatch shape: UPDATE ... = ? WHERE id = ?
    expect(db.prepare('UPDATE t SET a = ? WHERE b = ?').run('z', 'y').changes).toBe(1);
    expect((db.prepare('SELECT a FROM t WHERE b = ?').get('y') as { a: string }).a).toBe('z');
    db.close();
  });

  it('binds 2 positionals on all() — the getStructuralEdgesForNode shape', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('k', 'other'); // node as source
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('other', 'k'); // node as target
    const rows = db.prepare('SELECT id FROM t WHERE a = ? OR b = ?').all('k', 'k');
    expect(rows.length).toBe(2); // BOTH source- and target-matches (would be 1 if the 2nd bind were dropped)
    db.close();
  });

  it('reconciles named params via @-prefixing', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: 'n1', b: 'n2' });
    expect((db.prepare('SELECT b FROM t WHERE a = @a').get({ a: 'n1' }) as { b: string }).b).toBe(
      'n2'
    );
    db.close();
  });

  it('returns undefined (not null) for a missing row', () => {
    const db = freshDb();
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(999)).toBeUndefined();
    db.close();
  });

  it('nests transactions: inner throw rolls back to savepoint, outer continues, savepoint released', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a) VALUES (?)').run('outer-before');

    const failingInner = db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run('inner-doomed');
      throw new Error('boom');
    });

    db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run('outer-during');
      expect(() => failingInner()).toThrow('boom'); // inner rolls back its savepoint only
      // A SECOND nested transaction after the caught one must succeed — proving the
      // failed savepoint was RELEASEd (not left dangling on the stack).
      db.transaction(() => db.prepare('INSERT INTO t (a) VALUES (?)').run('inner-ok'))();
    })();

    const names = (db.prepare('SELECT a FROM t ORDER BY id').all() as { a: string }[]).map(
      (r) => r.a
    );
    expect(names).toEqual(['outer-before', 'outer-during', 'inner-ok']); // 'inner-doomed' gone
    db.close();
  });

  it('rolls the whole outer transaction back when it throws', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a) VALUES (?)').run('kept');
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run('discarded');
      throw new Error('outer-fail');
    });
    expect(() => tx()).toThrow('outer-fail');
    expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('supports one-shot run/all/get(sql, values) that auto-finalize', () => {
    const db = freshDb();
    expect(db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['p', 'q']).changes).toBe(1);
    expect((db.get('SELECT a FROM t WHERE b = ?', 'q') as { a: string }).a).toBe('p');
    expect(db.all('SELECT * FROM t').length).toBe(1);
    // the one-shots must NOT enter the finalize registry (else the never-closed MCP DB leaks)
    expect((db as unknown as { stmts: Set<unknown> }).stmts.size).toBe(0);
    db.close();
  });

  it('close() is idempotent (better-sqlite3 parity)', () => {
    const db = freshDb();
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  // The acceptance cases of the stale-lock issue: with `process.kill` stubbed, only ESRCH reclaims.
  // lock-ownership.test.ts covers the rest of the rule (tokens, races, locks that name no owner).
  describe('stale-lock recovery (reclaimStaleLock)', () => {
    const pid = 424242; // the stubbed kill answers for it
    const token = `${pid}-0123456789ab@${encodeURIComponent(hostname())}`;
    let dir: string;
    let dbPath: string;
    let notices: string[];
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'lux-lock-'));
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

    /** A lock whose owner token names `pid`, plus that owner's marker in the registry. */
    function lockOwnedBy(ownerToken: string, ownerPid: number): void {
      mkdirSync(`${dbPath}.lock/${ownerToken}`, { recursive: true });
      mkdirSync(`${dbPath}.owners`);
      writeFileSync(`${dbPath}.owners/${ownerPid}`, hostname());
    }

    function killThrows(code: string | undefined): void {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error(`kill failed: ${code ?? 'no code'}`), { code });
      });
    }

    it('returns false when there is no lock', () => {
      expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
    });

    it('clears a stale lock left by a dead owner', () => {
      const dead = deadPid();
      lockOwnedBy(`${dead}-0123456789ab@${encodeURIComponent(hostname())}`, dead);
      expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(true);
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
    });

    it('does NOT clear a lock still held by a live owner', () => {
      lockOwnedBy(`${process.pid}-0123456789ab@${encodeURIComponent(hostname())}`, process.pid);
      expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}.lock`)).toBe(true);
    });

    it('reclaims when kill(pid, 0) reports ESRCH, and prunes the dead owner’s registry marker', () => {
      lockOwnedBy(token, pid);
      killThrows('ESRCH');
      expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(true);
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
      expect(existsSync(`${dbPath}.owners/${pid}`)).toBe(false);
    });

    it.each([
      ['EPERM — the owner is alive under another user', 'EPERM', /pid 424242.*EPERM/],
      ['an unknown code', 'EWHATEVER', /pid 424242.*EWHATEVER/],
      ['no code at all', undefined, /pid 424242 cannot be proven dead/],
    ])('refuses when kill(pid, 0) fails with %s', (_name, code, message) => {
      lockOwnedBy(token, pid);
      killThrows(code);
      expect(LuxSqlite.reclaimStaleLock(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}.lock/${token}`)).toBe(true);
      expect(existsSync(`${dbPath}.owners/${pid}`)).toBe(true);
      expect(notices.join('\n')).toMatch(message);
    });
  });
});
