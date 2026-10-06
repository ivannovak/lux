// Module dependencies survive every rebuild entry point (issue #6).
//
// The shared rebuild clears `module_dependencies` along with the content index, so whichever path
// runs it must write back the dependencies its scan computed. A sync that escalates to a full rebuild
// (here: a composer.lock change ⇒ config-changed) must leave the table equal to a cold
// `index rebuild` of the same commit, and `deps graph` must still have data to show.
//
// A failed write must not pass as a complete rebuild: the table is left empty, the run is degraded,
// and the warning reaches both the output and the persisted trust state.
//
// Every step is driven through the real CLI subprocess, so the assertion covers what an operator runs.
// Write failures are injected with a SQLite trigger in the database file, which the subprocess honours.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

const roots: string[] = [];

// spawnSync blocks the event loop, so vitest applies the per-case timeout only after the body
// returns: the 30 s per-call timeout is the real hang guard (a hung CLI fails on its own message),
// and the 60 s per-case timeout is a total-duration check. Measured: one call takes 2-4 s at load
// ~24 and about 8 s at load ~60, a case makes at most four, and the slowest case took ~25 s.
const CLI_CALL_TIMEOUT_MS = 30000;
const CLI_TIMEOUT_MS = 60000;

const LUX_YAML =
  'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: true\n  module_boundary: "src/Module/{name}"\n';

const USERS_A = `<?php
namespace App\\Module\\Users;

use App\\Module\\Orders\\OrderService;

class UserService {}
`;

const USERS_B = `<?php
namespace App\\Module\\Users;

use App\\Module\\Orders\\OrderService;
use App\\Module\\Billing\\BillingService;

class UserService {}
`;

const ORDERS = `<?php
namespace App\\Module\\Orders;

class OrderService {}
`;

const BILLING = `<?php
namespace App\\Module\\Billing;

use App\\Module\\Orders\\OrderService;
use App\\Module\\Users\\UserService;

class BillingService {}
`;

function git(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function commitAll(repo: string, msg: string): void {
  git(repo, 'git add -A');
  git(repo, `git commit -q -m ${JSON.stringify(msg)}`);
}

function runLux(repo: string, dbPath: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repo, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    timeout: CLI_CALL_TIMEOUT_MS,
  });
  if (r.error) {
    throw new Error(`lux ${args.join(' ')} did not finish: ${r.error.message}`);
  }
  return r;
}

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lux-sync-deps-db-'));
  roots.push(dir);
  return join(dir, 'lux.db');
}

function writeModule(repo: string, name: string, file: string, content: string): void {
  mkdirSync(join(repo, 'src', 'Module', name), { recursive: true });
  writeFileSync(join(repo, 'src', 'Module', name, file), content);
}

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'lux-sync-deps-'));
  roots.push(repo);
  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name x');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'sync-deps-fx' }));
  writeFileSync(join(repo, 'lux.yaml'), LUX_YAML);
  return repo;
}

/** Commit A: Users → Orders. */
function commitA(repo: string): void {
  writeFileSync(join(repo, 'composer.lock'), '{"content-hash":"a"}\n');
  writeModule(repo, 'Users', 'UserService.php', USERS_A);
  writeModule(repo, 'Orders', 'OrderService.php', ORDERS);
  commitAll(repo, 'A');
}

/** Commit B: a fingerprinted config change plus code that alters the dependency graph. */
function commitB(repo: string): void {
  writeFileSync(join(repo, 'composer.lock'), '{"content-hash":"b"}\n');
  writeModule(repo, 'Users', 'UserService.php', USERS_B);
  writeModule(repo, 'Billing', 'BillingService.php', BILLING);
  commitAll(repo, 'B');
}

/**
 * Make every module_dependencies insert after the first fail, so a write that is not atomic would
 * leave one row behind. Creates (and migrates) the database first when it does not exist yet.
 */
function failSecondDependencyInsert(dbPath: string): void {
  new LuxDatabase(dbPath).close();
  const raw = new Database(dbPath);
  try {
    raw.exec(`CREATE TRIGGER fail_second_dependency BEFORE INSERT ON module_dependencies
      WHEN (SELECT COUNT(*) FROM module_dependencies) >= 1
      BEGIN SELECT RAISE(ABORT, 'injected dependency write failure'); END;`);
  } finally {
    raw.close();
  }
}

function persistedTrustState(dbPath: string): { mode: string; warnings: string[] } {
  const db = new LuxDatabase(dbPath);
  try {
    return JSON.parse(db.getIndexMetadata('overlay_trust_state') ?? 'null') as {
      mode: string;
      warnings: string[];
    };
  } finally {
    db.close();
  }
}

const FAILURE_LINE =
  'Warning: Failed to write module dependencies (injected dependency write failure); ' +
  'the module dependency graph is empty until the next successful rebuild.';

/** Order-independent snapshot of every persisted dependency row (ids and timestamps excluded). */
function dependencyRows(dbPath: string): string[] {
  const db = new LuxDatabase(dbPath);
  try {
    return db
      .getAllModuleDependencies()
      .map((d) =>
        JSON.stringify([d.source_module, d.target_module, d.reference_count, d.sample_files])
      )
      .sort();
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('index sync — module dependencies after a full-rebuild escalation (issue #6)', () => {
  it(
    'a config-changed full rebuild leaves module_dependencies equal to a cold rebuild',
    () => {
      const repo = newRepo();
      commitA(repo);

      const dbPath = newDbPath();
      const rebuildA = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
      expect(rebuildA.status, rebuildA.stderr).toBe(0);
      const rowsA = dependencyRows(dbPath);
      expect(rowsA.length).toBeGreaterThan(0);

      commitB(repo);
      const sync = runLux(repo, dbPath, ['index', 'sync']);
      expect(sync.status, sync.stderr).toBe(0);
      expect(sync.stdout).toContain('Sync path: full rebuild (config-changed)');

      const coldDbPath = newDbPath();
      const coldB = runLux(repo, coldDbPath, ['index', 'rebuild', '--quiet']);
      expect(coldB.status, coldB.stderr).toBe(0);
      const rowsColdB = dependencyRows(coldDbPath);
      expect(rowsColdB).not.toEqual(rowsA);

      expect(dependencyRows(dbPath)).toEqual(rowsColdB);

      const graph = runLux(repo, dbPath, ['deps', 'graph', '--json']);
      expect(graph.status, graph.stderr).toBe(0);
      const parsed = JSON.parse(graph.stdout) as { data: unknown[] };
      expect(parsed.data.length).toBeGreaterThan(0);
    },
    CLI_TIMEOUT_MS
  );

  it(
    'a --force sync leaves module_dependencies equal to a cold rebuild',
    () => {
      const repo = newRepo();
      commitA(repo);
      const dbPath = newDbPath();
      const rebuildA = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
      expect(rebuildA.status, rebuildA.stderr).toBe(0);
      const rowsA = dependencyRows(dbPath);

      commitB(repo);
      const sync = runLux(repo, dbPath, ['index', 'sync', '--force']);
      expect(sync.status, sync.stderr).toBe(0);
      expect(sync.stdout).toContain('Force flag set, running full rebuild');

      const coldDbPath = newDbPath();
      const coldB = runLux(repo, coldDbPath, ['index', 'rebuild', '--quiet']);
      expect(coldB.status, coldB.stderr).toBe(0);
      const rowsColdB = dependencyRows(coldDbPath);
      expect(rowsColdB).not.toEqual(rowsA);

      expect(dependencyRows(dbPath)).toEqual(rowsColdB);
    },
    CLI_TIMEOUT_MS
  );

  it(
    'a content-only rebuild writes the dependencies its scan computed',
    () => {
      const repo = newRepo();
      writeModule(repo, 'Users', 'UserService.php', USERS_B);
      writeModule(repo, 'Orders', 'OrderService.php', ORDERS);
      writeModule(repo, 'Billing', 'BillingService.php', BILLING);
      commitAll(repo, 'A');

      const overlayDb = newDbPath();
      const overlay = runLux(repo, overlayDb, ['index', 'rebuild', '--quiet']);
      expect(overlay.status, overlay.stderr).toBe(0);

      const contentDb = newDbPath();
      const content = runLux(repo, contentDb, ['index', 'rebuild', '--content-only', '--quiet']);
      expect(content.status, content.stderr).toBe(0);

      const rows = dependencyRows(contentDb);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toEqual(dependencyRows(overlayDb));
    },
    CLI_TIMEOUT_MS
  );
});

describe('index rebuild / sync — a failed module-dependency write is reported, not hidden (issue #6)', () => {
  it(
    'index rebuild leaves no rows, degrades the run and shows the warning',
    () => {
      const repo = newRepo();
      commitA(repo);
      commitB(repo);
      const dbPath = newDbPath();
      failSecondDependencyInsert(dbPath);

      const r = runLux(repo, dbPath, ['index', 'rebuild']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Mode: degraded-overlay');
      expect(r.stderr).toContain(FAILURE_LINE);

      expect(dependencyRows(dbPath)).toEqual([]);
      const trust = persistedTrustState(dbPath);
      expect(trust.mode).toBe('degraded-overlay');
      expect(trust.warnings.some((w) => FAILURE_LINE.endsWith(w))).toBe(true);
    },
    CLI_TIMEOUT_MS
  );

  it(
    'a sync that escalates to a full rebuild shows the warning and persists it',
    () => {
      const repo = newRepo();
      commitA(repo);
      const dbPath = newDbPath();
      const rebuildA = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
      expect(rebuildA.status, rebuildA.stderr).toBe(0);
      failSecondDependencyInsert(dbPath);

      commitB(repo);
      const sync = runLux(repo, dbPath, ['index', 'sync']);
      expect(sync.status, sync.stderr).toBe(0);
      expect(sync.stdout).toContain('Sync path: full rebuild (config-changed)');
      expect(sync.stdout).toContain('Mode: degraded-overlay');
      expect(sync.stderr).toContain(FAILURE_LINE);

      expect(dependencyRows(dbPath)).toEqual([]);
      expect(persistedTrustState(dbPath).warnings.some((w) => FAILURE_LINE.endsWith(w))).toBe(true);
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index rebuild --content-only shows the warning',
    () => {
      const repo = newRepo();
      commitA(repo);
      commitB(repo);
      const dbPath = newDbPath();
      failSecondDependencyInsert(dbPath);

      const r = runLux(repo, dbPath, ['index', 'rebuild', '--content-only']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(FAILURE_LINE);
      expect(dependencyRows(dbPath)).toEqual([]);
    },
    CLI_TIMEOUT_MS
  );
});

describe('--quiet rebuild and sync paths never claim success over a failed write (issue #6)', () => {
  /** --quiet output must carry the warning and a ⚠ line, and nothing that reads as success. */
  function expectQuietWarning(r: ReturnType<typeof runLux>): void {
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(FAILURE_LINE);
    expect(r.stdout).toMatch(/^⚠ .*\d+ warning\(s\)/m);
    const output = `${r.stdout}\n${r.stderr}`;
    expect(output).not.toContain('✓');
    expect(output).not.toContain('successfully');
  }

  /** Repo at commit A, indexed with a working write; the next write will fail. */
  function indexedAtA(): { repo: string; dbPath: string } {
    const repo = newRepo();
    commitA(repo);
    const dbPath = newDbPath();
    const rebuildA = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
    expect(rebuildA.status, rebuildA.stderr).toBe(0);
    failSecondDependencyInsert(dbPath);
    return { repo, dbPath };
  }

  it(
    'index rebuild --quiet',
    () => {
      const repo = newRepo();
      commitA(repo);
      commitB(repo);
      const dbPath = newDbPath();
      failSecondDependencyInsert(dbPath);

      expectQuietWarning(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']));
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index rebuild --content-only --quiet',
    () => {
      const repo = newRepo();
      commitA(repo);
      commitB(repo);
      const dbPath = newDbPath();
      failSecondDependencyInsert(dbPath);

      expectQuietWarning(runLux(repo, dbPath, ['index', 'rebuild', '--content-only', '--quiet']));
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index sync --quiet escalating to a full rebuild',
    () => {
      const { repo, dbPath } = indexedAtA();
      commitB(repo);

      expectQuietWarning(runLux(repo, dbPath, ['index', 'sync', '--quiet']));
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index sync --force --quiet',
    () => {
      const { repo, dbPath } = indexedAtA();
      commitB(repo);

      expectQuietWarning(runLux(repo, dbPath, ['index', 'sync', '--force', '--quiet']));
    },
    CLI_TIMEOUT_MS
  );
});

describe('closing lines report warnings instead of success, with or without --quiet (issue #6)', () => {
  /** The run's warning is shown, its closing line matches, and nothing reads as success. */
  /** `carried`: the warning came from an earlier run, so it is printed with that label. */
  function expectWarnedRun(r: ReturnType<typeof runLux>, closing: RegExp, carried = false): void {
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(
      carried
        ? FAILURE_LINE.replace('Warning: ', 'Warning: carried from an earlier run: ')
        : FAILURE_LINE
    );
    expect(r.stdout).toMatch(closing);
    const output = `${r.stdout}\n${r.stderr}`;
    expect(output).not.toContain('✓');
    expect(output).not.toContain('successfully');
  }

  /** Repo at commit A whose rebuild hit a failed write, so its trust state carries the warning. */
  function degradedAtA(): { repo: string; dbPath: string } {
    const repo = newRepo();
    commitA(repo);
    commitB(repo);
    const dbPath = newDbPath();
    failSecondDependencyInsert(dbPath);
    const rebuild = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
    expect(rebuild.status, rebuild.stderr).toBe(0);
    return { repo, dbPath };
  }

  it(
    'index rebuild',
    () => {
      const repo = newRepo();
      commitA(repo);
      commitB(repo);
      const dbPath = newDbPath();
      failSecondDependencyInsert(dbPath);

      expectWarnedRun(
        runLux(repo, dbPath, ['index', 'rebuild']),
        /^⚠ Index rebuilt with \d+ warning\(s\)$/m
      );
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index rebuild --content-only',
    () => {
      const repo = newRepo();
      commitA(repo);
      commitB(repo);
      const dbPath = newDbPath();
      failSecondDependencyInsert(dbPath);

      expectWarnedRun(
        runLux(repo, dbPath, ['index', 'rebuild', '--content-only']),
        /^⚠ Index rebuilt with \d+ warning\(s\)$/m
      );
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index sync escalating to a full rebuild',
    () => {
      const repo = newRepo();
      commitA(repo);
      const dbPath = newDbPath();
      const rebuildA = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
      expect(rebuildA.status, rebuildA.stderr).toBe(0);
      failSecondDependencyInsert(dbPath);
      commitB(repo);

      expectWarnedRun(
        runLux(repo, dbPath, ['index', 'sync']),
        /^⚠ Sync escalated to full overlay rebuild with \d+ warning\(s\) \(/m
      );
    },
    CLI_TIMEOUT_MS
  );

  it(
    'index sync --force',
    () => {
      const repo = newRepo();
      commitA(repo);
      const dbPath = newDbPath();
      const rebuildA = runLux(repo, dbPath, ['index', 'rebuild', '--quiet']);
      expect(rebuildA.status, rebuildA.stderr).toBe(0);
      failSecondDependencyInsert(dbPath);
      commitB(repo);

      expectWarnedRun(
        runLux(repo, dbPath, ['index', 'sync', '--force']),
        /^⚠ Full rebuild complete with \d+ warning\(s\) \(/m
      );
    },
    CLI_TIMEOUT_MS
  );

  it(
    'an incremental index sync carrying the warning',
    () => {
      const { repo, dbPath } = degradedAtA();
      writeFileSync(join(repo, 'notes.md'), '# notes\n');
      commitAll(repo, 'docs only');

      const r = runLux(repo, dbPath, ['index', 'sync']);
      expect(r.stdout).toContain('Sync path: incremental content sync');
      expectWarnedRun(r, /^⚠ Synced with \d+ warning\(s\): \+1 indexed/m, true);
    },
    CLI_TIMEOUT_MS
  );

  it(
    'an incremental index sync --quiet carrying the warning',
    () => {
      const { repo, dbPath } = degradedAtA();
      writeFileSync(join(repo, 'notes.md'), '# notes\n');
      commitAll(repo, 'docs only');

      expectWarnedRun(
        runLux(repo, dbPath, ['index', 'sync', '--quiet']),
        /^⚠ Synced with \d+ warning\(s\): \+1 indexed/m,
        true
      );
    },
    CLI_TIMEOUT_MS
  );
});
