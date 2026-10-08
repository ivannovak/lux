// Shared by run-output-rules.test.ts and run-output-carried.test.ts: what a rebuild or sync prints
// (issue #6), driven through the real CLI.

import { expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { built, builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..', '..', '..');
export const CLI_ENTRY = builtCli();
export const FAULTS = built(join(__dirname, 'fixtures', 'faults', 'inject.ts'));

// spawnSync blocks the event loop, so the per-call timeout is the hang guard and the test timeout
// (vitest.config.ts) only bounds total duration.
export const CALL_TIMEOUT_MS = 45000;

export const LSP_LESS = 'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n';
export const TS_LSP = [
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
export const MISSING_TS_SERVER = [
  'lsp:',
  '  enabled: true',
  '  enrichers:',
  '    - language_id: typescript',
  '      enabled: true',
  '      server_command: lux-test-no-such-language-server',
  '',
].join('\n');
export const ROUTES_A =
  "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/a', fn () => 'a');\n";
export const ROUTES_B = ROUTES_A + "Route::get('/b', fn () => 'b');\n";
export const ROUTES_C = ROUTES_B + "Route::get('/c', fn () => 'c');\n";
export const BAD_FRONTMATTER = '---\ntitle: [unclosed\n---\nbody text that must stay indexed\n';

const roots: string[] = [];

/** Remove what this file's tests made (call from afterEach). */
export function removeTempDirs(): void {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export function git(repo: string, cmd: string): void {
  execSync(cmd, { cwd: repo, stdio: 'pipe' });
}

export function repoWith(files: Record<string, string>): string {
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

export function commitFile(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
  git(repo, 'git add -A');
  git(repo, 'git commit -q -m change');
}

export function dbPathIn(): string {
  return join(tempDir('lux-output-db-'), 'lux.db');
}

export function runLux(
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

export function linesMatching(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

/** The run exited 0 and printed nothing on either stream. */
export function expectSilent(r: ReturnType<typeof runLux>): void {
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
}
