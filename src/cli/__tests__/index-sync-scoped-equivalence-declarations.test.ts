// `lux index sync` across a change A→B states the same facts as a cold `lux index rebuild` of B
// (scoped-equivalence-scenarios.ts has the fixture and how a scenario runs).
//
// Scenarios about where things are declared: a declaration in two files, a route gaining and losing
// a second declaring file, a renamed file and a symlink, and a vendor pack built after the rebuild.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { join } from 'path';
import { git, runCli, selectRows, type IndexDump } from './scoped-sync-harness.js';
import {
  BASE_TREE,
  SCENARIO_TIMEOUT_MS,
  expectEquivalent,
  runScenario,
  disposeScenarios,
  type Scenario,
} from './scoped-equivalence-scenarios.js';

afterAll(disposeScenarios);

describe('index sync — scoped sync converges on a cold rebuild: declarations and files', () => {
  describe('a declaration made in two files settles as in a cold rebuild', () => {
    let s: Scenario;
    const provider = (name: string, listener: string) =>
      [
        '<?php',
        'namespace App\\Providers;',
        '',
        `class ${name}`,
        '{',
        '    public function boot()',
        '    {',
        `        Event::listen(\\App\\Events\\OrderPaid::class, \\App\\Listeners\\${listener}::class);`,
        '    }',
        '}',
        '',
      ].join('\n');
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        extraBase: {
          'app/Providers/BillingServiceProvider.php': provider('BillingServiceProvider', 'Charge'),
          'app/Providers/UsersServiceProvider.php': provider('UsersServiceProvider', 'Notify'),
        },
        // The scan reads files in path order, so the last writer, UsersServiceProvider, owns the
        // boundary. A refresh that visited its changed file first would hand it to Billing.
        change: {
          'app/Providers/UsersServiceProvider.php':
            provider('UsersServiceProvider', 'Notify') + '\n',
        },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('records the event boundary against the same file as a cold rebuild', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
      const boundary = (dump: IndexDump) =>
        selectRows(dump, 'operational_boundaries', (r) => r.includes('OrderPaid'));
      expect(boundary(s.cold)).toHaveLength(1);
      expect(boundary(s.scoped)).toEqual(boundary(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('a route gaining and losing a second declaring file', () => {
    const WEB = "<?php\nRoute::get('/dup', function () {\n    return 1;\n});\n";
    const OTHER = "<?php\nRoute::get('/dup', function () {\n    return 2;\n});\n";
    const surfaces = (dump: IndexDump) =>
      selectRows(dump, 'structural_nodes', (r) => r.includes('node_type=capability-surface'));

    it(
      'qualifies both surfaces by file when a second file declares the route',
      () => {
        const s = runScenario({
          lspBudgetMs: 600_000,
          extraBase: { 'routes/web.php': WEB },
          change: { 'routes/other.php': OTHER },
        });
        expect(s.syncStdout).toContain('scoped refresh complete');
        expect(surfaces(s.cold).filter((r) => r.includes('/dup#file:'))).toHaveLength(2);
        expect(surfaces(s.scoped)).toEqual(surfaces(s.cold));
        expectEquivalent(s);
      },
      SCENARIO_TIMEOUT_MS
    );

    it(
      'returns to the bare surface id when the second declaration goes',
      () => {
        const s = runScenario({
          lspBudgetMs: 600_000,
          extraBase: { 'routes/web.php': WEB, 'routes/other.php': OTHER },
          change: { 'routes/other.php': null },
        });
        expect(s.syncStdout).toContain('scoped refresh complete');
        expect(surfaces(s.cold).some((r) => r.includes('/dup#file:'))).toBe(false);
        expect(surfaces(s.cold).some((r) => r.includes('id=surface:http:GET:/dup |'))).toBe(true);
        expect(surfaces(s.scoped)).toEqual(surfaces(s.cold));
        expectEquivalent(s);
      },
      SCENARIO_TIMEOUT_MS
    );
  });

  describe('a renamed file and a symlink whose target changed', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        extraBase: { 'docs/AGENTS.md': '# Agents\n\nFirst guidance.\n' },
        betweenAAndB: (repo) => {
          git(repo, 'git mv src/Module/Billing/Exporter.php src/Module/Billing/ExportBuilder.php');
        },
        change: { 'docs/AGENTS.md': '# Agents\n\nRevised guidance.\n' },
      });
    }, SCENARIO_TIMEOUT_MS);

    it('drops what was indexed under the old path of a renamed file', () => {
      const oldPath = (dump: IndexDump, table: string) =>
        selectRows(dump, table, (r) => r.includes('src/Module/Billing/Exporter.php'));
      expect(oldPath(s.cold, 'structural_nodes')).toEqual([]);
      expect(oldPath(s.scoped, 'structural_nodes')).toEqual([]);
      expect(oldPath(s.scoped, 'knowledge_entries')).toEqual(oldPath(s.cold, 'knowledge_entries'));
    });

    it('reindexes a symlink whose target changed', () => {
      const linked = (dump: IndexDump) =>
        selectRows(dump, 'knowledge_entries', (r) => r.includes('file_path=CLAUDE.md'));
      expect(linked(s.cold).some((r) => r.includes('Revised guidance'))).toBe(true);
      expect(linked(s.scoped)).toEqual(linked(s.cold));
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
      // The merged pack is every app file's resolution universe: no scoped refresh can follow it.
      expect(s.syncStdout).toContain('Sync path: full rebuild (vendor-pack-changed)');
      const vendorNodes = (dump: IndexDump) =>
        selectRows(dump, 'structural_nodes', (r) => r.includes('origin=vendor-pack'));
      expect(vendorNodes(s.cold).length).toBeGreaterThan(0);
      expect(vendorNodes(s.scoped)).toEqual(vendorNodes(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });
});
