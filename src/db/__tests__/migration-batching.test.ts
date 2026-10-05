import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { MigrationRunner } from '../migrations.js';
import { LuxSqlite } from '../sqlite-adapter.js';

// node-sqlite3-wasm's VFS calls openSync on the shared CommonJS fs object, so counting opens of
// `<db>-journal` there counts committed write transactions under `journal_mode = delete`.
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lux-migration-batching-'));
  dirs.push(dir);
  return join(dir, 'lux.db');
}

function countJournals<T>(fn: () => T): { result: T; journals: number } {
  let journals = 0;
  const openSync = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && path.endsWith('-journal')) journals++;
    return (openSync as (...args: unknown[]) => number)(path, ...rest);
  });
  const result = fn();
  vi.restoreAllMocks();
  return { result, journals };
}

describe('migration batching (issue #15)', () => {
  it('applies every pending migration of a fresh index in one commit', () => {
    // Two commits in all: creating schema_version, then every migration together.
    const path = tempDbPath();
    const pending = MigrationRunner.latestVersion();

    const { result: db, journals } = countJournals(() => new LuxDatabase(path));

    expect(db.getAppliedSchemaVersion()).toBe(pending);
    expect(pending).toBeGreaterThan(1);
    expect(journals).toBe(2);
    db.close();
  });

  it('keeps the migrations before a failing one applied, and none of the failing one', () => {
    const sqlite = new LuxSqlite(':memory:');
    const runner = new MigrationRunner(sqlite);
    vi.spyOn(runner, 'loadMigrations').mockReturnValue([
      { version: 1, name: 'first', sql: 'CREATE TABLE first_table (x INTEGER);' },
      {
        version: 2,
        name: 'broken',
        sql: 'CREATE TABLE half_table (x INTEGER); INSERT INTO missing_table VALUES (1);',
      },
      { version: 3, name: 'third', sql: 'CREATE TABLE third_table (x INTEGER);' },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => runner.runMigrations()).toThrow(/missing_table/);

    const tables = (
      sqlite.all(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`) as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(runner.getCurrentVersion()).toBe(1);
    expect(tables).toContain('first_table');
    expect(tables).not.toContain('half_table');
    expect(tables).not.toContain('third_table');
    sqlite.close();
  });

  it('surfaces the original error, and keeps nothing, when a migration aborts the whole transaction', () => {
    const sqlite = new LuxSqlite(':memory:');
    const runner = new MigrationRunner(sqlite);
    vi.spyOn(runner, 'loadMigrations').mockReturnValue([
      {
        version: 1,
        name: 'first',
        sql:
          'CREATE TABLE first_table (x INTEGER); CREATE TABLE guard (x INTEGER); ' +
          "CREATE TRIGGER guard_rollback BEFORE INSERT ON guard BEGIN SELECT RAISE(ROLLBACK, 'injected rollback'); END;",
      },
      { version: 2, name: 'second', sql: 'CREATE TABLE second_table (x INTEGER);' },
      { version: 3, name: 'aborting', sql: 'INSERT INTO guard VALUES (1);' },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => runner.runMigrations()).toThrow('injected rollback');
    expect(runner.getCurrentVersion()).toBe(0);
    expect(sqlite.inTransaction()).toBe(false);
    sqlite.close();
  });
});
