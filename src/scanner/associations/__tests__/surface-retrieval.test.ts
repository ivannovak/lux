// Tests for surface-centered retrieval helpers and feature-path formatting.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import {
  getSurfaceFeaturePath,
  getFeaturePathsForFile,
  formatFeaturePath,
  formatFeaturePathBlock,
  formatFileFeaturePathBlock,
  CLOSURE_HANDLER_TOKEN,
} from '../surface-retrieval.js';
import type { StructuralNode, StructuralEdge } from '../../../db/types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-surface-retrieval-test-'));

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
    file_path: filePath,
    metadata: '{}',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertSurface(
  db: LuxDatabase,
  id: string,
  handle: string,
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
    metadata: JSON.stringify({ transport: 'http', method: 'GET', path, routeName }),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertEdge(
  db: LuxDatabase,
  id: string,
  edgeType: StructuralEdge['edge_type'],
  sourceNodeId: string,
  targetNodeId: string
): void {
  db.upsertStructuralEdge({
    id,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    edge_type: edgeType,
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: 'test',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

// ---------------------------------------------------------------------------
// getSurfaceFeaturePath — basic assembly
// ---------------------------------------------------------------------------

describe('getSurfaceFeaturePath()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null for a surface that does not exist', () => {
    const result = getSurfaceFeaturePath(db, 'surface:http:GET:/api/unknown');
    expect(result).toBeNull();
  });

  it('returns a FeaturePath with all empty arrays when no edges exist', () => {
    upsertSurface(
      db,
      'surface:http:GET:/api/invoices',
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php'
    );

    const path = getSurfaceFeaturePath(db, 'surface:http:GET:/api/invoices');
    expect(path).not.toBeNull();
    expect(path!.surface.id).toBe('surface:http:GET:/api/invoices');
    expect(path!.providers).toHaveLength(0);
    expect(path!.consumers).toHaveLength(0);
    expect(path!.validators).toHaveLength(0);
    expect(path!.responseContracts).toHaveLength(0);
    expect(path!.artifacts).toHaveLength(0);
    expect(path!.declaringFile).toBeNull();
  });

  it('populates providers from handled_by edges', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(
      db,
      controllerNodeId,
      'symbol',
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php'
    );
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path!.providers).toHaveLength(1);
    expect(path!.providers[0].id).toBe(controllerNodeId);
  });

  it('populates consumers from calls_surface edges', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, wrapperNodeId, 'symbol', 'fetchInvoices', 'src/api/invoices.ts');
    upsertEdge(
      db,
      `${wrapperNodeId}→${surfaceId}:calls_surface`,
      'calls_surface',
      wrapperNodeId,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path!.consumers).toHaveLength(1);
    expect(path!.consumers[0].id).toBe(wrapperNodeId);
  });

  it('populates artifacts from derived_from edges', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(
      db,
      artifactNodeId,
      'file',
      'src/generated/openapi-client.ts',
      'src/generated/openapi-client.ts'
    );
    upsertEdge(
      db,
      `${artifactNodeId}→${surfaceId}:derived_from`,
      'derived_from',
      artifactNodeId,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path!.artifacts).toHaveLength(1);
    expect(path!.artifacts[0].id).toBe(artifactNodeId);
  });

  it('populates declaringFile from declares_surface edge', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const fileNodeId = 'file:routes/api.php';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, fileNodeId, 'file', 'routes/api.php', 'routes/api.php');
    upsertEdge(
      db,
      `${fileNodeId}→${surfaceId}:declares_surface`,
      'declares_surface',
      fileNodeId,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path!.declaringFile).not.toBeNull();
    expect(path!.declaringFile!.id).toBe(fileNodeId);
  });

  it('expands validators and responseContracts from the primary provider', () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, 'POST /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, controllerNodeId, 'symbol', 'InvoiceController@store');
    upsertNode(db, requestNodeId, 'symbol', 'StoreInvoiceRequest');
    upsertNode(db, resourceNodeId, 'symbol', 'InvoiceResource');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${requestNodeId}:validates_with:store`,
      source_node_id: controllerNodeId,
      target_node_id: requestNodeId,
      edge_type: 'validates_with',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${requestNodeId}:validates_with:store`, [
      {
        id: `${controllerNodeId}→${requestNodeId}:validates_with:store:ev:0`,
        edge_id: `${controllerNodeId}→${requestNodeId}:validates_with:store`,
        resolver: 'test',
        evidence_kind: 'php-typed-parameter',
        note: 'request: StoreInvoiceRequest [method:store]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${resourceNodeId}:returns_contract:store`,
      source_node_id: controllerNodeId,
      target_node_id: resourceNodeId,
      edge_type: 'returns_contract',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${resourceNodeId}:returns_contract:store`, [
      {
        id: `${controllerNodeId}→${resourceNodeId}:returns_contract:store:ev:0`,
        edge_id: `${controllerNodeId}→${resourceNodeId}:returns_contract:store`,
        resolver: 'test',
        evidence_kind: 'php-return-constructor',
        note: 'response: InvoiceResource [method:store]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);

    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path!.validators).toHaveLength(1);
    expect(path!.validators[0].id).toBe(requestNodeId);
    expect(path!.responseContracts).toHaveLength(1);
    expect(path!.responseContracts[0].id).toBe(resourceNodeId);
  });

  it('builds a full feature path with all roles populated', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';
    const fileNode = 'file:routes/api.php';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, controllerNodeId, 'symbol', 'InvoiceController@index');
    upsertNode(db, requestNodeId, 'symbol', 'ListInvoicesRequest');
    upsertNode(db, resourceNodeId, 'symbol', 'InvoiceResource');
    upsertNode(db, wrapperNodeId, 'symbol', 'fetchInvoices');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');
    upsertNode(db, fileNode, 'file', 'routes/api.php', 'routes/api.php');

    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${requestNodeId}:validates_with:index`,
      source_node_id: controllerNodeId,
      target_node_id: requestNodeId,
      edge_type: 'validates_with',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${requestNodeId}:validates_with:index`, [
      {
        id: `${controllerNodeId}→${requestNodeId}:validates_with:index:ev:0`,
        edge_id: `${controllerNodeId}→${requestNodeId}:validates_with:index`,
        resolver: 'test',
        evidence_kind: 'php-typed-parameter',
        note: 'request: ListInvoicesRequest [method:index]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${resourceNodeId}:returns_contract:index`,
      source_node_id: controllerNodeId,
      target_node_id: resourceNodeId,
      edge_type: 'returns_contract',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${resourceNodeId}:returns_contract:index`, [
      {
        id: `${controllerNodeId}→${resourceNodeId}:returns_contract:index:ev:0`,
        edge_id: `${controllerNodeId}→${resourceNodeId}:returns_contract:index`,
        resolver: 'test',
        evidence_kind: 'php-return-constructor',
        note: 'response: InvoiceResource [method:index]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);
    upsertEdge(
      db,
      `${wrapperNodeId}→${surfaceId}:calls_surface`,
      'calls_surface',
      wrapperNodeId,
      surfaceId
    );
    upsertEdge(
      db,
      `${artifactNodeId}→${surfaceId}:derived_from`,
      'derived_from',
      artifactNodeId,
      surfaceId
    );
    upsertEdge(
      db,
      `${fileNode}→${surfaceId}:declares_surface`,
      'declares_surface',
      fileNode,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path!.providers).toHaveLength(1);
    expect(path!.consumers).toHaveLength(1);
    expect(path!.validators).toHaveLength(1);
    expect(path!.responseContracts).toHaveLength(1);
    expect(path!.artifacts).toHaveLength(1);
    expect(path!.declaringFile).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getFeaturePathsForFile()
// ---------------------------------------------------------------------------

describe('getFeaturePathsForFile()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns paths for all surfaces with matching file_path', () => {
    upsertSurface(
      db,
      'surface:http:GET:/api/invoices',
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php'
    );
    upsertSurface(
      db,
      'surface:http:POST:/api/invoices',
      'POST /api/invoices',
      '/api/invoices',
      'routes/api.php'
    );
    upsertSurface(
      db,
      'surface:http:GET:/api/users',
      'GET /api/users',
      '/api/users',
      'routes/web.php'
    );

    const paths = getFeaturePathsForFile(db, 'routes/api.php');
    expect(paths).toHaveLength(2);
    const ids = paths.map((p) => p.surface.id);
    expect(ids).toContain('surface:http:GET:/api/invoices');
    expect(ids).toContain('surface:http:POST:/api/invoices');
  });

  it('returns empty array when no surfaces match the file', () => {
    const paths = getFeaturePathsForFile(db, 'routes/nonexistent.php');
    expect(paths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatFeaturePath()
// ---------------------------------------------------------------------------

describe('formatFeaturePath()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('produces a compact path with consumer → surface → provider → contract tokens', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, controllerNodeId, 'symbol', 'InvoiceController@index');
    upsertNode(db, resourceNodeId, 'symbol', 'InvoiceResource');
    upsertNode(db, wrapperNodeId, 'symbol', 'fetchInvoices');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${resourceNodeId}:returns_contract:index`,
      source_node_id: controllerNodeId,
      target_node_id: resourceNodeId,
      edge_type: 'returns_contract',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${resourceNodeId}:returns_contract:index`, [
      {
        id: `${controllerNodeId}→${resourceNodeId}:returns_contract:index:ev:0`,
        edge_id: `${controllerNodeId}→${resourceNodeId}:returns_contract:index`,
        resolver: 'test',
        evidence_kind: 'php-return-constructor',
        note: 'response: InvoiceResource [method:index]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);
    upsertEdge(
      db,
      `${wrapperNodeId}→${surfaceId}:calls_surface`,
      'calls_surface',
      wrapperNodeId,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const formatted = formatFeaturePath(path);

    expect(formatted).toContain('fetchInvoices');
    expect(formatted).toContain('GET /api/invoices');
    expect(formatted).toContain('InvoiceController@index');
    expect(formatted).toContain('InvoiceResource');
    expect(formatted).toContain('→');
  });

  it('handles surface-only path (no edges) gracefully', () => {
    upsertSurface(
      db,
      'surface:http:GET:/api/health',
      'GET /api/health',
      '/api/health',
      'routes/api.php'
    );

    const path = getSurfaceFeaturePath(db, 'surface:http:GET:/api/health')!;
    const formatted = formatFeaturePath(path);

    expect(formatted).toContain('GET /api/health');
    expect(formatted).not.toContain('→');
  });

  it('limits consumers to 2 with overflow token', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');

    for (let i = 0; i < 3; i++) {
      const wid = `symbol:ts:src/api/${i}.ts#fn${i}`;
      upsertNode(db, wid, 'symbol', `fn${i}`);
      upsertEdge(db, `${wid}→${surfaceId}:calls_surface:${i}`, 'calls_surface', wid, surfaceId);
    }

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const formatted = formatFeaturePath(path);
    expect(formatted).toContain('+1 more');
  });

  // Phase 5 — prefer proven consumers over candidate noise

  it('prefers provenConsumers (confidence >= 0.75) over low-confidence consumers in compact path', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const provenId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';
    const candidateId = 'symbol:ts:src/utils/links.ts#invoiceLink';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, provenId, 'symbol', 'fetchInvoices');
    upsertNode(db, candidateId, 'symbol', 'invoiceLink');

    // proven consumer: high confidence
    db.upsertStructuralEdge({
      id: `${provenId}→${surfaceId}:calls_surface`,
      source_node_id: provenId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.75,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'transport-proven',
      updated_at: Math.floor(Date.now() / 1000),
    });
    // candidate consumer: low confidence
    db.upsertStructuralEdge({
      id: `${candidateId}→${surfaceId}:calls_surface`,
      source_node_id: candidateId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.4,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'candidate-only',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    expect(path.consumers).toHaveLength(2);
    expect(path.provenConsumers).toHaveLength(1);
    expect(path.provenConsumers[0].id).toBe(provenId);

    // Compact path should show proven consumer, not the candidate
    const formatted = formatFeaturePath(path);
    expect(formatted).toContain('fetchInvoices');
    expect(formatted).not.toContain('invoiceLink');
  });

  it('falls back to all consumers when no proven consumers exist', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const candidateId = 'symbol:ts:src/utils/links.ts#invoiceLink';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, candidateId, 'symbol', 'invoiceLink');

    db.upsertStructuralEdge({
      id: `${candidateId}→${surfaceId}:calls_surface`,
      source_node_id: candidateId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.4,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'candidate-only',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    expect(path.provenConsumers).toHaveLength(0);

    // Falls back to showing candidate when no proven ones exist
    const formatted = formatFeaturePath(path);
    expect(formatted).toContain('invoiceLink');
  });
});

// ---------------------------------------------------------------------------
// formatFeaturePathBlock()
// ---------------------------------------------------------------------------

describe('formatFeaturePathBlock()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('includes surface handle, provider, validator, and contract in block output', () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';
    const fileNodeId = 'file:routes/api.php';

    upsertSurface(
      db,
      surfaceId,
      'POST /api/invoices',
      '/api/invoices',
      'routes/api.php',
      'invoices.store'
    );
    upsertNode(db, controllerNodeId, 'symbol', 'InvoiceController@store');
    upsertNode(db, requestNodeId, 'symbol', 'StoreInvoiceRequest');
    upsertNode(db, resourceNodeId, 'symbol', 'InvoiceResource');
    upsertNode(db, fileNodeId, 'file', 'routes/api.php', 'routes/api.php');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${requestNodeId}:validates_with:store`,
      source_node_id: controllerNodeId,
      target_node_id: requestNodeId,
      edge_type: 'validates_with',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${requestNodeId}:validates_with:store`, [
      {
        id: `${controllerNodeId}→${requestNodeId}:validates_with:store:ev:0`,
        edge_id: `${controllerNodeId}→${requestNodeId}:validates_with:store`,
        resolver: 'test',
        evidence_kind: 'php-typed-parameter',
        note: 'request: StoreInvoiceRequest [method:store]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);
    db.upsertStructuralEdge({
      id: `${controllerNodeId}→${resourceNodeId}:returns_contract:store`,
      source_node_id: controllerNodeId,
      target_node_id: resourceNodeId,
      edge_type: 'returns_contract',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${controllerNodeId}→${resourceNodeId}:returns_contract:store`, [
      {
        id: `${controllerNodeId}→${resourceNodeId}:returns_contract:store:ev:0`,
        edge_id: `${controllerNodeId}→${resourceNodeId}:returns_contract:store`,
        resolver: 'test',
        evidence_kind: 'php-return-constructor',
        note: 'response: InvoiceResource [method:store]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);
    upsertEdge(
      db,
      `${fileNodeId}→${surfaceId}:declares_surface`,
      'declares_surface',
      fileNodeId,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const block = formatFeaturePathBlock(path);

    expect(block).toContain('POST /api/invoices');
    expect(block).toContain('invoices.store');
    expect(block).toContain('InvoiceController@store');
    expect(block).toContain('StoreInvoiceRequest');
    expect(block).toContain('InvoiceResource');
    expect(block).toContain('routes/api.php');
    expect(block).toContain('Path:');
  });

  it('filters provider-side validator edges by surface controllerMethod when provider is shared', () => {
    const surfaceId = 'surface:http:POST:/event_messages';
    const providerId = 'symbol:php:App\\Http\\Controllers\\EventMessageController';
    const storeRequestId = 'symbol:php:App\\Http\\Requests\\StoreEventMessageRequest';
    const indexRequestId = 'symbol:php:App\\Http\\Requests\\IndexEventMessageRequest';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /event_messages',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/event_messages',
        controllerMethod: 'store',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, providerId, 'symbol', 'EventMessageController');
    upsertNode(db, storeRequestId, 'symbol', 'StoreEventMessageRequest');
    upsertNode(db, indexRequestId, 'symbol', 'IndexEventMessageRequest');
    upsertEdge(db, `${surfaceId}→${providerId}:handled_by`, 'handled_by', surfaceId, providerId);

    db.upsertStructuralEdge({
      id: `${providerId}→${storeRequestId}:validates_with:store`,
      source_node_id: providerId,
      target_node_id: storeRequestId,
      edge_type: 'validates_with',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${providerId}→${storeRequestId}:validates_with:store`, [
      {
        id: `${providerId}→${storeRequestId}:validates_with:store:ev:0`,
        edge_id: `${providerId}→${storeRequestId}:validates_with:store`,
        resolver: 'test',
        evidence_kind: 'php-typed-parameter',
        note: 'request: App\\Http\\Requests\\StoreEventMessageRequest [method:store]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);

    db.upsertStructuralEdge({
      id: `${providerId}→${indexRequestId}:validates_with:index`,
      source_node_id: providerId,
      target_node_id: indexRequestId,
      edge_type: 'validates_with',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.replaceEdgeEvidence(`${providerId}→${indexRequestId}:validates_with:index`, [
      {
        id: `${providerId}→${indexRequestId}:validates_with:index:ev:0`,
        edge_id: `${providerId}→${indexRequestId}:validates_with:index`,
        resolver: 'test',
        evidence_kind: 'php-typed-parameter',
        note: 'request: App\\Http\\Requests\\IndexEventMessageRequest [method:index]',
        recorded_at: Math.floor(Date.now() / 1000),
      },
    ]);

    const featurePath = getSurfaceFeaturePath(db, surfaceId)!;
    expect(featurePath.validators.map((v) => v.id)).toEqual([storeRequestId]);
  });

  // Phase 5 — auditability: block formatter labels low-confidence consumers as "(candidate)"

  it('labels low-confidence consumers as "(candidate)" in block output', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const provenId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';
    const candidateId = 'symbol:ts:src/utils/links.ts#invoiceLink';

    upsertSurface(db, surfaceId, 'GET /api/invoices', '/api/invoices', 'routes/api.php');
    upsertNode(db, provenId, 'symbol', 'fetchInvoices');
    upsertNode(db, candidateId, 'symbol', 'invoiceLink');

    db.upsertStructuralEdge({
      id: `${provenId}→${surfaceId}:calls_surface`,
      source_node_id: provenId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.75,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'transport-proven',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralEdge({
      id: `${candidateId}→${surfaceId}:calls_surface`,
      source_node_id: candidateId,
      target_node_id: surfaceId,
      edge_type: 'calls_surface',
      confidence: 0.4,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'candidate-only',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const block = formatFeaturePathBlock(path);

    // Proven consumer appears without annotation
    expect(block).toContain('fetchInvoices');
    // Candidate consumer is labeled
    expect(block).toContain('invoiceLink (candidate)');
  });
});

// ---------------------------------------------------------------------------
// formatFileFeaturePathBlock()
// ---------------------------------------------------------------------------

describe('formatFileFeaturePathBlock()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when no surfaces are associated with the file', () => {
    const result = formatFileFeaturePathBlock(db, 'routes/api.php');
    expect(result).toBeNull();
  });

  it('returns a block containing all surfaces for the file', () => {
    upsertSurface(
      db,
      'surface:http:GET:/api/invoices',
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php'
    );
    upsertSurface(
      db,
      'surface:http:POST:/api/invoices',
      'POST /api/invoices',
      '/api/invoices',
      'routes/api.php'
    );

    const block = formatFileFeaturePathBlock(db, 'routes/api.php');
    expect(block).not.toBeNull();
    expect(block).toContain('GET /api/invoices');
    expect(block).toContain('POST /api/invoices');
  });
});

// ---------------------------------------------------------------------------
// Closure-backed surface rendering
// ---------------------------------------------------------------------------
//
// Closure-backed routes (providerKind === 'closure') never emit a `handled_by`
// edge — the route body is an inline anonymous function with no named provider.
// Retrieval must distinguish them from controller-backed surfaces whose
// provider resolution failed, so formatters branch on the metadata instead of
// treating an empty `providers[]` as an unresolved miss in both cases.

/**
 * Upsert a capability-surface node with an explicit providerKind annotation.
 * Mirrors what the detector persists for closure- vs controller-backed routes.
 */
function upsertSurfaceWithKind(
  db: LuxDatabase,
  id: string,
  handle: string,
  path: string,
  filePath: string,
  providerKind: 'controller' | 'closure'
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'capability-surface',
    symbol_name: handle,
    language_id: 'http',
    file_path: filePath,
    metadata: JSON.stringify({
      transport: 'http',
      method: handle.split(' ')[0],
      path,
      providerKind,
    }),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

describe('getSurfaceFeaturePath() — providerKind propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('propagates providerKind=closure and sets isClosureBacked=true', () => {
    const surfaceId = 'surface:http:GET:/health';
    upsertSurfaceWithKind(db, surfaceId, 'GET /health', '/health', 'routes/api.php', 'closure');

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    expect(path.providerKind).toBe('closure');
    expect(path.isClosureBacked).toBe(true);
  });

  it('propagates providerKind=controller and sets isClosureBacked=false', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    upsertSurfaceWithKind(
      db,
      surfaceId,
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php',
      'controller'
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    expect(path.providerKind).toBe('controller');
    expect(path.isClosureBacked).toBe(false);
  });

  it('leaves providerKind undefined for legacy surfaces without the annotation', () => {
    // upsertSurface() does not set providerKind — mirrors pre-tranche detector output.
    upsertSurface(db, 'surface:http:GET:/legacy', 'GET /legacy', '/legacy', 'routes/api.php');

    const path = getSurfaceFeaturePath(db, 'surface:http:GET:/legacy')!;
    expect(path.providerKind).toBeUndefined();
    expect(path.isClosureBacked).toBe(false);
  });
});

describe('formatFeaturePath() — closure-backed surfaces', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits the closure-handler token in the provider slot for a closure-backed surface', () => {
    const surfaceId = 'surface:http:GET:/health';
    upsertSurfaceWithKind(db, surfaceId, 'GET /health', '/health', 'routes/api.php', 'closure');

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const formatted = formatFeaturePath(path);

    // Surface renders as first-class handled, with arrow separation — not a
    // silent drop that would conflate it with an unresolved miss.
    expect(formatted).toBe(`GET /health → ${CLOSURE_HANDLER_TOKEN}`);
  });

  it('renders consumer → surface → closure-handler for a closure-backed surface with a proven consumer', () => {
    const surfaceId = 'surface:http:GET:/health';
    const consumerId = 'symbol:ts:src/monitor.ts#pingHealth';

    upsertSurfaceWithKind(db, surfaceId, 'GET /health', '/health', 'routes/api.php', 'closure');
    upsertNode(db, consumerId, 'symbol', 'pingHealth');
    upsertEdge(
      db,
      `${consumerId}→${surfaceId}:calls_surface`,
      'calls_surface',
      consumerId,
      surfaceId
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const formatted = formatFeaturePath(path);

    expect(formatted).toBe(`pingHealth → GET /health → ${CLOSURE_HANDLER_TOKEN}`);
  });

  it('does NOT fabricate closure-handler for controller-backed surfaces whose provider is unresolved', () => {
    // Controller-backed surface where the `handled_by` edge never resolved in the
    // DB (provider miss). The formatter must keep the provider slot empty so the
    // signal of "truly missing" is preserved — we only synthesize a handler
    // token when the detector classified the surface as closure-backed.
    const surfaceId = 'surface:http:GET:/api/invoices';
    upsertSurfaceWithKind(
      db,
      surfaceId,
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php',
      'controller'
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const formatted = formatFeaturePath(path);

    expect(formatted).toBe('GET /api/invoices');
    expect(formatted).not.toContain(CLOSURE_HANDLER_TOKEN);
  });

  it('keeps controller-backed rendering unchanged when a provider is resolved', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';

    upsertSurfaceWithKind(
      db,
      surfaceId,
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php',
      'controller'
    );
    upsertNode(db, controllerNodeId, 'symbol', 'InvoiceController@index');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const formatted = formatFeaturePath(path);

    expect(formatted).toContain('InvoiceController@index');
    expect(formatted).not.toContain(CLOSURE_HANDLER_TOKEN);
  });
});

describe('formatFeaturePathBlock() — closure-backed surfaces', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('renders a "Handler: closure (inline)" line for closure-backed surfaces', () => {
    const surfaceId = 'surface:http:GET:/health';
    upsertSurfaceWithKind(db, surfaceId, 'GET /health', '/health', 'routes/api.php', 'closure');

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const block = formatFeaturePathBlock(path);

    expect(block).toContain('Surface: GET /health');
    expect(block).toContain('Handler: closure (inline)');
    // Closure-backed surfaces must not emit a Provider(s) line — that label is
    // reserved for resolved controller nodes so readers can distinguish the two.
    expect(block).not.toContain('Provider(s):');
    // Compact Path: line also surfaces the closure-handler token.
    expect(block).toContain(`Path: GET /health → ${CLOSURE_HANDLER_TOKEN}`);
  });

  it('does NOT emit a Handler line for controller-backed surfaces with unresolved providers', () => {
    // An unresolved controller-backed surface stays silent in the block — the
    // absence of Provider(s) is itself a meaningful signal of the miss.
    const surfaceId = 'surface:http:GET:/api/invoices';
    upsertSurfaceWithKind(
      db,
      surfaceId,
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php',
      'controller'
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const block = formatFeaturePathBlock(path);

    expect(block).not.toContain('Handler:');
    expect(block).not.toContain('Provider(s):');
  });

  it('keeps controller-backed block output unchanged when a provider is resolved', () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';

    upsertSurfaceWithKind(
      db,
      surfaceId,
      'GET /api/invoices',
      '/api/invoices',
      'routes/api.php',
      'controller'
    );
    upsertNode(db, controllerNodeId, 'symbol', 'InvoiceController@index');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const path = getSurfaceFeaturePath(db, surfaceId)!;
    const block = formatFeaturePathBlock(path);

    expect(block).toContain('Provider(s): InvoiceController@index');
    expect(block).not.toContain('Handler:');
  });
});
