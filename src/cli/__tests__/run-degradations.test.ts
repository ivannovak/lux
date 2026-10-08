// Degradations reach the run's warnings on every rebuild and sync path, including the scoped refresh
// that a code commit takes by default and the post-commit hook that runs it (issue #6). Each case
// must print its warning once as `Warning: <message>`, close on ⚠, and print nothing that reads as
// success.
//
// Faults no fixture repository produces are injected with the test preload in
// fixtures/faults/inject.ts; database write failures with SQLite triggers.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { LuxDatabase } from '../../db/index.js';
import { loadOverlayTrustState } from '../../scanner/overlay-trust-state.js';
import { built, builtCli, builtModularCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();
// A fault is injected into Lux's modules, which only the unbundled CLI loads from their own files.
const FAULT_CLI_ENTRY = builtModularCli();
const HOOK = join(PROJECT_ROOT, 'bin', 'post-commit-hook.sh');
const FAULTS = built(join(__dirname, 'fixtures', 'faults', 'inject.ts'));
const SOURCE_CLI = join(__dirname, 'fixtures', 'hook-cli', 'lux-from-source.sh');

// spawnSync blocks the event loop, so the per-call timeout is the hang guard and the test timeout
// (vitest.config.ts) only bounds total duration.
const CALL_TIMEOUT_MS = 45000;

const LSP_LESS = 'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n';
const ROUTES_A =
  "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/a', fn () => 'a');\n";
const ROUTES_B = ROUTES_A + "Route::get('/b', fn () => 'b');\n";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(repo: string, cmd: string): void {
  execSync(cmd, { cwd: repo, stdio: 'pipe' });
}

/** A committed repo holding the given files (paths relative to the repo root). */
function repoWith(files: Record<string, string>): string {
  const repo = tempDir('lux-degrade-');
  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name x');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, 'git add -A');
  git(repo, 'git commit -q -m base');
  return repo;
}

function commitFile(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
  git(repo, 'git add -A');
  git(repo, 'git commit -q -m change');
}

/** A migrated, empty database, so the run under test does not print the migration log. */
function newDbPath(): string {
  const dbPath = join(tempDir('lux-degrade-db-'), 'lux.db');
  new LuxDatabase(dbPath).close();
  return dbPath;
}

function runLux(
  repo: string,
  dbPath: string,
  args: string[],
  opts: { faults?: string; env?: Record<string, string> } = {}
) {
  const preload = opts.faults ? ['--import', FAULTS] : [];
  const r = spawnSync(
    process.execPath,
    [
      ...preload,
      opts.faults ? FAULT_CLI_ENTRY : CLI_ENTRY,
      '--db',
      dbPath,
      '--corpus',
      repo,
      ...args,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...opts.env,
        LUX_TEST_FAULTS: opts.faults ?? '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      timeout: CALL_TIMEOUT_MS,
    }
  );
  if (r.error) throw new Error(`lux ${args.join(' ')} did not finish: ${r.error.message}`);
  return r;
}

function installTrigger(dbPath: string, sql: string): void {
  const raw = new Database(dbPath);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
}

/** The output carries `warning` in the fixed form, a matching ⚠ closing line, and no success. */
function expectWarned(
  output: { stdout: string; stderr: string },
  warning: string,
  closing: RegExp
) {
  expect(output.stderr).toContain(`Warning: ${warning}`);
  const all = `${output.stdout}\n${output.stderr}`;
  expect(all).toMatch(closing);
  for (const line of all.split('\n').filter((l) => l.includes('Warning'))) {
    expect(line).toMatch(/^Warning: /);
  }
  expect(all).not.toContain('✓');
  expect(all).not.toContain('successfully');
}

const DETECTOR_FAULT = 'detector "laravel-http-surfaces" threw — injected detector fault';

/** A Laravel-style repo indexed cleanly, then a route change committed: the next sync is scoped. */
function routesRepoReadyForScopedSync(): { repo: string; dbPath: string } {
  const repo = repoWith({
    'lux.yaml': LSP_LESS,
    'composer.json': '{}',
    'routes/web.php': ROUTES_A,
  });
  const dbPath = newDbPath();
  const rebuild = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
  expect(rebuild.status, rebuild.stderr).toBe(0);
  commitFile(repo, 'routes/web.php', ROUTES_B);
  return { repo, dbPath };
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('scoped refresh reports what it absorbed (issue #6)', () => {
  it('a detector fault on `index sync --quiet`', () => {
    const { repo, dbPath } = routesRepoReadyForScopedSync();

    const r = runLux(repo, dbPath, ['index', 'sync', '--quiet'], { faults: 'laravel-detector' });

    expect(r.status, r.stderr).toBe(0);
    expectWarned(r, DETECTOR_FAULT, /^⚠ scoped refresh complete .* with \d+ warning\(s\) in /m);
    const db = new LuxDatabase(dbPath);
    const trust = loadOverlayTrustState(db);
    db.close();
    expect(trust?.mode).toBe('degraded-overlay');
    expect(trust?.warnings).toContain(DETECTOR_FAULT);
  });

  it('a detector fault relayed by the post-commit hook', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'composer.json': '{}',
      'routes/web.php': ROUTES_A,
    });
    const dbPath = join(repo, '.lux', 'lux.db');
    const rebuild = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
    expect(rebuild.status, rebuild.stderr).toBe(0);
    commitFile(repo, 'routes/web.php', ROUTES_B);

    const r = spawnSync('bash', [HOOK], {
      cwd: repo,
      encoding: 'utf-8',
      env: {
        ...process.env,
        LUX_CLI: SOURCE_CLI,
        LUX_TEST_NODE: process.execPath,
        LUX_SKIP_SYNC: '',
        LUX_TEST_FAULTS: 'laravel-detector',
        LUX_TEST_CLI_ENTRY: FAULT_CLI_ENTRY,
        NODE_OPTIONS: `--import ${FAULTS}`,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      timeout: CALL_TIMEOUT_MS,
    });
    if (r.error) throw new Error(`post-commit hook did not finish: ${r.error.message}`);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`Warning: ${DETECTOR_FAULT}`);
    expect(r.stderr).toMatch(/^⚠ Lux index synced with \d+ warning\(s\) \(1 file\(s\) updated\)$/m);
    expect(r.stderr).not.toContain('✓');
  });
});

describe('degradations outside the scanner channel (issue #6)', () => {
  it('an enricher that fails to start', () => {
    const repo = repoWith({
      'lux.yaml': [
        'lsp:',
        '  enabled: true',
        '  enrichers:',
        '    - language_id: typescript',
        '      enabled: true',
        '      server_command: lux-test-no-such-language-server',
        '',
      ].join('\n'),
      'package.json': '{}',
      'a.ts': 'export const a = 1;\n',
    });

    const r = runLux(repo, newDbPath(), ['index', 'rebuild', '--quiet']);
    expect(r.status, r.stderr).toBe(0);
    expectWarned(
      r,
      'Failed to initialize typescript enricher',
      /^⚠ index rebuild complete with \d+ warning\(s\) in /m
    );
  });

  it('a configured enricher with no implementation', () => {
    const repo = repoWith({
      'lux.yaml': [
        'lsp:',
        '  enabled: true',
        '  enrichers:',
        '    - language_id: cobol',
        '      enabled: true',
        '      server_command: cobol-ls',
        '',
      ].join('\n'),
      'package.json': '{}',
      'a.ts': 'export const a = 1;\n',
    });

    const r = runLux(repo, newDbPath(), ['index', 'rebuild', '--quiet']);
    expect(r.status, r.stderr).toBe(0);
    expectWarned(
      r,
      'LSP enricher for "cobol" was configured but is not supported',
      /^⚠ index rebuild complete with \d+ warning\(s\) in /m
    );
  });

  it('a failed event log on an incremental sync', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'docs/a.md': '# a\n' });
    const dbPath = newDbPath();
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
    installTrigger(
      dbPath,
      `CREATE TRIGGER fail_events BEFORE INSERT ON events
         BEGIN SELECT RAISE(ABORT, 'injected events failure'); END;`
    );
    commitFile(repo, 'docs/a.md', '# a\n\nmore\n');

    const r = runLux(repo, dbPath, ['index', 'sync']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Sync path: incremental content sync');
    expectWarned(r, 'Failed to log sync event', /^⚠ Synced with \d+ warning\(s\): /m);
  });

  it('a failed event log on a sync that escalates to a full rebuild', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'package.json': '{}',
      'composer.lock': '{"content-hash":"a"}\n',
      'a.ts': 'export const a = 1;\n',
    });
    const dbPath = newDbPath();
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
    installTrigger(
      dbPath,
      `CREATE TRIGGER fail_events BEFORE INSERT ON events
         BEGIN SELECT RAISE(ABORT, 'injected events failure'); END;`
    );
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
    commitFile(repo, 'composer.lock', '{"content-hash":"b"}\n');

    const r = runLux(repo, dbPath, ['index', 'sync']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Sync path: full rebuild (config-changed)');
    expectWarned(
      r,
      'Failed to log sync event',
      /^⚠ Sync escalated to full overlay rebuild with \d+ warning\(s\) \(/m
    );
  });

  it('an embedder that cannot be constructed', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'package.json': '{}',
      'a.ts': 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    });

    const r = runLux(repo, newDbPath(), ['index', 'rebuild', '--quiet'], {
      faults: 'embedder',
      env: { LUX_EMBEDDING_TOKEN: 'test-token-never-sent' },
    });
    expect(r.status, r.stderr).toBe(0);
    expectWarned(
      r,
      'anchor embedder unavailable, skipped the embed pass: injected embedder fault',
      /^⚠ index rebuild complete with \d+ warning\(s\) in /m
    );
  });

  it('an embed pass stopped by a failed embed request', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'package.json': '{}',
      'a.ts': 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    });

    const r = runLux(repo, newDbPath(), ['index', 'rebuild', '--quiet'], {
      faults: 'embed-pass',
      env: { LUX_EMBEDDING_TOKEN: 'test-token-never-sent' },
    });
    expect(r.status, r.stderr).toBe(0);
    expectWarned(
      r,
      'anchor embed pass failed after embedding 0 node(s): injected embed request failure',
      /^⚠ index rebuild complete with \d+ warning\(s\) in /m
    );
  });

  it('an AST extraction limit on one file', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'package.json': '{}',
      'good.js': 'export function good() {}\n',
      'big.js': `export function big() {}\n${' '.repeat(2.2 * 1024 * 1024)}`,
    });
    const dbPath = newDbPath();

    const r = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
    expect(r.status, r.stderr).toBe(0);
    expectWarned(r, 'AST extraction limit for big.js', /^⚠ index rebuild complete with /m);
    const db = new LuxDatabase(dbPath);
    const trust = loadOverlayTrustState(db);
    db.close();
    expect(trust?.warnings.some((w) => w.startsWith('AST extraction limit for big.js'))).toBe(true);
  });
});
