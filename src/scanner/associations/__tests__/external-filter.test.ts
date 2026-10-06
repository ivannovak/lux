import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode, StructuralEdge, NodeOrigin } from '../../../db/types.js';
import { getSurfaceFeaturePath } from '../surface-retrieval.js';

// REQ-7 (ADR-3): merged vendor-pack (external) nodes must never surface as a
// capability's consumers/providers/artifacts in surface-retrieval. External
// nodes stay reachable through a trace, never as an app retrieval answer.

const testDir = mkdtempSync(join(tmpdir(), 'lux-external-filter-test-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function symbol(id: string, origin: NodeOrigin): StructuralNode {
  return {
    id,
    node_type: 'symbol',
    file_path: origin === 'local' ? 'app/Thing.php' : 'vendor/framework/Thing.php',
    language_id: 'php',
    symbol_name: id,
    qualified_name: id,
    origin,
    updated_at: now(),
  };
}

function edge(
  id: string,
  type: StructuralEdge['edge_type'],
  source: string,
  target: string
): StructuralEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    edge_type: type,
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
  };
}

describe('surface-retrieval external-node filtering (REQ-7)', () => {
  let db: LuxDatabase;
  const surfaceId = 'capability-surface:GET /api/things';

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(join(testDir, 'project.db'));

    db.upsertStructuralNode({
      id: surfaceId,
      node_type: 'capability-surface',
      symbol_name: 'GET /api/things',
      qualified_name: 'GET /api/things',
      metadata: '{}',
      origin: 'local',
      updated_at: now(),
    });
    db.upsertStructuralNode(symbol('symbol:php:App\\ThingConsumer::call', 'local'));
    db.upsertStructuralNode(symbol('symbol:php:Illuminate\\Router::dispatch', 'vendor-pack'));
    db.upsertStructuralNode(symbol('symbol:php:App\\ThingController::index', 'local'));
    db.upsertStructuralNode(
      symbol('symbol:php:Illuminate\\Routing\\Controller::callAction', 'vendor-pack')
    );

    // Two consumers call the surface; one is app, one is a merged vendor node.
    db.upsertStructuralEdge(
      edge('e:c1', 'calls_surface', 'symbol:php:App\\ThingConsumer::call', surfaceId)
    );
    db.upsertStructuralEdge(
      edge('e:c2', 'calls_surface', 'symbol:php:Illuminate\\Router::dispatch', surfaceId)
    );
    // Two providers handle the surface; one app, one vendor.
    db.upsertStructuralEdge(
      edge('e:p1', 'handled_by', surfaceId, 'symbol:php:App\\ThingController::index')
    );
    db.upsertStructuralEdge(
      edge(
        'e:p2',
        'handled_by',
        surfaceId,
        'symbol:php:Illuminate\\Routing\\Controller::callAction'
      )
    );
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('excludes external consumers and providers from the feature path', () => {
    const path = getSurfaceFeaturePath(db, surfaceId);
    expect(path).not.toBeNull();

    const consumerIds = path!.consumers.map((n) => n.id);
    expect(consumerIds).toContain('symbol:php:App\\ThingConsumer::call');
    expect(consumerIds).not.toContain('symbol:php:Illuminate\\Router::dispatch');
    expect(path!.consumers.every((n) => !LuxDatabase.isExternalNode(n))).toBe(true);

    const providerIds = path!.providers.map((n) => n.id);
    expect(providerIds).toContain('symbol:php:App\\ThingController::index');
    expect(providerIds).not.toContain('symbol:php:Illuminate\\Routing\\Controller::callAction');
  });
});
