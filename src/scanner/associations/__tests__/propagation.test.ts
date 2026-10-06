// Tests for symbolic propagation passes (provider, consumer, artifact).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { propagateSurfaces } from '../propagation.js';
import type { AssociationContext } from '../types.js';
import type { StructuralNode, StructuralEdge } from '../../../db/types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-propagation-test-'));
const ROOT = '/app';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function makeContext(
  entries: Array<{ filePath: string; languageId?: string; content?: string; lsp?: unknown }>
): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((e) => ({
      filePath: e.filePath,
      languageId: e.languageId,
      metadata: {
        ...(e.content ? { content: e.content } : {}),
        ...(e.lsp ? { lsp: e.lsp } : {}),
      },
    })),
    dirtyFiles: [],
  };
}

function upsertNode(
  db: LuxDatabase,
  id: string,
  nodeType: StructuralNode['node_type'],
  filePath?: string
): void {
  db.upsertStructuralNode({
    id,
    node_type: nodeType,
    symbol_name: id,
    language_id: 'php',
    file_path: filePath,
    metadata: '{}',
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
    confidence: 0.95,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: 'test',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertSurface(
  db: LuxDatabase,
  surfaceId: string,
  path: string,
  controllerNodeId?: string
): void {
  db.upsertStructuralNode({
    id: surfaceId,
    node_type: 'capability-surface',
    symbol_name: `GET ${path}`,
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ transport: 'http', method: 'GET', path }),
    updated_at: Math.floor(Date.now() / 1000),
  });

  if (controllerNodeId) {
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
  }
}

// ---------------------------------------------------------------------------
// propagateSurfaces — early exit
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — no surfaces', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns zero counts when no surfaces exist', async () => {
    const ctx = makeContext([]);
    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
    expect(result.consumerEdgesAdded).toBe(0);
    expect(result.artifactEdgesAdded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider propagation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — provider propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits validates_with edge when controller file has FormRequest sibling in LSP hierarchy', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');

    const lspData = {
      typeHierarchy: [{ name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] }],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    // Provider edges go from controllerNode → siblingNode (not from surface)
    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const edgeTypes = controllerEdges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('validates_with');
  });

  it('emits returns_contract edge when controller file has JsonResource sibling', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const lspData = {
      typeHierarchy: [{ name: 'InvoiceResource', supertypes: [{ name: 'JsonResource' }] }],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const edgeTypes = controllerEdges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('returns_contract');
  });

  it('emits both validates_with and returns_contract when both sibling types present', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const lspData = {
      typeHierarchy: [
        { name: 'StoreInvoiceRequest', supertypes: [{ name: 'FormRequest' }] },
        { name: 'InvoiceResource', supertypes: [{ name: 'JsonResource' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(2);
  });

  it('skips propagation when controller node does not exist in DB', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    // Surface has handled_by edge pointing to a controller node that was never persisted
    upsertSurface(db, surfaceId, '/api/users', 'symbol:php:UserController@index');
    // Note: UserController@index is NOT inserted into DB

    const ctx = makeContext([]);
    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  it('skips propagation when controller node has no file_path', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    const controllerNodeId = 'symbol:php:UserController@index';

    upsertSurface(db, surfaceId, '/api/users', controllerNodeId);
    // Controller node without file_path
    db.upsertStructuralNode({
      id: controllerNodeId,
      node_type: 'symbol',
      symbol_name: 'UserController',
      language_id: 'php',
      file_path: undefined,
      metadata: '{}',
      updated_at: Math.floor(Date.now() / 1000),
    });

    const ctx = makeContext([]);
    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  it('skips sibling symbols that do not exist in DB', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    // requestNodeId is NOT inserted into DB

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');

    const lspData = {
      typeHierarchy: [{ name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] }],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(0);
  });

  // Patch A — class-level provider node resolution

  it('resolves class-level handled_by target (Patch A: materializer compatibility)', async () => {
    // The detector emits handled_by to a class-level controller node, with the
    // controller method preserved in surface metadata.
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:App\\Http\\Controllers\\InvoiceController';
    const requestNodeId = 'symbol:php:App\\Http\\Requests\\ListInvoicesRequest';

    // Surface with controllerMethod in metadata (as detector now emits)
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/invoices',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/api/invoices',
        explicitProvider: 'App\\Http\\Controllers\\InvoiceController',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');

    const phpContent = [
      '<?php',
      'namespace App\\Http\\Controllers;',
      'use App\\Http\\Requests\\ListInvoicesRequest;',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(ListInvoicesRequest $request)',
      '    {',
      '        return response()->json(Invoice::all());',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(edges.some((e) => e.edge.edge_type === 'validates_with')).toBe(true);
  });

  it('is idempotent — re-running does not duplicate provider edges', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');

    const lspData = {
      typeHierarchy: [{ name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] }],
    };
    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', lsp: lspData },
    ]);

    await propagateSurfaces(db, ctx);
    await propagateSurfaces(db, ctx); // second run

    // Provider edges are on the controller node, not the surface
    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const validateEdges = controllerEdges.filter((e) => e.edge.edge_type === 'validates_with');
    expect(validateEdges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provider propagation — Phase 3 handler-centered expansion (PHP content path)
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — provider propagation (PHP content analysis)', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits validates_with via typed method parameter when no LSP data present', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');

    const phpContent = [
      '<?php',
      'namespace App\\Http\\Controllers;',
      '',
      'class InvoiceController extends Controller',
      '{',
      '    public function store(StoreInvoiceRequest $request): JsonResponse',
      '    {',
      '        $invoice = Invoice::create($request->validated());',
      "        return response()->json(['id' => $invoice->id], 201);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
        // no lsp data
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(2);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'validates_with')).toBe(true);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });

  it('emits returns_contract via new XResource() in method body', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(): JsonResponse',
      '    {',
      '        $invoice = Invoice::findOrFail(1);',
      '        return new InvoiceResource($invoice);',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });

  it('emits returns_contract via XResource::collection() static factory', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');

    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(): JsonResponse',
      '    {',
      '        return InvoiceResource::collection(Invoice::paginate());',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(edges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });

  it('resolves qualified name via use import and falls back to short name for DB lookup', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    // Node stored with short name (as many indexers produce)
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');

    const phpContent = [
      '<?php',
      'use App\\Http\\Requests\\StoreInvoiceRequest;',
      '',
      'class InvoiceController extends Controller',
      '{',
      '    public function store(StoreInvoiceRequest $request): JsonResponse',
      '    {',
      '        Invoice::create($request->validated());',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    // Coarse inference adds empty-ack (implicit-fallthrough) for the side-effecting
    // method with no explicit return — 1 explicit FormRequest + 1 coarse empty-ack.
    expect(result.providerEdgesAdded).toBe(2);

    // The explicit FormRequest validates_with edge must still be present
    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(
      edges.some(
        (e) => e.edge.edge_type === 'validates_with' && e.edge.target_node_id === requestNodeId
      )
    ).toBe(true);
  });

  it('does NOT emit validates_with for bare Request base class', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');

    // No FormRequest node, only uses base Request
    const phpContent = [
      '<?php',
      'use Illuminate\\Http\\Request;',
      '',
      'class InvoiceController extends Controller',
      '{',
      '    public function index(Request $request): JsonResponse',
      '    {',
      "        return response()->json(['data' => []]);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);

    const controllerEdges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'validates_with')).toBe(false);
    expect(controllerEdges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
  });

  it('combines LSP and PHP content analysis — emits both edges when each source finds a different symbol', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol');
    upsertNode(db, resourceNodeId, 'symbol');

    // PHP content finds the request param; LSP finds the resource type
    // for a sibling method, so without method-scoped preference this would smear.
    const phpContent = [
      '<?php',
      'class InvoiceController extends Controller',
      '{',
      '    public function store(StoreInvoiceRequest $request): JsonResponse',
      '    {',
      '        return response()->json(["ok" => true]);',
      '    }',
      '',
      '    public function index(): JsonResponse',
      '    {',
      '        return new InvoiceResource(Invoice::first());',
      '    }',
      '}',
    ].join('\n');

    const lspData = {
      typeHierarchy: [{ name: 'InvoiceResource', supertypes: [{ name: 'JsonResource' }] }],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(2);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    expect(edges.some((e) => e.edge.edge_type === 'validates_with')).toBe(true);
    expect(edges.some((e) => e.edge.edge_type === 'returns_contract')).toBe(true);
    expect(edges.some((e) => e.edge.target_node_id.includes('inline-json-response'))).toBe(true);
  });

  it('prefers method-scoped PHP evidence over broad LSP hierarchy on shared controllers', async () => {
    const indexSurfaceId = 'surface:http:GET:/event/{event}/messages';
    const storeSurfaceId = 'surface:http:POST:/event_messages';
    const providerId = 'symbol:php:EventMessageController';
    const indexRequestId = 'symbol:php:IndexEventMessageRequest';
    const storeRequestId = 'symbol:php:StoreEventMessageRequest';

    db.upsertStructuralNode({
      id: indexSurfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /event/{event}/messages',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/event/{event}/messages',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralNode({
      id: storeSurfaceId,
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
    upsertNode(db, providerId, 'symbol', 'app/Http/Controllers/EventMessageController.php');
    upsertNode(db, indexRequestId, 'symbol', 'app/Http/Requests/IndexEventMessageRequest.php');
    upsertNode(db, storeRequestId, 'symbol', 'app/Http/Requests/StoreEventMessageRequest.php');
    upsertEdge(
      db,
      `${indexSurfaceId}→${providerId}:handled_by`,
      'handled_by',
      indexSurfaceId,
      providerId
    );
    upsertEdge(
      db,
      `${storeSurfaceId}→${providerId}:handled_by`,
      'handled_by',
      storeSurfaceId,
      providerId
    );

    const phpContent = [
      '<?php',
      'class EventMessageController extends Controller',
      '{',
      '    public function index(IndexEventMessageRequest $request, $eventId)',
      '    {',
      '        return response()->json([]);',
      '    }',
      '',
      '    public function store(StoreEventMessageRequest $request)',
      '    {',
      '        return response()->json(["ok" => true]);',
      '    }',
      '}',
    ].join('\n');

    const lspData = {
      typeHierarchy: [
        { name: 'IndexEventMessageRequest', supertypes: [{ name: 'FormRequest' }] },
        { name: 'StoreEventMessageRequest', supertypes: [{ name: 'FormRequest' }] },
      ],
    };

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/EventMessageController.php',
        languageId: 'php',
        content: phpContent,
        lsp: lspData,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(4);

    const edges = db.getRelatedEdgesWithEvidence(providerId);
    const validateTargets = edges
      .filter((e) => e.edge.edge_type === 'validates_with')
      .map((e) => e.edge.target_node_id)
      .sort();
    expect(validateTargets).toEqual([indexRequestId, storeRequestId].sort());
    expect(
      edges.some((e) => e.edge.id.includes(':index') && e.edge.target_node_id === indexRequestId)
    ).toBe(true);
    expect(
      edges.some((e) => e.edge.id.includes(':store') && e.edge.target_node_id === storeRequestId)
    ).toBe(true);
    expect(
      edges.some(
        (e) =>
          e.edge.id.includes(':index') && e.edge.target_node_id.includes('inline-json-response')
      )
    ).toBe(true);
    expect(
      edges.some(
        (e) =>
          e.edge.id.includes(':store') && e.edge.target_node_id.includes('inline-json-response')
      )
    ).toBe(true);
  });

  it('keeps response resources method-scoped on shared controllers', async () => {
    const indexSurfaceId = 'surface:http:GET:/api/settlements';
    const showSurfaceId = 'surface:http:GET:/api/settlements/{settlement}';
    const providerId = 'symbol:php:SettlementController';
    const indexResourceId = 'symbol:php:SettlementIndexResource';
    const showResourceId = 'symbol:php:SettlementShowResource';

    db.upsertStructuralNode({
      id: indexSurfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/settlements',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/api/settlements',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralNode({
      id: showSurfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/settlements/{settlement}',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/api/settlements/{settlement}',
        controllerMethod: 'show',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, providerId, 'symbol', 'app/Http/Controllers/SettlementController.php');
    upsertNode(db, indexResourceId, 'symbol', 'app/Http/Resources/SettlementIndexResource.php');
    upsertNode(db, showResourceId, 'symbol', 'app/Http/Resources/SettlementShowResource.php');
    upsertEdge(
      db,
      `${indexSurfaceId}→${providerId}:handled_by`,
      'handled_by',
      indexSurfaceId,
      providerId
    );
    upsertEdge(
      db,
      `${showSurfaceId}→${providerId}:handled_by`,
      'handled_by',
      showSurfaceId,
      providerId
    );

    const phpContent = [
      '<?php',
      'use App\\Http\\Resources\\SettlementIndexResource;',
      'use App\\Http\\Resources\\SettlementShowResource;',
      'class SettlementController extends Controller',
      '{',
      '    public function index(Request $request): JsonResponse',
      '    {',
      '        return response()->json([',
      "            'data' => SettlementIndexResource::collection($settlements),",
      '        ]);',
      '    }',
      '',
      '    public function show(Settlement $settlement): JsonResponse',
      '    {',
      '        return response()->json([',
      "            'data' => new SettlementShowResource($settlement),",
      '        ]);',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/SettlementController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    // Coarse inference now also emits a route-bound-input validates_with for the
    // `show(Settlement $settlement)` typed parameter — total edges is 3.
    expect(result.providerEdgesAdded).toBe(3);

    const edges = db
      .getRelatedEdgesWithEvidence(providerId)
      .filter((e) => e.edge.edge_type === 'returns_contract');

    expect(
      edges.some((e) => e.edge.id.includes(':index') && e.edge.target_node_id === indexResourceId)
    ).toBe(true);
    expect(
      edges.some((e) => e.edge.id.includes(':index') && e.edge.target_node_id === showResourceId)
    ).toBe(false);
    expect(
      edges.some((e) => e.edge.id.includes(':show') && e.edge.target_node_id === showResourceId)
    ).toBe(true);
    expect(
      edges.some((e) => e.edge.id.includes(':show') && e.edge.target_node_id === indexResourceId)
    ).toBe(false);
  });

  it('emits a synthetic validates_with contract for inline $request->validate() when no FormRequest exists', async () => {
    const surfaceId = 'surface:http:PUT:/admin/update_sale_order';
    const providerId = 'symbol:php:ListingController';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'PUT /admin/update_sale_order',
      language_id: 'http',
      file_path: 'routes/admin.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'PUT',
        path: '/admin/update_sale_order',
        controllerMethod: 'updateSaleOrder',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, providerId, 'symbol', 'app/Http/Controllers/ListingController.php');
    upsertEdge(db, `${surfaceId}→${providerId}:handled_by`, 'handled_by', surfaceId, providerId);

    const phpContent = [
      '<?php',
      'class ListingController extends Controller',
      '{',
      '    public function updateSaleOrder(Request $request)',
      '    {',
      '        $validated = $request->validate([',
      "            'sale_order' => 'required|array',",
      "            'event_id' => 'required|integer',",
      '        ]);',
      "        return response('ok', 200);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/ListingController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    // Coarse inference also emits a scalar-response returns_contract for
    // `return response('ok', 200)` — total edges is 2.
    expect(result.providerEdgesAdded).toBe(2);

    const syntheticId =
      'contract:php:app/Http/Controllers/ListingController.php#updateSaleOrder:inline-validator';
    const syntheticNode = db.getStructuralNode(syntheticId);
    expect(syntheticNode).toBeDefined();
    expect(syntheticNode?.node_type).toBe('contract');

    const edges = db
      .getRelatedEdgesWithEvidence(providerId)
      .filter((e) => e.edge.edge_type === 'validates_with');
    expect(
      edges.some(
        (e) => e.edge.id.includes(':updateSaleOrder') && e.edge.target_node_id === syntheticId
      )
    ).toBe(true);
  });

  it('emits a synthetic validates_with contract for inline validator() helper usage when no FormRequest exists', async () => {
    const surfaceId = 'surface:http:POST:/api/events/registration-settings/{event}';
    const providerId = 'symbol:php:UpdateEventRegistrationSettingsController';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /api/events/registration-settings/{event}',
      language_id: 'http',
      file_path: 'src/Module/BidRegistration/RouteServiceProvider.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/api/events/registration-settings/{event}',
        controllerMethod: '__invoke',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(
      db,
      providerId,
      'symbol',
      'src/Module/BidRegistration/Http/Controllers/UpdateEventRegistrationSettingsController.php'
    );
    upsertEdge(db, `${surfaceId}→${providerId}:handled_by`, 'handled_by', surfaceId, providerId);

    const phpContent = [
      '<?php',
      'class UpdateEventRegistrationSettingsController extends Controller',
      '{',
      '    public function __invoke(Request $request, $event): JsonResponse',
      '    {',
      '        $validated = validator($request->all(), [',
      "            'approval_type' => ['required', 'string'],",
      "            'require_drivers_license' => ['boolean'],",
      '        ]);',
      '        if ($validated->fails()) {',
      "            return response()->json(['success' => false], 422);",
      '        }',
      "        return response()->json(['success' => true]);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath:
          'src/Module/BidRegistration/Http/Controllers/UpdateEventRegistrationSettingsController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(2);

    const syntheticId =
      'contract:php:src/Module/BidRegistration/Http/Controllers/UpdateEventRegistrationSettingsController.php#__invoke:inline-validator';
    const syntheticNode = db.getStructuralNode(syntheticId);
    expect(syntheticNode).toBeDefined();
    expect(syntheticNode?.node_type).toBe('contract');

    const edges = db
      .getRelatedEdgesWithEvidence(providerId)
      .filter((e) => e.edge.edge_type === 'validates_with');
    expect(
      edges.some((e) => e.edge.id.includes(':__invoke') && e.edge.target_node_id === syntheticId)
    ).toBe(true);
  });

  it('emits a synthetic returns_contract node for inline response()->json payloads when no resource exists', async () => {
    const surfaceId = 'surface:http:GET:/api/listings/{listing}';
    const providerId = 'symbol:php:QuickAdminListingController';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/listings/{listing}',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/api/listings/{listing}',
        controllerMethod: 'show',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, providerId, 'symbol', 'app/Http/Controllers/QuickAdminListingController.php');
    upsertEdge(db, `${surfaceId}→${providerId}:handled_by`, 'handled_by', surfaceId, providerId);

    const phpContent = [
      '<?php',
      'class QuickAdminListingController extends Controller',
      '{',
      '    public function show(Listing $listing, Request $request)',
      '    {',
      '        $listingArray = [];',
      "        $listingArray['id'] = $listing->id;",
      '        return response()->json($listingArray);',
      '    }',
      '',
      '    public function create(StoreListingRequest $request)',
      '    {',
      "        return response()->json(['ok' => true], 201);",
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/QuickAdminListingController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    // Coarse inference also emits a route-bound-input validates_with for
    // `Listing $listing` typed param — total edges is 2.
    expect(result.providerEdgesAdded).toBe(2);

    const syntheticId =
      'contract:php:app/Http/Controllers/QuickAdminListingController.php#show:inline-json-response';
    const syntheticNode = db.getStructuralNode(syntheticId);
    expect(syntheticNode).toBeDefined();
    expect(syntheticNode?.node_type).toBe('contract');

    const edges = db
      .getRelatedEdgesWithEvidence(providerId)
      .filter((e) => e.edge.edge_type === 'returns_contract');
    expect(
      edges.some((e) => e.edge.id.includes(':show') && e.edge.target_node_id === syntheticId)
    ).toBe(true);
    expect(edges.some((e) => e.edge.id.includes(':show') && e.edge.id.includes(':create'))).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Consumer propagation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — consumer propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits calls_surface edge when TS wrapper function references surface path', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = [
      "import axios from 'axios';",
      '',
      'export async function fetchInvoices(params: InvoiceParams) {',
      "  return axios.get('/api/invoices', { params });",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const edgeTypes = ctx2!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('calls_surface');
  });

  it('emits calls_surface for arrow function export referencing path', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    const wrapperNodeId = 'symbol:ts:src/api/users.ts#getUsers';

    upsertSurface(db, surfaceId, '/api/users');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/users.ts');

    const tsContent = [
      'export const getUsers = async (page: number) => {',
      "  const response = await fetch('/api/users?page=' + page);",
      '  return response.json();',
      '};',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/users.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);
  });

  it('does NOT emit calls_surface when TS file references path but wrapper node absent from DB', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    // wrapperNodeId NOT in DB

    upsertSurface(db, surfaceId, '/api/invoices');

    const tsContent = [
      'export async function fetchInvoices() {',
      "  return fetch('/api/invoices');",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('does NOT emit calls_surface when surface has no path in metadata', async () => {
    // Surface with no path (malformed metadata)
    db.upsertStructuralNode({
      id: 'surface:http:unknown',
      node_type: 'capability-surface',
      symbol_name: 'unknown',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ transport: 'http' }), // no path
      updated_at: Math.floor(Date.now() / 1000),
    });

    const ctx = makeContext([
      { filePath: 'src/api/foo.ts', languageId: 'typescript', content: 'export function foo() {}' },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('is idempotent — re-running does not duplicate consumer edges', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = "export async function fetchInvoices() { return fetch('/api/invoices'); }";
    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    await propagateSurfaces(db, ctx);
    await propagateSurfaces(db, ctx);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const callsEdges = ctx2!.edges.filter((e) => e.edge.edge_type === 'calls_surface');
    expect(callsEdges).toHaveLength(1);
  });

  // Phase 2 — two-stage consumer propagation hardening

  it('does NOT emit calls_surface when function references path but has no transport callsite', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/utils/paths.ts#invoicesPath';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/utils/paths.ts');

    // Function mentions the path but never calls fetch / axios / HTTP method
    const tsContent = ['export function invoicesPath() {', "  return '/api/invoices';", '}'].join(
      '\n'
    );

    const ctx = makeContext([
      { filePath: 'src/utils/paths.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('does NOT emit calls_surface when path static skeleton is shorter than 4 characters', async () => {
    // Skeleton of '/ab' is 'ab' (2 chars) — too short to be a meaningful discriminator
    db.upsertStructuralNode({
      id: 'surface:http:GET:/ab',
      node_type: 'capability-surface',
      symbol_name: 'GET /ab',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ transport: 'http', method: 'GET', path: '/ab' }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    const wrapperNodeId = 'symbol:ts:src/api/ab.ts#getAb';
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/ab.ts');

    const tsContent = "export const getAb = () => fetch('/ab');";
    const ctx = makeContext([
      { filePath: 'src/api/ab.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);
  });

  it('matches static path skeleton after stripping dynamic segments', async () => {
    // Surface path '/api/invoices/{id}' should match a wrapper referencing '/api/invoices/'
    db.upsertStructuralNode({
      id: 'surface:http:GET:/api/invoices/{id}',
      node_type: 'capability-surface',
      symbol_name: 'GET /api/invoices/{id}',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ transport: 'http', method: 'GET', path: '/api/invoices/{id}' }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoice';
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = [
      'export async function fetchInvoice(id: number) {',
      "  return fetch('/api/invoices/' + id);",
      '}',
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);
  });

  it('emits calls_surface with confidence 0.75 for a transport-proven wrapper', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');

    const tsContent = "export async function fetchInvoices() { return fetch('/api/invoices'); }";
    const ctx = makeContext([
      { filePath: 'src/api/invoices.ts', languageId: 'typescript', content: tsContent },
    ]);

    await propagateSurfaces(db, ctx);

    const surfaceCtx = db.getSurfaceCenteredContext(surfaceId);
    const callsEdge = surfaceCtx!.edges.find((e) => e.edge.edge_type === 'calls_surface');
    expect(callsEdge).toBeDefined();
    expect(callsEdge!.edge.confidence).toBeCloseTo(0.75);
  });

  it('does not emit calls_surface when transport method contradicts the surface method', async () => {
    const surfaceId = 'surface:http:POST:/api/events/registration-settings/{event}';
    const fileNodeId =
      'file:src/Module/BidRegistration/resources/js/components/BidRegistrationDialog/BidRegistrationDialog.vue';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /api/events/registration-settings/{event}',
      language_id: 'http',
      file_path: 'src/Module/BidRegistration/RouteServiceProvider.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/api/events/registration-settings/{event}',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(
      db,
      fileNodeId,
      'file',
      'src/Module/BidRegistration/resources/js/components/BidRegistrationDialog/BidRegistrationDialog.vue'
    );

    const ctx = makeContext([
      {
        filePath:
          'src/Module/BidRegistration/resources/js/components/BidRegistrationDialog/BidRegistrationDialog.vue',
        languageId: 'vue',
        content: [
          'async function fetchData(eventId) {',
          '  return axios.get(`/api/events/registration-settings/${eventId}`);',
          '}',
        ].join('\n'),
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(0);

    const surfaceCtx = db.getSurfaceCenteredContext(surfaceId);
    const callsEdge = surfaceCtx?.edges.find((e) => e.edge.edge_type === 'calls_surface');
    expect(callsEdge).toBeUndefined();
  });

  it('matches axios route-name callsites inside Vue methods when a symbol node exists', async () => {
    const surfaceId = 'surface:http:POST:/api/listing/create';
    const methodNodeId = 'symbol:ts:resources/js/Shared/Sidebar/QuickAdd.vue#saveListing';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /api/listing/create',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/api/listing/create',
        routeName: 'admin.listing.create',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, methodNodeId, 'symbol', 'resources/js/Shared/Sidebar/QuickAdd.vue');
    upsertNode(
      db,
      'file:resources/js/Shared/Sidebar/QuickAdd.vue',
      'file',
      'resources/js/Shared/Sidebar/QuickAdd.vue'
    );

    const ctx = makeContext([
      {
        filePath: 'resources/js/Shared/Sidebar/QuickAdd.vue',
        languageId: 'vue',
        content: [
          'methods: {',
          '  async saveListing() {',
          '    await axios.post(route("admin.listing.create", this.eventId), data);',
          '  },',
          '},',
        ].join('\n'),
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const edge = edges.find((e) => e.source_node_id === methodNodeId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe(0.75);
    expect(edge!.provenance_summary).toContain('script-transport-route-and-method-reference');
  });

  it('falls back to file node for route-name callsites in unsymbolized JS helpers', async () => {
    const surfaceId = 'surface:http:POST:/api/track_user_action';
    const fileNodeId = 'file:resources/js/Shared/utils/track-util.js';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /api/track_user_action',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/api/track_user_action',
        routeName: 'user.track-user-action',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, fileNodeId, 'file', 'resources/js/Shared/utils/track-util.js');

    const ctx = makeContext([
      {
        filePath: 'resources/js/Shared/utils/track-util.js',
        languageId: 'javascript',
        content: [
          'const trackUserAction = (actionName) => {',
          '  axios.post(route("user.track-user-action"), { trackable_action: actionName });',
          '};',
        ].join('\n'),
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const edge = edges.find((e) => e.source_node_id === fileNodeId);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe(0.75);
    expect(edge!.provenance_summary).toContain('script-transport-route-and-method-reference');
  });

  it('anchors route-based Vue transport to a method symbol discovered by file lookup', async () => {
    const surfaceId = 'surface:http:POST:/event_messages';
    const methodNodeId = 'symbol:vue:resources/js/Shared/Admin/AdminMessageForm.vue:sendMessage';

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
        routeName: 'event-messages.store',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertStructuralNode({
      id: methodNodeId,
      node_type: 'symbol',
      symbol_name: 'sendMessage',
      symbol_kind: 'Method',
      language_id: 'vue',
      file_path: 'resources/js/Shared/Admin/AdminMessageForm.vue',
      metadata: '{}',
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(
      db,
      'file:resources/js/Shared/Admin/AdminMessageForm.vue',
      'file',
      'resources/js/Shared/Admin/AdminMessageForm.vue'
    );

    const ctx = makeContext([
      {
        filePath: 'resources/js/Shared/Admin/AdminMessageForm.vue',
        languageId: 'vue',
        content: [
          'methods: {',
          '  sendMessage() {',
          '    axios.post(route("event-messages.store"), { message: this.messageFieldContent });',
          '  },',
          '},',
        ].join('\n'),
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBe(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const methodEdge = edges.find((e) => e.source_node_id === methodNodeId);
    expect(methodEdge).toBeDefined();
    expect(methodEdge!.confidence).toBe(0.75);
    expect(methodEdge!.provenance_summary).toContain('script-transport-route-and-method-reference');
  });
});

// ---------------------------------------------------------------------------
// Artifact propagation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — artifact propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits derived_from edge for a generated openapi file referencing surface path', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');

    const artifactContent = [
      '// Auto-generated. Do not edit.',
      'export function getApiInvoices(params: InvoiceParams): Promise<Invoice[]> {',
      "  return request({ method: 'GET', path: '/api/invoices', params });",
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'src/generated/openapi-client.ts',
        languageId: 'typescript',
        content: artifactContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const edgeTypes = ctx2!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('derived_from');
  });

  // Phase 4: .client.ts in /api/ without a generation header is 'handwritten-wrapper'
  // — it should NOT receive a derived_from edge; consumer propagation handles it instead.
  it('does NOT emit derived_from for .client.ts in /api/ without generation header', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    const artifactNodeId = 'file:src/api/users.client.ts';

    upsertSurface(db, surfaceId, '/api/users');
    upsertNode(db, artifactNodeId, 'file', 'src/api/users.client.ts');

    // No generation header — classified as handwritten-wrapper
    const content = "export const usersClientGet = () => fetch('/api/users');";

    const ctx = makeContext([
      { filePath: 'src/api/users.client.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('does NOT emit derived_from for a regular TS file (non-artifact)', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const fileNodeId = 'file:src/components/InvoiceList.tsx';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, fileNodeId, 'file', 'src/components/InvoiceList.tsx');

    const content = '// References /api/invoices in a comment';

    const ctx = makeContext([
      { filePath: 'src/components/InvoiceList.tsx', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('does NOT emit derived_from when artifact file node absent from DB', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    // artifact file node NOT in DB

    upsertSurface(db, surfaceId, '/api/invoices');

    const artifactContent = '// references /api/invoices';

    const ctx = makeContext([
      {
        filePath: 'src/generated/openapi-client.ts',
        languageId: 'typescript',
        content: artifactContent,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('is idempotent — re-running does not duplicate artifact edges', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');

    const content = '// /api/invoices endpoint';
    const ctx = makeContext([
      { filePath: 'src/generated/openapi-client.ts', languageId: 'typescript', content },
    ]);

    await propagateSurfaces(db, ctx);
    await propagateSurfaces(db, ctx);

    const ctx2 = db.getSurfaceCenteredContext(surfaceId);
    const derivedEdges = ctx2!.edges.filter((e) => e.edge.edge_type === 'derived_from');
    expect(derivedEdges).toHaveLength(1);
  });

  // Phase 4 — artifact role classification

  it('emits derived_from for a .client.ts file WITH a generation header', async () => {
    const surfaceId = 'surface:http:GET:/api/users';
    // Even though it is in /api/, the generation header makes it a generated-client
    const artifactNodeId = 'file:src/api/users.client.ts';

    upsertSurface(db, surfaceId, '/api/users');
    upsertNode(db, artifactNodeId, 'file', 'src/api/users.client.ts');

    const content = [
      '// Auto-generated. Do not edit.',
      "export const usersClientGet = () => fetch('/api/users');",
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/api/users.client.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });

  it('does NOT emit derived_from for a file in /services/ without generation evidence', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const fileNodeId = 'file:src/services/invoice-service.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, fileNodeId, 'file', 'src/services/invoice-service.ts');

    const content =
      "export class InvoiceService { async getAll() { return fetch('/api/invoices'); } }";

    const ctx = makeContext([
      { filePath: 'src/services/invoice-service.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('classifies @generated marker in file header as generated-client', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/client/invoices.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/client/invoices.ts');

    const content = [
      '/* @generated */',
      "export function getInvoices() { return fetch('/api/invoices'); }",
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/client/invoices.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });

  it('classifies openapi-named file outside /api/ as schema-derived and emits derived_from', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/openapi-types.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/openapi-types.ts');

    const content = "export type GetInvoicesPath = '/api/invoices';";

    const ctx = makeContext([
      { filePath: 'src/openapi-types.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });

  // Patch C — vendored/public asset denoising

  it('does NOT emit derived_from for a file in public/vendor/', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const vendorNodeId = 'file:public/vendor/axios.min.js';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, vendorNodeId, 'file', 'public/vendor/axios.min.js');

    // Would normally trigger generation header path; vendored asset must be excluded
    const content = [
      '// Do not edit. Auto-generated.',
      "axios.get('/api/invoices').then(function(r) { return r.data; });",
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'public/vendor/axios.min.js', languageId: 'javascript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('does NOT emit derived_from for a file in public/swagger-ui/', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const swaggerNodeId = 'file:public/swagger-ui/swagger-ui-bundle.js';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, swaggerNodeId, 'file', 'public/swagger-ui/swagger-ui-bundle.js');

    // Swagger UI bundle contains API paths as part of its distribution content
    const content = "/* swagger-ui bundle */ var path='/api/invoices';";

    const ctx = makeContext([
      { filePath: 'public/swagger-ui/swagger-ui-bundle.js', languageId: 'javascript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });

  it('still emits derived_from for a project-local generated client (not in public/vendor/)', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const artifactNodeId = 'file:src/generated/invoices-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/invoices-client.ts');

    const content = [
      '// Auto-generated. Do not edit.',
      "export function getInvoices() { return fetch('/api/invoices'); }",
    ].join('\n');

    const ctx = makeContext([
      { filePath: 'src/generated/invoices-client.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(1);
  });

  it('handwritten service wrapper still does not migrate into artifact propagation (Patch C regression)', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const wrapperNodeId = 'file:src/services/invoice-api.ts';

    upsertSurface(db, surfaceId, '/api/invoices');
    upsertNode(db, wrapperNodeId, 'file', 'src/services/invoice-api.ts');

    // No generation header — a handwritten wrapper in /services/
    const content = "export const getInvoices = () => fetch('/api/invoices');";

    const ctx = makeContext([
      { filePath: 'src/services/invoice-api.ts', languageId: 'typescript', content },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.artifactEdgesAdded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PropagationResult aggregation
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — result aggregation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns correct counts across all three pass types simultaneously', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const requestNodeId = 'symbol:php:ListInvoicesRequest';
    const wrapperNodeId = 'symbol:ts:src/api/invoices.ts#fetchInvoices';
    const artifactNodeId = 'file:src/generated/openapi-client.ts';

    upsertSurface(db, surfaceId, '/api/invoices', controllerNodeId);
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/ListInvoicesRequest.php');
    upsertNode(db, wrapperNodeId, 'symbol', 'src/api/invoices.ts');
    upsertNode(db, artifactNodeId, 'file', 'src/generated/openapi-client.ts');

    const lspData = {
      typeHierarchy: [{ name: 'ListInvoicesRequest', supertypes: [{ name: 'FormRequest' }] }],
    };

    const ctx = makeContext([
      { filePath: 'app/Http/Controllers/InvoiceController.php', languageId: 'php', lsp: lspData },
      {
        filePath: 'src/api/invoices.ts',
        languageId: 'typescript',
        content: "export async function fetchInvoices() { return fetch('/api/invoices'); }",
      },
      {
        filePath: 'src/generated/openapi-client.ts',
        languageId: 'typescript',
        content: '// generated: /api/invoices',
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.providerEdgesAdded).toBe(1);
    expect(result.consumerEdgesAdded).toBe(1);
    expect(result.artifactEdgesAdded).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Blade / inline-JS consumer propagation (Patch B)
// ---------------------------------------------------------------------------

describe('propagateSurfaces() — blade consumer propagation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function upsertBladeFileNode(db: LuxDatabase, relPath: string): void {
    db.upsertStructuralNode({
      id: `file:${relPath}`,
      node_type: 'file',
      symbol_name: relPath,
      language_id: 'php',
      file_path: relPath,
      metadata: '{}',
      updated_at: Math.floor(Date.now() / 1000),
    });
  }

  function upsertSurfaceWithRoute(
    db: LuxDatabase,
    surfaceId: string,
    path: string,
    routeName?: string
  ): void {
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: `GET ${path}`,
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({ transport: 'http', method: 'GET', path, routeName }),
      updated_at: Math.floor(Date.now() / 1000),
    });
  }

  it('emits calls_surface when Blade file has $.get() with literal path', async () => {
    const surfaceId = 'surface:http:GET:/patients/list';
    upsertSurfaceWithRoute(db, surfaceId, '/patients/list');
    upsertBladeFileNode(db, 'resources/views/patients/index.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/patients/index.blade.php',
        languageId: 'php',
        content: `<script>
  $(function() {
    $.get('/patients/list', function(data) { /* ... */ });
  });
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/patients/index.blade.php'
    );
    expect(blade).toBeDefined();
    expect(blade!.edge_type).toBe('calls_surface');
    expect(blade!.confidence).toBe(0.75);
  });

  it('promotes Blade $.post() to proven when method and path both match the surface', async () => {
    const surfaceId = 'surface:http:POST:/patients';
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /patients',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({ transport: 'http', method: 'POST', path: '/patients' }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertBladeFileNode(db, 'resources/views/patients/create.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/patients/create.blade.php',
        languageId: 'php',
        content: `<script>
  function submitForm(data) {
    $.post('/patients', data, function(res) { console.log(res); });
  }
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/patients/create.blade.php'
    );
    expect(blade).toBeDefined();
    expect(blade!.edge_type).toBe('calls_surface');
    expect(blade!.confidence).toBe(0.75);
    expect(blade!.provenance_summary).toContain('blade-transport-path-and-method-reference');
  });

  it('emits calls_surface when Blade file has $.post() with literal path', async () => {
    const surfaceId = 'surface:http:POST:/patients';
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /patients',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({ transport: 'http', method: 'POST', path: '/patients' }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertBladeFileNode(db, 'resources/views/patients/create.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/patients/create.blade.php',
        languageId: 'php',
        content: `<script>
  function submitForm(data) {
    $.post('/patients', data, function(res) { console.log(res); });
  }
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/patients/create.blade.php'
    );
    expect(blade).toBeDefined();
    expect(blade!.edge_type).toBe('calls_surface');
  });

  it('promotes Blade $.ajax object form to proven when url and explicit method match', async () => {
    const surfaceId = 'surface:http:GET:/api/appointments';
    upsertSurfaceWithRoute(db, surfaceId, '/api/appointments');
    upsertBladeFileNode(db, 'resources/views/appointments/show.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/appointments/show.blade.php',
        languageId: 'php',
        content: `<script>
  $.ajax({
    url: '/api/appointments',
    method: 'GET',
    success: function(r) { render(r); }
  });
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/appointments/show.blade.php'
    );
    expect(blade).toBeDefined();
    expect(blade!.confidence).toBe(0.75);
    expect(blade!.provenance_summary).toContain('blade-transport-path-and-method-reference');
  });

  it('promotes Blade route() helper edges when transport method and route name both match', async () => {
    const surfaceId = 'surface:http:GET:/reports/summary';
    upsertSurfaceWithRoute(db, surfaceId, '/reports/summary', 'reports.summary');
    upsertBladeFileNode(db, 'resources/views/dashboard.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/dashboard.blade.php',
        languageId: 'php',
        content: `<script>
  $.get(route('reports.summary'), function(data) { renderChart(data); });
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/dashboard.blade.php'
    );
    expect(blade).toBeDefined();
    expect(blade!.confidence).toBe(0.75);
    expect(blade!.provenance_summary).toContain('blade-transport-route-and-method-reference');
  });

  it('emits calls_surface when Blade file uses $.ajax({ url: path }) object form', async () => {
    const surfaceId = 'surface:http:GET:/api/appointments';
    upsertSurfaceWithRoute(db, surfaceId, '/api/appointments');
    upsertBladeFileNode(db, 'resources/views/appointments/show.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/appointments/show.blade.php',
        languageId: 'php',
        content: `<script>
  $.ajax({
    url: '/api/appointments',
    method: 'GET',
    success: function(r) { render(r); }
  });
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/appointments/show.blade.php'
    );
    expect(blade).toBeDefined();
  });

  it('does NOT emit calls_surface when path appears in Blade without a transport call', async () => {
    const surfaceId = 'surface:http:GET:/patients/list';
    upsertSurfaceWithRoute(db, surfaceId, '/patients/list');
    upsertBladeFileNode(db, 'resources/views/patients/help.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/patients/help.blade.php',
        languageId: 'php',
        content: `<!-- Navigate to /patients/list to view all patients -->
<p>See the <a href="/patients/list">patient list</a> page.</p>`,
      },
    ]);

    await propagateSurfaces(db, ctx);
    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/patients/help.blade.php'
    );
    expect(blade).toBeUndefined();
  });

  it('emits calls_surface when Blade file uses route() helper name in $.get()', async () => {
    const surfaceId = 'surface:http:GET:/reports/summary';
    upsertSurfaceWithRoute(db, surfaceId, '/reports/summary', 'reports.summary');
    upsertBladeFileNode(db, 'resources/views/dashboard.blade.php');

    const ctx = makeContext([
      {
        filePath: 'resources/views/dashboard.blade.php',
        languageId: 'php',
        content: `<script>
  $.get(route('reports.summary'), function(data) { renderChart(data); });
</script>`,
      },
    ]);

    const result = await propagateSurfaces(db, ctx);
    expect(result.consumerEdgesAdded).toBeGreaterThanOrEqual(1);

    const edges = db.getStructuralEdgesForNode(surfaceId);
    const blade = edges.find(
      (e) => e.source_node_id === 'file:resources/views/dashboard.blade.php'
    );
    expect(blade).toBeDefined();
    expect(blade!.edge_type).toBe('calls_surface');
  });
});

// ---------------------------------------------------------------------------
// Coarse contract inference — response kinds
// ---------------------------------------------------------------------------

describe('coarse contract inference — response kinds', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Helper: set up a surface with a controller node pointed at a PHP file,
   * where the controller method is encoded in the node ID suffix and surface metadata.
   */
  function setupCoarseSurface(
    surfaceId: string,
    httpMethod: string,
    path: string,
    controllerFile: string,
    controllerMethod: string,
    phpContent: string
  ): { controllerNodeId: string; ctx: AssociationContext } {
    const controllerNodeId = `symbol:php:SomeController`;
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: `${httpMethod} ${path}`,
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: httpMethod,
        path,
        controllerMethod,
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const ctx = makeContext([{ filePath: controllerFile, languageId: 'php', content: phpContent }]);
    return { controllerNodeId, ctx };
  }

  it('infers empty-ack with explicit-empty-return evidenceSubtype from explicit return;', async () => {
    const phpContent = [
      '<?php',
      'class TrackController extends Controller {',
      '    public function store(Request $request) {',
      '        UserAction::create($request->all());',
      '        return;',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurface(
      'surface:http:POST:/api/track',
      'POST',
      '/api/track',
      'app/Http/Controllers/TrackController.php',
      'store',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find(
      (e) => e.edge.edge_type === 'returns_contract' && e.edge.source_node_id === controllerNodeId
    );
    expect(returnEdge).toBeDefined();

    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    expect(contractNode).toBeDefined();
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('empty-ack');
    expect(meta.shapeConfidence).toBe('coarse');
    expect(meta.evidenceSubtype).toBe('explicit-empty-return');
    expect(meta.interactionKind).toBe('command');
  });

  it('infers empty-ack with implicit-fallthrough evidenceSubtype from side-effecting method with no return', async () => {
    const phpContent = [
      '<?php',
      'class TrackController extends Controller {',
      '    public function track(Request $request) {',
      '        event(new UserTracked($request->user()));',
      '        dispatch(new SendNotification());',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurface(
      'surface:http:POST:/api/track_event',
      'POST',
      '/api/track_event',
      'app/Http/Controllers/TrackController.php',
      'track',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find(
      (e) => e.edge.edge_type === 'returns_contract' && e.edge.source_node_id === controllerNodeId
    );
    expect(returnEdge).toBeDefined();

    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    expect(contractNode).toBeDefined();
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('empty-ack');
    expect(meta.evidenceSubtype).toBe('implicit-fallthrough');
  });

  it('infers page-response from Inertia::render()', async () => {
    const phpContent = [
      '<?php',
      'use Inertia\\Inertia;',
      'class InvoiceController extends Controller {',
      '    public function index() {',
      '        return Inertia::render("Invoices/Index", ["invoices" => Invoice::all()]);',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurface(
      'surface:http:GET:/invoices',
      'GET',
      '/invoices',
      'app/Http/Controllers/InvoiceController.php',
      'index',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find(
      (e) => e.edge.edge_type === 'returns_contract' && e.edge.source_node_id === controllerNodeId
    );
    expect(returnEdge).toBeDefined();

    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    expect(contractNode).toBeDefined();
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('page-response');
    expect(meta.shapeConfidence).toBe('coarse');
    expect(meta.interactionKind).toBe('page');
    expect(meta.framework).toBe('inertia');
  });

  it('infers page-response from view() helper', async () => {
    const phpContent = [
      '<?php',
      'class AdminController extends Controller {',
      '    public function dashboard() {',
      '        return view("admin.dashboard", compact("stats"));',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurface(
      'surface:http:GET:/admin/dashboard',
      'GET',
      '/admin/dashboard',
      'app/Http/Controllers/AdminController.php',
      'dashboard',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('page-response');
    expect(meta.interactionKind).toBe('page');
  });

  it('infers redirect-response from redirect() helper', async () => {
    const phpContent = [
      '<?php',
      'class AuthController extends Controller {',
      '    public function logout() {',
      '        Auth::logout();',
      '        return redirect("/login");',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurface(
      'surface:http:POST:/logout',
      'POST',
      '/logout',
      'app/Http/Controllers/AuthController.php',
      'logout',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('redirect-response');
    expect(meta.interactionKind).toBe('redirect');
  });

  it('infers scalar-response from response(string) helper', async () => {
    const phpContent = [
      '<?php',
      'class PingController extends Controller {',
      '    public function ping() {',
      '        return response("pong", 200);',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurface(
      'surface:http:GET:/ping',
      'GET',
      '/ping',
      'app/Http/Controllers/PingController.php',
      'ping',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('scalar-response');
    expect(meta.interactionKind).toBe('command');
  });
});

// ---------------------------------------------------------------------------
// Coarse contract inference — request kinds
// ---------------------------------------------------------------------------

describe('coarse contract inference — request kinds', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function setupCoarseSurfacePost(
    surfaceId: string,
    controllerFile: string,
    controllerMethod: string,
    phpContent: string
  ): { controllerNodeId: string; ctx: AssociationContext } {
    const controllerNodeId = `symbol:php:SomeController`;
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: `POST /api/items`,
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/api/items',
        controllerMethod,
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    return {
      controllerNodeId,
      ctx: makeContext([{ filePath: controllerFile, languageId: 'php', content: phpContent }]),
    };
  }

  it('infers route-bound-input from typed method params (non-base types)', async () => {
    const phpContent = [
      '<?php',
      'class EventController extends Controller {',
      '    public function show(Event $event, Listing $listing) {',
      '        return Inertia::render("Event/Show", compact("event", "listing"));',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurfacePost(
      'surface:http:POST:/api/items',
      'app/Http/Controllers/EventController.php',
      'show',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const requestEdge = edges.find((e) => e.edge.edge_type === 'validates_with');
    expect(requestEdge).toBeDefined();

    const contractNode = db.getStructuralNode(requestEdge!.edge.target_node_id);
    expect(contractNode).toBeDefined();
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('route-bound-input');
    expect(meta.shapeConfidence).toBe('coarse');
    expect(meta.boundParams).toContainEqual(expect.objectContaining({ type: 'Event' }));
    expect(meta.boundParams).toContainEqual(expect.objectContaining({ type: 'Listing' }));
  });

  it('infers implicit-input-shape from repeated $request->input() access', async () => {
    const phpContent = [
      '<?php',
      'class SearchController extends Controller {',
      '    public function search(Request $request) {',
      '        $query = $request->input("q");',
      '        $page = $request->input("page");',
      '        $perPage = $request->input("per_page");',
      '        return response()->json([$query, $page, $perPage]);',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurfacePost(
      'surface:http:POST:/api/items',
      'app/Http/Controllers/SearchController.php',
      'search',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const requestEdge = edges.find((e) => e.edge.edge_type === 'validates_with');
    expect(requestEdge).toBeDefined();

    const contractNode = db.getStructuralNode(requestEdge!.edge.target_node_id);
    expect(contractNode).toBeDefined();
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('implicit-input-shape');
    expect(meta.inputSignals).toContain('q');
    expect(meta.inputSignals).toContain('page');
  });

  it('infers implicit-input-shape from Laravel request property access', async () => {
    const phpContent = [
      '<?php',
      'class UserHistoryController extends Controller {',
      '    public function show(Request $request) {',
      '        $history = BidRegistration::where("user_id", $request->user_id)->get();',
      '        return response()->json($history);',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupCoarseSurfacePost(
      'surface:http:POST:/api/user-history',
      'app/Http/Controllers/UserHistoryController.php',
      'show',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const requestEdge = edges.find((e) => e.edge.edge_type === 'validates_with');
    expect(requestEdge).toBeDefined();

    const contractNode = db.getStructuralNode(requestEdge!.edge.target_node_id);
    expect(contractNode).toBeDefined();
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('implicit-input-shape');
    expect(meta.inputSignals).toContain('user_id');
  });

  it('does not emit coarse request contract when explicit FormRequest fills the request role', async () => {
    const surfaceId = 'surface:http:POST:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@store';
    const requestNodeId = 'symbol:php:StoreInvoiceRequest';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /api/invoices',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/api/invoices',
        controllerMethod: 'store',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, requestNodeId, 'symbol', 'app/Http/Requests/StoreInvoiceRequest.php');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const phpContent = [
      '<?php',
      'use App\\Http\\Requests\\StoreInvoiceRequest;',
      'class InvoiceController extends Controller {',
      '    public function store(StoreInvoiceRequest $request, Invoice $invoice) {',
      '        $invoice->save();',
      '        return redirect("/invoices");',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const requestEdges = edges.filter((e) => e.edge.edge_type === 'validates_with');

    // Should have exactly one validates_with edge — the explicit FormRequest one
    expect(requestEdges.length).toBe(1);

    // The target should be the explicit class node, not a coarse node
    const target = db.getStructuralNode(requestEdges[0].edge.target_node_id);
    expect(target?.id).toBe(requestNodeId);
  });
});

// ---------------------------------------------------------------------------
// Coarse contract inference — sibling method isolation
// ---------------------------------------------------------------------------

describe('coarse contract inference — sibling method isolation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('does not smear page-response evidence from one method to a sibling empty-ack method', async () => {
    // A mixed-style controller: index() renders a page, store() is a command.
    // The store() method should NOT get a page-response contract.
    const phpContent = [
      '<?php',
      'use Inertia\\Inertia;',
      'class EventController extends Controller {',
      '    public function index() {',
      '        return Inertia::render("Events/Index", ["events" => Event::all()]);',
      '    }',
      '',
      '    public function store(Request $request) {',
      '        Event::create($request->all());',
      '        return;',
      '    }',
      '}',
    ].join('\n');

    // Set up two surfaces pointing to the same controller file,
    // one for index() and one for store().
    const indexSurfaceId = 'surface:http:GET:/events';
    const storeSurfaceId = 'surface:http:POST:/events';
    const controllerNodeIdIndex = 'symbol:php:EventControllerIndex';
    const controllerNodeIdStore = 'symbol:php:EventControllerStore';
    const controllerFile = 'app/Http/Controllers/EventController.php';

    // Index surface
    db.upsertStructuralNode({
      id: indexSurfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /events',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/events',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeIdIndex, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${indexSurfaceId}→${controllerNodeIdIndex}:handled_by`,
      'handled_by',
      indexSurfaceId,
      controllerNodeIdIndex
    );

    // Store surface
    db.upsertStructuralNode({
      id: storeSurfaceId,
      node_type: 'capability-surface',
      symbol_name: 'POST /events',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/events',
        controllerMethod: 'store',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeIdStore, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${storeSurfaceId}→${controllerNodeIdStore}:handled_by`,
      'handled_by',
      storeSurfaceId,
      controllerNodeIdStore
    );

    const ctx = makeContext([{ filePath: controllerFile, languageId: 'php', content: phpContent }]);

    await propagateSurfaces(db, ctx);

    // index() should get page-response
    const indexEdges = db.getRelatedEdgesWithEvidence(controllerNodeIdIndex);
    const indexResponseEdge = indexEdges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(indexResponseEdge).toBeDefined();
    const indexContract = db.getStructuralNode(indexResponseEdge!.edge.target_node_id);
    expect(JSON.parse(indexContract!.metadata ?? '{}').contractKind).toBe('page-response');

    // store() should get empty-ack, NOT page-response
    const storeEdges = db.getRelatedEdgesWithEvidence(controllerNodeIdStore);
    const storeResponseEdge = storeEdges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(storeResponseEdge).toBeDefined();
    const storeContract = db.getStructuralNode(storeResponseEdge!.edge.target_node_id);
    const storeMeta = JSON.parse(storeContract!.metadata ?? '{}');
    expect(storeMeta.contractKind).toBe('empty-ack');
    expect(storeMeta.contractKind).not.toBe('page-response');
  });
});

// ---------------------------------------------------------------------------
// Coarse contract inference — adapter-gated serialized response
// ---------------------------------------------------------------------------

describe('coarse contract inference — adapter-gated serialized response', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('emits serialized-collection-response for Eloquent collection return in API controller path', async () => {
    const phpContent = [
      '<?php',
      'class JobController extends Controller {',
      '    public function index() {',
      '        return Job::paginate(15);',
      '    }',
      '}',
    ].join('\n');

    const surfaceId = 'surface:http:GET:/api/jobs';
    const controllerNodeId = 'symbol:php:JobController';
    const controllerFile = 'app/Http/Controllers/Api/JobController.php';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/jobs',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/api/jobs',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const ctx = makeContext([{ filePath: controllerFile, languageId: 'php', content: phpContent }]);

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    expect(meta.contractKind).toBe('serialized-collection-response');
  });

  it('falls back to coarse page-response (not serialized) for non-API controller path', async () => {
    // Same pattern as above but controller is NOT under Controllers/Api/
    const phpContent = [
      '<?php',
      'class ReportController extends Controller {',
      '    public function index() {',
      '        return view("reports.index", ["reports" => Report::paginate(15)]);',
      '    }',
      '}',
    ].join('\n');

    const surfaceId = 'surface:http:GET:/reports';
    const controllerNodeId = 'symbol:php:ReportController';
    const controllerFile = 'app/Http/Controllers/ReportController.php';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /reports',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/reports',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const ctx = makeContext([{ filePath: controllerFile, languageId: 'php', content: phpContent }]);

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const contractNode = db.getStructuralNode(returnEdge!.edge.target_node_id);
    const meta = JSON.parse(contractNode!.metadata ?? '{}');
    // Should be page-response (view()) not serialized-collection-response
    expect(meta.contractKind).toBe('page-response');
    expect(meta.contractKind).not.toBe('serialized-collection-response');
    expect(meta.contractKind).not.toBe('serialized-model-response');
  });

  it('does not emit coarse response when explicit returns_contract already exists', async () => {
    const surfaceId = 'surface:http:GET:/api/invoices';
    const controllerNodeId = 'symbol:php:InvoiceController@index';
    const resourceNodeId = 'symbol:php:InvoiceResource';

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/invoices',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/api/invoices',
        controllerMethod: 'index',
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', 'app/Http/Controllers/InvoiceController.php');
    upsertNode(db, resourceNodeId, 'symbol', 'app/Http/Resources/InvoiceResource.php');
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );

    const phpContent = [
      '<?php',
      'use App\\Http\\Resources\\InvoiceResource;',
      'class InvoiceController extends Controller {',
      '    public function index() {',
      '        return InvoiceResource::collection(Invoice::all());',
      '    }',
      '}',
    ].join('\n');

    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/InvoiceController.php',
        languageId: 'php',
        content: phpContent,
      },
    ]);

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdges = edges.filter((e) => e.edge.edge_type === 'returns_contract');

    // Only one returns_contract — the explicit class one
    expect(returnEdges.length).toBe(1);
    expect(returnEdges[0].edge.target_node_id).toBe(resourceNodeId);
  });
});

// ---------------------------------------------------------------------------
// Coarse contract inference — remaining response families
// ---------------------------------------------------------------------------

describe('coarse contract inference — native-array-response, native-object-response, framework-null-coercion', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function setupSurface(
    surfaceId: string,
    controllerFile: string,
    controllerMethod: string,
    phpContent: string
  ): { controllerNodeId: string; ctx: AssociationContext } {
    const controllerNodeId = 'symbol:php:SomeController';
    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /some',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/some',
        controllerMethod,
      }),
      updated_at: Math.floor(Date.now() / 1000),
    });
    upsertNode(db, controllerNodeId, 'symbol', controllerFile);
    upsertEdge(
      db,
      `${surfaceId}→${controllerNodeId}:handled_by`,
      'handled_by',
      surfaceId,
      controllerNodeId
    );
    return {
      controllerNodeId,
      ctx: makeContext([{ filePath: controllerFile, languageId: 'php', content: phpContent }]),
    };
  }

  it('infers native-array-response from PHP short array literal return', async () => {
    const phpContent = [
      '<?php',
      'class StatsController extends Controller {',
      '    public function summary() {',
      '        return ["total" => 100, "active" => 42];',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupSurface(
      'surface:http:GET:/stats/summary',
      'app/Http/Controllers/StatsController.php',
      'summary',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const meta = JSON.parse(
      db.getStructuralNode(returnEdge!.edge.target_node_id)!.metadata ?? '{}'
    );
    expect(meta.contractKind).toBe('native-array-response');
    expect(meta.shapeConfidence).toBe('coarse');
    expect(meta.interactionKind).toBe('query');
  });

  it('infers native-array-response from PHP long array() return', async () => {
    const phpContent = [
      '<?php',
      'class LegacyController extends Controller {',
      '    public function data() {',
      '        return array("key" => "value", "count" => 5);',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupSurface(
      'surface:http:GET:/legacy/data',
      'app/Http/Controllers/LegacyController.php',
      'data',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const meta = JSON.parse(
      db.getStructuralNode(returnEdge!.edge.target_node_id)!.metadata ?? '{}'
    );
    expect(meta.contractKind).toBe('native-array-response');
  });

  it('infers native-object-response from computed variable return', async () => {
    const phpContent = [
      '<?php',
      'class ProfileController extends Controller {',
      '    public function show(int $id) {',
      '        $profile = UserProfile::findOrFail($id);',
      '        return $profile;',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupSurface(
      'surface:http:GET:/profile/show',
      'app/Http/Controllers/ProfileController.php',
      'show',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const meta = JSON.parse(
      db.getStructuralNode(returnEdge!.edge.target_node_id)!.metadata ?? '{}'
    );
    expect(meta.contractKind).toBe('native-object-response');
    expect(meta.shapeConfidence).toBe('coarse');
    expect(meta.interactionKind).toBe('query');
  });

  it('infers native-object-response from new instance return', async () => {
    const phpContent = [
      '<?php',
      'class TokenController extends Controller {',
      '    public function issue() {',
      '        $token = new AccessToken(["user_id" => 1]);',
      '        return $token;',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupSurface(
      'surface:http:POST:/token/issue',
      'app/Http/Controllers/TokenController.php',
      'issue',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const meta = JSON.parse(
      db.getStructuralNode(returnEdge!.edge.target_node_id)!.metadata ?? '{}'
    );
    expect(meta.contractKind).toBe('native-object-response');
  });

  it('infers empty-ack with framework-null-coercion evidenceSubtype from return null', async () => {
    const phpContent = [
      '<?php',
      'class WebhookController extends Controller {',
      '    public function handle(Request $request) {',
      '        if (!$this->verify($request)) {',
      '            return null;',
      '        }',
      '        $this->process($request);',
      '        return null;',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupSurface(
      'surface:http:POST:/webhook/handle',
      'app/Http/Controllers/WebhookController.php',
      'handle',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const meta = JSON.parse(
      db.getStructuralNode(returnEdge!.edge.target_node_id)!.metadata ?? '{}'
    );
    expect(meta.contractKind).toBe('empty-ack');
    expect(meta.evidenceSubtype).toBe('framework-null-coercion');
    expect(meta.interactionKind).toBe('command');
  });

  it('prefers native-array-response over empty-ack when method returns empty array literal', async () => {
    // `return [];` should be native-array-response, not empty-ack, since it IS
    // a transport payload (an empty JSON array) — distinct from no payload.
    const phpContent = [
      '<?php',
      'class SearchController extends Controller {',
      '    public function search(Request $request) {',
      '        if (!$request->has("q")) {',
      '            return [];',
      '        }',
      '        return $this->doSearch($request->input("q"));',
      '    }',
      '}',
    ].join('\n');

    const { controllerNodeId, ctx } = setupSurface(
      'surface:http:GET:/search',
      'app/Http/Controllers/SearchController.php',
      'search',
      phpContent
    );

    await propagateSurfaces(db, ctx);

    const edges = db.getRelatedEdgesWithEvidence(controllerNodeId);
    const returnEdge = edges.find((e) => e.edge.edge_type === 'returns_contract');
    expect(returnEdge).toBeDefined();
    const meta = JSON.parse(
      db.getStructuralNode(returnEdge!.edge.target_node_id)!.metadata ?? '{}'
    );
    // Empty array literal is still native-array-response, not empty-ack
    expect(meta.contractKind).toBe('native-array-response');
    expect(meta.contractKind).not.toBe('empty-ack');
  });
});
