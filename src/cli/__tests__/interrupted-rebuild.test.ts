// A rebuild that dies part-way (killed, or the machine stops) leaves part of an index behind: its
// first commits clear the old index, and the rest never arrive. Whatever that part looks like, it is
// not a complete index: `index status` says the rebuild did not finish, and the next `index sync`
// rebuilds instead of syncing onto it. A rebuild records that it began (`beginRebuild`) in the
// commit that starts it; here that record is planted after a complete rebuild, which is the state a
// rebuild killed after its first commits leaves, without depending on when a kill lands.

import { describe, it, expect, afterAll } from 'vitest';
import { LuxDatabase } from '../../db/index.js';
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

describe('an index whose last rebuild did not finish', () => {
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
