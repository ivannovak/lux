import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import {
  formatOperationalNeighborhoodSummary,
  getOperationalBoundaryHandlers,
  getOperationalDispatchSourcesForJob,
  getOperationalDispatchedJobs,
  getOperationalEventListeners,
  getOperationalUpstreamTriggers,
  getTrustAwareOperationalNeighborhood,
} from '../operational/retrieval.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-operational-retrieval-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

describe('operational retrieval helpers', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();

    db.upsertOperationalBoundary({
      id: 'opb:schedule:nightly-sync',
      repo_root: '/app',
      kind: 'schedule',
      name: 'nightly-sync',
      trust_tier: 5,
      file_path: 'app/Console/Kernel.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:command:invoices:sync',
      repo_root: '/app',
      kind: 'command',
      name: 'invoices:sync',
      trust_tier: 5,
      file_path: 'app/Console/Commands/SyncInvoices.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:job:App\\Jobs\\RefreshReport',
      repo_root: '/app',
      kind: 'job',
      name: 'App\\Jobs\\RefreshReport',
      trust_tier: 4,
      file_path: 'app/Jobs/RefreshReport.php',
    });
    db.upsertOperationalBoundary({
      id: 'opb:event:App\\Events\\ListingImported',
      repo_root: '/app',
      kind: 'event',
      name: 'App\\Events\\ListingImported',
      trust_tier: 5,
      file_path: 'app/Providers/EventServiceProvider.php',
    });

    db.upsertOperationalHandler({
      id: 'oph:command-sync',
      boundary_id: 'opb:command:invoices:sync',
      symbol_id: 'symbol:php:App\\Console\\Commands\\SyncInvoices',
      trust_tier: 5,
    });
    db.upsertOperationalHandler({
      id: 'oph:job-refresh',
      boundary_id: 'opb:job:App\\Jobs\\RefreshReport',
      symbol_id: 'symbol:php:App\\Jobs\\RefreshReport',
      trust_tier: 4,
    });
    db.upsertOperationalHandler({
      id: 'oph:event-listener',
      boundary_id: 'opb:event:App\\Events\\ListingImported',
      symbol_id: 'symbol:php:App\\Listeners\\SyncSearchIndex',
      trust_tier: 5,
    });

    db.upsertOperationalEdge({
      id: 'ope:schedule-to-command',
      source_id: 'opb:schedule:nightly-sync',
      target_id: 'opb:command:invoices:sync',
      edge_type: 'TRIGGERS',
      transport: 'sync',
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
      source_id: 'opb:event:App\\Events\\ListingImported',
      target_id: 'symbol:php:App\\Listeners\\SyncSearchIndex',
      edge_type: 'HANDLED_BY',
      transport: 'event-bus',
      trust_tier: 5,
    });

    db.upsertOperationalContract({
      id: 'opc:command-signature',
      boundary_id: 'opb:command:invoices:sync',
      payload_schema: JSON.stringify({ command: 'invoices:sync', tokens: [{ kind: 'argument' }] }),
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
      payload_schema: JSON.stringify({ maxArity: 2 }),
      trust_tier: 4,
    });
    db.upsertOperationalContract({
      id: 'opc:event-schema',
      boundary_id: 'opb:event:App\\Events\\ListingImported',
      payload_schema: JSON.stringify({ eventClass: 'App\\Events\\ListingImported' }),
      trust_tier: 5,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('retrieves boundary handlers with edge and contract context', () => {
    const result = getOperationalBoundaryHandlers(db, 'opb:command:invoices:sync');
    expect(result).not.toBeNull();
    expect(result!.handlers).toHaveLength(1);
    expect(result!.handlers[0].handler.symbol_id).toBe(
      'symbol:php:App\\Console\\Commands\\SyncInvoices'
    );
    expect(result!.contracts).toHaveLength(1);
  });

  it('retrieves upstream triggers including transport and source contracts', () => {
    const result = getOperationalUpstreamTriggers(db, 'opb:job:App\\Jobs\\RefreshReport');
    expect(result).not.toBeNull();
    expect(result!.triggers).toHaveLength(1);
    expect(result!.triggers[0].sourceBoundary.kind).toBe('schedule');
    expect(result!.triggers[0].edge.transport).toBe('queue');
    expect(result!.triggers[0].sourceContracts).toHaveLength(1);
  });

  it('retrieves job dispatch sources from structural symbols', () => {
    const result = getOperationalDispatchSourcesForJob(db, 'opb:job:App\\Jobs\\RefreshReport');
    expect(result).not.toBeNull();
    expect(result!.dispatchSources).toHaveLength(1);
    expect(result!.dispatchSources[0].sourceKind).toBe('structural-symbol');
    expect(result!.dispatchSources[0].edge.transport).toBe('async');
  });

  it('retrieves dispatched jobs from a source symbol', () => {
    const result = getOperationalDispatchedJobs(
      db,
      'symbol:php:App\\Http\\Controllers\\ReportController'
    );

    expect(result.dispatchedJobs).toHaveLength(1);
    expect(result.dispatchedJobs[0].jobBoundary.id).toBe('opb:job:App\\Jobs\\RefreshReport');
    expect(result.dispatchedJobs[0].jobContracts).toHaveLength(1);
  });

  it('retrieves event listeners with trust-preserving transport context', () => {
    const result = getOperationalEventListeners(db, 'opb:event:App\\Events\\ListingImported');
    expect(result).not.toBeNull();
    expect(result!.listeners).toHaveLength(1);
    expect(result!.listeners[0].edge.transport).toBe('event-bus');
    expect(result!.contracts).toHaveLength(1);
  });

  it('builds a trust-aware local operational neighborhood', () => {
    const neighborhood = getTrustAwareOperationalNeighborhood(
      db,
      'opb:job:App\\Jobs\\RefreshReport',
      {
        maxDepth: 2,
        minTrustTier: 4,
      }
    );

    expect(neighborhood.nodes.some((node) => node.id === 'opb:schedule:nightly-sync')).toBe(true);
    expect(
      neighborhood.nodes.some((node) => node.id === 'symbol:php:App\\Jobs\\RefreshReport')
    ).toBe(true);
    expect(neighborhood.trustSummary.mixedTrust).toBe(true);

    const summary = formatOperationalNeighborhoodSummary(neighborhood);
    expect(summary).toContain('Seed: opb:job:App\\Jobs\\RefreshReport');
    expect(summary).toContain('TRIGGERS');
    expect(summary).toContain('HANDLED_BY');
  });
});
