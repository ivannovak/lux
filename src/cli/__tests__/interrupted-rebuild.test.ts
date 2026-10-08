// A rebuild that dies part-way (killed, or the machine stops) leaves part of an index behind: its
// first commits clear the old index, and the rest never arrive. Whatever that part looks like, it is
// not a complete index: `index status` says the rebuild did not finish, and the next `index sync`
// rebuilds instead of syncing onto it. A rebuild records that it began (`beginRebuild`) in the
// commit that starts it. The first case kills a real rebuild right after it has cleared the overlay
// (fixtures/faults/inject.ts, `die-mid-rebuild`), so it holds the rebuild to writing that record;
// the others plant the record, which is the same state without depending on a kill.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { built, builtModularCli } from '../../integration/__tests__/helpers/built-cli.js';
import { commitAll, indexedBaseline, initRepo, runCli, writeTree } from './scoped-sync-harness.js';

const baseline = indexedBaseline('lux-interrupted-rebuild', (repo, dbPath) => {
  initRepo(repo);
  writeTree(repo, {
    'package.json': '{"name":"interrupted"}\n',
    'lux.yaml': 'lsp:\n  enabled: false\n  enrichers: []\n',
    'src/a.ts': 'export function a(): number {\n  return 1;\n}\n',
    'docs/guide.md': '# Guide\n',
  });
  commitAll(repo, 'A');
  const rebuild = runCli(repo, dbPath, ['index', 'rebuild', '--quiet']);
  expect(rebuild.status, rebuild.stderr).toBe(0);
});

afterAll(() => baseline.dispose());

function interrupted(): void {
  baseline.restore();
  const db = new LuxDatabase(baseline.dbPath);
  db.beginRebuild();
  db.close();
}

function status(): { mode: string; warnings: string[] } {
  const r = runCli(baseline.repo, baseline.dbPath, ['index', 'status', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as {
    overlay: { mode: string; warnings: string[] };
  };
  return parsed.overlay;
}

const FAULTS = built(join(import.meta.dirname, 'fixtures', 'faults', 'inject.ts'));

describe('an index whose last rebuild did not finish', () => {
  it('is what a rebuild killed after clearing the overlay leaves', () => {
    baseline.restore();
    const killed = spawnSync(
      process.execPath,
      [
        '--import',
        FAULTS,
        builtModularCli(),
        '--db',
        baseline.dbPath,
        '--corpus',
        baseline.repo,
        'index',
        'rebuild',
      ],
      { encoding: 'utf-8', env: { ...process.env, LUX_TEST_FAULTS: 'die-mid-rebuild' } }
    );
    expect(killed.signal).toBe('SIGKILL');
    const db = new LuxDatabase(baseline.dbPath);
    const startedAt = db.unfinishedRebuildStartedAt();
    db.close();
    expect(startedAt).toBeDefined();
    const overlay = status();
    expect(overlay.mode).toBe('degraded-overlay');
    expect(overlay.warnings[0]).toMatch(/^The rebuild started at .* has not finished/u);
  });

  it('reads as complete before the rebuild starts', () => {
    baseline.restore();
    expect(status().mode).toBe('overlay-complete');
  });

  it('is reported by index status as unfinished, never as complete', () => {
    interrupted();
    const overlay = status();
    expect(overlay.mode).toBe('degraded-overlay');
    expect(overlay.warnings[0]).toMatch(/^The rebuild started at .* has not finished/u);
  });

  it('is rebuilt by the next index sync, which leaves it complete', () => {
    interrupted();
    const sync = runCli(baseline.repo, baseline.dbPath, ['index', 'sync']);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stdout).toMatch(/did not finish, running full rebuild/u);
    expect(status().mode).toBe('overlay-complete');
  });
});
