// End to end (issue #46): `lux index rebuild` in a git repository indexes tracked files only, so
// `lux search` cannot reach an ignored credential file, an untracked file, an ignored directory or
// a tracked credential file on the deny list; the rebuild names what the deny list skipped, once.
// An index built by an older Lux that still holds such a file loses it on the next sync, which says
// so once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { runLux, type CliRun } from '../../integration/__tests__/helpers/determinism.js';

const TOKENS = {
  tracked: 'zebratrackedtoken',
  untracked: 'zebrauntrackedtoken',
  ignoredCredential: 'zebraignoredcredential',
  ignoredDir: 'zebraignoreddirtoken',
  deniedCredential: 'zebradeniedcredential',
  legacyCredential: 'zebralegacycredential',
};

const NOTICE = 'Note: this index may hold files that git ignores';
const DENY_WARNING = 'Warning: skipped 1 file(s) on the credential deny list';

let base: string;
let repo: string;
let db: string;
let home: string;
let rebuild: CliRun;
let env: typeof process.env;

function storedPaths(): string[] {
  const raw = new LuxSqlite(db, { readonly: true, fileMustExist: true });
  try {
    return (
      raw.all('SELECT file_path FROM knowledge_entries ORDER BY file_path') as Array<{
        file_path: string;
      }>
    ).map((row) => row.file_path);
  } finally {
    raw.close();
  }
}

function searchPaths(token: string): string[] {
  const run = runLux(repo, db, home, ['search', token, '--json']);
  expect(run.status, run.stderr).toBe(0);
  const report = JSON.parse(run.stdout) as { results: Array<{ filePath: string }> };
  return report.results.map((result) => result.filePath);
}

function write(relPath: string, content: string): void {
  const full = join(repo, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-git-universe-cli-'));
  repo = join(base, 'repo');
  home = join(base, 'home');
  db = join(repo, '.lux', 'lux.db');
  mkdirSync(repo);
  mkdirSync(home);
  env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  write('lux.yaml', 'lsp:\n  enabled: false\n');
  write('.gitignore', '.lux/\nauth.json\nignored-dir/\n');
  write('package.json', '{"name":"fixture"}\n');
  write('docs/tracked.md', `# Tracked\n\n${TOKENS.tracked}\n`);
  write('config/auth.json', `{"token":"${TOKENS.deniedCredential}"}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  execFileSync('git', ['add', 'lux.yaml', '.gitignore', 'package.json', 'docs/tracked.md'], {
    cwd: repo,
    env,
  });
  execFileSync('git', ['add', '-f', 'config/auth.json'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo, env });
  write('untracked.md', `# Untracked\n\n${TOKENS.untracked}\n`);
  write('auth.json', `{"token":"${TOKENS.ignoredCredential}"}\n`);
  write('ignored-dir/notes.md', `# Ignored\n\n${TOKENS.ignoredDir}\n`);
  write('ignored-dir/code.ts', `export const t = '${TOKENS.ignoredDir}';\n`);

  rebuild = runLux(repo, db, home, ['index', 'rebuild']);
}, 300_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('lux index rebuild in a git repository', () => {
  it('succeeds', () => {
    expect(rebuild.status, rebuild.stderr).toBe(0);
  });

  it('indexes the tracked files only', () => {
    expect(storedPaths()).toEqual(['docs/tracked.md', 'lux.yaml', 'package.json']);
  });

  it('search finds tracked content', () => {
    expect(searchPaths(TOKENS.tracked)).toEqual(['docs/tracked.md']);
  });

  it.each([
    ['an ignored credential file', TOKENS.ignoredCredential],
    ['an untracked file', TOKENS.untracked],
    ['an ignored directory', TOKENS.ignoredDir],
    ['a tracked credential file on the deny list', TOKENS.deniedCredential],
  ])('search cannot find %s', (_label, token) => {
    expect(searchPaths(token)).toEqual([]);
  });

  it('names the denied file in one warning, which is not one of the trust warnings', () => {
    const warnings = rebuild.stderr.split('\n').filter((line) => line.startsWith('Warning:'));
    const deny = warnings.filter((line) => line.includes('deny list'));
    expect(deny).toHaveLength(1);
    expect(deny[0]).toContain(DENY_WARNING);
    expect(deny[0]).toContain('config/auth.json');
    // The run's own count (which decides degraded-overlay) leaves the deny-list line out.
    const trust = warnings.filter((line) => !line.includes('deny list'));
    expect(rebuild.stdout).toContain(`Index rebuilt with ${trust.length} warning(s)`);
    expect(trust.join('\n')).not.toContain('auth.json');
  });
});

/** Turn the index back into what schema 16 could hold: an ignored credential file indexed. */
function plantLegacyCredential(): void {
  const raw = new LuxSqlite(db);
  try {
    raw.run(
      `INSERT INTO knowledge_entries (type, title, file_path, content) VALUES ('source-code', 'auth.json', 'auth.json', ?)`,
      `{"token":"${TOKENS.legacyCredential}"}`
    );
    raw.run('DELETE FROM schema_version WHERE version > 16');
  } finally {
    raw.close();
  }
}

describe('an index built before the git file universe', () => {
  let read: CliRun;
  let sync: CliRun;
  let secondSync: CliRun;
  let pathsAfterSync: string[];
  let searchAfterSync: string[];
  let migrate: CliRun;
  let afterMigrate: string[];

  beforeAll(() => {
    plantLegacyCredential();
    read = runLux(repo, db, home, ['search', TOKENS.legacyCredential, '--json']);
    sync = runLux(repo, db, home, ['index', 'sync']);
    secondSync = runLux(repo, db, home, ['index', 'sync']);
    pathsAfterSync = storedPaths();
    searchAfterSync = searchPaths(TOKENS.legacyCredential);
    // The same old index met by an explicit migration, with no rebuild after it.
    plantLegacyCredential();
    migrate = runLux(repo, db, home, ['migrate', 'up']);
    afterMigrate = migrate.status === 0 ? searchPaths(TOKENS.legacyCredential) : ['<not run>'];
  }, 300_000);

  it('a read refuses the old index rather than serve it', () => {
    expect(read.status).not.toBe(0);
    const report = JSON.parse(read.stdout) as { refusal?: string; results?: unknown };
    expect(report.refusal).toBe('schema-too-old');
    expect(report.results).toBeUndefined();
  });

  it('the next sync says once that the index was cleared, and rebuilds it in full', () => {
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stderr.split(NOTICE)).toHaveLength(2);
    expect(sync.stdout).toContain('No previous index commit found, running full rebuild');
    expect(secondSync.status, secondSync.stderr).toBe(0);
    expect(secondSync.stderr).not.toContain(NOTICE);
  });

  it('a migration alone removes the credential file, before any rebuild', () => {
    expect(migrate.status, migrate.stderr).toBe(0);
    expect(migrate.stderr.split(NOTICE)).toHaveLength(2);
    expect(afterMigrate).toEqual([]);
  });

  it('after the sync the credential file is gone from the index and from search', () => {
    expect(pathsAfterSync).toEqual(['docs/tracked.md', 'lux.yaml', 'package.json']);
    expect(searchAfterSync).toEqual([]);
  });
});
