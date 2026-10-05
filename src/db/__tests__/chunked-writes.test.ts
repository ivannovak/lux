import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { writeAllInChunks, writeInChunks } from '../chunked-writes.js';

// node-sqlite3-wasm's VFS calls openSync on the shared CommonJS fs object, so counting opens of
// `<db>-journal` there counts committed write transactions under `journal_mode = delete`.
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fileDb(): LuxDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'lux-chunked-writes-'));
  dirs.push(dir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = new LuxDatabase(join(dir, 'lux.db'));
  vi.restoreAllMocks();
  return db;
}

function countJournals(fn: () => void): number {
  let journals = 0;
  const openSync = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && path.endsWith('-journal')) journals++;
    return (openSync as (...args: unknown[]) => number)(path, ...rest);
  });
  fn();
  vi.restoreAllMocks();
  return journals;
}

function node(i: number) {
  return { id: `file:f${i}.ts`, node_type: 'file' as const, file_path: `f${i}.ts`, updated_at: 1 };
}

function nodeIds(db: LuxDatabase): string[] {
  return db
    .getStructuralNodesByType('file')
    .map((n) => n.id)
    .sort();
}

describe('writeInChunks', () => {
  it('commits once per chunk, so commits grow with items / chunk size and not with items', () => {
    const db = fileDb();
    const items = Array.from({ length: 10 }, (_, i) => i);

    const journals = countJournals(() =>
      writeAllInChunks(db, items, 4, (i) => db.upsertStructuralNode(node(i)))
    );

    expect(journals).toBe(3);
    expect(nodeIds(db)).toHaveLength(10);
    db.close();
  });

  it('commits the items before a failing statement and returns its error', () => {
    const db = new LuxDatabase(':memory:');

    const result = writeInChunks(db, [0, 1, 2, 3, 4], 2, (i) => {
      if (i === 3) throw new Error('item 3 failed');
      db.upsertStructuralNode(node(i));
    });

    expect(result.committed).toBe(3);
    expect(result.error?.message).toBe('item 3 failed');
    expect(nodeIds(db)).toEqual(['file:f0.ts', 'file:f1.ts', 'file:f2.ts']);
    db.close();
  });

  it('counts only earlier chunks when an error aborts the whole transaction', () => {
    const db = new LuxDatabase(':memory:');
    (db as unknown as { db: { exec(sql: string): void } }).db.exec(
      `CREATE TRIGGER fail_fourth BEFORE INSERT ON structural_nodes
         WHEN (SELECT count(*) FROM structural_nodes) >= 3
       BEGIN SELECT RAISE(ROLLBACK, 'injected rollback'); END;`
    );

    const result = writeInChunks(db, [0, 1, 2, 3, 4], 2, (i) => db.upsertStructuralNode(node(i)));

    expect(result.committed).toBe(2);
    expect(result.error?.message).toContain('injected rollback');
    expect(db.inTransaction()).toBe(false);
    expect(nodeIds(db)).toEqual(['file:f0.ts', 'file:f1.ts']);
    db.close();
  });

  it('rolls back only the failing chunk when writing all-or-nothing chunks', () => {
    const db = new LuxDatabase(':memory:');

    expect(() =>
      writeAllInChunks(db, [0, 1, 2, 3, 4], 2, (i) => {
        if (i === 3) throw new Error('item 3 failed');
        db.upsertStructuralNode(node(i));
      })
    ).toThrow('item 3 failed');

    expect(nodeIds(db)).toEqual(['file:f0.ts', 'file:f1.ts']);
    db.close();
  });
});
