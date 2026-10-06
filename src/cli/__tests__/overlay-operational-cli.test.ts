import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

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

describe('overlay operational CLI', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-overlay-operational-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-overlay-operational-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'app', 'Console', 'Commands'), { recursive: true });
    mkdirSync(join(repoDir, 'app', 'Console'), { recursive: true });
    mkdirSync(join(repoDir, 'app', 'Http', 'Controllers'), { recursive: true });
    mkdirSync(join(repoDir, 'app', 'Jobs'), { recursive: true });
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'overlay-operational-test' })
    );

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
        fileNodeCount: 4,
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

    db.upsertOperationalBoundary({
      id: 'opb:schedule:nightly-sync',
      repo_root: repoDir,
      kind: 'schedule',
      name: 'nightly-sync',
      trust_tier: 5,
      file_path: 'app/Console/Kernel.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:job:App\\Jobs\\RefreshReport',
      repo_root: repoDir,
      kind: 'job',
      name: 'App\\Jobs\\RefreshReport',
      trust_tier: 4,
      file_path: 'app/Jobs/RefreshReport.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:job:App\\Jobs\\RefreshReportDaily',
      repo_root: repoDir,
      kind: 'job',
      name: 'App\\Jobs\\RefreshReportDaily',
      trust_tier: 4,
      file_path: 'app/Jobs/RefreshReportDaily.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:event:App\\Events\\ReportReady',
      repo_root: repoDir,
      kind: 'event',
      name: 'App\\Events\\ReportReady',
      trust_tier: 5,
      file_path: 'app/Events/ReportReady.php',
    });

    db.upsertOperationalHandler({
      id: 'oph:job-refresh',
      boundary_id: 'opb:job:App\\Jobs\\RefreshReport',
      symbol_id: 'symbol:php:App\\Jobs\\RefreshReport',
      trust_tier: 4,
    });
    db.upsertOperationalHandler({
      id: 'oph:event-listener',
      boundary_id: 'opb:event:App\\Events\\ReportReady',
      symbol_id: 'symbol:php:App\\Listeners\\SendReportNotification',
      trust_tier: 5,
    });

    db.upsertOperationalEdge({
      id: 'ope:schedule-to-job',
      source_id: 'opb:schedule:nightly-sync',
      target_id: 'opb:job:App\\Jobs\\RefreshReport',
      edge_type: 'TRIGGERS',
      transport: 'queue',
      trust_tier: 5,
    });
    db.upsertOperationalEdge({
      id: 'ope:job-handled-by',
      source_id: 'opb:job:App\\Jobs\\RefreshReport',
      target_id: 'symbol:php:App\\Jobs\\RefreshReport',
      edge_type: 'HANDLED_BY',
      transport: 'queue',
      trust_tier: 4,
    });
    db.upsertOperationalEdge({
      id: 'ope:dispatch-job',
      source_id: 'symbol:php:App\\Http\\Controllers\\ReportController',
      target_id: 'opb:job:App\\Jobs\\RefreshReport',
      edge_type: 'DISPATCHES',
      transport: 'async',
      trust_tier: 4,
    });
    db.upsertOperationalEdge({
      id: 'ope:event-listener',
      source_id: 'opb:event:App\\Events\\ReportReady',
      target_id: 'symbol:php:App\\Listeners\\SendReportNotification',
      edge_type: 'HANDLED_BY',
      transport: 'event-bus',
      trust_tier: 5,
    });

    db.upsertOperationalContract({
      id: 'opc:schedule-cadence',
      boundary_id: 'opb:schedule:nightly-sync',
      payload_schema: JSON.stringify({ cadence: { methods: ['dailyAt'] } }),
      trust_tier: 5,
    });
    db.upsertOperationalContract({
      id: 'opc:job-payload',
      boundary_id: 'opb:job:App\\Jobs\\RefreshReport',
      payload_schema: JSON.stringify({ dispatchMethods: ['dispatch'], maxArity: 2 }),
      trust_tier: 4,
    });

    db.upsertStructuralNode({
      id: 'symbol:php:App\\Jobs\\RefreshReport',
      node_type: 'symbol',
      file_path: 'app/Jobs/RefreshReport.php',
      language_id: 'php',
      symbol_name: 'App\\Jobs\\RefreshReport',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralNode({
      id: 'symbol:php:App\\Http\\Controllers\\ReportController',
      node_type: 'symbol',
      file_path: 'app/Http/Controllers/ReportController.php',
      language_id: 'php',
      symbol_name: 'App\\Http\\Controllers\\ReportController',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralNode({
      id: 'symbol:php:App\\Listeners\\SendReportNotification',
      node_type: 'symbol',
      file_path: 'app/Listeners/SendReportNotification.php',
      language_id: 'php',
      symbol_name: 'App\\Listeners\\SendReportNotification',
      updated_at: Math.floor(Date.now() / 1000),
    });

    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('answers dispatch-source questions as JSON with resolution metadata', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what dispatches App\\Jobs\\RefreshReport?',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      intent: string;
      overlayTrustLevel: string;
      resolution: { status: string; matchedBy?: string; candidates: Array<{ id: string }> };
      target: { id: string; trustTier: number; filePath: string | null };
      primaryAnswer: {
        summary: string;
        confidence: string;
        items: Array<{ id: string; filePath?: string | null }>;
      };
      trust: {
        targetTrustTier: number;
        evidenceTrustTiers: number[];
        mixedTrust: boolean;
      };
      transport: Array<{ edgeType: string; transport: string | null; trustTier: number }>;
      evidence: Array<{
        source: { id: string; filePath?: string | null };
        target: { id: string };
      }>;
      context: unknown[];
    };

    expect(payload.intent).toBe('dispatch-sources');
    expect(payload.overlayTrustLevel).toBe('overlay-complete');
    expect(payload.resolution.status).toBe('resolved');
    expect(payload.resolution.matchedBy).toBe('exact');
    expect(payload.target.id).toBe('opb:job:App\\Jobs\\RefreshReport');
    expect(payload.target.trustTier).toBe(4);
    expect(payload.target.filePath).toBe('app/Jobs/RefreshReport.php');
    expect(payload.primaryAnswer.summary).toContain('dispatches job:App\\Jobs\\RefreshReport');
    expect(payload.primaryAnswer.confidence).toBe('high');
    expect(payload.primaryAnswer.items[0].id).toBe(
      'symbol:php:App\\Http\\Controllers\\ReportController'
    );
    expect(payload.primaryAnswer.items[0].filePath).toBe(
      'app/Http/Controllers/ReportController.php'
    );
    expect(payload.trust.targetTrustTier).toBe(4);
    expect(payload.trust.evidenceTrustTiers).toEqual([4]);
    expect(payload.trust.mixedTrust).toBe(false);
    expect(payload.transport[0].edgeType).toBe('DISPATCHES');
    expect(payload.transport[0].transport).toBe('async');
    expect(payload.evidence[0].source.filePath).toBe('app/Http/Controllers/ReportController.php');
    expect(payload.context).toEqual([]);
  });

  it('answers schedule questions with direct evidence called out explicitly', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what schedules App\\Jobs\\RefreshReport?',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toContain(
      'schedule:nightly-sync schedules job:App\\Jobs\\RefreshReport'
    );
    expect(result.stdout).toContain('Overlay Trust: overlay-complete');
    expect(result.stdout).toContain('Target Trust Tier: 4');
    expect(result.stdout).toContain('Evidence Trust: tier 5');
    expect(result.stdout).toContain('Resolution Match: exact');
    expect(result.stdout).toContain('Direct Evidence');
    expect(result.stdout).toContain('TRIGGERS queue tier=5');
    expect(result.stdout).toContain('file: app/Console/Kernel.php');
    expect(result.stdout).toContain('contracts: opc:schedule-cadence tier=5');
  });

  it('answers event listener questions', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what listeners handle App\\Events\\ReportReady?',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toContain(
      'App\\Listeners\\SendReportNotification handles event:App\\Events\\ReportReady'
    );
    expect(result.stdout).toContain('HANDLED_BY event-bus tier=5');
    expect(result.stdout).toContain('app/Listeners/SendReportNotification.php');
  });

  it('answers neighborhood questions with context separated from direct evidence', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what operational boundaries can reach this workflow?',
      '--target',
      'App\\Jobs\\RefreshReport',
      '--max-depth',
      '1',
      '--min-trust-tier',
      '4',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toContain('job:App\\Jobs\\RefreshReport can reach');
    expect(result.stdout).toContain('Direct Evidence');
    expect(result.stdout).toContain('- none persisted for this answer');
    expect(result.stdout).toContain('Context');
    expect(result.stdout).toContain('schedule:nightly-sync');
    expect(result.stdout).toContain('TRIGGERS queue tier=5');
  });

  it('resolves basename-exact job targets before looser partial matches', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what schedules this workflow?',
      '--target',
      'RefreshReport',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toContain(
      'schedule:nightly-sync schedules job:App\\Jobs\\RefreshReport'
    );
    expect(result.stdout).toContain('Resolution Match: exact');
    expect(result.stdout).not.toContain('RefreshReportDaily');
  });

  it('rejects truly ambiguous operational targets with candidate guidance', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what schedules this workflow?',
      '--target',
      'Refresh',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Multiple persisted operational boundaries matched');
    expect(result.stdout).toContain('Candidates');
    expect(result.stdout).toContain('job:App\\Jobs\\RefreshReport');
    expect(result.stdout).toContain('job:App\\Jobs\\RefreshReportDaily');
  });

  it('rejects unknown operational question targets', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'operational',
      'ask',
      'what dispatches App\\Jobs\\Missing?',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Lux could not resolve');
  });
});
