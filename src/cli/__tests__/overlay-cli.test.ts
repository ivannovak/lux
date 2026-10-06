import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import {
  loadOverlayTrustState,
  inspectOverlayTrustState,
} from '../../scanner/overlay-trust-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

interface OverlayTrustPayload {
  mode: string;
  trustLevel?: string;
  trustSource: string;
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

function writeLaravelHttpFixture(repoDir: string) {
  mkdirSync(join(repoDir, 'routes'), { recursive: true });
  mkdirSync(join(repoDir, 'app', 'Http', 'Controllers'), { recursive: true });

  writeFileSync(
    join(repoDir, 'app', 'Http', 'Controllers', 'InvoiceController.php'),
    '<?php\n' +
      '\n' +
      'namespace App\\Http\\Controllers;\n' +
      '\n' +
      'class InvoiceController\n' +
      '{\n' +
      '    public function index(): array\n' +
      '    {\n' +
      "        return ['ok' => true];\n" +
      '    }\n' +
      '}\n'
  );

  writeFileSync(
    join(repoDir, 'routes', 'api.php'),
    '<?php\n' +
      '\n' +
      'use App\\Http\\Controllers\\InvoiceController;\n' +
      'use Illuminate\\Support\\Facades\\Route;\n' +
      '\n' +
      "Route::prefix('api')->group(function () {\n" +
      "    Route::get('/invoices', [InvoiceController::class, 'index'])->name('api.invoices.index');\n" +
      "    Route::get('/health', function () { return ['ok' => true]; })->name('api.health');\n" +
      '});\n'
  );
}

describe('overlay CLI trust surface', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-overlay-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-cli-overlay-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });

    writeFileSync(
      join(repoDir, 'lux.yaml'),
      [
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
      ].join('\n')
    );
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify(
        {
          name: 'overlay-e2e-fixture',
          private: true,
          type: 'module',
          version: '1.0.0',
        },
        null,
        2
      ) + '\n'
    );
    writeFileSync(
      join(repoDir, 'tsconfig.json'),
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
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(
      join(repoDir, 'src', 'app.ts'),
      'export const value = 1;\n' +
        'export function double(x: number) {\n' +
        '  return x * 2;\n' +
        '}\n' +
        'export class Greeter {\n' +
        '  greet(name: string) {\n' +
        '    return `hello ${name}`;\n' +
        '  }\n' +
        '}\n'
    );

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

  it('content-only rebuild stays unpersisted and derives content-only trust state', () => {
    const result = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mode: content-only');
    expect(result.stdout).toContain('Trust Level: content-only');
    expect(result.stdout).toContain('fallback path');

    const db = new LuxDatabase(dbPath);
    const persisted = loadOverlayTrustState(db);
    const inspection = inspectOverlayTrustState(db);
    const stats = db.getStats();
    db.close();

    expect(stats.knowledge_entries).toBeGreaterThan(0);
    expect(persisted).toBeNull();
    expect(inspection.source).toBe('derived');
    expect(inspection.state?.mode).toBe('content-only');
  });

  it('overlay status reports no-overlay diagnostics before any rebuild', () => {
    const db = new LuxDatabase(dbPath);
    db.close();

    const result = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(result.stdout) as OverlayStatusPayload;
    expect(payload.runtime).toEqual({
      corpusPath: repoDir,
      corpusSource: 'explicit',
      dbPath,
      dbSource: 'explicit',
    });
    expect(payload.overlay.mode).toBe('none');
    expect(payload.overlay.trustLevel).toBe('no-overlay');
    expect(payload.overlay.trustSource).toBe('none');
    expect(payload.overlay.warnings).toContain(
      'No overlay trust state recorded. Run "lux index rebuild" to build the canonical overlay path.'
    );
  });

  it('overlay status reports derived content-only state after content-only rebuild', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(result.stdout) as OverlayStatusPayload;
    expect(payload.runtime).toEqual({
      corpusPath: repoDir,
      corpusSource: 'explicit',
      dbPath,
      dbSource: 'explicit',
    });
    expect(payload.overlay.mode).toBe('content-only');
    expect(payload.overlay.trustLevel).toBe('content-only');
    expect(payload.overlay.trustSource).toBe('derived');
    expect(
      payload.overlay.warnings.some((warning) =>
        warning.includes('No structural overlay nodes are present')
      )
    ).toBe(true);
  });

  it('overlay check fails with no-overlay diagnostics before any rebuild', () => {
    const db = new LuxDatabase(dbPath);
    db.close();

    const result = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error: No structural overlay trust state found in database.');
    expect(result.stderr).toContain('Trust level: no-overlay');
  });

  it('overlay check fails against content-only state', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Error: Overlay trust level is content-only (persisted mode: content-only), not overlay-complete.'
    );
    expect(result.stderr).toContain(
      'Run "lux index rebuild" to restore the canonical overlay-complete state.'
    );
  });

  it('canonical rebuild reaches real overlay-complete state when symbols materialize', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--quiet']);
    expect(rebuild.status).toBe(0);
    // A clean --quiet run prints nothing at all.
    expect(rebuild.stdout).toBe('');
    expect(rebuild.stderr).toBe('');

    const db = new LuxDatabase(dbPath);
    const trustState = loadOverlayTrustState(db);
    const stats = db.getStats();
    const guide = db.getKnowledgeEntryByPath(join(repoDir, 'docs', 'guide.md'));
    const fileNodes = db.getStructuralNodesByType('file');
    const symbolNodes = db.getStructuralNodesByType('symbol');
    const surfaces = db.getCapabilitySurfaces();
    db.close();

    expect(trustState).not.toBeNull();
    expect(trustState?.mode).toBe('overlay-complete');
    expect(trustState?.symbolNodeCount).toBeGreaterThan(0);
    expect(trustState?.sourceAction).toBe('index-rebuild');
    expect(stats.knowledge_entries).toBeGreaterThan(0);
    expect(guide?.content).toContain('Guide');
    expect(fileNodes.length).toBeGreaterThan(0);
    expect(symbolNodes.length).toBeGreaterThan(0);
    expect(surfaces.length).toBe(0);

    const status = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);
    const check = runCli(repoDir, dbPath, ['overlay', 'check']);

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
    expect(payload.overlay.symbolNodeCount).toBeGreaterThan(0);
    expect(payload.overlay.enrichmentStatus).toBe('active');
    expect(payload.overlay.warnings).toEqual([]);

    expect(check.status).toBe(0);
    expect(check.stdout).toContain('Overlay check passed:');
  });

  it('canonical rebuild preserves detected Laravel HTTP surfaces and detector edges', () => {
    writeLaravelHttpFixture(repoDir);

    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild']);
    expect(rebuild.status).toBe(0);
    expect(rebuild.stdout).toContain('Detector "laravel-http-surfaces": 2 surface(s), 3 edge(s).');

    const db = new LuxDatabase(dbPath);
    const trustState = loadOverlayTrustState(db);
    const surfaces = db.getCapabilitySurfaces();
    const invoiceSurface = surfaces.find((surface) => surface.symbol_name === 'GET /api/invoices');
    const healthSurface = surfaces.find((surface) => surface.symbol_name === 'GET /api/health');
    const invoiceContext = invoiceSurface ? db.getSurfaceCenteredContext(invoiceSurface.id) : null;
    const healthContext = healthSurface ? db.getSurfaceCenteredContext(healthSurface.id) : null;
    db.close();

    expect(trustState).not.toBeNull();
    expect(trustState?.surfaceCount).toBeGreaterThanOrEqual(2);
    expect(trustState?.detectorEdgeCount).toBeGreaterThanOrEqual(3);
    expect(invoiceSurface).toBeDefined();
    expect(healthSurface).toBeDefined();

    const invoiceMeta = JSON.parse(invoiceSurface?.metadata ?? '{}') as Record<string, unknown>;
    const healthMeta = JSON.parse(healthSurface?.metadata ?? '{}') as Record<string, unknown>;

    expect(invoiceMeta.path).toBe('/api/invoices');
    expect(invoiceMeta.routeName).toBe('api.invoices.index');
    expect(invoiceMeta.explicitProvider).toBe('App\\Http\\Controllers\\InvoiceController');
    expect(invoiceMeta.controllerMethod).toBe('index');
    expect(invoiceMeta.providerKind).toBe('controller');
    expect(healthMeta.path).toBe('/api/health');
    expect(healthMeta.providerKind).toBe('closure');

    expect(invoiceContext).not.toBeNull();
    expect(healthContext).not.toBeNull();
    expect(invoiceContext?.edges.some(({ edge }) => edge.edge_type === 'declares_surface')).toBe(
      true
    );
    expect(invoiceContext?.edges.some(({ edge }) => edge.edge_type === 'handled_by')).toBe(true);
    expect(healthContext?.edges.some(({ edge }) => edge.edge_type === 'declares_surface')).toBe(
      true
    );
    expect(healthContext?.edges.some(({ edge }) => edge.edge_type === 'handled_by')).toBe(false);

    const handledByEdge = invoiceContext?.edges.find(({ edge }) => edge.edge_type === 'handled_by');
    const declaresSurfaceEdge = invoiceContext?.edges.find(
      ({ edge }) => edge.edge_type === 'declares_surface'
    );

    expect(handledByEdge?.edge.target_node_id).toBe(
      'symbol:php:App\\Http\\Controllers\\InvoiceController'
    );
    expect(handledByEdge?.evidence[0]?.note).toContain('InvoiceController::class');
    expect(declaresSurfaceEdge?.evidence[0]?.file_path).toBe('routes/api.php');
  });
});
