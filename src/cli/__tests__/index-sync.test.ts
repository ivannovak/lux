import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { loadOverlayTrustState } from '../../scanner/overlay-trust-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');
// A stub language server, so the enricher comes up whatever is installed on the machine.
const STUB_LSP_SERVER = join(__dirname, 'fixtures', 'stub-lsp-server.mjs');

interface OverlayTrustPayload {
  mode: string;
  trustLevel?: string;
  trustSource: string;
  sourceAction: string;
  warnings: string[];
  symbolNodeCount?: number;
  enrichmentStatus?: string;
}

interface OverlayStatusPayload {
  overlay: OverlayTrustPayload;
  runtime: { corpusPath: string; corpusSource: string; dbPath: string; dbSource: string };
}

function git(repoPath: string, command: string): string {
  return execSync(command, {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function commitAll(repoPath: string, message: string): string {
  git(repoPath, 'git add -A');
  git(repoPath, `git commit -m ${JSON.stringify(message)}`);
  return git(repoPath, 'git rev-parse HEAD');
}

function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    }
  );
}

function enableTypeScriptLsp(repoPath: string) {
  writeFileSync(
    join(repoPath, 'lux.yaml'),
    [
      'lsp:',
      '  enabled: true',
      '  enrichers:',
      '    - language_id: typescript',
      '      enabled: true',
      `      server_command: ${JSON.stringify(process.execPath)}`,
      '      server_args:',
      `        - ${JSON.stringify(STUB_LSP_SERVER)}`,
      'deps:',
      '  enabled: false',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        name: 'index-sync-e2e-fixture',
        private: true,
        type: 'module',
        version: '1.0.0',
      },
      null,
      2
    ) + '\n'
  );
  writeFileSync(
    join(repoPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2
    ) + '\n'
  );
}

describe('index sync CLI', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-sync-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-cli-sync-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });

    writeFileSync(
      join(repoDir, 'lux.yaml'),
      ['lsp:', '  enabled: false', '  enrichers: []', 'deps:', '  enabled: false', ''].join('\n')
    );
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const value = 1;\n');

    git(repoDir, 'git init');
    git(repoDir, 'git config user.email "test@test.com"');
    git(repoDir, 'git config user.name "Test"');
    commitAll(repoDir, 'init');

    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--quiet']);
    expect(rebuild.status).toBe(0);
    // --quiet still reports the rebuild's warnings; this LSP-less fixture produces only this one.
    expect(rebuild.stderr.match(/^Warning: .*$/gm)).toEqual([
      expect.stringContaining('Warning: No symbol nodes were materialized'),
    ]);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('uses incremental sync for non-structural changes and records sync trust source', () => {
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n\nupdated\n');
    const headCommit = commitAll(repoDir, 'docs update');

    const result = runCli(repoDir, dbPath, ['index', 'sync']);
    const status = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);
    const check = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Sync path: incremental content sync (no structural source changes detected).'
    );
    expect(result.stdout).toContain(
      'Overlay trust after sync: stale-overlay (persisted mode: degraded-overlay,'
    );
    expect(result.stderr).toContain('Warning:');
    // The sync carries the fixture's LSP warning, so it closes on ⚠, not ✓.
    expect(result.stdout).toMatch(/^⚠ Synced with \d+ warning\(s\): /m);
    expect(result.stdout).not.toContain('✓ Synced:');

    const db = new LuxDatabase(dbPath);
    const trustState = loadOverlayTrustState(db);
    const entry = db.getKnowledgeEntryByPath('docs/guide.md');
    db.close();

    expect(trustState).not.toBeNull();
    expect(trustState?.sourceAction).toBe('index-sync');
    expect(trustState?.lastIndexedCommit).toBe(headCommit);
    expect(
      trustState?.warnings.some((warning) =>
        warning.includes('synced without rebuilding the structural overlay')
      )
    ).toBe(false);
    expect(entry?.content).toContain('updated');

    expect(status.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(status.stdout) as OverlayStatusPayload;
    expect(payload.runtime).toEqual({
      corpusPath: repoDir,
      corpusSource: 'explicit',
      dbPath,
      dbSource: 'explicit',
    });
    expect(payload.overlay.mode).toBe('degraded-overlay');
    expect(payload.overlay.trustLevel).toBe('stale-overlay');
    expect(payload.overlay.trustSource).toBe('persisted');
    expect(payload.overlay.sourceAction).toBe('index-sync');

    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      'Error: Overlay trust level is stale-overlay (persisted mode: degraded-overlay), not overlay-complete.'
    );
  });

  it('escalates to overlay rebuild for structural source changes', () => {
    enableTypeScriptLsp(repoDir);
    writeFileSync(
      join(repoDir, 'src', 'app.ts'),
      'export const value = 2;\n' +
        'export function double(x: number) {\n' +
        '  return x * 2;\n' +
        '}\n' +
        'export class Greeter {\n' +
        '  greet(name: string) {\n' +
        '    return `hello ${name}`;\n' +
        '  }\n' +
        '}\n'
    );
    const headCommit = commitAll(repoDir, 'source update');

    const result = runCli(repoDir, dbPath, ['index', 'sync']);
    const status = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);
    const check = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(result.status).toBe(0);
    // Phase 3b: enableTypeScriptLsp rewrote lux.yaml after the fingerprint was baselined at
    // rebuild, so the structural sync escalates to a full rebuild via the config-fingerprint
    // mismatch (Decision 7) rather than the pre-3b unconditional escalation.
    expect(result.stdout).toContain('Sync path: full rebuild (config-changed).');
    expect(result.stdout).toContain('Trust Level: overlay-complete');
    expect(result.stdout).toContain('✓ Sync escalated to full overlay rebuild');
    expect(result.stdout).not.toMatch(/[✓⚠] Synced/);

    const db = new LuxDatabase(dbPath);
    const trustState = loadOverlayTrustState(db);
    const recentEvents = db.getRecentEvents(5);
    db.close();

    expect(trustState).not.toBeNull();
    expect(trustState?.sourceAction).toBe('index-rebuild');
    expect(trustState?.lastIndexedCommit).toBe(headCommit);
    expect(
      trustState?.warnings.some((warning) =>
        warning.includes('synced without rebuilding the structural overlay')
      )
    ).toBe(false);
    expect(
      recentEvents.some((event) => event.summary?.includes('Sync escalated to overlay rebuild:'))
    ).toBe(true);

    expect(status.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(status.stdout) as OverlayStatusPayload;
    expect(payload.runtime).toEqual({
      corpusPath: repoDir,
      corpusSource: 'explicit',
      dbPath,
      dbSource: 'explicit',
    });
    expect(payload.overlay.mode).toBe('overlay-complete');
    expect(payload.overlay.trustLevel).toBe('overlay-complete');
    expect(payload.overlay.trustSource).toBe('persisted');
    expect(payload.overlay.sourceAction).toBe('index-rebuild');
    expect(payload.overlay.symbolNodeCount).toBeGreaterThan(0);
    expect(payload.overlay.enrichmentStatus).toBe('active');
    expect(payload.overlay.warnings).toEqual([]);

    expect(check.status).toBe(0);
    expect(check.stdout).toContain('Overlay check passed:');
  });
});
