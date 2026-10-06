import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxSqlite } from '../sqlite-adapter.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * node-sqlite3-wasm locks the file with a `<db>.lock` directory held for as long as any statement
 * is active, and its Statement.get() steps once and leaves the statement active. A cached
 * statement's get() therefore held the lock until that statement next ran: a long rebuild kept
 * readers on other connections out for tens of seconds at a time.
 */
describe('Stmt.get', () => {
  it('releases the file lock once it has returned the row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-stmt-get-lock-'));
    dirs.push(dir);
    const path = join(dir, 'lux.db');
    const db = new LuxSqlite(path);
    db.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b');"
    );
    const byId = db.prepare('SELECT v FROM t WHERE id >= ? ORDER BY id');

    expect(byId.get(1)).toEqual({ v: 'a' });
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(byId.get(2)).toEqual({ v: 'b' });
    expect(byId.get(3)).toBeUndefined();
    expect(existsSync(`${path}.lock`)).toBe(false);
    db.close();
  });
});
