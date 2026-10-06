import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

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

function now(): number {
  return Math.floor(Date.now() / 1000);
}

describe('overlay boundaries CLI', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-overlay-boundaries-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-overlay-boundaries-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'src', 'Module', 'Checkout', 'Actions'), { recursive: true });
    mkdirSync(join(repoDir, 'src', 'Module', 'Billing', 'Services'), { recursive: true });
    mkdirSync(join(repoDir, 'src', 'Module', 'ListingImport', 'Services'), { recursive: true });
    mkdirSync(join(repoDir, 'src', 'Module', 'Listing', 'Controllers'), { recursive: true });
    mkdirSync(join(repoDir, 'routes'), { recursive: true });

    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'overlay-boundaries-test' })
    );
    writeFileSync(join(repoDir, 'routes', 'api.php'), '<?php\n');

    const db = new LuxDatabase(dbPath);
    persistRebuildTrustState(
      db,
      {
        mode: 'overlay-complete',
        repoPath: repoDir,
        configSource: 'lux.yaml',
        configLspEnabled: true,
        surfaceCount: 1,
        detectorEdgeCount: 2,
        propagatedEdgeCount: 1,
        fileNodeCount: 6,
        symbolNodeCount: 1,
        controllerBackedCount: 1,
        closureBackedCount: 0,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'active',
        propagationStatus: 'ran',
        warnings: [],
      },
      { sourceAction: 'index-rebuild' }
    );

    db.upsertStructuralNode({
      id: 'file:src/Module/Checkout/Actions/PlaceOrder.php',
      node_type: 'file',
      file_path: 'src/Module/Checkout/Actions/PlaceOrder.php',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: 'file:src/Module/Billing/Services/BillingService.php',
      node_type: 'file',
      file_path: 'src/Module/Billing/Services/BillingService.php',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: 'file:src/Module/ListingImport/Services/RunImport.php',
      node_type: 'file',
      file_path: 'src/Module/ListingImport/Services/RunImport.php',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: 'surface:http:GET:/listings',
      node_type: 'capability-surface',
      file_path: 'routes/api.php',
      symbol_name: 'GET /listings',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: 'symbol:php:App\\Module\\Listing\\Controllers\\ListingController',
      node_type: 'symbol',
      file_path: 'src/Module/Listing/Controllers/ListingController.php',
      symbol_name: 'ListingController',
      updated_at: now(),
    });

    db.upsertStructuralEdge({
      id: 'checkout->billing',
      source_node_id: 'file:src/Module/Checkout/Actions/PlaceOrder.php',
      target_node_id: 'file:src/Module/Billing/Services/BillingService.php',
      edge_type: 'resolves_service',
      confidence: 0.96,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'constructor-service-resolution',
      updated_at: now(),
    });
    db.upsertStructuralEdge({
      id: 'import->surface',
      source_node_id: 'file:src/Module/ListingImport/Services/RunImport.php',
      target_node_id: 'surface:http:GET:/listings',
      edge_type: 'calls_surface',
      confidence: 0.92,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'surface call',
      updated_at: now(),
    });
    db.upsertStructuralEdge({
      id: 'surface->listing',
      source_node_id: 'surface:http:GET:/listings',
      target_node_id: 'symbol:php:App\\Module\\Listing\\Controllers\\ListingController',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'surface handler',
      updated_at: now(),
    });
    db.insertModuleDependency({
      source_module: 'Checkout',
      target_module: 'Billing',
      reference_count: 3,
      sample_files: JSON.stringify(['src/Module/Checkout/Actions/PlaceOrder.php']),
    });
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('lists boundary exploration overview as JSON', () => {
    const result = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'explore', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      trustLevel: string;
      relationshipCount: number;
      regionCount: number;
      familyCount: number;
      availableRegions: string[];
      availableFamilies: string[];
    };

    expect(payload.trustLevel).toBe('overlay-complete');
    expect(payload.relationshipCount).toBeGreaterThanOrEqual(2);
    expect(payload.regionCount).toBeGreaterThanOrEqual(3);
    expect(payload.familyCount).toBeGreaterThanOrEqual(2);
    expect(payload.availableRegions).toContain('Listing');
    expect(payload.availableFamilies).toContain('surface-bridge');
  });

  it('lists focused neighborhood exploration in text mode', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'boundaries',
      'neighborhood',
      'Listing',
      '--top',
      '5',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Boundary Exploration');
    expect(result.stdout).toContain('Neighborhood: Listing');
    expect(result.stdout).toContain('ListingImport -> Listing');
  });

  it('lists families as JSON', () => {
    const result = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'list-families', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      list: string;
      count: number;
      families: Array<{
        family: string;
        relationshipCount: number;
      }>;
    };

    expect(payload.list).toBe('families');
    expect(payload.count).toBeGreaterThanOrEqual(2);
    expect(payload.families.some((family) => family.family === 'surface-bridge')).toBe(true);
  });

  it('lists regions as JSON', () => {
    const result = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'list-regions', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      list: string;
      count: number;
      regions: Array<{
        region: string;
        outboundCount: number;
      }>;
    };

    expect(payload.list).toBe('regions');
    expect(payload.count).toBeGreaterThanOrEqual(3);
    expect(payload.regions.some((region) => region.region === 'Listing')).toBe(true);
  });

  it('emits aggregated relationships as JSON', () => {
    const result = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'show', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      trustLevel: string;
      count: number;
      aggregates: Array<{
        sourceRegion: string;
        targetRegion: string;
        relationshipKind: string;
        projectedWeight: number;
      }>;
    };

    expect(payload.trustLevel).toBe('overlay-complete');
    expect(payload.count).toBeGreaterThanOrEqual(2);
    expect(
      payload.aggregates.some(
        (aggregate) =>
          aggregate.sourceRegion === 'Checkout' &&
          aggregate.targetRegion === 'Billing' &&
          aggregate.relationshipKind === 'interacts-with'
      )
    ).toBe(true);
    expect(
      payload.aggregates.some(
        (aggregate) =>
          aggregate.sourceRegion === 'ListingImport' &&
          aggregate.targetRegion === 'Listing' &&
          aggregate.projectedWeight > 0
      )
    ).toBe(true);
  });

  it('supports focused JSON exports for a given region', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'boundaries',
      'show',
      '--json',
      '--focus',
      'Listing',
      '--focus-direction',
      'inbound',
      '--top',
      '1',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      focusRegion: string | null;
      focusDirection: string | null;
      totalCount: number;
      count: number;
      aggregates: Array<{
        sourceRegion: string;
        targetRegion: string;
      }>;
    };

    expect(payload.focusRegion).toBe('Listing');
    expect(payload.focusDirection).toBe('inbound');
    expect(payload.totalCount).toBeGreaterThanOrEqual(1);
    expect(payload.count).toBe(1);
    expect(payload.aggregates.every((aggregate) => aggregate.targetRegion === 'Listing')).toBe(
      true
    );
  });

  it('supports focused text output with all sample paths', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'boundaries',
      'show',
      '--focus',
      'Listing',
      '--include-paths',
      '--top',
      '1',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Focus: Listing (both)');
    expect(result.stdout).toContain('Top: 1 of');
    expect(result.stdout).toContain('sample');
    expect(result.stdout).toContain('surface call');
  });

  it('rejects invalid focus directions', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'boundaries',
      'show',
      '--focus',
      'Listing',
      '--focus-direction',
      'sideways',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--focus-direction must be one of');
  });
});
