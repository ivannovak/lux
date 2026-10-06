import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { resolveOwnershipIntersection } from '../ownership.js';
import type { DeltaTouchSet } from '../types.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-delta-ownership-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function touchSet(symbolIds: string[]): DeltaTouchSet {
  return {
    nodes: [],
    symbolIds,
    surfacesDeclared: [],
    evidenceEdgeCount: 0,
    operationalBoundaries: [],
    orphanedNodeCount: 0,
    symbolChanges: [],
    precision: { fileLevelOnly: [], renamedOnly: [], cosmeticOnly: [], changedOutsideSymbols: [] },
    walkSeeds: symbolIds,
  };
}

/** Insert an HTTP `handled_by` route (surface + handler node + edge) into `db`. */
function addRoute(
  db: LuxDatabase,
  route: string,
  handlerFqcn: string,
  edgeId = `${route}=>${handlerFqcn}`
): void {
  const handlerId = `symbol:php:${handlerFqcn}`;
  db.upsertStructuralNode({ id: route, node_type: 'capability-surface', updated_at: 1 });
  db.upsertStructuralNode({ id: handlerId, node_type: 'symbol', updated_at: 1 });
  db.upsertStructuralEdge({
    id: edgeId,
    source_node_id: route,
    target_node_id: handlerId,
    edge_type: 'handled_by',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

describe('delta ownership intersection (spec 13 Part A, Phase 2b)', () => {
  it('reports a cross-area transition for a touched App\\ handler (source: cross-area-recompute)', () => {
    // kernel worktree: composer.json (Acme\Core) + git HEAD + a populated .lux
    const kernelDir = join(root, 'core');
    mkdirSync(kernelDir, { recursive: true });
    writeFileSync(
      join(kernelDir, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'Acme\\Core\\': 'src/' } } })
    );
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m i', {
      cwd: kernelDir,
    });
    const kdb = new LuxDatabase(join(kernelDir, '.lux', 'lux.db'));
    addRoute(kdb, 'surface:http:GET:/k1', 'Acme\\Core\\C1'); // kernel-owned
    addRoute(kdb, 'surface:http:GET:/k2', 'App\\C2'); // client-override (implements)
    addRoute(kdb, 'surface:http:GET:/k3', 'App\\C3'); // client-gap
    kdb.close();

    // client corpus: composer.json (App), lux.yaml overlay.kernel, vendor symlink, populated .lux
    const client = join(root, 'client');
    mkdirSync(join(client, 'vendor', 'acme'), { recursive: true });
    writeFileSync(
      join(client, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } })
    );
    writeFileSync(join(client, 'lux.yaml'), 'overlay:\n  kernel:\n    package: acme/core\n');
    symlinkSync(kernelDir, join(client, 'vendor', 'acme', 'core'));
    const cdb = new LuxDatabase(join(client, '.lux', 'lux.db'));
    cdb.upsertStructuralNode({ id: 'symbol:php:App\\C2', node_type: 'symbol', updated_at: 1 });

    // a diff touching the App\C2 handler (client-override) and the App\C3 gap handler
    const proj = resolveOwnershipIntersection(
      cdb,
      touchSet(['symbol:php:App\\C2', 'symbol:php:App\\C3']),
      { corpusPath: client }
    );
    cdb.close();

    expect(proj.source).toBe('cross-area-recompute');
    expect(proj.kernelConfigured).toBe(true);
    expect(proj.kernelResolved).toBe(true);
    expect(proj.kernelDrift?.stale).toBe(false);
    const byRoute = Object.fromEntries(proj.transitions.map((t) => [t.route, t]));
    expect(byRoute['surface:http:GET:/k2']).toMatchObject({
      label: 'client-override',
      changedHandler: 'symbol:php:App\\C2',
    });
    expect(byRoute['surface:http:GET:/k3']).toMatchObject({
      label: 'client-gap',
      changedHandler: 'symbol:php:App\\C3',
    });
  });

  it('reads persisted single-index labels when no kernel is configured (source: single-index)', () => {
    const client = join(root, 'plain');
    mkdirSync(client, { recursive: true });
    const cdb = new LuxDatabase(join(client, '.lux', 'lux.db'));
    addRoute(cdb, 'surface:http:GET:/x', 'App\\Handler', 'e1');
    cdb.setEdgeOwnershipBatch([{ id: 'e1', ownership: 'client-override' }]);

    const proj = resolveOwnershipIntersection(cdb, touchSet(['symbol:php:App\\Handler']), {
      corpusPath: client,
    });
    cdb.close();

    expect(proj.source).toBe('single-index');
    expect(proj.kernelConfigured).toBe(false);
    expect(proj.transitions).toEqual([
      {
        route: 'surface:http:GET:/x',
        label: 'client-override',
        changedHandler: 'symbol:php:App\\Handler',
      },
    ]);
  });

  it('degrades to unavailable + warning (never throws) when a configured kernel is unindexed', () => {
    const kernelDir = join(root, 'core-noidx'); // has composer.json but NO .lux index
    mkdirSync(kernelDir, { recursive: true });
    writeFileSync(
      join(kernelDir, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'Acme\\Core\\': 'src/' } } })
    );

    const client = join(root, 'unindexed');
    mkdirSync(join(client, 'vendor', 'acme'), { recursive: true });
    writeFileSync(
      join(client, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } })
    );
    writeFileSync(join(client, 'lux.yaml'), 'overlay:\n  kernel:\n    package: acme/core\n');
    symlinkSync(kernelDir, join(client, 'vendor', 'acme', 'core'));
    const cdb = new LuxDatabase(join(client, '.lux', 'lux.db'));

    let proj!: ReturnType<typeof resolveOwnershipIntersection>;
    expect(() => {
      proj = resolveOwnershipIntersection(cdb, touchSet(['symbol:php:App\\Whatever']), {
        corpusPath: client,
      });
    }).not.toThrow();
    cdb.close();

    expect(proj.source).toBe('unavailable');
    expect(proj.kernelConfigured).toBe(true);
    expect(proj.kernelResolved).toBe(false);
    expect(proj.warning).toBeTruthy();
    expect(proj.transitions).toEqual([]);
  });
});
