// `lux index sync` across a change A→B states the same facts as a cold `lux index rebuild` of B
// (scoped-equivalence-scenarios.ts has the fixture and how a scenario runs).
//
// The comparison instrument, and the scenarios that start from the plain fixture at A (they share one
// rebuild of it).

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { copyFileSync } from 'fs';
import { join } from 'path';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import {
  INDEX_COMPARISON_EXCLUSIONS,
  diffIndexes,
  dumpIndex,
  formatDifferences,
  git,
  runCli,
  selectRows,
  type IndexDump,
} from './scoped-sync-harness.js';
import {
  BASE_TREE,
  expectEquivalent,
  runScenario,
  trustState,
  disposeScenarios,
  type Scenario,
} from './scoped-equivalence-scenarios.js';

afterAll(disposeScenarios);

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
    });

    it('reports no difference between two cold rebuilds of the same commit', () => {
      const second = join(s.coldDb + '.second');
      const rebuild = runCli(s.repo, second, ['index', 'rebuild'], {
        LUX_PACK_CACHE: join(s.coldDb, '..', 'packs'),
      });
      expect(rebuild.status, rebuild.stderr).toBe(0);
      const differences = diffIndexes(s.cold, dumpIndex(second, s.repo));
      expect(differences, formatDifferences(differences)).toEqual([]);
    });

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
    });

    it('keeps the group prefix on every HTTP surface', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
      const surfaces = (dump: IndexDump) =>
        selectRows(dump, 'structural_nodes', (r) => r.includes('node_type=capability-surface'));
      expect(surfaces(s.cold).some((r) => r.includes('GET /admin/api/bulk-downloads/{id}'))).toBe(
        true
      );
      expect(surfaces(s.scoped)).toEqual(surfaces(s.cold));
    });

    it('stamps detector and LSP edges with the commit that derived them, on both paths', () => {
      const head = git(s.repo, 'git rev-parse HEAD');
      const commits = (dbPath: string) => {
        const db = new LuxSqlite(dbPath, { readonly: true });
        const rows = db.all(
          `SELECT DISTINCT source_commit FROM structural_edges
            WHERE edge_type IN ('declares_surface', 'handled_by') OR id LIKE '%:lsp'`
        ) as Array<{ source_commit: string | null }>;
        db.close();
        return rows.map((row) => row.source_commit);
      };
      expect(commits(s.coldDb)).toEqual([head]);
      expect(commits(s.scopedDb)).toEqual([head]);
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
    });

    it('materializes the same LSP symbol nodes as a cold rebuild', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
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
    });

    it('refreshes module_dependencies (defect 4)', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
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

  describe('framework nodes a rebuild materializes for a refreshed file', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        change: {
          // An exported interface is a mobile-architecture node in a rebuild, not only an LSP symbol.
          'resources/js/types/cart.ts': 'export interface CartLine {\n  id: number;\n}\n',
        },
      });
    });

    it('materializes the same framework nodes as a cold rebuild', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
      const cartNodes = (dump: IndexDump) =>
        selectRows(dump, 'structural_nodes', (r) =>
          r.includes('file_path=resources/js/types/cart.ts')
        );
      expect(cartNodes(s.cold).some((r) => r.includes('"framework":"mobile"'))).toBe(true);
      expect(cartNodes(s.scoped)).toEqual(cartNodes(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('a failed module-dependency write on the scoped path', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'] + '\n',
        },
        betweenAAndB: (_repo, _env, dbDir) => {
          const db = new LuxSqlite(join(dbDir, 'scoped.db'));
          db.exec(`CREATE TRIGGER fail_dependency_write BEFORE INSERT ON module_dependencies
            BEGIN SELECT RAISE(ABORT, 'injected dependency write failure'); END;`);
          db.close();
        },
      });
    });

    it('degrades the refreshed trust state with the warning, as a rebuild does', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
      const trust = trustState(s.scoped);
      expect(trust.mode).toBe('degraded-overlay');
      expect(trust.warnings).toContain(
        'Failed to write module dependencies (injected dependency write failure); ' +
          'the module dependency graph is empty until the next successful rebuild.'
      );
      expect(s.scoped.get('module_dependencies')).toEqual([]);
    });
  });
});
