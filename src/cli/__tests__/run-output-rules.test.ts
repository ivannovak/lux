// What a rebuild or sync prints (issue #6): each warning once; malformed frontmatter warned about
// and still indexed; a failed `--embeddings` model fetch warned about; nothing at all from a clean
// `--quiet` run on any path; migrations only under `--verbose`; and warnings an earlier run raised
// labelled as carried, until a run that re-runs their component cleanly retires them.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { hostname, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { loadOverlayTrustState } from '../../scanner/overlay-trust-state.js';
import { built, builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();
const FAULTS = built(join(__dirname, 'fixtures', 'faults', 'inject.ts'));

// spawnSync blocks the event loop, so the per-call timeout is the hang guard and the per-case
// timeout only bounds total duration; the clean-quiet case makes five LSP-backed runs.
const CALL_TIMEOUT_MS = 45000;
const CASE_TIMEOUT_MS = 240000;

const LSP_LESS = 'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n';
const TS_LSP = [
  'lsp:',
  '  enabled: true',
  '  enrichers:',
  '    - language_id: typescript',
  '      enabled: true',
  '      server_command: typescript-language-server',
  '      server_args:',
  '        - --stdio',
  'deps:',
  '  enabled: false',
  '',
].join('\n');
const MISSING_TS_SERVER = [
  'lsp:',
  '  enabled: true',
  '  enrichers:',
  '    - language_id: typescript',
  '      enabled: true',
  '      server_command: lux-test-no-such-language-server',
  '',
].join('\n');
const ROUTES_A =
  "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/a', fn () => 'a');\n";
const ROUTES_B = ROUTES_A + "Route::get('/b', fn () => 'b');\n";
const ROUTES_C = ROUTES_B + "Route::get('/c', fn () => 'c');\n";
const BAD_FRONTMATTER = '---\ntitle: [unclosed\n---\nbody text that must stay indexed\n';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(repo: string, cmd: string): void {
  execSync(cmd, { cwd: repo, stdio: 'pipe' });
}

function repoWith(files: Record<string, string>): string {
  const repo = tempDir('lux-output-');
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

function dbPathIn(): string {
  return join(tempDir('lux-output-db-'), 'lux.db');
}

function runLux(
  repo: string,
  dbPath: string,
  args: string[],
  opts: { faults?: string; env?: Record<string, string>; globalArgs?: string[] } = {}
) {
  const preload = opts.faults ? ['--import', FAULTS] : [];
  const r = spawnSync(
    process.execPath,
    [...preload, CLI_ENTRY, ...(opts.globalArgs ?? []), '--db', dbPath, '--corpus', repo, ...args],
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

function linesMatching(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

/** The run exited 0 and printed nothing on either stream. */
function expectSilent(r: ReturnType<typeof runLux>): void {
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('run output rules (issue #6)', () => {
  it(
    'prints a warning raised both now and by an earlier run once, as this run’s',
    () => {
      const repo = repoWith({
        'lux.yaml': MISSING_TS_SERVER,
        'package.json': '{}',
        'a.ts': 'export const a = 1;\n',
      });
      const dbPath = dbPathIn();
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
      commitFile(repo, 'a.ts', 'export const a = 2;\n');

      const r = runLux(repo, dbPath, ['index', 'sync', '--mark-only']);
      expect(r.status, r.stderr).toBe(0);
      const lines = linesMatching(r.stderr, 'Failed to initialize typescript enricher');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Warning: Failed to initialize typescript enricher/);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'warns about malformed frontmatter and still indexes the file, on rebuild and on sync',
    () => {
      const repo = repoWith({
        'lux.yaml': LSP_LESS,
        'package.json': '{}',
        'bad.md': BAD_FRONTMATTER,
      });
      const dbPath = dbPathIn();
      const contentOf = (): string | undefined => {
        const db = new LuxDatabase(dbPath);
        try {
          return db.getKnowledgeEntryByPath('bad.md')?.content;
        } finally {
          db.close();
        }
      };

      const rebuild = runLux(repo, dbPath, ['index', 'rebuild']);
      expect(rebuild.status, rebuild.stderr).toBe(0);
      expect(rebuild.stderr).toMatch(/^Warning: malformed frontmatter in bad\.md; /m);
      expect(rebuild.stdout).toMatch(/^⚠ Index rebuilt with \d+ warning\(s\)$/m);
      expect(contentOf()).toContain('body text that must stay indexed');

      commitFile(repo, 'bad.md', BAD_FRONTMATTER + 'and a second line\n');
      const sync = runLux(repo, dbPath, ['index', 'sync']);
      expect(sync.status, sync.stderr).toBe(0);
      expect(sync.stdout).toContain('Sync path: incremental content sync');
      expect(sync.stderr).toMatch(/^Warning: malformed frontmatter in bad\.md; /m);
      expect(sync.stdout).toMatch(/^⚠ Synced with \d+ warning\(s\): /m);
      expect(contentOf()).toContain('and a second line');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'warns when `index rebuild --embeddings` cannot fetch the model',
    () => {
      const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'a.md': '# a\n' });

      const r = runLux(repo, dbPathIn(), ['index', 'rebuild', '--embeddings'], {
        faults: 'model-fetch',
        env: { HOME: tempDir('lux-output-home-') },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(
        /^Warning: could not fetch the embedding model \(.*injected fetch failure.*\); continued without anchor embeddings$/m
      );
      expect(r.stdout).toMatch(/^⚠ Index rebuilt with \d+ warning\(s\)$/m);
      expect(`${r.stdout}${r.stderr}`).not.toContain('✓');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'prints nothing from a clean `--quiet` run on every rebuild and sync path',
    () => {
      const repo = repoWith({
        'lux.yaml': TS_LSP,
        'package.json': JSON.stringify({ name: 'quiet-fx', private: true, type: 'module' }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
        'a.ts': 'export function a(): number {\n  return 1;\n}\n',
      });
      const dbPath = dbPathIn();

      expectSilent(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']));

      commitFile(repo, 'a.ts', 'export function a(): number {\n  return 2;\n}\n');
      const scoped = runLux(repo, dbPath, ['index', 'sync', '--quiet']);
      expectSilent(scoped);

      commitFile(repo, 'notes.md', '# notes\n');
      expectSilent(runLux(repo, dbPath, ['index', 'sync', '--quiet']));

      commitFile(repo, 'lux.yaml', TS_LSP + '# config edit\n');
      expectSilent(runLux(repo, dbPath, ['index', 'sync', '--quiet']));

      expectSilent(runLux(repo, dbPath, ['index', 'sync', '--force', '--quiet']));
    },
    CASE_TIMEOUT_MS
  );

  it(
    'prints migrations only under --verbose, and never under --quiet',
    () => {
      const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'a.md': '# a\n' });

      const plain = runLux(repo, dbPathIn(), ['index', 'rebuild', '--content-only']);
      expect(plain.status, plain.stderr).toBe(0);
      expect(`${plain.stdout}${plain.stderr}`).not.toContain('migration');

      const verbose = runLux(repo, dbPathIn(), ['index', 'rebuild', '--content-only'], {
        globalArgs: ['--verbose'],
      });
      expect(verbose.status, verbose.stderr).toBe(0);
      expect(verbose.stderr).toContain('Applying migration 1: initial_schema');

      const both = runLux(repo, dbPathIn(), ['index', 'rebuild', '--content-only', '--quiet'], {
        globalArgs: ['--verbose'],
      });
      expectSilent(both);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'labels a carried warning, and a scoped sync that re-runs its component cleanly retires it',
    () => {
      const repo = repoWith({
        'lux.yaml': LSP_LESS,
        'composer.json': '{}',
        'routes/web.php': ROUTES_A,
        'docs/a.md': '# a\n',
      });
      const dbPath = dbPathIn();
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
      const FAULT = 'detector "laravel-http-surfaces" threw — injected detector fault';

      // A scoped sync with the detector broken raises the warning as its own.
      commitFile(repo, 'routes/web.php', ROUTES_B);
      const faulted = runLux(repo, dbPath, ['index', 'sync', '--quiet'], {
        faults: 'laravel-detector',
      });
      expect(faulted.stderr).toContain(`Warning: ${FAULT}`);

      // A docs-only sync re-runs no detector: the warning is still there, labelled as carried.
      commitFile(repo, 'docs/a.md', '# a\n\nmore\n');
      const carried = runLux(repo, dbPath, ['index', 'sync']);
      expect(carried.status, carried.stderr).toBe(0);
      expect(carried.stderr).toContain(`Warning: carried from an earlier run: ${FAULT}`);

      // A scoped sync whose detector runs cleanly retires it.
      commitFile(repo, 'routes/web.php', ROUTES_C);
      const cleared = runLux(repo, dbPath, ['index', 'sync']);
      expect(cleared.status, cleared.stderr).toBe(0);
      expect(cleared.stdout).toContain('scoped overlay refresh');
      expect(`${cleared.stdout}${cleared.stderr}`).not.toContain(FAULT);
      const db = new LuxDatabase(dbPath);
      const trust = loadOverlayTrustState(db);
      db.close();
      expect(trust?.warnings).not.toContain(FAULT);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'warns when the embed step cannot read lux.yaml and falls back to the local model',
    () => {
      const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'a.md': '# a\n' });
      const dbPath = dbPathIn();
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
      // Broken after indexing, so the no-change sync's embed step is the only reader.
      writeFileSync(join(repo, 'lux.yaml'), 'lsp: [unclosed\n');

      const r = runLux(repo, dbPath, ['index', 'sync']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Index matches HEAD');
      expect(r.stderr).toMatch(
        /^Warning: lux\.yaml could not be read for its embedding settings, so the local model was used — /m
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    'does not label warnings derived from the current index as carried',
    () => {
      const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'docs/a.md': '# a\n' });
      const dbPath = dbPathIn();
      // A content-only rebuild records no trust state, so no earlier run raised any warning.
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--content-only', '--quiet']).status).toBe(
        0
      );
      commitFile(repo, 'docs/a.md', '# a\n\nmore\n');

      const r = runLux(repo, dbPath, ['index', 'sync']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/^Warning: /m);
      expect(r.stderr).not.toContain('carried from an earlier run');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'does not label inferred warnings as carried on a scoped sync either',
    () => {
      const repo = repoWith({
        'lux.yaml': LSP_LESS,
        'package.json': '{}',
        'a.ts': 'export function a(): number {\n  return 1;\n}\n',
      });
      const dbPath = dbPathIn();
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
      // With the persisted trust state gone, the next sync infers one from the DB's shape.
      const db = new LuxDatabase(dbPath);
      db.clearRebuildTrustState();
      db.close();
      commitFile(repo, 'a.ts', 'export function a(): number {\n  return 2;\n}\n');

      const r = runLux(repo, dbPath, ['index', 'sync']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('scoped overlay refresh');
      expect(r.stderr).toMatch(/^Warning: /m);
      expect(r.stderr).not.toContain('carried from an earlier run');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'keeps a clean --quiet sync silent when it clears a stale lock, and --verbose shows the notice',
    () => {
      const repo = repoWith({
        'lux.yaml': TS_LSP,
        'package.json': JSON.stringify({ name: 'lock-fx', private: true, type: 'module' }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
        'a.ts': 'export function a(): number {\n  return 1;\n}\n',
      });
      const dbPath = dbPathIn();
      expectSilent(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']));
      const NOTE = 'Note: cleared a stale database lock';

      // A lock left by a crashed run: its owner token names a pid that is not running, so the next
      // open reclaims it. (A lock that names no owner is never reclaimed.)
      const crashedRunLeavesLock = (): void => {
        mkdirSync(`${dbPath}.lock/4194303-0123456789ab@${encodeURIComponent(hostname())}`, {
          recursive: true,
        });
      };
      commitFile(repo, 'notes.md', '# notes\n');
      crashedRunLeavesLock();
      expectSilent(runLux(repo, dbPath, ['index', 'sync', '--quiet']));

      // Notices print by default, not only under --verbose.
      commitFile(repo, 'notes.md', '# notes\n\nmore\n');
      crashedRunLeavesLock();
      const plain = runLux(repo, dbPath, ['index', 'sync']);
      expect(plain.status, plain.stderr).toBe(0);
      expect(plain.stderr).toContain(NOTE);

      commitFile(repo, 'notes.md', '# notes\n\nmore\n\nagain\n');
      crashedRunLeavesLock();
      const verbose = runLux(repo, dbPath, ['index', 'sync'], { globalArgs: ['--verbose'] });
      expect(verbose.status, verbose.stderr).toBe(0);
      expect(verbose.stderr).toContain(NOTE);
    },
    CASE_TIMEOUT_MS
  );

  it('describes --quiet as it behaves, on rebuild and on sync', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}' });
    for (const command of ['rebuild', 'sync']) {
      const help = runLux(repo, dbPathIn(), ['index', command, '--help']);
      expect(help.stdout.replace(/\s+/g, ' '), command).toContain(
        '--quiet Print nothing on a clean run; otherwise only the warnings and one ⚠ line'
      );
    }
  });
});
