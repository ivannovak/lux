// Scoped-by-default + config-fingerprint escalation (spec 15 Part E / Decision 7 / SC-10 / T3b.4).
// A structural sync is SCOPED BY DEFAULT under budget; editing lux.yaml/composer.lock escalates to
// a full rebuild (fingerprint mismatch); a markdown-only change stays on the incremental content
// path; a firstParty-configured repo escalates on any structural change; `--full` forces full.
//
// The overlay + fingerprint + pointer are seeded in-process via rebuildWithOverlay (fast, no tsx
// cold start), mirroring what `lux index rebuild` persists in production; only the `lux index sync`
// under test is driven through the real CLI subprocess.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { rebuildWithOverlay } from '../../scanner/rebuild-orchestrator.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import { persistStructuralConfigFingerprint } from '../../scanner/config-fingerprint.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

const roots: string[] = [];

const A_V1 = `export function helper(): number { return 1; }\nexport function run(): number { return helper(); }\n`;
const A_V2 = `export function helper(): number { return 1; }\nexport function run(): number { return helper() + 0; }\n`;
const BASE_YAML = 'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n';

function git(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
}
function commitAll(repo: string, msg: string): string {
  git(repo, 'git add -A');
  git(repo, `git commit -q -m ${JSON.stringify(msg)}`);
  return git(repo, 'git rev-parse HEAD');
}
function runSync(repo: string, dbPath: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [CLI_ENTRY, '--db', dbPath, '--corpus', repo, 'index', 'sync', ...extra],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }
  );
}

/** Repo with a.ts + lux.yaml, a real in-process overlay, persisted trust + fingerprint + pointer. */
async function setup(luxYaml = BASE_YAML): Promise<{ repo: string; dbPath: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'lux-scoped-default-'));
  roots.push(repo);
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-scoped-default-db-'));
  roots.push(dbDir);
  const dbPath = join(dbDir, 'lux.db');

  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name x');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'scoped-default-fx' }));
  writeFileSync(join(repo, 'lux.yaml'), luxYaml);
  writeFileSync(join(repo, 'a.ts'), A_V1);
  const baseCommit = commitAll(repo, 'base');

  const db = new LuxDatabase(dbPath);
  const { result } = await rebuildWithOverlay(db, repo);
  persistRebuildTrustState(db, result, { lastIndexedCommit: baseCommit });
  persistStructuralConfigFingerprint(repo, db);
  db.setIndexMetadata('last_indexed_commit', baseCommit);
  db.close();

  return { repo, dbPath };
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('index sync — scoped-by-default + fingerprint escalation (spec 15 Part E / SC-10)', () => {
  it('a plain 1-file structural change under budget → scoped refresh by default', async () => {
    const { repo, dbPath } = await setup();
    writeFileSync(join(repo, 'a.ts'), A_V2);
    commitAll(repo, 'body change');

    const r = runSync(repo, dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('scoped refresh complete');
    expect(r.stdout).not.toContain('Sync path: full rebuild');
  });

  it('--full forces a full rebuild over the same under-budget change', async () => {
    const { repo, dbPath } = await setup();
    writeFileSync(join(repo, 'a.ts'), A_V2);
    commitAll(repo, 'body change');

    const r = runSync(repo, dbPath, ['--full']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sync path: full rebuild');
    expect(r.stdout).not.toContain('scoped refresh complete');
  });

  it('editing lux.yaml (alongside a structural change) → full rebuild (fingerprint mismatch)', async () => {
    const { repo, dbPath } = await setup();
    writeFileSync(join(repo, 'a.ts'), A_V2);
    writeFileSync(join(repo, 'lux.yaml'), BASE_YAML + '# cosmetic edit\n');
    commitAll(repo, 'config + source change');

    const r = runSync(repo, dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sync path: full rebuild (config-changed)');
    expect(r.stdout).not.toContain('scoped refresh complete');
  });

  it('adding composer.lock (alongside a structural change) → full rebuild (fingerprint mismatch)', async () => {
    const { repo, dbPath } = await setup();
    writeFileSync(join(repo, 'a.ts'), A_V2);
    writeFileSync(join(repo, 'composer.lock'), '{"content-hash":"xyz"}\n');
    commitAll(repo, 'lock + source change');

    const r = runSync(repo, dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sync path: full rebuild (config-changed)');
    expect(r.stdout).not.toContain('scoped refresh complete');
  });

  it('a markdown-only change stays on the incremental content path (no escalation)', async () => {
    const { repo, dbPath } = await setup();
    writeFileSync(join(repo, 'notes.md'), '# notes\n');
    commitAll(repo, 'docs add');

    const r = runSync(repo, dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sync path: incremental content sync');
    expect(r.stdout).not.toContain('scoped refresh complete');
    expect(r.stdout).not.toContain('Sync path: full rebuild');
  });

  it('a firstParty-configured repo → full rebuild on any structural change (Decision 9)', async () => {
    const { repo, dbPath } = await setup(BASE_YAML + 'firstParty:\n  packages:\n    - "acme/*"\n');
    writeFileSync(join(repo, 'a.ts'), A_V2);
    commitAll(repo, 'body change');

    const r = runSync(repo, dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sync path: full rebuild (first-party)');
    expect(r.stdout).not.toContain('scoped refresh complete');
  });
});
