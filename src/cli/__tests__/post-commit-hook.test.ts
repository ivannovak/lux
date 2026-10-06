// The post-commit hook relays a sync's warnings instead of reporting a clean sync (issue #6).
//
// The hook runs `lux index sync --quiet` with its output captured, so on exit 0 it must look at that
// output: a sync that reported warnings is relayed with its ⚠ line, never as `✓ Lux index synced`.
// Stubbed CLIs pin the relay logic exactly; one case drives the real CLI end to end.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const HOOK = join(PROJECT_ROOT, 'bin', 'post-commit-hook.sh');
const CLI_ENTRY = builtCli();
const STUB_CLI = join(__dirname, 'fixtures', 'hook-cli', 'stub-lux.sh');
const SOURCE_CLI = join(__dirname, 'fixtures', 'hook-cli', 'lux-from-source.sh');

// spawnSync blocks the event loop, so the per-call timeout is the hang guard; the per-case timeout
// only bounds total duration. The real-CLI case makes two CLI runs of 2-8 s each.
const CALL_TIMEOUT_MS = 30000;
const CASE_TIMEOUT_MS = 60000;

const roots: string[] = [];

function git(repo: string, cmd: string): void {
  execSync(cmd, { cwd: repo, stdio: 'pipe' });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A repo whose last commit changed one indexable file, as the hook sees it after a commit. */
function committedRepo(luxYaml: string): string {
  const repo = tempDir('lux-hook-repo-');
  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name x');
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'lux.yaml'), luxYaml);
  writeFileSync(join(repo, 'notes.md'), '# notes\n');
  git(repo, 'git add -A');
  git(repo, 'git commit -q -m base');
  return repo;
}

/**
 * Environment for the checked-in stub `lux`, whose `index sync` prints the given output; every call
 * the hook makes to it is logged to `argsLog`.
 */
function stubOutput(
  syncStdout: string,
  syncStderr: string
): { env: Record<string, string>; argsLog: string } {
  const dir = tempDir('lux-hook-stub-');
  writeFileSync(join(dir, 'stdout.txt'), syncStdout);
  writeFileSync(join(dir, 'stderr.txt'), syncStderr);
  const argsLog = join(dir, 'args.log');
  return {
    env: {
      STUB_SYNC_STDOUT: join(dir, 'stdout.txt'),
      STUB_SYNC_STDERR: join(dir, 'stderr.txt'),
      STUB_ARGS_LOG: argsLog,
    },
    argsLog,
  };
}

/** The `--reason` the hook recorded for its usage event. */
function hookEventReason(argsLog: string): string | undefined {
  const call = readFileSync(argsLog, 'utf-8')
    .split('\n')
    .find((line) => line.includes('usage hook-event'));
  return call?.match(/--reason (\S+)/)?.[1];
}

function runHook(repo: string, luxCli: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [HOOK], {
    cwd: repo,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
      LUX_CLI: luxCli,
      LUX_TEST_NODE: process.execPath,
      LUX_TEST_CLI_ENTRY: CLI_ENTRY,
      LUX_SKIP_SYNC: '',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    timeout: CALL_TIMEOUT_MS,
  });
  if (r.error) throw new Error(`post-commit hook did not finish: ${r.error.message}`);
  return r;
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('post-commit hook — sync outcome reporting', () => {
  it(
    'reports a clean sync as synced',
    () => {
      const repo = committedRepo('lsp:\n  enabled: false\n');

      const stub = stubOutput('', '');

      const r = runHook(repo, STUB_CLI, stub.env);

      expect(r.status).toBe(0);
      expect(r.stderr).toContain('✓ Lux index synced (1 file(s) updated)');
      expect(r.stderr).not.toContain('⚠');
      expect(hookEventReason(stub.argsLog)).toBe('sync_success');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'relays the warnings and the ⚠ line of a sync that reported warnings',
    () => {
      const repo = committedRepo('lsp:\n  enabled: false\n');
      const stub = stubOutput(
        '⚠ Synced with 2 warning(s): +1 indexed, -0 deleted (commit abc12345)\n',
        'Warning: first problem\nWarning: second problem\n'
      );

      const r = runHook(repo, STUB_CLI, stub.env);

      expect(r.status).toBe(0);
      expect(r.stderr).toContain('Warning: first problem');
      expect(r.stderr).toContain('Warning: second problem');
      expect(r.stderr).toContain('⚠ Synced with 2 warning(s): +1 indexed');
      expect(r.stderr).toContain('⚠ Lux index synced with 2 warning(s) (1 file(s) updated)');
      expect(r.stderr).not.toContain('✓');
      expect(hookEventReason(stub.argsLog)).toBe('sync_warnings');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'relays a real sync warning end to end',
    () => {
      const repo = committedRepo(
        'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n'
      );
      const dbPath = join(repo, '.lux', 'lux.db');
      const rebuild = spawnSync(
        process.execPath,
        [CLI_ENTRY, '--db', dbPath, '--corpus', repo, 'index', 'rebuild', '--quiet'],
        { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: CALL_TIMEOUT_MS }
      );
      expect(rebuild.status, rebuild.stderr).toBe(0);

      writeFileSync(join(repo, 'notes.md'), '# notes\n\nmore\n');
      git(repo, 'git commit -q -am docs');

      const r = runHook(repo, SOURCE_CLI);

      // This LSP-less fixture always carries the no-symbols overlay warning.
      expect(r.status).toBe(0);
      // Raised by the rebuild before the commit, so the sync relays it as carried.
      expect(r.stderr).toContain(
        'Warning: carried from an earlier run: No symbol nodes were materialized'
      );
      expect(r.stderr).toMatch(/^⚠ Synced with \d+ warning\(s\): /m);
      expect(r.stderr).toMatch(
        /^⚠ Lux index synced with \d+ warning\(s\) \(1 file\(s\) updated\)$/m
      );
      expect(r.stderr).not.toContain('✓');
    },
    CASE_TIMEOUT_MS
  );
});
