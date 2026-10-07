// The case-only rename of issue #46, simulated so it runs on any filesystem. Git tracks
// `Dir/File.php`; the filesystem walk is mocked to report the directory as `dir/`, which is what a
// case-insensitive checkout returns after the rename lands from elsewhere. The index must hold the
// paths `git ls-files` prints, whatever the walk says.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const walk = vi.hoisted(() => ({ lowercaseDir: false }));

vi.mock('glob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('glob')>();
  const lower = (paths: string[]): string[] =>
    walk.lowercaseDir ? paths.map((path) => path.replace(/^Dir\//u, 'dir/')) : paths;
  return {
    ...actual,
    glob: async (...args: Parameters<typeof actual.glob>) =>
      lower((await actual.glob(...args)) as string[]),
    globSync: (...args: Parameters<typeof actual.globSync>) =>
      lower(actual.globSync(...args) as string[]),
  };
});

const { GeneralScanner } = await import('../general.js');
const { toStoredPath } = await import('../../db/stored-path.js');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lux-case-walk-'));
  mkdirSync(join(repo, 'Dir'));
  writeFileSync(join(repo, 'composer.json'), '{}\n');
  writeFileSync(join(repo, 'Dir', 'File.php'), '<?php\nclass File {}\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
  execFileSync('git', ['add', '-A'], { cwd: repo, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo, env: gitEnv });
  walk.lowercaseDir = true;
});

afterAll(() => {
  walk.lowercaseDir = false;
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('a directory whose case on disk differs from git', () => {
  it('the mocked walk does report the disk case', async () => {
    const { glob } = await import('glob');
    expect(await glob('**/*.php', { cwd: repo })).toEqual(['dir/File.php']);
  });

  it('indexes exactly the paths git ls-files prints', async () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf-8' })
      .trim()
      .split('\n')
      .sort();
    expect(tracked).toEqual(['Dir/File.php', 'composer.json']);
    const scan = await new GeneralScanner(repo).scan();
    const paths = scan.knowledge.map((entry) => toStoredPath(repo, entry.filePath)).sort();
    expect(paths).toEqual(tracked);
  });
});
