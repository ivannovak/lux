import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

function git(repoPath: string, command: string): string {
  return execSync(command, {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

describe('index sync nested repo root hint', () => {
  let parentDir: string;
  let nestedRepoDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'lux-index-parent-'));
    nestedRepoDir = join(parentDir, 'vcs');

    mkdirSync(join(nestedRepoDir, '.lux'), { recursive: true });
    git(nestedRepoDir, 'git init');
    git(nestedRepoDir, 'git config user.email "test@test.com"');
    git(nestedRepoDir, 'git config user.name "Test"');
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('suggests the nested repo root when sync is run from a parent folder', () => {
    const result = runCli(PROJECT_ROOT, ['--corpus', parentDir, 'index', 'sync']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error: Content directory is not a git repository');
    expect(result.stderr).toContain(`Hint: found a nested git repository at ${nestedRepoDir}`);
    expect(result.stderr).toContain('Try rerunning with --corpus pointed at that repo root.');
  });
});
