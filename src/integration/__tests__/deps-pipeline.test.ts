import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { generalScan } from '../../scanner/general.js';
import { GeneralScanner } from '../../scanner/index.js';
import { LuxDatabase } from '../../db/index.js';
import { computeClusters } from '../../scanner/imports/clustering.js';
import { detectModuleBoundaries, resolveModule } from '../../scanner/imports/module-boundary.js';
import { tmpdir } from 'node:os';

describe('Dependency Pipeline Integration', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-deps-pipeline-test-'));
  const dbPath = join(testDir, 'test.db');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function setupFixture() {
    // Create module structure with PHP and TS files
    mkdirSync(join(testDir, 'src', 'Module', 'Users', 'Services'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'Module', 'Orders', 'Services'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'Module', 'Billing', 'Services'), { recursive: true });
    mkdirSync(join(testDir, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(testDir, 'packages', 'ui', 'src'), { recursive: true });

    // package.json to mark as code repo
    writeFileSync(join(testDir, 'package.json'), '{}');

    // lux.yaml with module boundary config
    writeFileSync(
      join(testDir, 'lux.yaml'),
      `deps:
  enabled: true
  module_boundary: "src/Module/{name}"
`
    );

    // PHP files with cross-module imports
    writeFileSync(
      join(testDir, 'src', 'Module', 'Users', 'Services', 'UserService.php'),
      `<?php
namespace App\\Module\\Users\\Services;

use App\\Module\\Orders\\Services\\OrderService;
use App\\Module\\Orders\\Services\\OrderRepository;
use App\\Module\\Billing\\Services\\BillingService;

class UserService {
    public function getOrders(): array {}
    public function getBilling(): void {}
}
`
    );

    writeFileSync(
      join(testDir, 'src', 'Module', 'Orders', 'Services', 'OrderService.php'),
      `<?php
namespace App\\Module\\Orders\\Services;

use App\\Module\\Users\\Services\\UserService;

class OrderService {
    public function findByUser(): array {}
}
`
    );

    writeFileSync(
      join(testDir, 'src', 'Module', 'Orders', 'Services', 'OrderRepository.php'),
      `<?php
namespace App\\Module\\Orders\\Services;

class OrderRepository {
}
`
    );

    writeFileSync(
      join(testDir, 'src', 'Module', 'Billing', 'Services', 'BillingService.php'),
      `<?php
namespace App\\Module\\Billing\\Services;

use App\\Module\\Orders\\Services\\OrderService;
use App\\Module\\Users\\Services\\UserService;

class BillingService {
    public function generateInvoice(): void {}
}
`
    );

    // TS files in packages
    writeFileSync(
      join(testDir, 'packages', 'ui', 'src', 'Button.ts'),
      `import { theme } from '../../core/src/theme.js';

export const Button = () => {};
`
    );

    writeFileSync(
      join(testDir, 'packages', 'core', 'src', 'theme.ts'),
      `export const theme = { primary: '#000' };`
    );
  }

  it('should parse imports during generalScan', async () => {
    setupFixture();

    const result = await generalScan(testDir);

    expect(result.dependencies.length).toBeGreaterThan(0);

    // Users → Orders dependency
    const usersToOrders = result.dependencies.find(
      (d) => d.source_module === 'Users' && d.target_module === 'Orders'
    );
    expect(usersToOrders).toBeDefined();
    expect(usersToOrders!.reference_count).toBeGreaterThanOrEqual(2);

    // Users → Billing dependency
    const usersToBilling = result.dependencies.find(
      (d) => d.source_module === 'Users' && d.target_module === 'Billing'
    );
    expect(usersToBilling).toBeDefined();

    // Billing → Orders dependency
    const billingToOrders = result.dependencies.find(
      (d) => d.source_module === 'Billing' && d.target_module === 'Orders'
    );
    expect(billingToOrders).toBeDefined();

    // Billing → Users dependency
    const billingToUsers = result.dependencies.find(
      (d) => d.source_module === 'Billing' && d.target_module === 'Users'
    );
    expect(billingToUsers).toBeDefined();
  });

  it('should populate module_dependencies table after indexing', async () => {
    setupFixture();

    const result = await generalScan(testDir);
    const db = new LuxDatabase(dbPath);

    try {
      const scanner = new GeneralScanner(testDir);
      db.clearAll();
      await scanner.index(db, result.scan);

      // Write dependencies
      db.clearModuleDependencies();
      for (const dep of result.dependencies) {
        db.insertModuleDependency({
          source_module: dep.source_module,
          target_module: dep.target_module,
          reference_count: dep.reference_count,
          sample_files: JSON.stringify(dep.sample_files),
        });
      }

      const allDeps = db.getAllModuleDependencies();
      expect(allDeps.length).toBeGreaterThan(0);

      const modules = db.getDistinctModules();
      expect(modules).toContain('Users');
      expect(modules).toContain('Orders');
      expect(modules).toContain('Billing');
    } finally {
      db.close();
    }
  });

  it('should compute clusters from indexed dependencies', async () => {
    setupFixture();

    const result = await generalScan(testDir);
    const db = new LuxDatabase(dbPath);

    try {
      db.clearModuleDependencies();
      for (const dep of result.dependencies) {
        db.insertModuleDependency({
          source_module: dep.source_module,
          target_module: dep.target_module,
          reference_count: dep.reference_count,
          sample_files: JSON.stringify(dep.sample_files),
        });
      }

      const allDeps = db.getAllModuleDependencies();
      const clusters = computeClusters(allDeps);

      expect(clusters.length).toBeGreaterThan(0);

      // All modules should appear in clusters
      const allMembers = clusters.flatMap((c) => c.members);
      expect(allMembers).toContain('Users');
      expect(allMembers).toContain('Orders');
      expect(allMembers).toContain('Billing');
    } finally {
      db.close();
    }
  });

  it('should resolve file to module for impact analysis', () => {
    setupFixture();

    const patterns = detectModuleBoundaries(testDir);
    expect(patterns).toContain('src/Module/{name}');

    const mod = resolveModule(
      join(testDir, 'src', 'Module', 'Users', 'Services', 'UserService.php'),
      testDir,
      patterns
    );
    expect(mod).toBe('Users');
  });

  it('should find dependents for impact blast radius', async () => {
    setupFixture();

    const result = await generalScan(testDir);
    const db = new LuxDatabase(dbPath);

    try {
      db.clearModuleDependencies();
      for (const dep of result.dependencies) {
        db.insertModuleDependency({
          source_module: dep.source_module,
          target_module: dep.target_module,
          reference_count: dep.reference_count,
          sample_files: JSON.stringify(dep.sample_files),
        });
      }

      // Who depends on Orders?
      const dependents = db.getModuleDependencies('Orders', 'target');
      expect(dependents.length).toBeGreaterThan(0);

      // Users and Billing both import from Orders
      const sources = dependents.map((d) => d.source_module);
      expect(sources).toContain('Users');
      expect(sources).toContain('Billing');
    } finally {
      db.close();
    }
  });

  it('should handle deps graph output format', async () => {
    setupFixture();

    const result = await generalScan(testDir);
    const db = new LuxDatabase(dbPath);

    try {
      db.clearModuleDependencies();
      for (const dep of result.dependencies) {
        db.insertModuleDependency({
          source_module: dep.source_module,
          target_module: dep.target_module,
          reference_count: dep.reference_count,
          sample_files: JSON.stringify(dep.sample_files),
        });
      }

      // Simulate graph output: get module with its deps and dependents
      const outgoing = db.getModuleDependencies('Users', 'source');
      const incoming = db.getModuleDependencies('Users', 'target');

      expect(outgoing.length).toBeGreaterThan(0);
      // Orders and Billing import from Users, so incoming should have entries
      expect(incoming.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
