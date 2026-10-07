// The scanner's file universe is git's (issue #46): a full scan indexes tracked files only, takes
// their paths from `git ls-files`, never reads an ignored file, and skips a credential file on the
// built-in deny list even when it is tracked. A directory that is not a git repository keeps the
// filesystem walk, with the deny list still applied.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeneralScanner } from '../general.js';
import { isDeniedPath, resolveDenyPatterns } from '../file-universe.js';
import { toStoredPath } from '../../db/stored-path.js';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' });
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

async function indexedPaths(root: string) {
  const scan = await new GeneralScanner(root).scan();
  return {
    scan,
    paths: scan.knowledge.map((entry) => toStoredPath(root, entry.filePath)).sort(),
  };
}

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-git-universe-'));
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('a git repository', () => {
  let repo: string;

  beforeAll(() => {
    repo = join(base, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    write(repo, '.gitignore', 'auth.json\nignored-dir/\n');
    write(repo, 'package.json', '{"name":"fixture"}\n');
    write(repo, 'README.md', '# Fixture\n');
    write(repo, 'src/tracked.ts', 'export const tracked = 1;\n');
    // A tracked credential file: committed despite the ignore rule, so only the deny list stops it.
    write(repo, 'config/auth.json', '{"token":"tracked-credential"}\n');
    git(repo, ['add', '.gitignore', 'package.json', 'README.md', 'src/tracked.ts']);
    git(repo, ['add', '-f', 'config/auth.json']);
    git(repo, ['commit', '-q', '-m', 'fixture']);
    // On disk only: untracked, ignored, and inside an ignored directory.
    write(repo, 'untracked.md', '# Untracked\n');
    write(repo, 'src/untracked.ts', 'export const untracked = 1;\n');
    write(repo, 'auth.json', '{"token":"ignored-credential"}\n');
    write(repo, 'ignored-dir/notes.md', '# Ignored notes\n');
    write(repo, 'ignored-dir/code.ts', 'export const ignored = 1;\n');
  });

  it('indexes the tracked files and nothing else', async () => {
    const { paths } = await indexedPaths(repo);
    expect(paths).toEqual(['README.md', 'package.json', 'src/tracked.ts']);
  });

  it('names the tracked credential file it skipped, and nothing it was never going to read', async () => {
    const { scan } = await indexedPaths(repo);
    expect(scan.denied).toEqual(['config/auth.json']);
    // A deny-list skip is a policy outcome, not a problem the scan absorbed: no trust warning.
    expect(scan.warnings ?? []).toEqual([]);
  });

  it('keeps a tracked file that was deleted from disk out of the index', async () => {
    const clone = join(base, 'deleted');
    git(base, ['clone', '-q', repo, clone]);
    rmSync(join(clone, 'src', 'tracked.ts'));
    const { paths } = await indexedPaths(clone);
    expect(paths).toEqual(['README.md', 'package.json']);
  });
});

describe('a directory that is not a git repository', () => {
  it('walks the filesystem, still applying the deny list', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    write(plain, 'package.json', '{"name":"plain"}\n');
    write(plain, 'notes.md', '# Notes\n');
    write(plain, 'src/a.ts', 'export const a = 1;\n');
    write(plain, 'auth.json', '{"token":"plain-credential"}\n');
    const { scan, paths } = await indexedPaths(plain);
    expect(paths).toEqual(['notes.md', 'package.json', 'src/a.ts']);
    expect(scan.denied).toEqual(['auth.json']);
  });

  it('walks the filesystem when the directory is ignored by an enclosing repository', async () => {
    const outer = join(base, 'outer');
    mkdirSync(outer);
    git(outer, ['init', '-q', '-b', 'main']);
    write(outer, '.gitignore', 'inner/\n');
    write(outer, 'inner/package.json', '{"name":"inner"}\n');
    write(outer, 'inner/src/b.ts', 'export const b = 1;\n');
    const { paths } = await indexedPaths(join(outer, 'inner'));
    expect(paths).toEqual(['package.json', 'src/b.ts']);
  });
});

describe('a directory renamed only in case', () => {
  // On a case-insensitive filesystem (macOS, Windows) a checkout keeps the old directory case on
  // disk after a case-only rename lands from elsewhere: git tracks `Dir/File.php`, the disk says
  // `dir/`. src/scanner/__tests__/git-file-universe-case.test.ts simulates the same on a
  // case-sensitive filesystem by mocking the walk.
  const probe = mkdtempSync(join(tmpdir(), 'lux-case-probe-'));
  writeFileSync(join(probe, 'a'), '');
  const caseInsensitive = existsSync(join(probe, 'A'));
  rmSync(probe, { recursive: true, force: true });

  it.skipIf(!caseInsensitive)('indexes the paths git tracks, in git’s case', async () => {
    const repo = join(base, 'case');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    write(repo, 'composer.json', '{}\n');
    write(repo, 'Dir/File.php', '<?php\nclass File {}\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'fixture']);
    renameSync(join(repo, 'Dir'), join(repo, 'tmp-case'));
    renameSync(join(repo, 'tmp-case'), join(repo, 'dir'));

    const tracked = git(repo, ['ls-files']).trim().split('\n').sort();
    expect(tracked).toEqual(['Dir/File.php', 'composer.json']);
    const { paths } = await indexedPaths(repo);
    expect(paths).toEqual(tracked);
  });
});

describe('the deny list', () => {
  const builtIn = resolveDenyPatterns();

  it.each([
    'auth.json',
    'config/auth.json',
    '.env',
    'app/.env',
    '.env.local',
    '.env.production',
    'certs/server.pem',
    'keys/private.key',
    'id_rsa',
    'home/.ssh/id_rsa.pub',
    'id_ed25519',
    '.npmrc',
    'packages/web/.npmrc',
    '.netrc',
  ])('denies %s', (path) => {
    expect(isDeniedPath(path, builtIn)).toBe(true);
  });

  it.each(['.env.example', 'app/.env.example', 'src/auth.ts', 'docs/env.md', 'keyboard.ts'])(
    'allows %s',
    (path) => {
      expect(isDeniedPath(path, builtIn)).toBe(false);
    }
  );

  it('is extended, never narrowed, by lux.yaml', () => {
    const patterns = resolveDenyPatterns({
      excludeGeneratedArtifacts: true,
      ignorePatterns: [],
      denyPatterns: ['**/secrets.yaml'],
    });
    expect(isDeniedPath('deploy/secrets.yaml', patterns)).toBe(true);
    expect(isDeniedPath('auth.json', patterns)).toBe(true);
  });
});
