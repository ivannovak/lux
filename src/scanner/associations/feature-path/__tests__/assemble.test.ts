// Tests for tranche-one feature-path retrieval assembly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../../db/index.js';
import type { StructuralEdge, StructuralNode } from '../../../../db/types.js';
import { assembleFeaturePathAnswer } from '../assemble.js';
import { resolveFeaturePathTarget } from '../resolve.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-assemble-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function upsertNode(
  db: LuxDatabase,
  id: string,
  nodeType: StructuralNode['node_type'],
  symbolName: string,
  filePath?: string
): void {
  db.upsertStructuralNode({
    id,
    node_type: nodeType,
    symbol_name: symbolName,
    language_id: 'php',
    ...(filePath ? { file_path: filePath } : {}),
    metadata: '{}',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertSurface(
  db: LuxDatabase,
  id: string,
  handle: string,
  method: string,
  path: string,
  filePath: string,
  routeName?: string
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'capability-surface',
    symbol_name: handle,
    language_id: 'http',
    file_path: filePath,
    metadata: JSON.stringify({ transport: 'http', method, path, routeName }),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertEdge(
  db: LuxDatabase,
  id: string,
  edgeType: StructuralEdge['edge_type'],
  sourceNodeId: string,
  targetNodeId: string,
  confidence: number = 0.9
): void {
  db.upsertStructuralEdge({
    id,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    edge_type: edgeType,
    confidence,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: 'test',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

describe('assembleFeaturePathAnswer', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('produces an honest "no target" answer when resolution fails', () => {
    const resolution = resolveFeaturePathTarget(db, 'no-such-route');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles no-such-route?',
      intent: 'route-handler',
      resolution,
    });

    expect(answer.target).toBeNull();
    expect(answer.primaryAnswer.confidence).toBe('none');
    expect(answer.directEvidence).toEqual([]);
    expect(answer.failures.map((failure) => failure.failureClass)).toContain('unresolved-target');
  });

  it('assembles route-declaration evidence and a handler-recovery item for a resolved surface', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
    });

    expect(answer.target?.id).toBe(surfaceId);
    expect(answer.directEvidence.map((item) => item.kind).sort()).toEqual([
      'handler-recovery',
      'route-declaration',
    ]);
    expect(answer.primaryAnswer.summary).toContain('OfferController@store');
    expect(answer.primaryAnswer.confidence).toBe('high');
    expect(answer.failures.map((failure) => failure.failureClass)).not.toContain(
      'missing-handler-recovery'
    );
  });

  it('files consumers under context, not direct evidence', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    const consumerId = 'symbol:ts:OffersClient.create';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertNode(
      db,
      consumerId,
      'symbol',
      'OffersClient.create',
      'frontend/services/offers-client.ts'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);
    upsertEdge(db, `edge:calls_surface:${consumerId}`, 'calls_surface', consumerId, surfaceId, 0.9);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
    });

    expect(answer.context.map((item) => item.kind)).toContain('nearby-consumer');
    // The same consumer node ID must NOT also appear in direct evidence.
    const directNodeIds = answer.directEvidence.map((item) => item.nodeId);
    expect(directNodeIds).not.toContain(consumerId);
  });

  it('frames route-callers as persisted consumer context rather than exhaustive call graph proof', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:App\\Http\\Controllers\\OfferController@store';
    const consumerId = 'symbol:ts:OffersClient.create';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertNode(
      db,
      consumerId,
      'symbol',
      'OffersClient.create',
      'frontend/services/offers-client.ts'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);
    upsertEdge(db, `edge:calls_surface:${consumerId}`, 'calls_surface', consumerId, surfaceId, 0.9);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'who calls POST /offers?',
      intent: 'route-callers',
      resolution,
    });

    expect(answer.primaryAnswer.summary).toContain('Persisted consumers');
    expect(answer.primaryAnswer.summary).toContain('listed under Context');
    expect(answer.primaryAnswer.confidence).toBe('medium');
    expect(answer.context.map((item) => item.kind)).toContain('nearby-consumer');
    expect(answer.directEvidence.map((item) => item.nodeId)).not.toContain(consumerId);
  });

  it('does not present unresolved ownership as a positive ownership claim in the summary', () => {
    const surfaceId = 'surface:http:GET:/profile';
    const controllerId = 'symbol:php:ProfileController';
    upsertSurface(db, surfaceId, 'GET /profile', 'GET', '/profile', 'routes/web.php');
    upsertNode(
      db,
      controllerId,
      'symbol',
      'ProfileController',
      'app/Http/Controllers/ProfileController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    const resolution = resolveFeaturePathTarget(db, 'GET /profile');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles GET /profile?',
      intent: 'route-handler',
      resolution,
      repoRoot: testDir,
    });

    expect(answer.ownership?.basis).toBe('unresolved');
    expect(answer.primaryAnswer.summary).toContain('ProfileController');
    expect(answer.primaryAnswer.summary).not.toContain('belongs to unresolved');
    expect(answer.failures.map((failure) => failure.failureClass)).toContain('weak-ownership');
  });

  it('flags missing-handler-recovery when the surface resolves but has no provider', () => {
    const surfaceId = 'surface:http:POST:/offers';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
    });

    expect(answer.failures.map((failure) => failure.failureClass)).toContain(
      'missing-handler-recovery'
    );
    expect(answer.primaryAnswer.confidence).toBe('none');
  });

  it('records a closure handler when providerKind is closure', () => {
    const surfaceId = 'surface:http:GET:/health';
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /health',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/health',
        providerKind: 'closure',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });

    const resolution = resolveFeaturePathTarget(db, 'GET /health');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles GET /health?',
      intent: 'route-handler',
      resolution,
    });

    const handler = answer.directEvidence.find((item) => item.kind === 'handler-recovery');
    expect(handler).toBeDefined();
    expect(handler?.description).toContain('closure');
  });

  it('auto-attributes ownership when repoRoot is provided and extensions.ownership is omitted', () => {
    const repoRoot = join(testDir, 'repo');
    mkdirSync(join(repoRoot, 'app/Modules/Listings'), { recursive: true });
    writeFileSync(join(repoRoot, 'app/Modules/Listings/OfferController.php'), '<?php');

    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Modules/Listings/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
      repoRoot,
    });

    expect(answer.ownership?.regionName).toBe('Listings');
    expect(answer.ownership?.basis).toBe('module-boundary');
    expect(answer.primaryAnswer.summary).toContain('Listings');
    expect(answer.failures.map((failure) => failure.failureClass)).not.toContain('weak-ownership');
  });

  it('explicit extensions.ownership wins over auto-attribution', () => {
    const repoRoot = join(testDir, 'repo');
    mkdirSync(join(repoRoot, 'app/Modules/Listings'), { recursive: true });
    writeFileSync(join(repoRoot, 'app/Modules/Listings/OfferController.php'), '<?php');

    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Modules/Listings/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
      repoRoot,
      extensions: {
        ownership: {
          regionId: 'module:Custom',
          regionName: 'Custom',
          basis: 'overlay-led',
          trustTier: 4,
          rationale: 'forced by caller',
        },
      },
    });

    expect(answer.ownership?.regionName).toBe('Custom');
    expect(answer.ownership?.basis).toBe('overlay-led');
  });

  it('auto-summarizes contracts and emits direct-evidence items when validators/response contracts exist', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    const requestId = 'contract:schema:StoreOfferRequest';
    const responseId = 'contract:schema:OfferResource';

    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );

    db.upsertStructuralNode({
      id: requestId,
      node_type: 'contract',
      symbol_name: 'StoreOfferRequest',
      language_id: 'php',
      file_path: 'app/Http/Requests/StoreOfferRequest.php',
      metadata: JSON.stringify({
        transport: 'http',
        side: 'request',
        contractKind: 'explicit-class',
        shapeConfidence: 'exact',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralNode({
      id: responseId,
      node_type: 'contract',
      symbol_name: 'OfferResource',
      language_id: 'php',
      file_path: 'app/Http/Resources/OfferResource.php',
      metadata: JSON.stringify({
        transport: 'http',
        side: 'response',
        contractKind: 'explicit-class',
        shapeConfidence: 'exact',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });

    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);
    // Edge IDs end with `:store` so surface-retrieval's controllerMethod scope filter matches.
    upsertEdge(
      db,
      `${controllerId}->${requestId}:validates_with:store`,
      'validates_with',
      controllerId,
      requestId
    );
    upsertEdge(
      db,
      `${controllerId}->${responseId}:returns_contract:store`,
      'returns_contract',
      controllerId,
      responseId
    );

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what is the request and response shape for POST /offers?',
      intent: 'route-contract',
      resolution,
    });

    expect(answer.contracts?.request?.label).toBe('exact(StoreOfferRequest)');
    expect(answer.contracts?.response?.label).toBe('exact(OfferResource)');
    expect(answer.directEvidence.map((item) => item.kind).sort()).toEqual(
      ['handler-recovery', 'response-contract', 'route-declaration', 'validator-attachment'].sort()
    );
    expect(answer.failures.map((failure) => failure.failureClass)).not.toContain(
      'insufficient-contract-recovery'
    );
  });

  it('emits insufficient-contract-recovery for route-contract intent when no contract exists', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what is the request shape for POST /offers?',
      intent: 'route-contract',
      resolution,
    });

    expect(answer.contracts).toBeNull();
    expect(answer.failures.map((failure) => failure.failureClass)).toContain(
      'insufficient-contract-recovery'
    );
  });

  it('explicit extensions.contracts wins over auto-summary', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    const requestId = 'contract:schema:StoreOfferRequest';

    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    db.upsertStructuralNode({
      id: requestId,
      node_type: 'contract',
      symbol_name: 'StoreOfferRequest',
      language_id: 'php',
      file_path: 'app/Http/Requests/StoreOfferRequest.php',
      metadata: JSON.stringify({
        transport: 'http',
        side: 'request',
        contractKind: 'explicit-class',
        shapeConfidence: 'exact',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);
    upsertEdge(
      db,
      `${controllerId}->${requestId}:validates_with:store`,
      'validates_with',
      controllerId,
      requestId
    );

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what is the request shape for POST /offers?',
      intent: 'route-contract',
      resolution,
      extensions: {
        contracts: {
          request: { label: 'exact(ForcedByCaller)', shapeConfidence: 'exact' },
        },
      },
    });

    expect(answer.contracts?.request?.label).toBe('exact(ForcedByCaller)');
  });

  it('merges extension data (ownership, contracts, downstream, cross-language) into the answer', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
      extensions: {
        ownership: {
          regionId: 'module:Listings',
          regionName: 'Listings',
          basis: 'module-boundary',
          trustTier: 5,
        },
        contracts: {
          response: { label: 'exact(OfferResource)', shapeConfidence: 'exact' },
        },
      },
    });

    expect(answer.ownership?.regionName).toBe('Listings');
    expect(answer.contracts?.response?.label).toBe('exact(OfferResource)');
    expect(answer.primaryAnswer.summary).toContain('Listings');
    expect(answer.failures.map((failure) => failure.failureClass)).not.toContain('weak-ownership');
  });

  it('auto-attaches a bounded downstream step from handler operational edges', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    db.upsertOperationalBoundary({
      id: 'opb:job:NotifyOfferCreated',
      repo_root: testDir,
      kind: 'job',
      name: 'NotifyOfferCreated',
      trust_tier: 4,
      file_path: 'app/Jobs/NotifyOfferCreated.php',
    });
    db.upsertOperationalEdge({
      id: 'ope:dispatch-notify',
      source_id: controllerId,
      target_id: 'opb:job:NotifyOfferCreated',
      edge_type: 'DISPATCHES',
      transport: 'queue',
      trust_tier: 4,
    });

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what does POST /offers trigger?',
      intent: 'route-downstream',
      resolution,
    });

    expect(answer.downstreamStep).not.toBeNull();
    expect(answer.downstreamStep!.edgeType).toBe('DISPATCHES');
    expect(answer.downstreamStep!.target.label).toBe('NotifyOfferCreated');
    expect(answer.downstreamStep!.transport).toBe('queue');
  });

  it('honestly refuses naming-only cross-language consumers without lifting them to direct evidence', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    const consumerId = 'symbol:ts:OffersClient.create';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    db.upsertStructuralNode({
      id: consumerId,
      node_type: 'symbol',
      symbol_name: 'OffersClient.create',
      language_id: 'typescript',
      file_path: 'frontend/services/offers-client.ts',
      metadata: '{}',
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);
    db.upsertStructuralEdge({
      id: 'edge:naming-call',
      source_node_id: consumerId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.4,
      confidence_class: 'heuristic',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'naming-match',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
    });

    expect(answer.crossLanguage?.status).toBe('refused-naming-only');
    // Refused associations are NEVER direct evidence (T10, R6, R10).
    const directKinds = answer.directEvidence.map((item) => item.kind);
    expect(directKinds).not.toContain('high-trust-cross-language-association');
    const directNodeIds = answer.directEvidence.map((item) => item.nodeId);
    expect(directNodeIds).not.toContain(consumerId);
    // Refused consumers may still appear as adjacency context.
    const contextNodeIds = answer.context.map((item) => item.nodeId);
    expect(contextNodeIds).toContain(consumerId);
    // And the failure classifier flags the refusal.
    expect(answer.failures.map((f) => f.failureClass)).toContain(
      'cross-language-below-promotion-threshold'
    );
  });

  it('promotes artifact-backed cross-language consumers and dedupes them out of context', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    const consumerId = 'symbol:ts:OffersClient.create';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    db.upsertStructuralNode({
      id: consumerId,
      node_type: 'symbol',
      symbol_name: 'OffersClient.create',
      language_id: 'typescript',
      file_path: 'frontend/services/offers-client.ts',
      metadata: '{}',
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);
    db.upsertStructuralEdge({
      id: 'edge:strong-call',
      source_node_id: consumerId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.95,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'generated-types',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what handles POST /offers?',
      intent: 'route-handler',
      resolution,
    });

    expect(answer.crossLanguage?.status).toBe('promoted');
    // Promoted association surfaces as DIRECT evidence...
    const directKinds = answer.directEvidence.map((item) => item.kind);
    expect(directKinds).toContain('high-trust-cross-language-association');
    // ...and is deduped out of context so the same node isn't shown twice.
    const contextNodeIds = answer.context.map((item) => item.nodeId);
    expect(contextNodeIds).not.toContain(consumerId);
    // No refusal failure when promoted.
    expect(answer.failures.map((f) => f.failureClass)).not.toContain(
      'cross-language-below-promotion-threshold'
    );
  });

  it('explicit extensions.downstreamStep wins over auto-attach', () => {
    const surfaceId = 'surface:http:POST:/offers';
    const controllerId = 'symbol:php:OfferController@store';
    upsertSurface(
      db,
      surfaceId,
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertNode(
      db,
      controllerId,
      'symbol',
      'OfferController@store',
      'app/Http/Controllers/OfferController.php'
    );
    upsertEdge(db, `edge:handled_by:${surfaceId}`, 'handled_by', surfaceId, controllerId);

    db.upsertOperationalEdge({
      id: 'ope:auto',
      source_id: controllerId,
      target_id: 'opb:job:Auto',
      edge_type: 'DISPATCHES',
      trust_tier: 5,
    });

    const resolution = resolveFeaturePathTarget(db, 'POST /offers');
    const answer = assembleFeaturePathAnswer(db, {
      question: 'what does POST /offers trigger?',
      intent: 'route-downstream',
      resolution,
      extensions: {
        downstreamStep: {
          description: 'forced by caller',
          edgeType: 'TRIGGERS',
          source: { id: controllerId, label: 'OfferController@store' },
          target: { id: 'opb:custom', label: 'Custom' },
          trustTier: 3,
        },
      },
    });

    expect(answer.downstreamStep?.description).toBe('forced by caller');
    expect(answer.downstreamStep?.edgeType).toBe('TRIGGERS');
  });
});
