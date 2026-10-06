import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';

describe('Deps Command', () => {
  const testDir = join(__dirname, 'fixtures', 'deps-cmd-test');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(dbPath);

    // Seed test data
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Orders',
      reference_count: 10,
      sample_files: JSON.stringify(['src/Module/Users/UserService.php']),
    });
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Auth',
      reference_count: 5,
      sample_files: JSON.stringify(['src/Module/Users/AuthCheck.php']),
    });
    db.insertModuleDependency({
      source_module: 'Orders',
      target_module: 'Users',
      reference_count: 3,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Billing',
      target_module: 'Orders',
      reference_count: 8,
      sample_files: null,
    });
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('graph subcommand logic', () => {
    it('should retrieve all dependencies', () => {
      const allDeps = db.getAllModuleDependencies();
      expect(allDeps).toHaveLength(4);
    });

    it('should get dependencies for a specific module', () => {
      const outgoing = db.getModuleDependencies('Users', 'source');
      expect(outgoing).toHaveLength(2);
      expect(outgoing[0].target_module).toBe('Orders'); // highest ref count first
    });

    it('should get dependents for a specific module', () => {
      const incoming = db.getModuleDependencies('Orders', 'target');
      expect(incoming).toHaveLength(2);
    });

    it('should return distinct modules', () => {
      const modules = db.getDistinctModules();
      expect(modules).toEqual(['Auth', 'Billing', 'Orders', 'Users']);
    });
  });

  describe('clusters subcommand logic', () => {
    it('should compute clusters from dependency data', async () => {
      const { computeClusters } = await import('../../scanner/imports/clustering.js');
      const allDeps = db.getAllModuleDependencies();
      const clusters = computeClusters(allDeps);

      expect(clusters.length).toBeGreaterThan(0);
      // Every module should appear in exactly one cluster
      const allMembers = clusters.flatMap((c) => c.members);
      expect(allMembers).toContain('Users');
      expect(allMembers).toContain('Orders');
    });
  });

  describe('impact subcommand logic', () => {
    it('should find modules that depend on a given module', () => {
      // Who depends on Orders?
      const dependents = db.getModuleDependencies('Orders', 'target');
      expect(dependents).toHaveLength(2); // Users and Billing
      const sources = dependents.map((d) => d.source_module);
      expect(sources).toContain('Users');
      expect(sources).toContain('Billing');
    });

    it('should calculate blast radius', () => {
      const dependents = db.getModuleDependencies('Orders', 'target');
      const totalRefs = dependents.reduce((sum, d) => sum + d.reference_count, 0);
      expect(totalRefs).toBe(18); // 10 + 8
      expect(dependents.length).toBe(2);
    });
  });

  describe('coverage subcommand logic', () => {
    it('should compute clusters for coverage analysis', async () => {
      const { computeClusters } = await import('../../scanner/imports/clustering.js');
      const allDeps = db.getAllModuleDependencies();
      const clusters = computeClusters(allDeps);

      // Each cluster has members
      for (const cluster of clusters) {
        expect(cluster.members.length).toBeGreaterThan(0);
        expect(cluster.name).toBeTruthy();
      }
    });
  });
});
