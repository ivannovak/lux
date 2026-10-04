// `lux index sync` across a change A→B must leave the index stating the same facts as a cold
// `lux index rebuild` of B, apart from staleness it reports. Each scenario indexes a small Laravel +
// TypeScript + Vue repository at A, scoped-syncs a copy of that index to B through the real CLI,
// cold-rebuilds B into a separate index, and compares the two row by row (scoped-sync-harness.ts
// lists every column the comparison excludes). A fake language server stands in for intelephense
// and tsserver so the LSP tier runs for real and deterministically.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import {
  FAKE_LSP_SERVER,
  INDEX_COMPARISON_EXCLUSIONS,
  commitAll,
  diffIndexes,
  dumpIndex,
  formatDifferences,
  initRepo,
  runCli,
  selectRows,
  writeTree,
  type IndexDump,
} from './scoped-sync-harness.js';

const SCENARIO_TIMEOUT_MS = 240_000;

function luxYaml(lspBudgetMs: number): string {
  const enricher = (languageId: string) =>
    [
      `    - language_id: ${languageId}`,
      `      enabled: true`,
      `      server_command: ${JSON.stringify(process.execPath)}`,
      `      server_args:`,
      `        - ${JSON.stringify(FAKE_LSP_SERVER)}`,
      `      max_concurrency: 4`,
      `      request_timeout_ms: 10000`,
      `      init_timeout_ms: 10000`,
    ].join('\n');
  return [
    'lsp:',
    '  enabled: true',
    '  enrichers:',
    enricher('php'),
    enricher('typescript'),
    enricher('vue'),
    'deps:',
    '  enabled: true',
    '  module_boundary: "src/Module/{name}"',
    'refresh:',
    `  lspBudgetMs: ${lspBudgetMs}`,
    '',
  ].join('\n');
}

const BASE_TREE: Record<string, string> = {
  'composer.json': '{"name":"acme/shop"}\n',
  'package.json': '{"name":"shop"}\n',
  '.gitignore': 'vendor/\n',
  'app/Providers/RouteServiceProvider.php': [
    '<?php',
    'namespace App\\Providers;',
    '',
    'class RouteServiceProvider',
    '{',
    '    public function boot()',
    '    {',
    "        Route::prefix('admin/api')->group(__DIR__ . '/../../routes/admin-api.php');",
    '    }',
    '}',
    '',
  ].join('\n'),
  'routes/admin-api.php': [
    '<?php',
    'use App\\Http\\Controllers\\BulkDownloadController;',
    '',
    "Route::get('/bulk-downloads', [BulkDownloadController::class, 'index']);",
    '',
  ].join('\n'),
  'app/Http/Controllers/BulkDownloadController.php': [
    '<?php',
    'namespace App\\Http\\Controllers;',
    '',
    'use App\\Module\\Billing\\Exporter;',
    '',
    'class BulkDownloadController',
    '{',
    '    public function index(Exporter $exporter)',
    '    {',
    '        return $exporter->build();',
    '    }',
    '',
    '    public function show(Exporter $exporter)',
    '    {',
    '        return $exporter->build();',
    '    }',
    '}',
    '',
  ].join('\n'),
  'src/Module/Billing/Exporter.php': [
    '<?php',
    'namespace App\\Module\\Billing;',
    '',
    'class Exporter',
    '{',
    '    public function build()',
    '    {',
    '        return 1;',
    '    }',
    '}',
    '',
  ].join('\n'),
  'src/Module/Users/Account.php': [
    '<?php',
    'namespace App\\Module\\Users;',
    '',
    'use App\\Module\\Billing\\Exporter;',
    '',
    'class Account',
    '{',
    '    public function export(Exporter $exporter)',
    '    {',
    '        return $exporter->build();',
    '    }',
    '}',
    '',
  ].join('\n'),
  'resources/js/composables/useCart.ts': 'export function useCart(): number {\n  return 1;\n}\n',
  'resources/js/pages/cart.ts': [
    "import { useCart } from '../composables/useCart';",
    '',
    'export function total(): number {',
    '  return useCart();',
    '}',
    '',
  ].join('\n'),
  'resources/js/components/CartBadge.vue': [
    '<script setup lang="ts">',
    'const count = 1;',
    'function bump(): number {',
    '  return count + 1;',
    '}',
    '</script>',
    '',
    '<template>',
    '  <span @click="bump">{{ count }}</span>',
    '</template>',
    '',
  ].join('\n'),
};

interface Scenario {
  repo: string;
  /** The index scoped-synced from A to B. */
  scopedDb: string;
  /** A cold rebuild of B. */
  coldDb: string;
  syncStdout: string;
  syncStatus: number | null;
  scoped: IndexDump;
  cold: IndexDump;
}

interface ScenarioDef {
  lspBudgetMs: number;
  /** Changes committed as B. A null value deletes the file. */
  change: Record<string, string | null>;
  /** Runs after A is indexed and before the sync (e.g. building a vendor pack). */
  betweenAAndB?: (repo: string, env: Record<string, string>, dbDir: string) => void;
  /** Files present at A in addition to BASE_TREE. */
  extraBase?: Record<string, string>;
  env?: Record<string, string>;
  syncArgs?: string[];
}

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function runScenario(def: ScenarioDef): Scenario {
  const repo = tempDir('lux-scoped-eq-');
  const dbDir = tempDir('lux-scoped-eq-db-');
  const env = { LUX_PACK_CACHE: join(dbDir, 'packs'), ...(def.env ?? {}) };
  initRepo(repo);
  writeTree(repo, { ...BASE_TREE, ...(def.extraBase ?? {}), 'lux.yaml': luxYaml(def.lspBudgetMs) });
  commitAll(repo, 'A');

  const scopedDb = join(dbDir, 'scoped.db');
  const coldDb = join(dbDir, 'cold.db');
  const rebuildA = runCli(repo, scopedDb, ['index', 'rebuild'], env);
  expect(rebuildA.status, rebuildA.stderr).toBe(0);
  if (process.env.KEEP_FIXTURES) copyFileSync(scopedDb, join(dbDir, 'A.db'));

  def.betweenAAndB?.(repo, env, dbDir);
  writeTree(repo, def.change);
  commitAll(repo, 'B');

  const sync = runCli(repo, scopedDb, ['index', 'sync', ...(def.syncArgs ?? ['--scoped'])], env);
  expect(sync.status, sync.stderr).toBe(0);
  const rebuildB = runCli(repo, coldDb, ['index', 'rebuild'], env);
  expect(rebuildB.status, rebuildB.stderr).toBe(0);

  return {
    repo,
    scopedDb,
    coldDb,
    syncStdout: sync.stdout,
    syncStatus: sync.status,
    scoped: dumpIndex(scopedDb, repo),
    cold: dumpIndex(coldDb, repo),
  };
}

function expectEquivalent(s: Scenario): void {
  const differences = diffIndexes(s.cold, s.scoped);
  expect(differences, formatDifferences(differences)).toEqual([]);
}

function trustState(dump: IndexDump): Record<string, unknown> {
  return JSON.parse((dump.get('overlay_trust_state') ?? ['{}'])[0]) as Record<string, unknown>;
}

// KEEP_FIXTURES=1 keeps the fixture repositories and indexes (including A.db, the index at A) for
// inspection and prints their paths.
afterAll(() => {
  if (process.env.KEEP_FIXTURES) {
    console.log('FIXTURES', dirs.join(' '));
    return;
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('index sync — scoped sync converges on a cold rebuild', () => {
  it('names every comparison exclusion', () => {
    expect(INDEX_COMPARISON_EXCLUSIONS.length).toBeGreaterThan(0);
  });

  describe('comparison instrument', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'] + '\n',
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it(
      'reports no difference between two cold rebuilds of the same commit',
      () => {
        const second = join(s.coldDb + '.second');
        const rebuild = runCli(s.repo, second, ['index', 'rebuild'], {
          LUX_PACK_CACHE: join(s.coldDb, '..', 'packs'),
        });
        expect(rebuild.status, rebuild.stderr).toBe(0);
        const differences = diffIndexes(s.cold, dumpIndex(second, s.repo));
        expect(differences, formatDifferences(differences)).toEqual([]);
      },
      SCENARIO_TIMEOUT_MS
    );

    it('reports a single planted difference in a copy of the cold index', () => {
      const planted = s.coldDb + '.planted';
      copyFileSync(s.coldDb, planted);
      const db = new LuxSqlite(planted);
      db.run(
        `UPDATE structural_nodes SET symbol_name = 'GET /bulk-downloads' ` +
          `WHERE node_type = 'capability-surface' AND symbol_name = 'GET /admin/api/bulk-downloads'`
      );
      db.close();
      const differences = diffIndexes(s.cold, dumpIndex(planted, s.repo));
      expect(differences.map((d) => d.table)).toEqual(['structural_nodes']);
      expect(differences[0].onlyInExpected).toHaveLength(1);
      expect(differences[0].onlyInActual).toHaveLength(1);
      expect(differences[0].onlyInActual[0]).toContain('symbol_name=GET /bulk-downloads |');
    });
  });

  describe('LSP tier over budget (defect 1)', () => {
    let s: Scenario;
    beforeAll(() => {
      // Each documentSymbol answer takes 400 ms, so the PHP files of R cannot finish in 1 s.
      s = runScenario({
        lspBudgetMs: 1000,
        env: { FAKE_LSP_DELAY_MS: '400' },
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'].replace(
            'return $exporter->build();',
            '$built = $exporter->build();\n        return $built;'
          ),
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('leaves no typed-receiver call edge stale or missing', () => {
      const lspEdges = (dump: IndexDump) =>
        selectRows(dump, 'structural_edges', (row) => /^id=[^|]*:lsp \|/u.test(row));
      expect(lspEdges(s.cold).length).toBeGreaterThan(0);
      expect(lspEdges(s.scoped)).toEqual(lspEdges(s.cold));
      expect(selectRows(s.scoped, 'structural_edges', (r) => r.includes('=stale'))).toEqual([]);
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('route group prefix declared outside the changed files (defect 2)', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        change: {
          'routes/admin-api.php':
            BASE_TREE['routes/admin-api.php'] +
            "Route::get('/bulk-downloads/{id}', [BulkDownloadController::class, 'show']);\n",
          // A composable call makes this a React-candidate change.
          'resources/js/pages/cart.ts': BASE_TREE['resources/js/pages/cart.ts'].replace(
            'return useCart();',
            'return useCart() + 1;'
          ),
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('keeps the group prefix on every HTTP surface', () => {
      const surfaces = (dump: IndexDump) =>
        selectRows(dump, 'structural_nodes', (r) => r.includes('node_type=capability-surface'));
      expect(surfaces(s.cold).some((r) => r.includes('GET /admin/api/bulk-downloads/{id}'))).toBe(
        true
      );
      expect(surfaces(s.scoped)).toEqual(surfaces(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('LSP symbols of changed Vue files (defect 3)', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        change: {
          'resources/js/components/CartBadge.vue': BASE_TREE[
            'resources/js/components/CartBadge.vue'
          ].replace('const count = 1;', 'const count = 2;\nconst limit = 9;'),
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('materializes the same LSP symbol nodes as a cold rebuild', () => {
      const symbols = (dump: IndexDump) =>
        selectRows(dump, 'structural_nodes', (r) => r.includes('node_type=symbol'));
      expect(symbols(s.cold).some((r) => r.includes('symbol_name=limit'))).toBe(true);
      expect(symbols(s.scoped)).toEqual(symbols(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('module dependencies and trust counters (defects 4 and 5)', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        change: {
          // A new Billing → Users dependency, a new file, and a new HTTP surface.
          'src/Module/Billing/Invoice.php': [
            '<?php',
            'namespace App\\Module\\Billing;',
            '',
            'use App\\Module\\Users\\Account;',
            '',
            'class Invoice',
            '{',
            '    public function owner(Account $account)',
            '    {',
            '        return $account->export(new Exporter());',
            '    }',
            '}',
            '',
          ].join('\n'),
          'routes/admin-api.php':
            BASE_TREE['routes/admin-api.php'] +
            "Route::get('/invoices', [BulkDownloadController::class, 'show']);\n",
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('refreshes module_dependencies (defect 4)', () => {
      expect(
        selectRows(s.cold, 'module_dependencies', (r) =>
          r.includes('source_module=Billing | target_module=Users')
        ).length
      ).toBeGreaterThan(0);
      expect(s.scoped.get('module_dependencies')).toEqual(s.cold.get('module_dependencies'));
    });

    it('persists trust-state counters that describe the synced index (defect 5)', () => {
      const scopedTrust = trustState(s.scoped);
      const coldTrust = trustState(s.cold);
      for (const key of ['fileNodeCount', 'surfaceCount', 'symbolNodeCount'] as const) {
        expect(scopedTrust[key], key).toEqual(coldTrust[key]);
      }
      expect(scopedTrust).toEqual(coldTrust);
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('vendor pack built after the last rebuild (defect 6)', () => {
    let s: Scenario;
    beforeAll(() => {
      // composer.lock and vendor/ exist at A, but the pack for that lock is only built after A was
      // indexed. Nothing in the git diff or the config fingerprint changes; the default sync path runs.
      s = runScenario({
        lspBudgetMs: 600_000,
        extraBase: {
          'composer.lock':
            '{"packages":[{"name":"laravel/framework","version":"v11.0.0"},{"name":"acme/kit","version":"1.0.0"}]}\n',
          'vendor/acme/kit/src/Kit.php':
            '<?php\nnamespace Acme\\Kit;\n\nclass Kit\n{\n    public function make()\n    {\n        return 1;\n    }\n}\n',
          'vendor/composer/installed.json':
            '{"packages":[{"name":"acme/kit","version":"1.0.0","install-path":"../acme/kit","autoload":{"psr-4":{"Acme\\\\Kit\\\\":"src/"}}}]}\n',
        },
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'] + '\n',
        },
        syncArgs: [],
        betweenAAndB: (repo, env, dbDir) => {
          const build = runCli(
            repo,
            join(dbDir, 'scoped.db'),
            ['vendor-pack', 'build', '--depth', 'ast-only'],
            env
          );
          expect(build.status, build.stdout + build.stderr).toBe(0);
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('merges the vendor pack a cold rebuild merges', () => {
      const vendorNodes = (dump: IndexDump) =>
        selectRows(dump, 'structural_nodes', (r) => r.includes('origin=vendor-pack'));
      expect(vendorNodes(s.cold).length).toBeGreaterThan(0);
      expect(vendorNodes(s.scoped)).toEqual(vendorNodes(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });
});
