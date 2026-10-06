import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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

function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

describe('index status trust diagnostics', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-index-status-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-cli-index-status-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');

    git(repoDir, 'git init');
    git(repoDir, 'git config user.email "test@test.com"');
    git(repoDir, 'git config user.name "Test"');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m "init"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('refuses an absent index without creating it', () => {
    const result = runCli(repoDir, dbPath, ['index', 'status']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`No Lux index exists at ${dbPath}`);
    expect(result.stderr).toContain('Run `lux index rebuild` explicitly.');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('emits an absent-index refusal and read telemetry as JSON without creating the index', () => {
    const result = runCli(repoDir, dbPath, ['index', 'status', '--json']);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      error: 'index-open-refused',
      refusal: 'index-absent',
      message: `No Lux index exists at ${dbPath}. Run \`lux index rebuild\` explicitly.`,
      telemetry: { recorded: false, reason: 'read-only-index' },
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('reports derived content-only trust after content-only rebuild', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['index', 'status']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mode: content-only');
    expect(result.stdout).toContain('Trust Level: content-only');
    expect(result.stdout).toContain('Trust source: derived');
    expect(result.stderr).toContain('Warning: No structural overlay nodes are present');
  });

  it('emits derived content-only trust in index status JSON', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['index', 'status', '--json']);
    const overlayStatus = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    expect(overlayStatus.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      stats: { knowledge_entries: number };
      overlay: { mode: string; trustLevel: string; trustSource: string; warnings: string[] };
      runtime: { corpusPath: string; corpusSource: string; dbPath: string; dbSource: string };
      telemetry: { recorded: boolean; reason: string };
    };
    const overlayStatusPayload = JSON.parse(overlayStatus.stdout) as {
      overlay: typeof payload.overlay;
      runtime: typeof payload.runtime;
    };

    expect(payload.stats.knowledge_entries).toBeGreaterThan(0);
    expect(payload.telemetry).toEqual({ recorded: false, reason: 'read-only-index' });
    expect(payload.runtime).toEqual({
      corpusPath: repoDir,
      corpusSource: 'explicit',
      dbPath,
      dbSource: 'explicit',
    });
    expect(overlayStatusPayload.runtime).toEqual(payload.runtime);
    expect(payload.overlay).toEqual(overlayStatusPayload.overlay);
    expect(payload.overlay.mode).toBe('content-only');
    expect(payload.overlay.trustLevel).toBe('content-only');
    expect(payload.overlay.trustSource).toBe('derived');
    expect(
      payload.overlay.warnings.some((warning) =>
        warning.includes('No structural overlay nodes are present')
      )
    ).toBe(true);
  });
});
