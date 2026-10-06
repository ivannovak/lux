import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { generalScan } from '../../general.js';
import { LuxDatabase } from '../../../db/index.js';

describe('Scanner Import Integration', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-scanner-int-test-'));
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

  it('should parse PHP imports and produce module dependencies', async () => {
    // Set up fixture with module structure
    mkdirSync(join(testDir, 'src', 'Module', 'Users'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'Module', 'Orders'), { recursive: true });

    // Create a package.json so it's detected as a source code repo
    writeFileSync(join(testDir, 'package.json'), '{}');

    writeFileSync(
      join(testDir, 'src', 'Module', 'Users', 'UserService.php'),
      `<?php
namespace App\\Module\\Users;

use App\\Module\\Orders\\OrderRepository;
use App\\Module\\Orders\\OrderService;

class UserService {
    public function getOrders() {}
}
`
    );

    writeFileSync(
      join(testDir, 'src', 'Module', 'Orders', 'OrderRepository.php'),
      `<?php
namespace App\\Module\\Orders;

class OrderRepository {
}
`
    );

    const result = await generalScan(testDir, {
      config: {
        lsp: { enabled: false, enrichers: [] },
        deps: { enabled: true },
      },
    });

    expect(result.dependencies.length).toBeGreaterThan(0);

    // Users → Orders should exist
    const usersToOrders = result.dependencies.find(
      (d) => d.source_module === 'Users' && d.target_module === 'Orders'
    );
    expect(usersToOrders).toBeDefined();
    expect(usersToOrders!.reference_count).toBe(2);
  });

  it('should parse TS imports and produce module dependencies', async () => {
    mkdirSync(join(testDir, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(testDir, 'packages', 'ui', 'src'), { recursive: true });

    writeFileSync(join(testDir, 'package.json'), '{}');

    writeFileSync(
      join(testDir, 'packages', 'ui', 'src', 'Button.ts'),
      `import { theme } from '../../core/src/theme.js';
import { utils } from '../../core/src/utils.js';

export const Button = () => {};
`
    );

    writeFileSync(join(testDir, 'packages', 'core', 'src', 'theme.ts'), `export const theme = {};`);

    writeFileSync(join(testDir, 'packages', 'core', 'src', 'utils.ts'), `export const utils = {};`);

    const result = await generalScan(testDir, {
      config: {
        lsp: { enabled: false, enrichers: [] },
        deps: { enabled: true },
      },
    });

    const uiToCore = result.dependencies.find(
      (d) => d.source_module === 'ui' && d.target_module === 'core'
    );
    expect(uiToCore).toBeDefined();
    expect(uiToCore!.reference_count).toBeGreaterThanOrEqual(2);
  });

  it('should write dependencies to database during index rebuild', async () => {
    mkdirSync(join(testDir, 'src', 'Module', 'Auth'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'Module', 'Billing'), { recursive: true });

    writeFileSync(join(testDir, 'package.json'), '{}');

    writeFileSync(
      join(testDir, 'src', 'Module', 'Billing', 'BillingService.php'),
      `<?php
use App\\Module\\Auth\\AuthService;

class BillingService {}
`
    );

    writeFileSync(
      join(testDir, 'src', 'Module', 'Auth', 'AuthService.php'),
      `<?php
class AuthService {}
`
    );

    const result = await generalScan(testDir, {
      config: {
        lsp: { enabled: false, enrichers: [] },
        deps: { enabled: true },
      },
    });

    // Write to DB
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
      expect(allDeps.length).toBeGreaterThan(0);

      const billingToAuth = allDeps.find(
        (d) => d.source_module === 'Billing' && d.target_module === 'Auth'
      );
      expect(billingToAuth).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('should return empty dependencies when deps disabled', async () => {
    mkdirSync(join(testDir, 'src', 'Module', 'Users'), { recursive: true });
    writeFileSync(join(testDir, 'package.json'), '{}');
    writeFileSync(
      join(testDir, 'src', 'Module', 'Users', 'Service.php'),
      `<?php
use App\\Module\\Orders\\Repo;
class Service {}
`
    );

    const result = await generalScan(testDir, {
      config: {
        lsp: { enabled: false, enrichers: [] },
        deps: { enabled: false },
      },
    });

    expect(result.dependencies).toHaveLength(0);
  });
});
