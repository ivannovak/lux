// End to end: an index left by an older Lux, with absolute paths in it, is rebuilt in full by the
// next `lux index sync` and comes out with corpus-relative paths only (issue #16).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { runLux, type CliRun } from '../../integration/__tests__/helpers/determinism.js';

let base: string;
let repo: string;
let db: string;
let home: string;
let rebuild: CliRun;
let pathsBefore: string[];
let read: CliRun;
let sync: CliRun;
let pathsAfterUpgrade: string[];
let incremental: CliRun;
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

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-abs-sync-'));
  repo = join(base, 'repo');
  home = join(base, 'home');
  db = join(repo, '.lux', 'lux.db');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(repo, 'lux.yaml'), 'lsp:\n  enabled: false\n');
  writeFileSync(join(repo, 'README.md'), '# Settlement\n');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nsettlement guide\n');
  writeFileSync(join(repo, '.gitignore'), '.lux/\n');
  env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo, env });

  rebuild = runLux(repo, db, home, ['index', 'rebuild', '--quiet']);
  pathsBefore = rebuild.status === 0 ? storedPaths() : [];

  // Turn it back into what schema 15 wrote: absolute paths, and no record of migration 16.
  const raw = new LuxSqlite(db);
  try {
    raw.run(`UPDATE knowledge_entries SET file_path = ? || '/' || file_path`, repo);
    raw.run('DELETE FROM schema_version WHERE version > 15');
  } finally {
    raw.close();
  }

  read = runLux(repo, db, home, ['search', 'settlement', '--json']);
  sync = runLux(repo, db, home, ['index', 'sync']);
  pathsAfterUpgrade = sync.status === 0 ? storedPaths() : [];

  // Then an ordinary incremental sync: one file modified, one deleted, one added.
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n\nsettlement guide, revised\n');
  rmSync(join(repo, 'README.md'));
  writeFileSync(join(repo, 'docs', 'new.md'), '# New\n\nsettlement addendum\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: repo, env });
  incremental = runLux(repo, db, home, ['index', 'sync']);
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('an old index with absolute paths, met by this Lux', () => {
  it('the fixture index was built, with relative paths', () => {
    expect(rebuild.status, rebuild.stderr).toBe(0);
    expect(pathsBefore).toEqual(expect.arrayContaining(['README.md', 'docs/guide.md']));
  });

  it('a read refuses it instead of printing its absolute paths', () => {
    expect(read.status).not.toBe(0);
    const report = JSON.parse(read.stdout) as { refusal?: string; results?: unknown };
    expect(report.refusal).toBe('schema-too-old');
    expect(report.results).toBeUndefined();
  });

  it('sync says the index was cleared, and rebuilds in full', () => {
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stderr).toContain('Note: this index stored absolute file paths');
    expect(sync.stdout).toContain('No previous index commit found, running full rebuild');
  });

  it('afterwards every stored path is corpus-relative, and none was lost', () => {
    expect(pathsAfterUpgrade.filter((path) => isAbsolute(path))).toEqual([]);
    expect(pathsAfterUpgrade).toEqual(pathsBefore);
  });
});

describe('an incremental sync', () => {
  it('takes the incremental path', () => {
    expect(incremental.status, incremental.stderr).toBe(0);
    expect(incremental.stdout).toContain('incremental content sync');
  });

  it('removes a deleted file, replaces a modified one rather than adding a second row, and adds a new one', () => {
    const after = storedPaths();
    expect(after.filter((path) => isAbsolute(path))).toEqual([]);
    expect(after).not.toContain('README.md');
    expect(after.filter((path) => path === 'docs/guide.md')).toHaveLength(1);
    expect(after).toContain('docs/new.md');
    expect(after).toEqual(
      [...pathsAfterUpgrade.filter((path) => path !== 'README.md'), 'docs/new.md'].sort()
    );
  });

  it('search then finds the revised content under the relative path', () => {
    const found = runLux(repo, db, home, ['search', 'revised', '--json']);
    const report = JSON.parse(found.stdout) as { results: Array<{ filePath: string }> };
    expect(report.results.map((r) => r.filePath)).toEqual(['docs/guide.md']);
  });
});
