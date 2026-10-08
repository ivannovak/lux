// The SQLite engine is a vendored copy of node-sqlite3-wasm whose lock and unlock calls go through
// an injected hook object, and whose statements have a public reset(). These cases pin the three
// things that keep that arrangement honest:
//   - the engine really calls the hooks, so lock ownership cannot be bypassed inside it;
//   - nothing replaces functions on Node's `fs` to get there;
//   - nothing in src/ loads the npm package, which has neither the hooks nor reset().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { driver } from '../driver.js';

const SRC = resolve(__dirname, '..', '..');

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-vendored-driver-'));
  dbPath = join(dir, 'x.db');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('the vendored engine', () => {
  it('takes and releases its lock through driver.lockHooks', async () => {
    const { LuxSqlite } = await import('../sqlite-adapter.js');
    const db = new LuxSqlite(dbPath);
    db.exec('CREATE TABLE t (a)');
    const lock = vi.spyOn(driver.lockHooks, 'lock');
    const unlock = vi.spyOn(driver.lockHooks, 'unlock');

    db.exec('BEGIN IMMEDIATE');
    expect(lock).toHaveBeenCalledWith(`${dbPath}.lock`);
    expect(unlock).not.toHaveBeenCalled();
    expect(existsSync(`${dbPath}.lock`)).toBe(true);

    db.exec('ROLLBACK');
    expect(unlock).toHaveBeenCalledWith(`${dbPath}.lock`);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    db.close();
  });

  it('holds no lock when the lock hook refuses it', async () => {
    const { LuxSqlite } = await import('../sqlite-adapter.js');
    const db = new LuxSqlite(dbPath);
    db.exec('CREATE TABLE t (a)');
    db.run('PRAGMA busy_timeout = 0');
    vi.spyOn(driver.lockHooks, 'lock').mockImplementation(() => {
      throw Object.assign(new Error('held elsewhere'), { code: 'EEXIST' });
    });

    expect(() => db.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    vi.restoreAllMocks();
    db.close();
  });

  it('exposes a public reset() that ends a statement’s read and releases its lock', () => {
    const db = new driver.Database(dbPath);
    db.exec('CREATE TABLE t (a)');
    db.run('INSERT INTO t VALUES (1)');
    const stmt = db.prepare('SELECT a FROM t');

    expect(stmt.get()).toEqual({ a: 1 });
    expect(existsSync(`${dbPath}.lock`)).toBe(true); // get() steps once and leaves the statement active

    stmt.reset();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    stmt.finalize();
    db.close();
  });
});

describe('the vendor directory holds exactly the vendored engine', () => {
  // ESLint and validate:dead-code both skip src/db/vendor/, so nothing else may live there, and the
  // files that are there may change only by a deliberate re-sync that updates these pins together
  // with vendor/node-sqlite3-wasm/README.md.
  const VENDOR = resolve(SRC, 'db', 'vendor');
  const PINS: Record<string, string | null> = {
    'node-sqlite3-wasm/LICENSE': '9759019dbfadea5c126a4e3c70fb5a316bfc22894f7d4c4c24d0b17e3a53f4b6',
    'node-sqlite3-wasm/README.md': null, // prose about the copy; not code, so not pinned
    'node-sqlite3-wasm/node-sqlite3-wasm.cjs':
      '154e4d4b623d2ebdb5874e17cb857b333dc1584da9e6ff571ad9aa639b80c2ce',
    'node-sqlite3-wasm/node-sqlite3-wasm.d.cts':
      'd23bf430a63296b3fff77a0576779374beb581f6376de6615a3a8664dad10d5c',
    'node-sqlite3-wasm/node-sqlite3-wasm.wasm':
      '50382672f2e254b9807b227ba5c390a822ddd48bb920f6ff710d13f14b33ee7f',
  };

  function everyEntry(root: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) found.push(...everyEntry(path));
      else found.push(relative(VENDOR, path).split(sep).join('/'));
    }
    return found;
  }

  it('contains the five expected files and nothing else', () => {
    expect(everyEntry(VENDOR).sort()).toEqual(Object.keys(PINS).sort());
  });

  it.each(Object.entries(PINS).filter(([, sha]) => sha !== null))(
    '%s matches its pinned SHA-256',
    (file, sha) => {
      const actual = createHash('sha256')
        .update(readFileSync(join(VENDOR, file)))
        .digest('hex');
      expect(actual).toBe(sha);
    }
  );
});

describe('Node’s fs is left alone', () => {
  it('fs.mkdirSync and fs.rmdirSync are Node’s own after Lux has opened a database', async () => {
    const before = { mkdirSync: fs.mkdirSync, rmdirSync: fs.rmdirSync };

    const { LuxSqlite } = await import('../sqlite-adapter.js');
    const db = new LuxSqlite(dbPath);
    db.exec('CREATE TABLE t (a)');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    db.close();

    expect(fs.mkdirSync).toBe(before.mkdirSync);
    expect(fs.rmdirSync).toBe(before.rmdirSync);

    // Identity alone would pass if a wrapper had gone in before `before` was taken, so compare the
    // functions with those of a Node process that has never loaded Lux.
    const pristine = JSON.parse(
      execFileSync(process.execPath, [
        '-e',
        `const fs = require('node:fs');
         process.stdout.write(JSON.stringify([String(fs.mkdirSync), String(fs.rmdirSync)]));`,
      ]).toString()
    ) as [string, string];
    expect(String(fs.mkdirSync)).toBe(pristine[0]);
    expect(String(fs.rmdirSync)).toBe(pristine[1]);
  });
});

describe('nothing in src/ loads the npm package', () => {
  /** A module specifier that would resolve to node_modules/node-sqlite3-wasm. */
  // `from '…'`, a bare `import '…'`, or the specifier as the argument of any call: require(…),
  // import(…), and createRequire(…)(…) alike.
  const LOADS_NPM_PACKAGE = /(?:\bfrom\s*|\bimport\s+|\(\s*)['"]node-sqlite3-wasm(?:\/[^'"]*)?['"]/;

  function sourceFiles(root: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (/\.(?:ts|cts|mts|js|cjs|mjs)$/.test(entry.name)) found.push(path);
    }
    return found;
  }

  it('the matcher recognises every way of loading it, and ignores mentions in prose', () => {
    for (const loading of [
      `import { Database } from 'node-sqlite3-wasm';`,
      `import type { Statement } from "node-sqlite3-wasm";`,
      `const x = require('node-sqlite3-wasm');`,
      `const y = await import('node-sqlite3-wasm');`,
      `import 'node-sqlite3-wasm';`,
      `require("node-sqlite3-wasm/dist/node-sqlite3-wasm.js")`,
      `createRequire(import.meta.url)('node-sqlite3-wasm')`,
      `const load = createRequire(import.meta.url);\nload(\n  "node-sqlite3-wasm"\n);`,
      `require.resolve('node-sqlite3-wasm')`,
    ]) {
      expect(loading).toMatch(LOADS_NPM_PACKAGE);
    }
    for (const prose of [
      `// node-sqlite3-wasm has no URI read-only open mode`,
      `require('./vendor/node-sqlite3-wasm/node-sqlite3-wasm.cjs')`,
      `import type sqlite from './vendor/node-sqlite3-wasm/node-sqlite3-wasm.cjs';`,
    ]) {
      expect(prose).not.toMatch(LOADS_NPM_PACKAGE);
    }
  });

  it('no file under src/ imports or requires it', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(200); // the walk found the tree, not an empty directory

    const self = resolve(__dirname, 'vendored-driver.test.ts');
    const offenders = files
      .filter((f) => f !== self)
      .filter((f) => LOADS_NPM_PACKAGE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the vendored engine is loaded from exactly one module', () => {
    const loaders = sourceFiles(SRC)
      .filter((f) => !f.includes(`${join('db', 'vendor')}`) && !f.includes('__tests__'))
      .filter((f) =>
        /require\(\s*(?:layoutPath\(\s*)?['"][^'"]*node-sqlite3-wasm\.cjs['"]\s*\)/.test(
          readFileSync(f, 'utf8')
        )
      )
      .map((f) => relative(SRC, f));
    expect(loaders).toEqual([join('db', 'driver.ts')]);
  });
});
