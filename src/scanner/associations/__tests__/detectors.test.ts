// Tests for CapabilitySurfaceDetector contract and LaravelHttpSurfaceDetector.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { LaravelHttpSurfaceDetector } from '../detectors/laravel-http.js';
import { runDetectors, createDefaultDetectors } from '../detectors/index.js';
import type { AssociationContext } from '../types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-detectors-test-'));
const ROOT = '/app';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function makeContext(
  entries: Array<{ filePath: string; languageId?: string; content?: string }>
): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((e) => ({
      filePath: e.filePath,
      languageId: e.languageId,
      metadata: e.content ? { content: e.content } : {},
    })),
    dirtyFiles: [],
  };
}

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector — supports()
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector.supports()', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('returns true for a context with a PHP route file', () => {
    const ctx = makeContext([{ filePath: 'routes/api.php', languageId: 'php', content: '' }]);
    expect(detector.supports(ctx)).toBe(true);
  });

  it('returns false when no PHP route files are present', () => {
    const ctx = makeContext([{ filePath: 'src/app.ts', languageId: 'typescript', content: '' }]);
    expect(detector.supports(ctx)).toBe(false);
  });

  it('returns false for PHP files that are not route files', () => {
    const ctx = makeContext([
      { filePath: 'app/Services/InvoiceService.php', languageId: 'php', content: '' },
    ]);
    expect(detector.supports(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector — detect() surface nodes
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector.detect() — surface nodes', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('emits a surface node for a controller-array route', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/invoices');
    expect(batch.surfaces[0].handle).toBe('GET /api/invoices');
    expect(batch.surfaces[0].transport).toBe('http');
    expect(batch.surfaces[0].metadata.method).toBe('GET');
    expect(batch.surfaces[0].metadata.path).toBe('/api/invoices');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('InvoiceController');
  });

  it('emits a surface node for an invokable controller route', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::post('/api/invoices', CreateInvoiceAction::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:POST:/api/invoices');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('CreateInvoiceAction');
  });

  it('emits a surface node for a closure route (no explicit provider)', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/health', function () { return 'ok'; });`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/health');
    expect(batch.surfaces[0].metadata.explicitProvider).toBeUndefined();
  });

  it('emits multiple surfaces for multiple routes', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
          `Route::post('/api/invoices', [InvoiceController::class, 'store']);`,
          `Route::get('/api/users', [UserController::class, 'index']);`,
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(3);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:GET:/api/invoices');
    expect(ids).toContain('surface:http:POST:/api/invoices');
    expect(ids).toContain('surface:http:GET:/api/users');
  });

  it('captures route name when declared via ->name()', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index'])->name('invoices.index');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.routeName).toBe('invoices.index');
    expect(batch.surfaces[0].metadata.aliases).toContain('invoices.index');
  });

  it('emits a surface node for a legacy string-controller route under a registered api prefix', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/CoreServiceProvider.php',
        languageId: 'php',
        content: `Route::prefix('api')->middleware('api')->namespace("Acme\\Core\\Http\\Controllers")->group(__DIR__ . '/../routes/api.php');`,
      },
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::post('/listing/create', 'Api\\QuickAdminListingController@create')->name('admin.listing.create');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:POST:/api/listing/create');
    expect(batch.surfaces[0].metadata.path).toBe('/api/listing/create');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe(
      'Acme\\Core\\Http\\Controllers\\Api\\QuickAdminListingController'
    );
    expect(batch.surfaces[0].metadata.controllerMethod).toBe('create');
    expect(batch.surfaces[0].metadata.routeName).toBe('admin.listing.create');
  });

  it('captures legacy string-controller routes with registered api prefix and local fragments as written', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/CoreServiceProvider.php',
        languageId: 'php',
        content: `Route::prefix('api')->middleware('api')->namespace("Acme\\Core\\Http\\Controllers")->group(__DIR__ . '/../routes/api.php');`,
      },
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('users/dropdown/{query?}', 'Api\\UserController@dropdownIndex')->name('admin.users.dropdown');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/users/dropdown/{query?}');
    expect(batch.surfaces[0].metadata.path).toBe('/api/users/dropdown/{query?}');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe(
      'Acme\\Core\\Http\\Controllers\\Api\\UserController'
    );
    expect(batch.surfaces[0].metadata.routeName).toBe('admin.users.dropdown');
  });
});

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector — detect() edges
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector.detect() — boundary edges', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('emits declares_surface from route file to surface', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const declEdge = batch.edges.find((e) => e.edgeType === 'declares_surface');
    expect(declEdge).toBeDefined();
    expect(declEdge!.sourceNodeId).toBe('file:routes/api.php');
    expect(declEdge!.targetNodeId).toBe('surface:http:GET:/api/invoices');
    expect(declEdge!.confidenceClass).toBe('framework-inferred');
  });

  it('emits handled_by from surface to class-level controller symbol (not method-level)', async () => {
    // handled_by must target the class-level controller node that the materializer
    // persists. When the route declaration includes a namespace, preserve that
    // qualified identity so duplicate short controller names do not collide.
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [App\\Http\\Controllers\\InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeDefined();
    expect(handledEdge!.sourceNodeId).toBe('surface:http:GET:/api/invoices');
    expect(handledEdge!.targetNodeId).toBe('symbol:php:App\\Http\\Controllers\\InvoiceController');
    expect(handledEdge!.confidenceClass).toBe('framework-inferred');

    // Method is preserved in surface metadata
    const surface = batch.surfaces.find((s) => s.id === 'surface:http:GET:/api/invoices');
    expect(surface!.metadata.controllerMethod).toBe('index');
  });

  it('does NOT emit handled_by for closure routes (no explicit provider)', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/health', function () { return 'ok'; });`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeUndefined();
  });

  it('emits handled_by without method for invokable controllers', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::post('/api/invoices', App\\Actions\\CreateInvoiceAction::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeDefined();
    expect(handledEdge!.targetNodeId).toBe('symbol:php:App\\Actions\\CreateInvoiceAction');
  });

  it('attaches evidence with file path and line number', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const declEdge = batch.edges.find((e) => e.edgeType === 'declares_surface');
    expect(declEdge!.provenance.evidenceLocations[0].filePath).toBe('routes/api.php');
    expect(declEdge!.provenance.resolver).toBe('laravel-http-surfaces');
    expect(declEdge!.provenance.evidenceKind).toBe('route-declaration');
  });

  it('resolves legacy string controllers through the default controller namespace fallback', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/admin.php',
        languageId: 'php',
        content: `Route::put('/admin/update_sale_order', 'Api\\ListingController@updateSaleOrder')->name('admin.updateSaleOrder');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const surface = batch.surfaces.find(
      (s) => s.id === 'surface:http:PUT:/admin/update_sale_order'
    );
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');

    expect(surface!.metadata.explicitProvider).toBe(
      'App\\Http\\Controllers\\Api\\ListingController'
    );
    expect(handledEdge!.targetNodeId).toBe(
      'symbol:php:App\\Http\\Controllers\\Api\\ListingController'
    );
  });

  it('E3: expands a namespace-alias use import for a [Api\\Controller::class] route', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/Payments/routes.php',
        languageId: 'php',
        content:
          `use Acme\\Core\\Module\\Payments\\Http\\Controllers\\Api;\n` +
          `Route::post('/client-token', [Api\\GetClientTokenController::class, '__invoke']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const surface = batch.surfaces.find((s) => s.id === 'surface:http:POST:/client-token');
    expect(surface!.metadata.explicitProvider).toBe(
      'Acme\\Core\\Module\\Payments\\Http\\Controllers\\Api\\GetClientTokenController'
    );
  });

  it('E2: does not double-prefix an already-qualified legacy string controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/CoreServiceProvider.php',
        languageId: 'php',
        content: `Route::namespace("Acme\\Core\\Http\\Controllers")->group(__DIR__ . '/../routes/api.php');`,
      },
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/addr', 'Acme\\Core\\Http\\Controllers\\Api\\AcmeAddressController@countryStates');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const surface = batch.surfaces.find((s) => s.id === 'surface:http:GET:/addr');
    expect(surface!.metadata.explicitProvider).toBe(
      'Acme\\Core\\Http\\Controllers\\Api\\AcmeAddressController'
    );
  });

  it('E3-scope guard: a legacy string controller is group-prefixed, never use-import-expanded', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/CoreServiceProvider.php',
        languageId: 'php',
        content: `Route::namespace("Acme\\Core\\Http\\Controllers")->group(__DIR__ . '/../routes/api.php');`,
      },
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `use Some\\Vendor\\Api;\nRoute::get('/legacy', 'Api\\LegacyController@index');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const surface = batch.surfaces.find((s) => s.id === 'surface:http:GET:/legacy');
    // Laravel prefixes STRING controllers with the group namespace and does NOT
    // apply the `use Some\Vendor\Api;` import — E3 alias expansion must not leak here.
    expect(surface!.metadata.explicitProvider).toBe(
      'Acme\\Core\\Http\\Controllers\\Api\\LegacyController'
    );
  });
});

// ---------------------------------------------------------------------------
// runDetectors integration
// ---------------------------------------------------------------------------

describe('runDetectors()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('persists surface nodes into the DB', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const result = await runDetectors(db, ctx);
    expect(result.surfacesDetected).toBe(1);

    const surfaces = db.getCapabilitySurfaces();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].id).toBe('surface:http:GET:/api/invoices');
    expect(surfaces[0].node_type).toBe('capability-surface');
  });

  it('persists boundary edges into the DB', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const result = await runDetectors(db, ctx);
    expect(result.surfaceEdgesStored).toBeGreaterThanOrEqual(2); // declares_surface + handled_by

    const ctx2 = db.getSurfaceCenteredContext('surface:http:GET:/api/invoices');
    expect(ctx2).not.toBeNull();
    const edgeTypes = ctx2!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('declares_surface');
    expect(edgeTypes).toContain('handled_by');
  });

  it('is idempotent — re-running does not duplicate surfaces or edges', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    await runDetectors(db, ctx);
    await runDetectors(db, ctx); // second run

    const surfaces = db.getCapabilitySurfaces();
    expect(surfaces).toHaveLength(1);
  });

  it('skips detectors that do not support the context', async () => {
    const ctx = makeContext([{ filePath: 'src/app.ts', languageId: 'typescript', content: '' }]);

    const result = await runDetectors(db, ctx);
    expect(result.surfacesDetected).toBe(0);
    expect(result.surfaceEdgesStored).toBe(0);
  });

  it('createDefaultDetectors() returns the LaravelHttpSurfaceDetector', () => {
    const detectors = createDefaultDetectors();
    expect(detectors.some((d) => d.name === 'laravel-http-surfaces')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route-group-aware surface normalization
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — route groups', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('composes canonical path from Route::prefix chain group', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::prefix('api')->group(function () {",
          "    Route::get('/invoices', [InvoiceController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/invoices');
    expect(batch.surfaces[0].metadata.path).toBe('/api/invoices');
    expect(batch.surfaces[0].metadata.localFragment).toBe('/invoices');
    expect(batch.surfaces[0].metadata.declarationLineage).toEqual(['api']);
  });

  it('composes canonical path from Route::group array syntax', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::group(['prefix' => 'admin'], function () {",
          "    Route::get('/users', [UserController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/admin/users');
    expect(batch.surfaces[0].metadata.declarationLineage).toEqual(['admin']);
  });

  it('handles nested prefix groups composing full path', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::prefix('api')->group(function () {",
          "    Route::prefix('v1')->group(function () {",
          "        Route::get('/invoices', [InvoiceController::class, 'index']);",
          '    });',
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/v1/invoices');
    expect(batch.surfaces[0].metadata.localFragment).toBe('/invoices');
    expect(batch.surfaces[0].metadata.declarationLineage).toEqual(['api', 'v1']);
  });

  it('handles sibling groups at the same nesting level', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::prefix('api')->group(function () {",
          "    Route::get('/invoices', [InvoiceController::class, 'index']);",
          '});',
          "Route::prefix('admin')->group(function () {",
          "    Route::get('/users', [UserController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(2);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:GET:/api/invoices');
    expect(ids).toContain('surface:http:GET:/admin/users');
  });

  it('preserves routes outside groups at top level', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::get('/health', function () { return 'ok'; });",
          "Route::prefix('api')->group(function () {",
          "    Route::get('/invoices', [InvoiceController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(2);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:GET:/health');
    expect(ids).toContain('surface:http:GET:/api/invoices');

    // Top-level route has no lineage
    const healthSurface = batch.surfaces.find((s) => s.id === 'surface:http:GET:/health')!;
    expect(healthSurface.metadata.declarationLineage).toBeUndefined();
  });

  it('composes paths that previously collapsed to coarse handles like GET /', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::prefix('chirps')->group(function () {",
          "    Route::get('/', [ChirpController::class, 'index']);",
          "    Route::post('/', [ChirpController::class, 'store']);",
          "    Route::get('create', [ChirpController::class, 'create']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(3);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:GET:/chirps');
    expect(ids).toContain('surface:http:POST:/chirps');
    expect(ids).toContain('surface:http:GET:/chirps/create');
  });

  it('Route::group with middleware but no prefix produces no extra prefix', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::group(['middleware' => ['auth']], function () {",
          "    Route::get('/dashboard', [DashboardController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    // No prefix, so path stays as-is
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/dashboard');
  });

  it('composes canonical path from Route::group array syntax when options contain nested arrays before the callback', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          'Route::group([',
          "    'prefix' => 'api/external/v1',",
          "    'middleware' => [",
          '        HandleApiExceptions::class,',
          "        'auth:sanctum',",
          "        'throttle:external-api',",
          '    ],',
          '], function () {',
          "    Route::get('users', IndexUsersController::class);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/external/v1/users');
    expect(batch.surfaces[0].metadata.path).toBe('/api/external/v1/users');
    expect(batch.surfaces[0].metadata.localFragment).toBe('users');
    expect(batch.surfaces[0].metadata.declarationLineage).toEqual(['api/external/v1']);
  });

  it('preserves handled_by edge with class-level controller within a group', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "Route::prefix('api')->group(function () {",
          "    Route::post('/invoices', [InvoiceController::class, 'store']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeDefined();
    expect(handledEdge!.sourceNodeId).toBe('surface:http:POST:/api/invoices');
    expect(handledEdge!.targetNodeId).toBe('symbol:php:InvoiceController');

    // Method preserved in surface metadata
    const surface = batch.surfaces.find((s) => s.id === 'surface:http:POST:/api/invoices');
    expect(surface!.metadata.controllerMethod).toBe('store');
  });
});

// ---------------------------------------------------------------------------
// Helper-wrapped path recovery
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — helper-wrapped path recovery', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('recovers surface from pathLookup wrapper with invokable controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/allsellerreport'), AllSellerReportController::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/events/allsellerreport');
    expect(batch.surfaces[0].metadata.path).toBe('/events/allsellerreport');
    expect(batch.surfaces[0].metadata.localFragment).toBe('/events/allsellerreport');
    expect(batch.surfaces[0].metadata.pathWrapper).toBe('pathLookup');
  });

  it('recovers surface from pathLookup wrapper with parameterized path', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/bidhistoryreport/{event}'), BidHistoryReportController::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/events/bidhistoryreport/{event}');
    expect(batch.surfaces[0].metadata.path).toBe('/events/bidhistoryreport/{event}');
    expect(batch.surfaces[0].metadata.pathWrapper).toBe('pathLookup');
  });

  it('recovers surface from pathLookup wrapper with array controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/allwatcherreport'), [EventController::class, 'allWatcherReport']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/events/allwatcherreport');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('EventController');
    expect(batch.surfaces[0].metadata.controllerMethod).toBe('allWatcherReport');
    expect(batch.surfaces[0].metadata.pathWrapper).toBe('pathLookup');
  });

  it('recovers surface from pathLookup wrapper with closure', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/foo'), function () { return view('events.foo'); });`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/events/foo');
    expect(batch.surfaces[0].metadata.pathWrapper).toBe('pathLookup');
    expect(batch.surfaces[0].metadata.explicitProvider).toBeUndefined();
  });

  it('evidence note includes helper-wrapped form when pathWrapper is set', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/allsellerreport'), AllSellerReportController::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const declEdge = batch.edges.find((e) => e.edgeType === 'declares_surface');
    expect(declEdge).toBeDefined();
    const note = declEdge!.provenance.evidenceLocations[0].note;
    // Note should show the wrapper form, not a bare string literal
    expect(note).toContain("pathLookup('/events/allsellerreport')");
  });

  it('does NOT recover surfaces from non-allowlisted helper wrappers', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        // dynamicPath is not in the allowlist — should not be captured
        content: `Route::get(dynamicPath('/events/foo'), SomeController::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(0);
  });

  it('does NOT recover surfaces from helper wrappers with non-literal arguments', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        // Variable argument — cannot be recovered conservatively
        content: `Route::get(pathLookup($routeName), SomeController::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(0);
  });

  it('composes canonical path with group prefixes when pathLookup path already contains the prefix', async () => {
    // When pathLookup carries the full absolute path (e.g. '/events/foo'), and a group
    // prefix is also present, the existing prefix deduplication logic must apply.
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "Route::prefix('events')->group(function () {",
          "    Route::get(pathLookup('/events/foo'), SomeController::class);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    // Path already includes the prefix, so composed path should not double it
    expect(batch.surfaces[0].metadata.path).toBe('/events/foo');
  });
});

// ---------------------------------------------------------------------------
// Conditional branch consolidation (T3 + T4)
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — conditional branch consolidation', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('consolidates two declarations for the same (method, path) into one surface', async () => {
    // Simulates an app-vs-core override pattern where both branches appear statically
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          '// app override branch',
          "Route::get('/events/foo', [App\\Http\\Controllers\\FooController::class, 'index']);",
          '// core fallback branch',
          "Route::get('/events/foo', [Core\\Http\\Controllers\\FooController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    // Only one surface for the logical route
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/events/foo');
  });

  it('arbitration prefers the namespace-qualified controller as winner', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          // Unqualified first (would lose)
          "Route::get('/events/foo', [FooController::class, 'index']);",
          // Namespace-qualified second (should win)
          "Route::get('/events/foo', [App\\Http\\Controllers\\FooController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    const surface = batch.surfaces[0];
    // Winner is the namespace-qualified controller
    expect(surface.metadata.explicitProvider).toBe('App\\Http\\Controllers\\FooController');
  });

  it('preserves losing branch as alternateProviders in metadata', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "Route::get('/events/foo', [App\\Http\\Controllers\\FooController::class, 'index']);",
          "Route::get('/events/foo', [Core\\Http\\Controllers\\FooController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const surface = batch.surfaces[0];
    // Losing branch preserved as alternates
    expect(surface.metadata.alternateProviders).toBeDefined();
    expect(surface.metadata.alternateProviders).toHaveLength(1);
    const alt = surface.metadata.alternateProviders![0];
    expect(alt.controllerQualifiedName).toMatch(/FooController/);
  });

  it('emits only one handled_by edge when two branches consolidate to one surface', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "Route::get('/events/foo', [App\\Http\\Controllers\\FooController::class, 'index']);",
          "Route::get('/events/foo', [Core\\Http\\Controllers\\FooController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdges = batch.edges.filter((e) => e.edgeType === 'handled_by');
    // Only one handled_by — no duplicate edges for the same surface
    expect(handledEdges).toHaveLength(1);
  });

  it('keeps distinct surfaces intact when (method, path) differ', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "Route::get('/events/foo', [FooController::class, 'index']);",
          "Route::post('/events/foo', [FooController::class, 'store']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    // Different methods → different logical surfaces → both kept
    expect(batch.surfaces).toHaveLength(2);
  });

  it('unresolved fallback: first candidate kept when no controller is resolvable', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        // Both branches are closure routes — no explicit provider either way
        content: [
          "Route::get('/events/foo', function () { return 'v1'; });",
          "Route::get('/events/foo', function () { return 'v2'; });",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    // Consolidates to one surface (closure routes have no provider to arbitrate)
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].metadata.explicitProvider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Module registration-context inheritance (T5 / T6)
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — module registration-context inheritance', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('applies prefix from loadRoutesFrom module provider to route file declarations', async () => {
    // Simulates a module service provider that calls loadRoutesFrom with no surrounding chain
    // The route file has declarations without an explicit prefix.
    const ctx = makeContext([
      {
        filePath: 'src/Modules/Accounting/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('admin/accounting')",
          "    ->middleware(['web', 'auth'])",
          '    ->group(function () {',
          "        $this->loadRoutesFrom(__DIR__ . '/../routes/admin.php');",
          '    });',
        ].join('\n'),
      },
      {
        filePath: 'src/Modules/Accounting/routes/admin.php',
        languageId: 'php',
        content: `Route::get('/', [AccountingController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/admin/accounting');
    expect(batch.surfaces[0].metadata.path).toBe('/admin/accounting');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('AccountingController');
  });

  it('applies prefix and namespace from loadRoutesFrom module provider', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Modules/Accounting/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('admin/accounting')",
          "    ->namespace('Acme\\Module\\Accounting\\Http\\Controllers')",
          '    ->group(function () {',
          "        $this->loadRoutesFrom(__DIR__ . '/../routes/admin.php');",
          '    });',
        ].join('\n'),
      },
      {
        filePath: 'src/Modules/Accounting/routes/admin.php',
        languageId: 'php',
        content: `Route::get('/ledger', 'LedgerController@index');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/admin/accounting/ledger');
    expect(batch.surfaces[0].metadata.path).toBe('/admin/accounting/ledger');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe(
      'Acme\\Module\\Accounting\\Http\\Controllers\\LedgerController'
    );
  });

  it('resolves invokable controller under inherited module namespace', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Modules/Reporting/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('admin/reporting')",
          "    ->namespace('Acme\\Module\\Reporting\\Http\\Controllers')",
          '    ->group(function () {',
          "        $this->loadRoutesFrom(__DIR__ . '/../routes/web.php');",
          '    });',
        ].join('\n'),
      },
      {
        filePath: 'src/Modules/Reporting/routes/web.php',
        languageId: 'php',
        content: `Route::get('/summary', SummaryController::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    // Invokable controller resolved via import map (no namespace prefix for ::class references)
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('SummaryController');
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/admin/reporting/summary');
  });

  it('module route file registered via plain loadRoutesFrom (no chain context) produces surface without prefix', async () => {
    // loadRoutesFrom with no surrounding Route:: chain — no prefix/namespace can be extracted
    const ctx = makeContext([
      {
        filePath: 'src/Modules/Simple/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: `$this->loadRoutesFrom(__DIR__ . '/../routes/routes.php');`,
      },
      {
        filePath: 'src/Modules/Simple/routes/routes.php',
        languageId: 'php',
        content: `Route::get('/simple/ping', [PingController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    // No prefix or namespace inherited — path is exactly as declared
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/simple/ping');
    expect(batch.surfaces[0].metadata.path).toBe('/simple/ping');
  });

  it('does NOT register route file context when loadRoutesFrom uses a non-literal path', async () => {
    // Variable path — too dynamic to recover safely, so no registration context is extracted
    const ctx = makeContext([
      {
        filePath: 'src/Modules/Dynamic/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('admin/dynamic')",
          '    ->group(function () {',
          '        $this->loadRoutesFrom($this->routeFile());',
          '    });',
        ].join('\n'),
      },
      {
        filePath: 'src/Modules/Dynamic/routes/dynamic.php',
        languageId: 'php',
        content: `Route::get('/item', [ItemController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    // Route file is still detected via isRouteFile, but without provider context
    // the path is recovered as-is from the declaration (no prefix applied)
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/item');
    expect(batch.surfaces[0].metadata.path).toBe('/item');
  });
});

// ---------------------------------------------------------------------------
// Comment-aware route extraction
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — comment-aware extraction', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('does not emit surfaces for routes commented out with //', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "// Route::get('/disabled', [DisabledController::class, 'index']);",
          "Route::get('/active', [ActiveController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/active');
  });

  it('does not emit surfaces for routes commented out with #', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "# Route::get('/disabled', [DisabledController::class, 'index']);",
          "Route::get('/active', [ActiveController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/active');
  });

  it('does not emit surfaces for routes wrapped in /* ... */ block comments', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          '/*',
          "Route::get('/legacy-1', [LegacyController::class, 'one']);",
          "Route::post('/legacy-2', [LegacyController::class, 'two']);",
          '*/',
          "Route::get('/active', [ActiveController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/active');
  });

  it('ignores a trailing // comment after an active route declaration', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: "Route::get('/active', [ActiveController::class, 'index']); // TODO",
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/active');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('ActiveController');
  });

  it('does not emit closure routes that are commented out', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          "// Route::get('/disabled-closure', function () { return 'old'; });",
          "Route::get('/active-closure', function () { return 'ok'; });",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/active-closure');
  });

  it('does not emit routes inside a commented-out group block', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          '/*',
          "Route::prefix('legacy')->group(function () {",
          "    Route::get('/inside', [LegacyController::class, 'index']);",
          '});',
          '*/',
          "Route::get('/active', [ActiveController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toEqual(['surface:http:GET:/active']);
  });

  it('preserves routes whose string literals contain //', async () => {
    // Ensures the comment masker correctly skips over string literals and does
    // not misinterpret the // inside 'http://' as the start of a line comment.
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content:
          "Route::get('/callback', [AuthController::class, 'handle'])->name('callback'); // redirect target for http://example.com",
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/callback');
  });

  it('still parses routes that follow a closed /* ... */ block', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          '/**',
          ' * API routes — see docs/api.md',
          ' */',
          "Route::get('/ping', [PingController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/ping');
  });

  it('does not emit duplicates when the only alternate branch is commented out', async () => {
    // Regression guard: conditional branch consolidation must not see a commented-out
    // alternative as a competing declaration.
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "// Route::get('/events/foo', [Core\\Http\\Controllers\\FooController::class, 'index']);",
          "Route::get('/events/foo', [App\\Http\\Controllers\\FooController::class, 'index']);",
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    const surface = batch.surfaces[0];
    expect(surface.metadata.explicitProvider).toBe('App\\Http\\Controllers\\FooController');
    // No alternate provider — the commented-out line was masked before parsing.
    expect(surface.metadata.alternateProviders).toBeUndefined();
  });

  it('does not register module route file context from a commented-out loadRoutesFrom', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Modules/Dead/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "// Route::prefix('admin/dead')",
          '//     ->group(function () {',
          "//         $this->loadRoutesFrom(__DIR__ . '/../routes/admin.php');",
          '//     });',
        ].join('\n'),
      },
      {
        filePath: 'src/Modules/Dead/routes/admin.php',
        languageId: 'php',
        content: `Route::get('/raw', [RawController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    // The commented-out provider chain must not apply the /admin/dead prefix.
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/raw');
  });
});

// ---------------------------------------------------------------------------
// Provider-kind classification (closure vs controller)
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — provider-kind classification', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('marks controller-array routes with providerKind=controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/a', [AController::class, 'index']);`,
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.providerKind).toBe('controller');
  });

  it('marks invokable-controller routes with providerKind=controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::post('/a', AInvokableController::class);`,
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.providerKind).toBe('controller');
  });

  it('marks legacy string-controller routes with providerKind=controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/admin.php',
        languageId: 'php',
        content: `Route::put('/a', 'Api\\AController@index');`,
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.providerKind).toBe('controller');
  });

  it('marks closure routes with providerKind=closure (not a provider miss)', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/health', function () { return 'ok'; });`,
      },
    ]);
    const batch = await detector.detect(ctx);
    const surface = batch.surfaces[0];
    expect(surface.metadata.providerKind).toBe('closure');
    expect(surface.metadata.explicitProvider).toBeUndefined();
  });

  it('marks helper-wrapped closure routes with providerKind=closure', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/foo'), function () { return view('events.foo'); });`,
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.providerKind).toBe('closure');
    expect(batch.surfaces[0].metadata.pathWrapper).toBe('pathLookup');
  });

  it('marks helper-wrapped invokable-controller routes with providerKind=controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: `Route::get(pathLookup('/events/report'), ReportController::class);`,
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.providerKind).toBe('controller');
  });

  it('consolidation: controller beats closure on same (method, path); winner kind=controller', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "Route::get('/events/foo', function () { return 'stub'; });",
          "Route::get('/events/foo', [App\\Http\\Controllers\\FooController::class, 'index']);",
        ].join('\n'),
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].metadata.providerKind).toBe('controller');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe(
      'App\\Http\\Controllers\\FooController'
    );
  });

  it('consolidation: two closure branches keep providerKind=closure', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/web.php',
        languageId: 'php',
        content: [
          "Route::get('/events/foo', function () { return 'v1'; });",
          "Route::get('/events/foo', function () { return 'v2'; });",
        ].join('\n'),
      },
    ]);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].metadata.providerKind).toBe('closure');
    expect(batch.surfaces[0].metadata.explicitProvider).toBeUndefined();
  });

  it('closure routes do not emit a handled_by edge', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/health', function () { return 'ok'; });`,
      },
    ]);
    const batch = await detector.detect(ctx);
    const handled = batch.edges.filter((e) => e.edgeType === 'handled_by');
    expect(handled).toHaveLength(0);
    // And the surface is honestly classified — not left as an empty miss.
    expect(batch.surfaces[0].metadata.providerKind).toBe('closure');
  });
});

// ---------------------------------------------------------------------------
// Provider-declared inline route files (RouteServiceProvider-style)
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector — provider-declared inline routes', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('supports() returns true for a RouteServiceProvider file with an inline Route::prefix(..)->group(..) block', () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('api/external')->middleware(['api'])->group(function () {",
          "    Route::get('/ping', [PingController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);
    expect(detector.supports(ctx)).toBe(true);
  });

  it('supports() returns true for a provider file with a direct top-level Route::get declaration', () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: `Route::get('/api/external/health', [HealthController::class, 'index']);`,
      },
    ]);
    expect(detector.supports(ctx)).toBe(true);
  });

  it('supports() returns false for a plain service provider file that contains no route declarations', () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/ExternalApiServiceProvider.php',
        languageId: 'php',
        content: [
          'class ExternalApiServiceProvider extends ServiceProvider {',
          '    public function register(): void {',
          '        $this->app->singleton(ExternalApiClient::class);',
          '    }',
          '}',
        ].join('\n'),
      },
    ]);
    expect(detector.supports(ctx)).toBe(false);
  });

  it('supports() returns false for a non-provider PHP service file even if it mentions Route::get in a docblock', () => {
    const ctx = makeContext([
      {
        filePath: 'src/Services/InvoiceService.php',
        languageId: 'php',
        content: [
          '/**',
          " * Helper for Route::get('/invoices', ...) lookups — not a route file.",
          ' */',
          'class InvoiceService {}',
        ].join('\n'),
      },
    ]);
    expect(detector.supports(ctx)).toBe(false);
  });

  it('supports() returns false for a provider file that only registers external route files (no inline declarations)', () => {
    // loadRoutesFrom-only providers are still handled via collectRouteFileRegistrations
    // against their target route file — they should NOT be treated as route sources themselves.
    const ctx = makeContext([
      {
        filePath: 'src/Module/Accounting/Providers/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('admin/accounting')",
          '    ->group(function () {',
          "        $this->loadRoutesFrom(__DIR__ . '/../routes/admin.php');",
          '    });',
        ].join('\n'),
      },
    ]);
    expect(detector.supports(ctx)).toBe(false);
  });

  it('detect() emits surfaces from an inline Route::prefix(..)->group(..) block in a RouteServiceProvider file', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('api/external')->middleware(['api'])->group(function () {",
          "    Route::get('/ping', [PingController::class, 'index']);",
          "    Route::post('/events', [EventsController::class, 'store']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(2);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:GET:/api/external/ping');
    expect(ids).toContain('surface:http:POST:/api/external/events');

    const ping = batch.surfaces.find((s) => s.id === 'surface:http:GET:/api/external/ping')!;
    expect(ping.metadata.declarationLineage).toEqual(['api/external']);
    expect(ping.metadata.explicitProvider).toBe('PingController');
    expect(ping.file_path).toBe('src/Module/ExternalApi/RouteServiceProvider.php');

    // declares_surface edge anchors the surface back to the provider file itself
    const declEdge = batch.edges.find(
      (e) =>
        e.edgeType === 'declares_surface' &&
        e.targetNodeId === 'surface:http:GET:/api/external/ping'
    );
    expect(declEdge).toBeDefined();
    expect(declEdge!.sourceNodeId).toBe('file:src/Module/ExternalApi/RouteServiceProvider.php');
  });

  it('detect() emits a surface from a direct top-level Route::get inside a provider file', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: `Route::get('/api/external/health', [HealthController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/external/health');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('HealthController');
  });

  it('detect() does not emit surfaces from a non-route provider (no route declarations)', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/ExternalApiServiceProvider.php',
        languageId: 'php',
        content: [
          'class ExternalApiServiceProvider extends ServiceProvider {',
          '    public function register(): void {',
          '        $this->app->singleton(ExternalApiClient::class);',
          '    }',
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });

  it('detect() ignores commented-out inline route declarations in a provider file', async () => {
    // The content-based eligibility check must honour comment masking so a
    // provider whose only Route::get is commented out is not treated as a route source.
    const ctx = makeContext([
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          'class ExternalApiServiceProvider extends ServiceProvider {',
          '    public function boot(): void {',
          "        // Route::get('/disabled', [DisabledController::class, 'index']);",
          '    }',
          '}',
        ].join('\n'),
      },
    ]);

    expect(detector.supports(ctx)).toBe(false);
    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(0);
  });

  it('preserves the classic routes/api.php path when both a classic route file and an inline provider are present', async () => {
    // Regression guard: the new heuristic must not interfere with the existing
    // registration flow for conventional route files.
    const ctx = makeContext([
      {
        filePath: 'src/CoreServiceProvider.php',
        languageId: 'php',
        content: `Route::prefix('api')->middleware('api')->group(__DIR__ . '/../routes/api.php');`,
      },
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/invoices', [InvoiceController::class, 'index']);`,
      },
      {
        filePath: 'src/Module/ExternalApi/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          "Route::prefix('api/external')->group(function () {",
          "    Route::get('/ping', [PingController::class, 'index']);",
          '});',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toEqual(['surface:http:GET:/api/external/ping', 'surface:http:GET:/api/invoices']);
  });

  it('detects helper-method routes invoked from boot() in provider files', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/BidRegistration/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          'class RouteServiceProvider extends ServiceProvider',
          '{',
          '    public function boot(): void',
          '    {',
          '        $this->routes(function () {',
          "            Route::group(['prefix' => 'api/bidregistration'], function() {",
          "                Route::middleware(['auth:api'])->group(function () {",
          '                    $this->authApiRoutes();',
          '                });',
          '            });',
          '        });',
          '    }',
          '',
          '    protected function authApiRoutes(): void',
          '    {',
          "        Route::post('/archive', [ArchiveRegistrationController::class, 'store']);",
          "        Route::post('/deny', [DenyRegistrationController::class, 'store']);",
          "        Route::get('/eligibility/{event}', ShowRegistrationEligibilityController::class);",
          '    }',
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:POST:/api/bidregistration/archive');
    expect(ids).toContain('surface:http:POST:/api/bidregistration/deny');
    expect(ids).toContain('surface:http:GET:/api/bidregistration/eligibility/{event}');
  });

  it('detects helper-method routes inside arrow-function group callbacks in provider files', async () => {
    const ctx = makeContext([
      {
        filePath: 'src/Module/SecureDocument/RouteServiceProvider.php',
        languageId: 'php',
        content: [
          'class RouteServiceProvider extends ServiceProvider',
          '{',
          '    public function boot(): void',
          '    {',
          '        $this->routes(function () {',
          "            Route::middleware(['auth:api'])->group(fn() => $this->apiRoutes());",
          '        });',
          '    }',
          '',
          '    protected function apiRoutes(): void',
          '    {',
          "        Route::group(['prefix' => 'api/sdl', 'as' => 'sdl.'], function () {",
          "            Route::post('/persist', [ApiController::class, 'persist'])->name('persist');",
          '        });',
          '    }',
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    const persist = batch.surfaces.find((s) => s.id === 'surface:http:POST:/api/sdl/persist');
    expect(persist).toBeDefined();
    expect(persist!.metadata.declarationLineage).toEqual(['api/sdl']);
    expect(persist!.metadata.explicitProvider).toBe('ApiController');
  });
});
