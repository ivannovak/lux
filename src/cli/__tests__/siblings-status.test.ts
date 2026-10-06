// `lux siblings status` (spec 10 Part D / Decision 8 / T1.5 / SC-2). Report-only (exit 0 always):
// lists each sibling with worktree/schema/indexed-vs-HEAD/staleness, renders fresh / STALE /
// drift-unknown rows and a structured refusal row + remediation per resolve-time class; `--json`
// emits the buildFederationBlock shape (attached + freshness / refusal).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-siblings-status-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A git worktree carrying a built .lux; returns its HEAD sha. */
function makeWorktree(dir: string, opts: { indexed?: boolean; skew?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'composer.json'),
    JSON.stringify({ autoload: { 'psr-4': { 'Acme\\X\\': 'src/' } } })
  );
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: dir,
  });
  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
  if (opts.indexed ?? true) {
    new LuxDatabase(join(dir, '.lux', 'lux.db')).close();
    if (opts.skew) {
      const raw = new LuxSqlite(join(dir, '.lux', 'lux.db'));
      raw.run(
        'DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)'
      );
      raw.close();
    }
  }
  return head;
}

function markIndexedAt(dir: string, sha: string): void {
  const db = new LuxDatabase(join(dir, '.lux', 'lux.db'));
  db.setIndexMetadata('last_indexed_commit', sha);
  db.close();
}

/** Build a corpus registering fresh / stale / db-only / worktree-missing / db-absent / skew. */
function makeCorpus(): string {
  const corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });

  const fresher = join(root, 'fresher');
  const fh = makeWorktree(fresher);
  markIndexedAt(fresher, fh); // last_indexed_commit == HEAD → fresh

  const staler = join(root, 'staler');
  makeWorktree(staler);
  markIndexedAt(staler, '0'.repeat(40)); // != HEAD → STALE

  const cached = join(root, 'cached');
  makeWorktree(cached); // used in db: mode → no worktree → drift unknown

  const noidx = join(root, 'noidx');
  makeWorktree(noidx, { indexed: false }); // db-absent

  const skew = join(root, 'skew');
  makeWorktree(skew, { skew: true }); // schema-skew

  writeFileSync(
    join(corpus, 'lux.yaml'),
    'siblings:\n' +
      `  fresher:\n    path: ${fresher}\n` +
      `  staler:\n    path: ${staler}\n` +
      `  cached:\n    db: ${join(cached, '.lux', 'lux.db')}\n` +
      `  gone:\n    path: ${join(root, 'does-not-exist')}\n` +
      `  noidx:\n    path: ${noidx}\n` +
      `  skew:\n    path: ${skew}\n`
  );
  return corpus;
}

describe('lux siblings status', () => {
  it('renders fresh / STALE / drift-unknown rows + a refusal row per class (exit 0)', () => {
    const corpus = makeCorpus();
    const res = runCli(corpus, ['--corpus', corpus, 'siblings', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('fresh');
    expect(res.stdout).toContain('STALE');
    expect(res.stdout).toContain('drift unknown');
    expect(res.stdout).toContain('WORKTREE-MISSING');
    expect(res.stdout).toContain('DB-ABSENT');
    expect(res.stdout).toContain('SCHEMA-SKEW');
    expect(res.stdout).toContain('↳'); // remediation lines
  });

  it('--json emits the buildFederationBlock shape (attached + freshness / refusal)', () => {
    const corpus = makeCorpus();
    const res = runCli(corpus, ['--corpus', corpus, 'siblings', 'status', '--json']);
    expect(res.status).toBe(0);
    const block = JSON.parse(res.stdout) as {
      siblings: Array<{
        name: string;
        attached: boolean;
        freshness?: { stale: boolean | null; dbSchemaVersion: number | null };
        refusal?: { reason: string };
      }>;
    };
    expect(Array.isArray(block.siblings)).toBe(true);
    const attached = block.siblings.filter((s) => s.attached);
    const refused = block.siblings.filter((s) => !s.attached);
    expect(attached.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect(attached[0].freshness).toBeDefined();
    expect(refused.some((s) => s.refusal?.reason === 'worktree-missing')).toBe(true);
  });

  it('reports no siblings when the registry is empty (exit 0)', () => {
    const corpus = join(root, 'empty');
    mkdirSync(corpus, { recursive: true });
    const res = runCli(corpus, ['--corpus', corpus, 'siblings', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No siblings registered');
  });
});
