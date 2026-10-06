// The shared rebuild writes the module dependencies its scan computed (issue #6). The write is one
// transaction, and a failed write degrades the rebuild instead of failing it or passing silently.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { rebuildContentOnly, rebuildWithOverlay } from '../rebuild-orchestrator.js';
import { persistModuleDependencies } from '../module-dependency-store.js';

const roots: string[] = [];

const FAILURE = /^Failed to write module dependencies \(.*\); the module dependency graph is empty/;

function fixture(): { repo: string; db: LuxDatabase } {
  const repo = mkdtempSync(join(tmpdir(), 'lux-rebuild-deps-'));
  roots.push(repo);
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(
    join(repo, 'lux.yaml'),
    'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: true\n  module_boundary: "src/Module/{name}"\n'
  );
  mkdirSync(join(repo, 'src', 'Module', 'Users'), { recursive: true });
  mkdirSync(join(repo, 'src', 'Module', 'Orders'), { recursive: true });
  mkdirSync(join(repo, 'src', 'Module', 'Billing'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'Module', 'Users', 'UserService.php'),
    '<?php\nnamespace App\\Module\\Users;\n\nuse App\\Module\\Orders\\OrderService;\nuse App\\Module\\Billing\\BillingService;\n\nclass UserService {}\n'
  );
  writeFileSync(
    join(repo, 'src', 'Module', 'Orders', 'OrderService.php'),
    '<?php\nnamespace App\\Module\\Orders;\n\nclass OrderService {}\n'
  );
  writeFileSync(
    join(repo, 'src', 'Module', 'Billing', 'BillingService.php'),
    '<?php\nnamespace App\\Module\\Billing;\n\nclass BillingService {}\n'
  );

  const dbDir = mkdtempSync(join(tmpdir(), 'lux-rebuild-deps-db-'));
  roots.push(dbDir);
  return { repo, db: new LuxDatabase(join(dbDir, 'lux.db')) };
}

/** Let the first insert through and fail the second, so a non-atomic write would leave one row. */
function failSecondInsert(db: LuxDatabase): void {
  const realInsert = db.insertModuleDependency.bind(db);
  let calls = 0;
  vi.spyOn(db, 'insertModuleDependency').mockImplementation((dep) => {
    calls++;
    if (calls === 2) throw new Error('disk full');
    realInsert(dep);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('rebuild orchestrator — module dependencies', () => {
  it('rebuildWithOverlay persists exactly the dependencies the scan computed', async () => {
    const { repo, db } = fixture();
    try {
      db.insertModuleDependency({
        source_module: 'Stale',
        target_module: 'Gone',
        reference_count: 9,
        sample_files: '[]',
      });

      const { result, scanResult } = await rebuildWithOverlay(db, repo);

      expect(scanResult.dependencies.length).toBe(2);
      // Compared as sets: the query returns rows in its own total order, not the scan's.
      const rows = db
        .getAllModuleDependencies()
        .map((d) => [d.source_module, d.target_module, d.reference_count].join('|'))
        .sort();
      expect(rows).toEqual(
        scanResult.dependencies
          .map((d) => [d.source_module, d.target_module, d.reference_count].join('|'))
          .sort()
      );
      expect(result.warnings.some((w) => FAILURE.test(w))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rebuildContentOnly persists the dependencies when given a database', async () => {
    const { repo, db } = fixture();
    try {
      const { scanResult } = await rebuildContentOnly(repo, { db });

      expect(scanResult.dependencies.length).toBe(2);
      expect(db.getAllModuleDependencies()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('a write failing part-way leaves no rows and reports it in the overlay result', async () => {
    const { repo, db } = fixture();
    try {
      failSecondInsert(db);

      const { result } = await rebuildWithOverlay(db, repo);

      expect(db.getAllModuleDependencies()).toEqual([]);
      expect(result.mode).toBe('degraded-overlay');
      expect(result.warnings.filter((w) => FAILURE.test(w))).toHaveLength(1);
      expect(result.warnings.find((w) => FAILURE.test(w))).toContain('disk full');
    } finally {
      db.close();
    }
  });

  it('a write failing part-way leaves no rows and reports it in the content-only result', async () => {
    const { repo, db } = fixture();
    try {
      failSecondInsert(db);

      const { result } = await rebuildContentOnly(repo, { db });

      expect(db.getAllModuleDependencies()).toEqual([]);
      expect(result.warnings.filter((w) => FAILURE.test(w))).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('persistModuleDependencies — state after a failed write, whoever calls it', () => {
  const DEPS = {
    dependencies: [
      { source_module: 'Users', target_module: 'Orders', reference_count: 1, sample_files: [] },
      { source_module: 'Users', target_module: 'Billing', reference_count: 1, sample_files: [] },
    ],
  };

  function seededDb(): LuxDatabase {
    const dbDir = mkdtempSync(join(tmpdir(), 'lux-persist-deps-db-'));
    roots.push(dbDir);
    const db = new LuxDatabase(join(dbDir, 'lux.db'));
    db.insertModuleDependency({
      source_module: 'Previous',
      target_module: 'Commit',
      reference_count: 4,
      sample_files: '[]',
    });
    return db;
  }

  it('leaves the table empty, not rolled back to its earlier rows, and says so', () => {
    const db = seededDb();
    try {
      failSecondInsert(db);

      const warning = persistModuleDependencies(db, DEPS);

      expect(db.getAllModuleDependencies()).toEqual([]);
      expect(warning).toBe(
        'Failed to write module dependencies (disk full); ' +
          'the module dependency graph is empty until the next successful rebuild.'
      );
    } finally {
      db.close();
    }
  });

  it('says the table state is unknown when clearing it after the failure also fails', () => {
    const db = seededDb();
    try {
      failSecondInsert(db);
      const realClear = db.clearModuleDependencies.bind(db);
      let clears = 0;
      vi.spyOn(db, 'clearModuleDependencies').mockImplementation(() => {
        clears++;
        if (clears === 2) throw new Error('database is locked');
        realClear();
      });

      const warning = persistModuleDependencies(db, DEPS);

      expect(clears).toBe(2);
      expect(warning).toBe(
        'Failed to write module dependencies (disk full), and clearing the table afterwards ' +
          'also failed (database is locked); the contents of module_dependencies are unknown ' +
          'until the next successful rebuild.'
      );
    } finally {
      db.close();
    }
  });
});
