// `lux index sync` across a change A→B states the same facts as a cold `lux index rebuild` of B
// (scoped-equivalence-scenarios.ts has the fixture and how a scenario runs).
//
// Scenarios about the LSP tier: a budget spent during requests or during start-up, LSP symbols of
// unchanged files, and cross-file calls resolved against files outside the refreshed set.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { selectRows, type IndexDump } from './scoped-sync-harness.js';
import {
  BASE_TREE,
  expectEquivalent,
  runScenario,
  disposeScenarios,
  type Scenario,
} from './scoped-equivalence-scenarios.js';

afterAll(disposeScenarios);

describe('index sync — scoped sync converges on a cold rebuild: the LSP tier', () => {
  describe('LSP tier over budget (defect 1)', () => {
    let s: Scenario;
    beforeAll(() => {
      // Each documentSymbol answer takes 400 ms, so the PHP files of R cannot finish in 1 s.
      s = runScenario({
        lspBudgetMs: 1000,
        syncEnv: { FAKE_LSP_DELAY_MS: '400' },
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'].replace(
            'return $exporter->build();',
            '$built = $exporter->build();\n        return $built;'
          ),
        },
      });
    });

    it('leaves no typed-receiver call edge stale or missing', () => {
      // A refresh whose LSP tier cannot finish cannot reproduce the rebuild; it escalates.
      expect(s.syncStdout).toContain('Sync path: full rebuild (lsp-budget-exceeded)');
      const lspEdges = (dump: IndexDump) =>
        selectRows(dump, 'structural_edges', (row) => /^id=[^|]*:lsp \|/u.test(row));
      expect(lspEdges(s.cold).length).toBeGreaterThan(0);
      expect(lspEdges(s.scoped)).toEqual(lspEdges(s.cold));
      expect(selectRows(s.scoped, 'structural_edges', (r) => r.includes('=stale'))).toEqual([]);
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('LSP budget spent while the servers are still starting', () => {
    let s: Scenario;
    beforeAll(() => {
      // Each server takes 700 ms to answer initialize, so the 1 s budget runs out during start-up.
      s = runScenario({
        lspBudgetMs: 1000,
        syncEnv: { FAKE_LSP_INIT_DELAY_MS: '700' },
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'] + '\n',
        },
      });
    });

    it('escalates, exits, and states the same facts as a cold rebuild', () => {
      expect(s.syncStatus).toBe(0);
      expect(s.syncStdout).toContain('Sync path: full rebuild (lsp-budget-exceeded)');
      expectEquivalent(s);
    });
  });

  describe('cross-file calls into a file outside the refreshed set', () => {
    let s: Scenario;
    const caller = (extra: string) =>
      [
        "import { makeStore, sharedStore } from './store';",
        '',
        'export function run(): number {',
        `  return makeStore() + sharedStore()${extra};`,
        '}',
        '',
      ].join('\n');
    beforeAll(() => {
      // Nova off, so the changed TypeScript file does not pull the whole program into R.
      s = runScenario({
        lspBudgetMs: 600_000,
        extraYaml: 'frameworks:\n  nova:\n    enabled: false\n',
        extraBase: {
          // makeStore is an AST definition; sharedStore only an LSP symbol (a const).
          'resources/js/store.ts':
            'export function makeStore(): number {\n  return 1;\n}\nexport const sharedStore = createStore();\n',
          'resources/js/caller.ts': caller(''),
        },
        change: { 'resources/js/caller.ts': caller(' + 1') },
      });
    });

    it('resolves an import into an unchanged file, as a rebuild does', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
      const toMakeStore = (dump: IndexDump) =>
        selectRows(dump, 'structural_edges', (r) =>
          r.includes('caller.ts#run→symbol:ts:resources/js/store.ts#makeStore')
        );
      expect(toMakeStore(s.cold)).toHaveLength(1);
      expect(toMakeStore(s.scoped)).toEqual(toMakeStore(s.cold));
    });

    it('resolves only to AST-defined symbols, as a rebuild does', () => {
      const toShared = (dump: IndexDump) =>
        selectRows(dump, 'structural_edges', (r) =>
          r.includes('caller.ts#run→symbol:ts:resources/js/store.ts#sharedStore')
        );
      expect(toShared(s.cold)).toEqual([]);
      expect(toShared(s.scoped)).toEqual([]);
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });

  describe('LSP metadata of an unchanged file that refers into a changed one', () => {
    let s: Scenario;
    beforeAll(() => {
      s = runScenario({
        lspBudgetMs: 600_000,
        extraBase: {
          // The fake server lists every call of `build` as a reference of Report::build, so
          // Report.php's recorded reference lines move when a calling file's lines do.
          'src/Module/Users/Report.php':
            '<?php\nnamespace App\\Module\\Users;\n\nclass Report\n{\n    public function build()\n    {\n        return 2;\n    }\n}\n',
        },
        change: {
          'src/Module/Users/Account.php': BASE_TREE['src/Module/Users/Account.php'].replace(
            'class Account',
            '// Exports for an account.\nclass Account'
          ),
        },
      });
    });

    it('rewrites the knowledge entry of every re-enriched file', () => {
      expect(s.syncStdout).toContain('scoped refresh complete');
      const report = (dump: IndexDump) =>
        selectRows(dump, 'knowledge_entries', (r) =>
          r.includes('file_path=src/Module/Users/Report.php')
        );
      expect(report(s.cold)).toHaveLength(1);
      expect(report(s.scoped)).toEqual(report(s.cold));
    });

    it('states the same facts as a cold rebuild', () => expectEquivalent(s));
  });
});
