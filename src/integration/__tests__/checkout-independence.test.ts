// An index does not depend on where its repository is checked out (issue #16).
//
// One commit is rebuilt in two directories of different depth and name, under two different HOMEs.
// The stored tables and the --json output must then be the same with NO path substitution: this
// test never replaces a checkout root with a placeholder, so an absolute path stored or printed
// anywhere shows up as a difference.
//
// What is left out of the comparison, and why:
//   - wall-clock columns and JSON keys (created_at, updated_at, recordedAt, …);
//   - INTEGER autoincrement `id` columns (insertion-order artifacts);
//   - the `events` table, an append-only usage log of per-run ids and durations (count compared);
//   - INVOCATION_PATH_FIELDS in --json output: runtime.corpusPath, runtime.dbPath and
//     overlay.repoPath say where this invocation ran, and are masked by exact key path.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import {
  diffDumps,
  dumpTables,
  runCommandRaw,
  runLux,
  writeDeterminismFixture,
  type CliRun,
} from './helpers/determinism.js';

/** Every command here prints at least one value that came from a stored path. */
const COMMANDS: Record<string, (root: string) => string[]> = {
  search: () => ['search', 'Alpha', '--json'],
  'search-snippets': () => ['search', 'Determinism', '--json', '--snippets'],
  'deps-graph': () => ['deps', 'graph', '--json'],
  'deps-clusters': () => ['deps', 'clusters', '--json'],
  // The file is named by absolute path, so the answer does not depend on the test's own cwd.
  'deps-impact': (root) => [
    'deps',
    'impact',
    join(root, 'src/Module/Alpha/Services/AlphaService.php'),
    '--json',
  ],
  // A relative argument names a file under the corpus, wherever the command is run from.
  'deps-impact-relative': () => [
    'deps',
    'impact',
    'src/Module/Alpha/Services/AlphaService.php',
    '--json',
  ],
  'deps-coverage': () => ['deps', 'coverage', '--json'],
  'boundaries-show': () => ['overlay', 'boundaries', 'show', '--json'],
  'overlay-ownership': () => ['overlay', 'ownership', '--json'],
  'overlay-status': () => ['overlay', 'status', '--json'],
  'index-status': () => ['index', 'status', '--json'],
  doctor: () => ['doctor', '--json'],
  anchors: () => ['anchors', 'alpha service', '--json'],
  delta: () => ['delta', '--json'],
};

interface Checkout {
  root: string;
  db: string;
  home: string;
  rebuild: CliRun;
  tables: Record<string, string[]>;
  output: Record<string, string>;
}

let base: string;
const checkouts: Checkout[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-checkout-independence-'));
  for (const [index, relative] of ['one/checkout', 'two/deeper/checkout-b'].entries()) {
    const root = join(base, relative);
    const home = join(base, `home-${index + 1}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(home);
    writeDeterminismFixture(root, { pinWorkspaceRoot: false });
    const db = join(root, '.lux', 'lux.db');
    const rebuild = runLux(root, db, home, ['index', 'rebuild', '--quiet']);
    const ok = rebuild.status === 0;
    checkouts.push({
      root,
      db,
      home,
      rebuild,
      tables: ok ? dumpTables(db, null) : {},
      output: ok
        ? Object.fromEntries(
            Object.entries(COMMANDS).map(([name, args]) => [
              name,
              runCommandRaw(root, db, home, args(root)),
            ])
          )
        : {},
    });
  }
}, 600_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('an index is independent of its checkout directory', () => {
  it('rebuilds both checkouts successfully', () => {
    for (const checkout of checkouts) {
      expect(checkout.rebuild.status, checkout.rebuild.stderr).toBe(0);
    }
  });

  it('stores the same rows in every table, compared without path substitution', () => {
    expect(diffDumps(checkouts[0].tables, checkouts[1].tables)).toEqual([]);
  });

  it('stores no value that contains either checkout root or HOME', () => {
    const machinePaths = checkouts.flatMap((c) => [c.root, c.home]);
    const offenders: string[] = [];
    for (const checkout of checkouts) {
      for (const [table, rows] of Object.entries(checkout.tables)) {
        for (const row of rows) {
          if (machinePaths.some((path) => row.includes(path))) {
            offenders.push(`${table}: ${row.slice(0, 200)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('stores corpus-relative paths in the two columns the issue names', () => {
    const [checkout] = checkouts;
    const entries = checkout.tables.knowledge_entries.map(
      (row) => JSON.parse(row) as { file_path: string }
    );
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.filter((entry) => isAbsolute(entry.file_path))).toEqual([]);
    expect(entries.map((entry) => entry.file_path)).toContain('src/Module/Alpha/readme.md');

    const deps = checkout.tables.module_dependencies.map(
      (row) => JSON.parse(row) as { sample_files: string[] }
    );
    const samples = deps.flatMap((dep) => dep.sample_files);
    expect(samples.length).toBeGreaterThan(20);
    expect(samples.filter((file) => isAbsolute(file))).toEqual([]);
    expect(samples.every((file) => file.startsWith('src/Module/'))).toBe(true);
  });

  for (const name of Object.keys(COMMANDS)) {
    it(`prints the same --json for ${name}, compared without path substitution`, () => {
      expect(checkouts[0].output[name].startsWith('exit=0\n'), checkouts[0].output[name]).toBe(
        true
      );
      expect(checkouts[1].output[name]).toBe(checkouts[0].output[name]);
    });
  }

  it('the commands that print stored paths print them, relative', () => {
    const search = JSON.parse(checkouts[0].output.search.split('\n').slice(1).join('\n')) as {
      results: Array<{ filePath: string }>;
    };
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.filter((r) => isAbsolute(r.filePath))).toEqual([]);

    const impact = JSON.parse(
      checkouts[0].output['deps-impact'].split('\n').slice(1).join('\n')
    ) as { file: string; dependentModules: Array<{ sampleFiles: string[] }> };
    const samples = impact.dependentModules.flatMap((m) => m.sampleFiles);
    expect(impact.file).toBe('src/Module/Alpha/Services/AlphaService.php');
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.filter((file) => isAbsolute(file))).toEqual([]);
  });

  it('deps impact echoes a relative argument as given, not rewritten against the cwd', () => {
    const impact = JSON.parse(
      checkouts[0].output['deps-impact-relative'].split('\n').slice(1).join('\n')
    ) as { file: string; module: string };
    expect(impact.file).toBe('src/Module/Alpha/Services/AlphaService.php');
    expect(impact.module).toBe('Alpha');
  });

  it('deps impact text output lists sample files relative, the same in both checkouts', () => {
    const text = checkouts.map(
      (c) =>
        runLux(c.root, c.db, c.home, [
          'deps',
          'impact',
          join(c.root, 'src/Module/Alpha/Services/AlphaService.php'),
        ]).stdout
    );
    const samples = text[0].split('\n').filter((line) => line.startsWith('      - '));
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((line) => line.startsWith('      - src/Module/'))).toBe(true);
    expect(text[1]).toBe(text[0]);
  });

  it('status still says where the repository is, from the running corpus path', () => {
    for (const checkout of checkouts) {
      const status = JSON.parse(
        runLux(checkout.root, checkout.db, checkout.home, ['index', 'status', '--json']).stdout
      ) as { overlay: { repoPath: string }; runtime: { corpusPath: string } };
      expect(status.overlay.repoPath).toBe(checkout.root);
      expect(status.runtime.corpusPath).toBe(checkout.root);
    }
  });

  it('detects one stored absolute path (planted control)', () => {
    const planted = join(base, 'planted.db');
    copyFileSync(checkouts[1].db, planted);
    const db = new LuxSqlite(planted);
    try {
      db.run(
        `UPDATE knowledge_entries SET file_path = ? || '/' || file_path
         WHERE rowid = (SELECT MIN(rowid) FROM knowledge_entries)`,
        checkouts[1].root
      );
    } finally {
      db.close();
    }
    const problems = diffDumps(checkouts[1].tables, dumpTables(planted, null));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^knowledge_entries: \d+ vs \d+ rows, 1 only in run 1, 1 only/);
  });
});
