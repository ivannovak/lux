import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { LuxDatabase } from '../index.js';
import { tmpdir } from 'node:os';

describe('Module Dependencies CRUD', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-moddeps-test-'));
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(dbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('insertModuleDependency', () => {
    it('should insert a module dependency', () => {
      db.insertModuleDependency({
        source_module: 'ModuleA',
        target_module: 'ModuleB',
        reference_count: 5,
        sample_files: JSON.stringify(['file1.php', 'file2.php']),
      });

      const deps = db.getAllModuleDependencies();
      expect(deps).toHaveLength(1);
      expect(deps[0].source_module).toBe('ModuleA');
      expect(deps[0].target_module).toBe('ModuleB');
      expect(deps[0].reference_count).toBe(5);
      expect(deps[0].sample_files).toBe(JSON.stringify(['file1.php', 'file2.php']));
    });

    it('should replace on duplicate source+target pair', () => {
      db.insertModuleDependency({
        source_module: 'ModuleA',
        target_module: 'ModuleB',
        reference_count: 3,
        sample_files: null,
      });

      db.insertModuleDependency({
        source_module: 'ModuleA',
        target_module: 'ModuleB',
        reference_count: 10,
        sample_files: JSON.stringify(['updated.php']),
      });

      const deps = db.getAllModuleDependencies();
      expect(deps).toHaveLength(1);
      expect(deps[0].reference_count).toBe(10);
    });

    it('should allow null sample_files', () => {
      db.insertModuleDependency({
        source_module: 'X',
        target_module: 'Y',
        reference_count: 1,
        sample_files: null,
      });

      const deps = db.getAllModuleDependencies();
      expect(deps[0].sample_files).toBeNull();
    });
  });

  describe('getModuleDependencies', () => {
    beforeEach(() => {
      db.insertModuleDependency({
        source_module: 'A',
        target_module: 'B',
        reference_count: 5,
        sample_files: null,
      });
      db.insertModuleDependency({
        source_module: 'A',
        target_module: 'C',
        reference_count: 3,
        sample_files: null,
      });
      db.insertModuleDependency({
        source_module: 'B',
        target_module: 'A',
        reference_count: 2,
        sample_files: null,
      });
    });

    it('should filter by source direction', () => {
      const deps = db.getModuleDependencies('A', 'source');
      expect(deps).toHaveLength(2);
      expect(deps.every((d) => d.source_module === 'A')).toBe(true);
    });

    it('should filter by target direction', () => {
      const deps = db.getModuleDependencies('A', 'target');
      expect(deps).toHaveLength(1);
      expect(deps[0].source_module).toBe('B');
      expect(deps[0].target_module).toBe('A');
    });

    it('should return both directions', () => {
      const deps = db.getModuleDependencies('A', 'both');
      expect(deps).toHaveLength(3);
    });

    it('should return empty for unknown module', () => {
      const deps = db.getModuleDependencies('Unknown', 'both');
      expect(deps).toHaveLength(0);
    });
  });

  describe('getAllModuleDependencies', () => {
    it('should return empty when no deps exist', () => {
      expect(db.getAllModuleDependencies()).toHaveLength(0);
    });

    it('should order by reference_count descending', () => {
      db.insertModuleDependency({
        source_module: 'A',
        target_module: 'B',
        reference_count: 2,
        sample_files: null,
      });
      db.insertModuleDependency({
        source_module: 'C',
        target_module: 'D',
        reference_count: 10,
        sample_files: null,
      });

      const deps = db.getAllModuleDependencies();
      expect(deps[0].reference_count).toBe(10);
      expect(deps[1].reference_count).toBe(2);
    });
  });

  describe('clearModuleDependencies', () => {
    it('should remove all module dependencies', () => {
      db.insertModuleDependency({
        source_module: 'A',
        target_module: 'B',
        reference_count: 1,
        sample_files: null,
      });
      db.insertModuleDependency({
        source_module: 'C',
        target_module: 'D',
        reference_count: 1,
        sample_files: null,
      });

      db.clearModuleDependencies();
      expect(db.getAllModuleDependencies()).toHaveLength(0);
    });
  });

  describe('getDistinctModules', () => {
    it('should return distinct module names from both columns', () => {
      db.insertModuleDependency({
        source_module: 'A',
        target_module: 'B',
        reference_count: 1,
        sample_files: null,
      });
      db.insertModuleDependency({
        source_module: 'B',
        target_module: 'C',
        reference_count: 1,
        sample_files: null,
      });

      const modules = db.getDistinctModules();
      expect(modules).toEqual(['A', 'B', 'C']);
    });

    it('should return empty when no deps', () => {
      expect(db.getDistinctModules()).toHaveLength(0);
    });
  });
});
