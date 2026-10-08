// The scenarios of the scoped-sync equivalence tests (index-sync-scoped-equivalence*.test.ts).
//
// `lux index sync` across a change A→B must leave the index stating the same facts as a cold
// `lux index rebuild` of B, apart from staleness it reports. Each scenario indexes a small Laravel +
// TypeScript + Vue repository at A, scoped-syncs that index to B through the real CLI, cold-rebuilds
// B into a separate index, and compares the two row by row (scoped-sync-harness.ts lists every
// column the comparison excludes). A fake language server stands in for intelephense and tsserver so
// the LSP tier runs for real and deterministically.
//
// Scenarios that start from the same A share one rebuild of it per test file: the first builds it,
// and each later one restores the repository and its index to A in place (indexedBaseline).

import { expect } from 'vitest';
import { copyFileSync, symlinkSync } from 'fs';
import { join } from 'path';
import {
  FAKE_LSP_SERVER,
  commitAll,
  diffIndexes,
  dumpIndex,
  formatDifferences,
  indexedBaseline,
  initRepo,
  runCli,
  writeTree,
  type IndexDump,
  type IndexedBaseline,
} from './scoped-sync-harness.js';

export const SCENARIO_TIMEOUT_MS = 240_000;

function luxYaml(lspBudgetMs: number, extra = ''): string {
  const enricher = (languageId: string) =>
    [
      `    - language_id: ${languageId}`,
      `      enabled: true`,
      `      server_command: ${JSON.stringify(process.execPath)}`,
      `      server_args:`,
      `        - ${JSON.stringify(FAKE_LSP_SERVER)}`,
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
    extra,
  ].join('\n');
}

export const BASE_TREE: Record<string, string> = {
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

export interface Scenario {
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

export interface ScenarioDef {
  lspBudgetMs: number;
  /** Changes committed as B. A null value deletes the file. */
  change: Record<string, string | null>;
  /** Runs after A is indexed and before the sync (e.g. building a vendor pack). */
  betweenAAndB?: (repo: string, env: Record<string, string>, dbDir: string) => void;
  /** Files present at A in addition to BASE_TREE. */
  extraBase?: Record<string, string>;
  /** Extra lux.yaml lines. */
  extraYaml?: string;
  env?: Record<string, string>;
  syncArgs?: string[];
}

/** The baselines of this test file, by the A they hold. */
const baselines = new Map<string, IndexedBaseline>();

/** Index A once per distinct A in a file; a later scenario with the same A restores it. */
function baselineFor(def: ScenarioDef, env: (dbDir: string) => Record<string, string>) {
  const key = JSON.stringify([def.lspBudgetMs, def.extraBase ?? {}, def.extraYaml ?? '', def.env]);
  const existing = baselines.get(key);
  if (existing) {
    existing.restore();
    return existing;
  }
  const baseline = indexedBaseline(
    'lux-scoped-eq',
    (repo, scopedDb, dbDir) => {
      initRepo(repo);
      writeTree(repo, {
        ...BASE_TREE,
        ...(def.extraBase ?? {}),
        'lux.yaml': luxYaml(def.lspBudgetMs, def.extraYaml),
      });
      if (def.extraBase?.['docs/AGENTS.md']) symlinkSync('docs/AGENTS.md', join(repo, 'CLAUDE.md'));
      commitAll(repo, 'A');
      const rebuildA = runCli(repo, scopedDb, ['index', 'rebuild'], env(dbDir));
      expect(rebuildA.status, rebuildA.stderr).toBe(0);
    },
    'scoped.db'
  );
  baselines.set(key, baseline);
  return baseline;
}

export function runScenario(def: ScenarioDef): Scenario {
  const scenarioEnv = (dbDir: string) => ({
    LUX_PACK_CACHE: join(dbDir, 'packs'),
    ...(def.env ?? {}),
  });
  const { repo, dbDir, dbPath: scopedDb } = baselineFor(def, scenarioEnv);
  const env = scenarioEnv(dbDir);
  const coldDb = join(dbDir, 'cold.db');
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

/**
 * Remove this file's fixtures. KEEP_FIXTURES=1 keeps them for inspection (including A.db, the
 * index at A, beside the last scenario's indexes) and prints their paths.
 */
export function disposeScenarios(): void {
  if (process.env.KEEP_FIXTURES) {
    console.log('FIXTURES', [...baselines.values()].map((b) => b.repo).join(' '));
    return;
  }
  for (const baseline of baselines.values()) baseline.dispose();
  baselines.clear();
}

export function expectEquivalent(s: Scenario): void {
  const differences = diffIndexes(s.cold, s.scoped);
  expect(differences, formatDifferences(differences)).toEqual([]);
}

export function trustState(dump: IndexDump): Record<string, unknown> {
  return JSON.parse((dump.get('overlay_trust_state') ?? ['{}'])[0]) as Record<string, unknown>;
}
