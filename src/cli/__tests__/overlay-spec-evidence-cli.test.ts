import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LuxDatabase } from '../../db/index.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}

function seedDb(db: LuxDatabase, repoDir: string): void {
  persistRebuildTrustState(
    db,
    {
      mode: 'overlay-complete',
      repoPath: repoDir,
      configSource: 'lux.yaml',
      configLspEnabled: true,
      surfaceCount: 1,
      detectorEdgeCount: 1,
      propagatedEdgeCount: 0,
      fileNodeCount: 2,
      symbolNodeCount: 2,
      controllerBackedCount: 1,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
      enrichmentStatus: 'active',
      propagationStatus: 'ran',
      warnings: [],
    },
    { sourceAction: 'index-rebuild' }
  );

  const now = Math.floor(Date.now() / 1000);
  db.upsertStructuralNode({
    id: 'file:routes/api.php',
    node_type: 'file',
    file_path: 'routes/api.php',
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'surface:http:POST:/orders',
    node_type: 'capability-surface',
    symbol_name: 'POST /orders',
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ method: 'POST', path: '/orders', routeName: 'orders.store' }),
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'symbol:php:App\\Http\\Controllers\\OrderController@store',
    node_type: 'symbol',
    symbol_name: 'OrderController@store',
    file_path: 'app/Http/Controllers/OrderController.php',
    updated_at: now,
  });
  db.upsertStructuralEdge({
    id: 'edge:declares-orders',
    source_node_id: 'file:routes/api.php',
    target_node_id: 'surface:http:POST:/orders',
    edge_type: 'declares_surface',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now,
  });
  db.upsertStructuralEdge({
    id: 'edge:orders-handler',
    source_node_id: 'surface:http:POST:/orders',
    target_node_id: 'symbol:php:App\\Http\\Controllers\\OrderController@store',
    edge_type: 'handled_by',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'surface:http:GET:/reports-alpha',
    node_type: 'capability-surface',
    symbol_name: 'GET /reports-alpha',
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ method: 'GET', path: '/reports-alpha' }),
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'surface:http:GET:/reports-beta',
    node_type: 'capability-surface',
    symbol_name: 'GET /reports-beta',
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ method: 'GET', path: '/reports-beta' }),
    updated_at: now,
  });
  db.upsertOperationalBoundary({
    id: 'opb:job:App\\Jobs\\SyncOrders',
    repo_root: repoDir,
    kind: 'job',
    name: 'App\\Jobs\\SyncOrders',
    trust_tier: 5,
    file_path: 'app/Jobs/SyncOrders.php',
  });
  db.upsertOperationalHandler({
    id: 'oph:sync-orders',
    boundary_id: 'opb:job:App\\Jobs\\SyncOrders',
    symbol_id: 'symbol:php:App\\Jobs\\SyncOrders',
    trust_tier: 5,
  });
  db.upsertOperationalEdge({
    id: 'ope:job-handler',
    source_id: 'opb:job:App\\Jobs\\SyncOrders',
    target_id: 'symbol:php:App\\Jobs\\SyncOrders',
    edge_type: 'HANDLED_BY',
    transport: 'queue',
    trust_tier: 5,
  });
}

describe('overlay spec-evidence CLI', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-spec-evidence-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-spec-evidence-db-'));
    dbPath = join(dbDir, 'lux.db');
    mkdirSync(join(repoDir, 'routes'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'spec-evidence-test' }));
    const db = new LuxDatabase(dbPath);
    seedDb(db, repoDir);
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('emits packet JSON for route targets', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'spec-evidence',
      'ask',
      '--json',
      '--target',
      'POST /orders',
      '--kind',
      'route',
      'What source evidence supports this operation?',
    ]);

    expect(result.status).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.surface).toBe('spec-derivation-evidence');
    expect(packet.target.kind).toBe('route');
    expect(packet.candidateOperation.entrySurfaces.length).toBeGreaterThan(0);
  });

  it('writes a single-target Markdown export', () => {
    const outPath = join(dbDir, 'sync-orders.md');
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'spec-evidence',
      'ask',
      '--target',
      'SyncOrders',
      '--kind',
      'job',
      '--out',
      outPath,
      'What source evidence supports this job?',
    ]);

    expect(result.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toContain('# Spec-Derivation Evidence');
  });

  it('writes a single-target JSON export', () => {
    const outPath = join(dbDir, 'sync-orders.json');
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'spec-evidence',
      'ask',
      '--target',
      'SyncOrders',
      '--kind',
      'job',
      '--out',
      outPath,
      'What source evidence supports this job?',
    ]);

    expect(result.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const packet = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(packet.surface).toBe('spec-derivation-evidence');
  });

  it('rejects unsupported export extensions', () => {
    const outPath = join(dbDir, 'sync-orders.txt');
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'spec-evidence',
      'ask',
      '--target',
      'SyncOrders',
      '--kind',
      'job',
      '--out',
      outPath,
      'What source evidence supports this job?',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--out must end in .json, .md, or .markdown');
    expect(existsSync(outPath)).toBe(false);
  });

  it('exits nonzero for ambiguous targets without falling back to generic ask', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'spec-evidence',
      'ask',
      '--json',
      '--target',
      'GET /reports',
      '--kind',
      'route',
      'What source evidence supports this route?',
    ]);

    expect(result.status).toBe(1);
    const packet = JSON.parse(result.stdout);
    expect(packet.target.resolutionState).toBe('ambiguous');
    expect(result.stdout).not.toContain('experts_consulted');
  });

  it('rejects deferred seed target kinds', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'spec-evidence',
      'ask',
      '--target',
      'App\\Events\\OrderPlaced',
      '--kind',
      'event',
      'What source evidence supports this event?',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Deferred seed targets');
  });
});
