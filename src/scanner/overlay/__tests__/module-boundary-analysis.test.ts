import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import {
  BOUNDARY_RUBRIC_SETTINGS,
  aggregateModuleBoundaryEvidence,
  canBoundaryEdgeStandAlone,
  classifyBoundaryEvidence,
  classifyBoundaryEvidenceTier,
  classifyBoundaryNodeOwnership,
  getBoundaryEvidenceWeight,
  isGraphFormingBoundaryEdgeType,
  isGlueNode,
  projectBoundaryPathsThroughGlue,
  isProjectionSupportEdgeType,
  isReinforcementBoundaryEdgeType,
} from '../module-boundary-analysis.js';
import { persistRebuildTrustState } from '../../overlay-trust-state.js';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-module-boundary-analysis-test-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, `test-${Date.now()}.db`));
}

function persistOverlayComplete(db: LuxDatabase): void {
  persistRebuildTrustState(
    db,
    {
      mode: 'overlay-complete',
      repoPath: '/repo',
      configSource: 'lux.yaml',
      configLspEnabled: true,
      surfaceCount: 2,
      detectorEdgeCount: 2,
      propagatedEdgeCount: 2,
      fileNodeCount: 8,
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
}

function upsertNode(db: LuxDatabase, node: Omit<StructuralNode, 'updated_at'>): void {
  db.upsertStructuralNode({ ...node, updated_at: now() });
}

function upsertEdge(
  db: LuxDatabase,
  edge: Omit<StructuralEdge, 'updated_at' | 'dirty_dependency_count'>
): void {
  db.upsertStructuralEdge({ ...edge, updated_at: now(), dirty_dependency_count: 0 });
}

describe('module-boundary rubric', () => {
  it('classifies service resolution as graph-forming standalone evidence', () => {
    const entry = classifyBoundaryEvidence('resolves_service');

    expect(entry.family).toBe('service-container');
    expect(entry.role).toBe('graph-forming');
    expect(entry.defaultTier).toBe('overlay-backed');
    expect(entry.canStandAlone).toBe(true);
    expect(isGraphFormingBoundaryEdgeType('resolves_service')).toBe(true);
  });

  it('classifies async workflow evidence as graph-forming', () => {
    const entry = classifyBoundaryEvidence('dispatches_job');

    expect(entry.family).toBe('async-workflow');
    expect(entry.role).toBe('graph-forming');
    expect(entry.startingWeight).toBeGreaterThan(0.9);
    expect(canBoundaryEdgeStandAlone('dispatches_job')).toBe(true);
  });

  it('keeps shared contract families reinforcement-first', () => {
    const entry = classifyBoundaryEvidence('shares_contract_family');

    expect(entry.family).toBe('shared-contract-family');
    expect(entry.role).toBe('reinforcement-only');
    expect(entry.defaultTier).toBe('supporting');
    expect(entry.canStandAlone).toBe(false);
    expect(isReinforcementBoundaryEdgeType('shares_contract_family')).toBe(true);
  });

  it('treats declares_surface as projection support rather than direct module truth', () => {
    const entry = classifyBoundaryEvidence('declares_surface');

    expect(entry.family).toBe('projection-through-glue');
    expect(entry.role).toBe('projection-support');
    expect(entry.defaultTier).toBe('projected-overlay');
    expect(isProjectionSupportEdgeType('declares_surface')).toBe(true);
  });

  it('discounts projected paths below direct paths', () => {
    const direct = getBoundaryEvidenceWeight('handled_by', { pathKind: 'direct' });
    const projected = getBoundaryEvidenceWeight('handled_by', {
      pathKind: 'projected-through-glue',
    });

    expect(projected).toBeCloseTo(direct * BOUNDARY_RUBRIC_SETTINGS.projectedPathDiscount, 6);
    expect(classifyBoundaryEvidenceTier('handled_by', 'projected-through-glue')).toBe(
      'projected-overlay'
    );
  });

  it('keeps direct-only mode available for conservative inspection', () => {
    const projected = getBoundaryEvidenceWeight('dispatches_job', {
      pathKind: 'projected-through-glue',
      mode: 'direct-only',
    });
    const direct = getBoundaryEvidenceWeight('dispatches_job', {
      pathKind: 'direct',
      mode: 'direct-only',
    });

    expect(projected).toBe(0);
    expect(direct).toBeGreaterThan(0);
  });

  it('classifies fallback template renders as supporting-only', () => {
    const entry = classifyBoundaryEvidence('renders_template');

    expect(entry.family).toBe('fallback-structure');
    expect(entry.role).toBe('supporting-only');
    expect(entry.defaultTier).toBe('supporting');
    expect(entry.canStandAlone).toBe(false);
  });
});

describe('module-boundary aggregation', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
    persistOverlayComplete(db);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('classifies owned nodes and glue nodes distinctly', () => {
    const owned: StructuralNode = {
      id: 'file:src/Module/Billing/Services/BillingService.php',
      node_type: 'file',
      file_path: 'src/Module/Billing/Services/BillingService.php',
      updated_at: now(),
    };
    const glue: StructuralNode = {
      id: 'file:routes/api.php',
      node_type: 'file',
      file_path: 'routes/api.php',
      updated_at: now(),
    };

    const ownedResult = classifyBoundaryNodeOwnership(owned, '/repo', ['src/Module/{name}']);
    const glueResult = classifyBoundaryNodeOwnership(glue, '/repo', ['src/Module/{name}']);

    expect(ownedResult.kind).toBe('owned-region');
    expect(ownedResult.region).toBe('Billing');
    expect(isGlueNode(glue)).toBe(true);
    expect(glueResult.kind).toBe('glue');
  });

  it('projects through glue while keeping direct evidence separate', () => {
    upsertNode(db, {
      id: 'file:src/Module/Checkout/Actions/PlaceOrder.php',
      node_type: 'file',
      file_path: 'src/Module/Checkout/Actions/PlaceOrder.php',
    });
    upsertNode(db, {
      id: 'file:src/Module/Billing/Services/BillingService.php',
      node_type: 'file',
      file_path: 'src/Module/Billing/Services/BillingService.php',
    });
    upsertNode(db, {
      id: 'surface:http:GET:/billing/invoices',
      node_type: 'capability-surface',
      file_path: 'routes/api.php',
      symbol_name: 'GET /billing/invoices',
    });
    upsertNode(db, {
      id: 'symbol:php:App\\Module\\Listing\\Controllers\\ListingController',
      node_type: 'symbol',
      file_path: 'src/Module/Listing/Controllers/ListingController.php',
      symbol_name: 'ListingController',
    });
    upsertNode(db, {
      id: 'file:src/Module/ListingImport/Services/RunImport.php',
      node_type: 'file',
      file_path: 'src/Module/ListingImport/Services/RunImport.php',
    });

    upsertEdge(db, {
      id: 'checkout->billing:service',
      source_node_id: 'file:src/Module/Checkout/Actions/PlaceOrder.php',
      target_node_id: 'file:src/Module/Billing/Services/BillingService.php',
      edge_type: 'resolves_service',
      confidence: 0.96,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'constructor-service-resolution',
    });
    upsertEdge(db, {
      id: 'listingimport->surface',
      source_node_id: 'file:src/Module/ListingImport/Services/RunImport.php',
      target_node_id: 'surface:http:GET:/billing/invoices',
      edge_type: 'calls_surface',
      confidence: 0.92,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'surface call',
    });
    upsertEdge(db, {
      id: 'surface->listing',
      source_node_id: 'surface:http:GET:/billing/invoices',
      target_node_id: 'symbol:php:App\\Module\\Listing\\Controllers\\ListingController',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'surface handler',
    });

    db.insertModuleDependency({
      source_module: 'Checkout',
      target_module: 'Billing',
      reference_count: 4,
      sample_files: JSON.stringify(['src/Module/Checkout/Actions/PlaceOrder.php']),
    });

    const paths = projectBoundaryPathsThroughGlue(db, { rootPath: '/repo' });
    const directPath = paths.find(
      (path) =>
        path.sourceRegion === 'Checkout' &&
        path.targetRegion === 'Billing' &&
        path.pathKind === 'direct'
    );
    const projectedPath = paths.find(
      (path) =>
        path.sourceRegion === 'ListingImport' &&
        path.targetRegion === 'Listing' &&
        path.pathKind === 'projected-through-glue'
    );

    expect(directPath).toBeDefined();
    expect(directPath?.families).toContain('service-container');
    expect(projectedPath).toBeDefined();
    expect(projectedPath?.families).toContain('surface-bridge');
    expect(projectedPath?.transitFiles).toContain('routes/api.php');

    const aggregates = aggregateModuleBoundaryEvidence(db, { rootPath: '/repo' });
    const checkoutBilling = aggregates.find(
      (aggregate) => aggregate.sourceRegion === 'Checkout' && aggregate.targetRegion === 'Billing'
    );
    const listingImportListing = aggregates.find(
      (aggregate) =>
        aggregate.sourceRegion === 'ListingImport' && aggregate.targetRegion === 'Listing'
    );

    expect(checkoutBilling).toBeDefined();
    expect(checkoutBilling?.directWeight).toBeGreaterThan(0.9);
    expect(checkoutBilling?.supportingWeight).toBeGreaterThan(0);
    expect(checkoutBilling?.relationshipKind).toBe('interacts-with');

    expect(listingImportListing).toBeDefined();
    expect(listingImportListing?.projectedWeight).toBeGreaterThan(0.8);
    expect(listingImportListing?.evidenceTiers).toContain('projected-overlay');
    expect(listingImportListing?.relationshipKind).toBe('interacts-with');
  });

  it('projects through multi-step glue transit when shared controllers point into owned modules', () => {
    upsertNode(db, {
      id: 'file:src/Module/CatalogAdmin/resources/js/services/catalog-api.js',
      node_type: 'file',
      file_path: 'src/Module/CatalogAdmin/resources/js/services/catalog-api.js',
    });
    upsertNode(db, {
      id: 'surface:http:POST:/api/listings/update-sold/{listing}',
      node_type: 'capability-surface',
      file_path: 'routes/api.php',
      symbol_name: 'POST /api/listings/update-sold/{listing}',
    });
    upsertNode(db, {
      id: 'symbol:php:Acme\\Core\\Http\\Controllers\\Api\\ListingController',
      node_type: 'symbol',
      file_path: 'src/Http/Controllers/Api/ListingController.php',
      symbol_name: 'ListingController',
    });
    upsertNode(db, {
      id: 'file:src/Http/Controllers/Api/ListingController.php',
      node_type: 'file',
      file_path: 'src/Http/Controllers/Api/ListingController.php',
    });
    upsertNode(db, {
      id: 'file:src/Module/Listing/Services/ListingCommandService.php',
      node_type: 'file',
      file_path: 'src/Module/Listing/Services/ListingCommandService.php',
    });

    upsertEdge(db, {
      id: 'catalog->surface',
      source_node_id: 'file:src/Module/CatalogAdmin/resources/js/services/catalog-api.js',
      target_node_id: 'surface:http:POST:/api/listings/update-sold/{listing}',
      edge_type: 'calls_surface',
      confidence: 0.9,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'catalog surface call',
    });
    upsertEdge(db, {
      id: 'surface->shared-controller',
      source_node_id: 'surface:http:POST:/api/listings/update-sold/{listing}',
      target_node_id: 'symbol:php:Acme\\Core\\Http\\Controllers\\Api\\ListingController',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'surface handler',
    });
    upsertEdge(db, {
      id: 'shared-controller->listing-service',
      source_node_id: 'file:src/Http/Controllers/Api/ListingController.php',
      target_node_id: 'file:src/Module/Listing/Services/ListingCommandService.php',
      edge_type: 'resolves_service',
      confidence: 0.96,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'shared controller service resolution',
    });

    const paths = projectBoundaryPathsThroughGlue(db, { rootPath: '/repo' });
    const projectedPath = paths.find(
      (path) =>
        path.sourceRegion === 'CatalogAdmin' &&
        path.targetRegion === 'Listing' &&
        path.pathKind === 'projected-through-glue'
    );

    expect(projectedPath).toBeDefined();
    expect(projectedPath?.transitFiles).toContain('routes/api.php');
    expect(projectedPath?.transitFiles).toContain('src/Http/Controllers/Api/ListingController.php');
    expect(projectedPath?.families).toContain('service-container');
    expect(projectedPath?.provenanceSummary).toContain(
      'same-file glue bridge via src/Http/Controllers/Api/ListingController.php'
    );

    const aggregate = aggregateModuleBoundaryEvidence(db, { rootPath: '/repo' }).find(
      (entry) => entry.sourceRegion === 'CatalogAdmin' && entry.targetRegion === 'Listing'
    );

    expect(aggregate).toBeDefined();
    expect(aggregate?.projectedWeight).toBeGreaterThan(1.5);
    expect(aggregate?.relationshipKind).toBe('interacts-with');
  });

  it('keeps projected paths out of direct-only mode', () => {
    upsertNode(db, {
      id: 'file:src/Module/ListingImport/Services/RunImport.php',
      node_type: 'file',
      file_path: 'src/Module/ListingImport/Services/RunImport.php',
    });
    upsertNode(db, {
      id: 'surface:http:GET:/listings',
      node_type: 'capability-surface',
      file_path: 'routes/api.php',
      symbol_name: 'GET /listings',
    });
    upsertNode(db, {
      id: 'symbol:php:App\\Module\\Listing\\Controllers\\ListingController',
      node_type: 'symbol',
      file_path: 'src/Module/Listing/Controllers/ListingController.php',
      symbol_name: 'ListingController',
    });

    upsertEdge(db, {
      id: 'listingimport->surface',
      source_node_id: 'file:src/Module/ListingImport/Services/RunImport.php',
      target_node_id: 'surface:http:GET:/listings',
      edge_type: 'calls_surface',
      confidence: 0.92,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
    });
    upsertEdge(db, {
      id: 'surface->listing',
      source_node_id: 'surface:http:GET:/listings',
      target_node_id: 'symbol:php:App\\Module\\Listing\\Controllers\\ListingController',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
    });

    const projected = aggregateModuleBoundaryEvidence(db, {
      rootPath: '/repo',
      mode: 'projected',
    }).find(
      (aggregate) =>
        aggregate.sourceRegion === 'ListingImport' && aggregate.targetRegion === 'Listing'
    );
    const directOnly = aggregateModuleBoundaryEvidence(db, {
      rootPath: '/repo',
      mode: 'direct-only',
    }).find(
      (aggregate) =>
        aggregate.sourceRegion === 'ListingImport' && aggregate.targetRegion === 'Listing'
    );

    expect(projected?.projectedWeight).toBeGreaterThan(0);
    expect(directOnly).toBeUndefined();
  });

  it('does not invent cross-module aggregates from self-contained module surfaces', () => {
    upsertNode(db, {
      id: 'file:src/Module/Analytics/RouteServiceProvider.php',
      node_type: 'file',
      file_path: 'src/Module/Analytics/RouteServiceProvider.php',
    });
    upsertNode(db, {
      id: 'surface:http:GET:/analytics/summary-activity',
      node_type: 'capability-surface',
      file_path: 'src/Module/Analytics/RouteServiceProvider.php',
      symbol_name: 'GET /analytics/summary-activity',
    });
    upsertNode(db, {
      id: 'symbol:php:App\\Module\\Analytics\\Http\\Controllers\\SummaryActivityController',
      node_type: 'symbol',
      file_path: 'src/Module/Analytics/Http/Controllers/SummaryActivityController.php',
      symbol_name: 'SummaryActivityController',
    });
    upsertNode(db, {
      id: 'file:src/Module/Permission/resources/js/services/team-api.js',
      node_type: 'file',
      file_path: 'src/Module/Permission/resources/js/services/team-api.js',
    });
    upsertNode(db, {
      id: 'surface:http:GET:/admin/api/roles-permissions/team-users',
      node_type: 'capability-surface',
      file_path: 'src/Module/Permission/routes/admin-api.php',
      symbol_name: 'GET /admin/api/roles-permissions/team-users',
    });
    upsertNode(db, {
      id: 'symbol:php:App\\Module\\Permission\\Http\\Controllers\\AdminApi\\TeamUsersIndexController',
      node_type: 'symbol',
      file_path: 'src/Module/Permission/Http/Controllers/AdminApi/TeamUsersIndexController.php',
      symbol_name: 'TeamUsersIndexController',
    });

    upsertEdge(db, {
      id: 'analytics->surface',
      source_node_id: 'file:src/Module/Analytics/RouteServiceProvider.php',
      target_node_id: 'surface:http:GET:/analytics/summary-activity',
      edge_type: 'declares_surface',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'route declaration',
    });
    upsertEdge(db, {
      id: 'surface->analytics-controller',
      source_node_id: 'surface:http:GET:/analytics/summary-activity',
      target_node_id:
        'symbol:php:App\\Module\\Analytics\\Http\\Controllers\\SummaryActivityController',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'surface handler',
    });
    upsertEdge(db, {
      id: 'permission-ui->surface',
      source_node_id: 'file:src/Module/Permission/resources/js/services/team-api.js',
      target_node_id: 'surface:http:GET:/admin/api/roles-permissions/team-users',
      edge_type: 'calls_surface',
      confidence: 0.75,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'script route call',
    });
    upsertEdge(db, {
      id: 'surface->permission-controller',
      source_node_id: 'surface:http:GET:/admin/api/roles-permissions/team-users',
      target_node_id:
        'symbol:php:App\\Module\\Permission\\Http\\Controllers\\AdminApi\\TeamUsersIndexController',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'surface handler',
    });

    const aggregates = aggregateModuleBoundaryEvidence(db, { rootPath: '/repo' });

    expect(
      aggregates.some(
        (aggregate) =>
          aggregate.sourceRegion === 'Analytics' || aggregate.targetRegion === 'Analytics'
      )
    ).toBe(false);
    expect(
      aggregates.some(
        (aggregate) =>
          aggregate.sourceRegion === 'Permission' || aggregate.targetRegion === 'Permission'
      )
    ).toBe(false);
  });

  it('does not remap shared authorization substrate into Permission-owned aggregates', () => {
    upsertNode(db, {
      id: 'file:src/Module/Checkout/Actions/PlaceOrder.php',
      node_type: 'file',
      file_path: 'src/Module/Checkout/Actions/PlaceOrder.php',
    });
    upsertNode(db, {
      id: 'file:src/Module/Billing/Services/BillingService.php',
      node_type: 'file',
      file_path: 'src/Module/Billing/Services/BillingService.php',
    });
    upsertNode(db, {
      id: 'file:src/Module/Permission/routes/admin-api.php',
      node_type: 'file',
      file_path: 'src/Module/Permission/routes/admin-api.php',
    });
    upsertNode(db, {
      id: 'surface:http:GET:/admin/api/roles-permissions/roles',
      node_type: 'capability-surface',
      file_path: 'src/Module/Permission/routes/admin-api.php',
      symbol_name: 'GET /admin/api/roles-permissions/roles',
    });
    upsertNode(db, {
      id: 'file:src/Module/Permission/Http/Controllers/AdminApi/Role/RoleIndexController.php',
      node_type: 'file',
      file_path: 'src/Module/Permission/Http/Controllers/AdminApi/Role/RoleIndexController.php',
    });
    upsertNode(db, {
      id: 'file:src/Module/Listing/Http/Controllers/AdminApi/ListingAuditHistoryController.php',
      node_type: 'file',
      file_path: 'src/Module/Listing/Http/Controllers/AdminApi/ListingAuditHistoryController.php',
    });
    upsertNode(db, {
      id: 'file:src/Enums/UserPermissionEnum.php',
      node_type: 'file',
      file_path: 'src/Enums/UserPermissionEnum.php',
    });
    upsertNode(db, {
      id: 'file:src/User.php',
      node_type: 'file',
      file_path: 'src/User.php',
    });

    upsertEdge(db, {
      id: 'checkout->billing:service',
      source_node_id: 'file:src/Module/Checkout/Actions/PlaceOrder.php',
      target_node_id: 'file:src/Module/Billing/Services/BillingService.php',
      edge_type: 'resolves_service',
      confidence: 0.96,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'constructor-service-resolution',
    });
    upsertEdge(db, {
      id: 'permission-routes->surface',
      source_node_id: 'file:src/Module/Permission/routes/admin-api.php',
      target_node_id: 'surface:http:GET:/admin/api/roles-permissions/roles',
      edge_type: 'declares_surface',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'route declaration',
    });
    upsertEdge(db, {
      id: 'permission-surface->controller',
      source_node_id: 'surface:http:GET:/admin/api/roles-permissions/roles',
      target_node_id:
        'file:src/Module/Permission/Http/Controllers/AdminApi/Role/RoleIndexController.php',
      edge_type: 'handled_by',
      confidence: 0.95,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'surface handler',
    });
    upsertEdge(db, {
      id: 'permission-controller->permission-enum',
      source_node_id:
        'file:src/Module/Permission/Http/Controllers/AdminApi/Role/RoleIndexController.php',
      target_node_id: 'file:src/Enums/UserPermissionEnum.php',
      edge_type: 'uses_contract_family',
      confidence: 0.42,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'shared permission enum',
    });
    upsertEdge(db, {
      id: 'permission-controller->user-model',
      source_node_id:
        'file:src/Module/Permission/Http/Controllers/AdminApi/Role/RoleIndexController.php',
      target_node_id: 'file:src/User.php',
      edge_type: 'calls',
      confidence: 0.2,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'shared authorization user model',
    });
    upsertEdge(db, {
      id: 'listing-controller->permission-enum',
      source_node_id:
        'file:src/Module/Listing/Http/Controllers/AdminApi/ListingAuditHistoryController.php',
      target_node_id: 'file:src/Enums/UserPermissionEnum.php',
      edge_type: 'uses_contract_family',
      confidence: 0.42,
      confidence_class: 'artifact-backed',
      freshness_status: 'fresh',
      provenance_summary: 'shared permission enum',
    });
    upsertEdge(db, {
      id: 'listing-controller->user-model',
      source_node_id:
        'file:src/Module/Listing/Http/Controllers/AdminApi/ListingAuditHistoryController.php',
      target_node_id: 'file:src/User.php',
      edge_type: 'calls',
      confidence: 0.2,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      provenance_summary: 'shared authorization user model',
    });

    db.insertModuleDependency({
      source_module: 'Listing',
      target_module: 'Permission',
      reference_count: 6,
      sample_files: JSON.stringify([
        'src/Module/Listing/Http/Controllers/AdminApi/ListingAuditHistoryController.php',
      ]),
    });

    const aggregates = aggregateModuleBoundaryEvidence(db, { rootPath: '/repo' });

    expect(
      aggregates.some(
        (aggregate) => aggregate.sourceRegion === 'Checkout' && aggregate.targetRegion === 'Billing'
      )
    ).toBe(true);
    expect(
      aggregates.some(
        (aggregate) =>
          aggregate.sourceRegion === 'Permission' || aggregate.targetRegion === 'Permission'
      )
    ).toBe(false);
  });
});
