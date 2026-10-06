// Cold-rebuild determinism (issue #7): two checkouts of one commit, rebuilt into separate
// databases with their files processed in different orders, must produce the same normalized
// tables and byte-identical --json output from every renderer-facing command.
//
// The fixture plants each hazard the issue measured: two files declaring the same symbol id,
// equal-weight module dependencies, order-sensitive float sums, and more sample candidates than
// a sample holds. LUX_TEST_SCAN_ORDER_SEED permutes the scan order per run, so a stage that
// depends on processing order diverges here instead of hiding behind the canonical sort.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import {
  DETERMINISM_COMMANDS,
  diffDumps,
  dumpTables,
  runBattery,
  runCommand,
  runLux,
  writeDeterminismFixture,
  writeOrderedRows,
  type CliRun,
} from './helpers/determinism.js';

interface Run {
  root: string;
  db: string;
  home: string;
  rebuild: CliRun;
  tables: Record<string, string[]>;
  battery: Record<string, string>;
}

const SEEDS = ['first-order', 'second-order'];
let base: string;
const runs: Run[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-determinism-'));
  for (const [index, seed] of SEEDS.entries()) {
    const root = join(base, `checkout-${index + 1}`);
    const home = join(base, `home-${index + 1}`);
    mkdirSync(root);
    mkdirSync(home);
    writeDeterminismFixture(root);
    const db = join(root, '.lux', 'lux.db');
    const rebuild = runLux(root, db, home, ['index', 'rebuild', '--quiet'], seed);
    runs.push({
      root,
      db,
      home,
      rebuild,
      tables: rebuild.status === 0 ? dumpTables(db, root) : {},
      battery: rebuild.status === 0 ? runBattery(root, db, home) : {},
    });
  }
}, 600_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('cold index rebuild determinism', () => {
  it('rebuilds both checkouts successfully', () => {
    for (const run of runs) expect(run.rebuild.status, run.rebuild.stderr).toBe(0);
  });

  it('plants every hazard it is meant to exercise', () => {
    const [run] = runs;
    const nodes = run.tables.structural_nodes.map((row) => JSON.parse(row) as { id: string });
    const qualified = nodes.filter((node) => node.id.includes('#file:')).map((node) => node.id);
    expect(qualified).toEqual(
      expect.arrayContaining([
        'symbol:php:module_helper#file:src/Module/Alpha/config/aliases.php',
        'symbol:php:module_helper#file:src/Module/Beta/config/aliases.php',
        'symbol:php:App\\Shared\\Duplicate#file:src/Module/Delta/Legacy/Duplicate.php',
        'symbol:php:App\\Shared\\Duplicate#file:src/Module/Gamma/Legacy/Duplicate.php',
      ])
    );
    expect(nodes.some((node) => node.id === 'symbol:php:module_helper')).toBe(false);

    // Every controller does `new Duplicate()`; with two declarations that reference is ambiguous,
    // resolves to neither, and is counted rather than silently lost.
    const status = JSON.parse(run.battery['index-status'].split('\n').slice(1).join('\n')) as {
      symbolIdCollisions: {
        collidingIds: number;
        edgesToAmbiguousIds: number;
        droppedAmbiguousReferences: number;
      };
    };
    const controllers = nodes.filter((node) =>
      /^symbol:php:App\\Module\\\w+\\Http\\Controllers\\\w+$/.test(node.id)
    ).length;
    expect(status.symbolIdCollisions.collidingIds).toBe(3);
    expect(status.symbolIdCollisions.droppedAmbiguousReferences).toBe(controllers);

    const deps = run.tables.module_dependencies.map(
      (row) => JSON.parse(row) as { reference_count: number; sample_files: string[] }
    );
    const counts = deps.map((dep) => dep.reference_count);
    expect(new Set(counts).size).toBeLessThan(counts.length); // ties exist
    expect(new Set(counts).size).toBeGreaterThan(1); // and weights differ
    expect(deps.every((dep) => dep.reference_count > dep.sample_files.length)).toBe(true);
  });

  it('writes the same normalized tables', () => {
    expect(diffDumps(runs[0].tables, runs[1].tables)).toEqual([]);
  });

  for (const name of Object.keys(DETERMINISM_COMMANDS)) {
    it(`prints the same --json for ${name}`, () => {
      expect(runs[0].battery[name].startsWith('exit=0\n')).toBe(true);
      expect(runs[1].battery[name]).toBe(runs[0].battery[name]);
    });
  }

  it('detects a one-row difference (planted control)', () => {
    const planted = join(base, 'planted.db');
    copyFileSync(runs[1].db, planted);
    const db = new LuxSqlite(planted);
    try {
      db.exec(
        `UPDATE module_dependencies SET reference_count = reference_count + 1
         WHERE rowid = (SELECT MIN(rowid) FROM module_dependencies)`
      );
    } finally {
      db.close();
    }

    // Compared with the database it was copied from, so the control holds whatever the rebuilds do.
    const problems = diffDumps(runs[1].tables, dumpTables(planted, runs[1].root));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^module_dependencies: \d+ vs \d+ rows, 1 only in run 1, 1 only/);

    const graph = runCommand(runs[1].root, planted, runs[1].home, 'deps-graph');
    expect(graph.startsWith('exit=0\n')).toBe(true);
    expect(graph).not.toBe(runs[1].battery['deps-graph']);
  }, 120_000);
});

// The rebuild writes rows in processing order, and SQLite returns rows that tie on every ORDER BY
// key in the order they were written. Writing one set of rows in two orders checks each read-side
// ordering directly: the battery must not see the difference.
describe('--json output from rows written in two orders', () => {
  const READ_COMMANDS = [
    'deps-graph',
    'deps-clusters',
    'boundaries-show',
    'boundaries-regions',
    'boundaries-families',
    'overlay-ownership',
  ];
  let dir: string;
  const outputs: Array<Record<string, string>> = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-row-order-'));
    const corpus = join(dir, 'corpus');
    const home = join(dir, 'home');
    mkdirSync(corpus);
    mkdirSync(home);
    for (const reverse of [false, true]) {
      const dbPath = join(dir, `${reverse ? 'reversed' : 'forward'}.db`);
      const db = new LuxDatabase(dbPath);
      try {
        writeOrderedRows(db, reverse);
      } finally {
        db.close();
      }
      outputs.push(
        Object.fromEntries(
          READ_COMMANDS.map((name) => [name, runCommand(corpus, dbPath, home, name)])
        )
      );
    }
  }, 300_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const name of READ_COMMANDS) {
    it(`prints the same --json for ${name}`, () => {
      expect(outputs[0][name].startsWith('exit=0\n')).toBe(true);
      expect(outputs[1][name]).toBe(outputs[0][name]);
    });
  }
});
