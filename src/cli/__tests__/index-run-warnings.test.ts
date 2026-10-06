// Every warning a rebuild or sync raises goes through one list: it is printed once as
// `Warning: <message>` on stderr, in every mode, and it turns the closing line from ✓ into ⚠. A run
// with no warnings closes on ✓, and a clean `index sync --quiet` prints nothing (issue #6).
//
// Warnings are forced with SQLite triggers in the database file and with git states the sync
// recovers from. Clean runs need an overlay with no warnings, which takes a real TypeScript LSP.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

// spawnSync blocks the event loop, so the per-call timeout is the hang guard and the per-case
// timeout only bounds total duration. An LSP-backed rebuild is the slowest call here.
const CALL_TIMEOUT_MS = 45000;
const CASE_TIMEOUT_MS = 120000;

const LSP_LESS_YAML = 'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n';
const TS_LSP_YAML = [
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

const roots: string[] = [];

function git(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function commitAll(repo: string, msg: string): string {
  git(repo, 'git add -A');
  git(repo, `git commit -q -m ${JSON.stringify(msg)}`);
  return git(repo, 'git rev-parse HEAD');
}

function runLux(repo: string, dbPath: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repo, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    timeout: CALL_TIMEOUT_MS,
  });
  if (r.error) throw new Error(`lux ${args.join(' ')} did not finish: ${r.error.message}`);
  return r;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A git repo with one commit holding the given lux.yaml, a doc and a small TypeScript project. */
function newRepo(luxYaml: string, opts: { commit?: boolean } = {}): string {
  const repo = tempDir('lux-run-warnings-');
  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name x');
  writeFileSync(join(repo, 'lux.yaml'), luxYaml);
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'run-warnings-fx', private: true, type: 'module' })
  );
  writeFileSync(
    join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    })
  );
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'greeter.ts'),
    'export class Greeter {\n  greet(name: string): string {\n    return `hello ${name}`;\n  }\n}\n'
  );
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n');
  if (opts.commit !== false) commitAll(repo, 'base');
  return repo;
}

/** A migrated, empty database, so the run under test does not print the migration log. */
function newDbPath(): string {
  const dbPath = join(tempDir('lux-run-warnings-db-'), 'lux.db');
  new LuxDatabase(dbPath).close();
  return dbPath;
}

/** Install a trigger in the database file. */
function installTrigger(dbPath: string, sql: string): void {
  const raw = new Database(dbPath);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
}

/** The run shows each warning once in the fixed form, closes on ⚠, and claims no success. */
function expectWarned(r: ReturnType<typeof runLux>, warnings: string[], closing: RegExp): void {
  expect(r.status, r.stderr).toBe(0);
  for (const warning of warnings) {
    expect(r.stderr).toContain(`Warning: ${warning}`);
  }
  expect(r.stdout).toMatch(closing);
  const output = `${r.stdout}\n${r.stderr}`;
  // One fixed form: any line that mentions a warning starts with `Warning: ` (never `[+…] Warning:`).
  for (const line of output.split('\n').filter((l) => l.includes('Warning'))) {
    expect(line).toMatch(/^Warning: /);
  }
  expect(output).not.toContain('✓');
  expect(output).not.toContain('successfully');
}

/** The run raised no warnings and closes on ✓. */
function expectClean(r: ReturnType<typeof runLux>, closing: string): void {
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).not.toContain('Warning');
  expect(r.stdout).toContain(closing);
  expect(r.stdout).not.toContain('⚠');
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('one warnings list per run (issue #6)', () => {
  it(
    'a scanner warning and a failed commit-hash write in a repo with no commits',
    () => {
      const repo = newRepo(LSP_LESS_YAML, { commit: false });

      expectWarned(
        runLux(repo, newDbPath(), ['index', 'rebuild', '--quiet']),
        [
          'could not read git state — freshness tracking will use "unknown".',
          'Failed to store git commit hash',
        ],
        /^⚠ index rebuild complete with \d+ warning\(s\) in /m
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    'a failed rebuild-event log',
    () => {
      const repo = newRepo(LSP_LESS_YAML);
      const dbPath = newDbPath();
      installTrigger(
        dbPath,
        `CREATE TRIGGER fail_events BEFORE INSERT ON events
         BEGIN SELECT RAISE(ABORT, 'injected events failure'); END;`
      );

      expectWarned(
        runLux(repo, dbPath, ['index', 'rebuild']),
        ['Failed to log rebuild event'],
        /^⚠ Index rebuilt with \d+ warning\(s\)$/m
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    'a failed commit-hash write',
    () => {
      const repo = newRepo(LSP_LESS_YAML);
      const dbPath = newDbPath();
      installTrigger(
        dbPath,
        `CREATE TRIGGER fail_commit_hash BEFORE INSERT ON index_metadata
         WHEN NEW.key = 'last_indexed_commit'
         BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END;`
      );

      expectWarned(
        runLux(repo, dbPath, ['index', 'rebuild', '--quiet']),
        ['Failed to store git commit hash'],
        /^⚠ index rebuild complete with \d+ warning\(s\) in /m
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    'index sync when the stored commit no longer exists',
    () => {
      const repo = newRepo(LSP_LESS_YAML);
      const dbPath = newDbPath();
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
      const db = new LuxDatabase(dbPath);
      db.setIndexMetadata('last_indexed_commit', 'deadbeef'.repeat(5));
      db.close();

      expectWarned(
        runLux(repo, dbPath, ['index', 'sync']),
        ['Stored commit no longer exists (possible force push); ran a full rebuild instead'],
        /^⚠ Full rebuild complete with \d+ warning\(s\) \(/m
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    'index sync when git diff fails',
    () => {
      const repo = newRepo(LSP_LESS_YAML);
      const dbPath = newDbPath();
      expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
      // A blob id passes the existence check but cannot be diffed against a commit.
      const blob = git(repo, 'git rev-parse HEAD:docs/guide.md');
      writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nmore\n');
      commitAll(repo, 'docs');
      const db = new LuxDatabase(dbPath);
      db.setIndexMetadata('last_indexed_commit', blob);
      db.close();

      expectWarned(
        runLux(repo, dbPath, ['index', 'sync']),
        ['git diff failed; ran a full rebuild instead'],
        /^⚠ Full rebuild complete with \d+ warning\(s\) \(/m
      );
    },
    CASE_TIMEOUT_MS
  );
});

describe('clean runs close on ✓ (issue #6)', () => {
  /** A TypeScript repo indexed by a clean, LSP-backed rebuild. */
  function cleanlyIndexed(): { repo: string; dbPath: string } {
    const repo = newRepo(TS_LSP_YAML);
    const dbPath = newDbPath();
    const rebuild = runLux(repo, dbPath, ['index', 'rebuild']);
    expectClean(rebuild, '✓ Index rebuilt successfully');
    return { repo, dbPath };
  }

  it(
    'index rebuild',
    () => {
      const { dbPath, repo } = cleanlyIndexed();
      const again = runLux(repo, dbPath, ['index', 'rebuild']);
      expectClean(again, '\n✓ Index rebuilt successfully');
      expect(again.stdout).toContain('✓ index rebuild complete in ');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'index rebuild --content-only --quiet',
    () => {
      const repo = newRepo(LSP_LESS_YAML);

      // A clean --quiet run prints nothing at all.
      const r = runLux(repo, newDbPath(), ['index', 'rebuild', '--content-only', '--quiet']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'an incremental index sync',
    () => {
      const { repo, dbPath } = cleanlyIndexed();
      writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nupdated\n');
      commitAll(repo, 'docs');

      const r = runLux(repo, dbPath, ['index', 'sync']);
      expect(r.stdout).toContain('Sync path: incremental content sync');
      expectClean(r, '✓ Synced: +1 indexed');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'an incremental index sync --quiet prints nothing',
    () => {
      const { repo, dbPath } = cleanlyIndexed();
      writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nupdated\n');
      commitAll(repo, 'docs');

      const r = runLux(repo, dbPath, ['index', 'sync', '--quiet']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    },
    CASE_TIMEOUT_MS
  );
});
