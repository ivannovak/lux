import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function git(repoPath: string, command: string): string {
  return execSync(command, {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function runCli(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

describe('hooks command runtime path resolution', () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-hooks-repo-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'lux-hooks-outside-'));

    mkdirSync(join(repoDir, '.lux'), { recursive: true });
    git(repoDir, 'git init');
    git(repoDir, 'git config user.email "test@test.com"');
    git(repoDir, 'git config user.name "Test"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('uses cwd as corpus root when no --corpus is provided', () => {
    const result = runCli(repoDir, ['hooks', 'install']);
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Post-commit hook installed successfully');
    expect(result.stdout).toContain('The index will now sync automatically after each commit.');
    expect(readFileSync(hookPath, 'utf-8')).toContain('Lux - Git post-commit hook');
  });

  it('uses LUX_CORPUS_PATH when invoked outside the repo', () => {
    const result = runCli(outsideDir, ['hooks', 'install'], { LUX_CORPUS_PATH: repoDir });
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Post-commit hook installed successfully');
    expect(readFileSync(hookPath, 'utf-8')).toContain('Lux - Git post-commit hook');
  });

  it('hints when corpus path contains a nested repo like vcs', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'lux-hooks-parent-'));
    const nestedRepoDir = join(parentDir, 'vcs');

    try {
      mkdirSync(join(nestedRepoDir, '.lux'), { recursive: true });
      git(nestedRepoDir, 'git init');
      git(nestedRepoDir, 'git config user.email "test@test.com"');
      git(nestedRepoDir, 'git config user.name "Test"');

      const result = runCli(outsideDir, ['hooks', 'install', '--corpus', parentDir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Not a git repository: ${parentDir}`);
      expect(result.stderr).toContain(`Hint: found a nested git repository at ${nestedRepoDir}`);
      expect(result.stderr).toContain('Try rerunning with --corpus pointed at that repo root.');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('hints on uninstall when corpus path contains a nested repo like vcs', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'lux-hooks-parent-'));
    const nestedRepoDir = join(parentDir, 'vcs');

    try {
      mkdirSync(join(nestedRepoDir, '.lux'), { recursive: true });
      git(nestedRepoDir, 'git init');
      git(nestedRepoDir, 'git config user.email "test@test.com"');
      git(nestedRepoDir, 'git config user.name "Test"');

      const result = runCli(outsideDir, ['hooks', 'uninstall', '--corpus', parentDir]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Not a git repository: ${parentDir}`);
      expect(result.stderr).toContain(`Hint: found a nested git repository at ${nestedRepoDir}`);
      expect(result.stderr).toContain('Try rerunning with --corpus pointed at that repo root.');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('still prefers explicit --corpus over env and cwd', () => {
    const otherRepoDir = mkdtempSync(join(tmpdir(), 'lux-hooks-other-repo-'));

    try {
      mkdirSync(join(otherRepoDir, '.lux'), { recursive: true });
      git(otherRepoDir, 'git init');
      git(otherRepoDir, 'git config user.email "test@test.com"');
      git(otherRepoDir, 'git config user.name "Test"');

      const result = runCli(outsideDir, ['hooks', 'install', '--corpus', otherRepoDir], {
        LUX_CORPUS_PATH: repoDir,
      });
      const hookPath = join(otherRepoDir, '.git', 'hooks', 'post-commit');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Path: ${hookPath}`);
      expect(readFileSync(hookPath, 'utf-8')).toContain('Lux - Git post-commit hook');
      expect(join(repoDir, '.git', 'hooks', 'post-commit')).not.toBe(hookPath);
    } finally {
      rmSync(otherRepoDir, { recursive: true, force: true });
    }
  });

  it('hook script watches generic indexable docs, not only knowledge paths', () => {
    const result = runCli(repoDir, ['hooks', 'install']);
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');

    expect(result.status).toBe(0);

    const hook = readFileSync(hookPath, 'utf-8');
    expect(hook).toContain('Automatically syncs index after corpus commits');
    expect(hook).toContain('LUX_SKIP_SYNC');
    expect(hook).toContain('LUX_SKIP_REBUILD');
    expect(hook).toContain('indexable content changes detected');
    expect(hook).toContain('\\.(md|mdx|txt|rst|php|ts|tsx|js|jsx|py|go|rs|java)$');
    expect(hook).toContain('git rev-parse --show-toplevel');
    expect(hook).toContain('--corpus "$repo_root" index sync --quiet');
    expect(hook).toContain('usage hook-event');
    expect(hook).toContain('--outcome "$outcome"');
    expect(hook).toContain('emit_hook_event "success" "sync_success"');
    expect(hook).toContain("Run 'lux index sync' manually to catch the index up.");
  });

  it('updates an existing stale Lux hook in place', () => {
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');
    writeFileSync(
      hookPath,
      '#!/usr/bin/env bash\n# Lux - Git post-commit hook - old hook\necho stale\n',
      'utf-8'
    );

    const result = runCli(repoDir, ['hooks', 'install']);
    const hook = readFileSync(hookPath, 'utf-8');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Lux post-commit hook updated');
    expect(hook).toContain('Automatically syncs index after corpus commits');
    expect(hook).toContain('--corpus "$repo_root" index sync --quiet');
    expect(hook).toContain('usage hook-event');
    expect(hook).not.toContain('echo stale');
  });

  it('keeps an up-to-date Lux hook unchanged', () => {
    const first = runCli(repoDir, ['hooks', 'install']);
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');
    const before = readFileSync(hookPath, 'utf-8');

    const second = runCli(repoDir, ['hooks', 'install']);
    const after = readFileSync(hookPath, 'utf-8');

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Lux post-commit hook already installed');
    expect(after).toBe(before);
  });
});
