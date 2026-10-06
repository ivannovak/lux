import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { classifyCrossAreaOwnership, type CrossAreaRoute } from '../ownership.js';
import type { ResolvedKernel } from '../kernel-area.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-xarea-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Insert an HTTP `handled_by` route (surface node + handler node + edge). */
function addRoute(db: LuxDatabase, route: string, handlerFqcn: string): void {
  const handlerId = `symbol:php:${handlerFqcn}`;
  db.upsertStructuralNode({ id: route, node_type: 'capability-surface', updated_at: 1 });
  db.upsertStructuralNode({ id: handlerId, node_type: 'symbol', updated_at: 1 });
  db.upsertStructuralEdge({
    id: `${route}->${handlerId}`,
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
function addNode(db: LuxDatabase, fqcn: string): void {
  db.upsertStructuralNode({ id: `symbol:php:${fqcn}`, node_type: 'symbol', updated_at: 1 });
}

describe('classifyCrossAreaOwnership', () => {
  it('partitions the kernel routes by client coverage and sweeps client-local', () => {
    const kernelPath = join(root, 'kernel', '.lux', 'lux.db');
    const kernelDb = new LuxDatabase(kernelPath);
    addRoute(kernelDb, 'surface:http:GET:/k1', 'Kern\\Core\\C1'); // kernel-owned (inherited)
    addRoute(kernelDb, 'surface:http:GET:/k2', 'App\\C2'); // client-override(implements): client has App\C2
    addRoute(kernelDb, 'surface:http:GET:/k3', 'App\\C3'); // client-gap: client lacks App\C3
    addRoute(kernelDb, 'surface:http:GET:/k4', 'Vendor\\C4'); // external
    addRoute(kernelDb, 'surface:http:GET:/k5', 'Kern\\Core\\C5'); // client-override(route): client serves /k5 too
    kernelDb.close();

    const clientPath = join(root, 'client', '.lux', 'lux.db');
    const clientDb = new LuxDatabase(clientPath);
    addNode(clientDb, 'App\\C2'); // client implements the /k2 handler
    addRoute(clientDb, 'surface:http:GET:/k5', 'App\\Override5'); // client's own handler for a Core route
    addRoute(clientDb, 'surface:http:GET:/c1', 'App\\Local1'); // client-local route

    const kernel: ResolvedKernel = { dbPath: kernelPath, worktree: '', namespace: 'Kern\\Core' };
    const map = classifyCrossAreaOwnership(clientDb, kernel, 'App');
    clientDb.close();

    expect(map.summary).toEqual({
      'kernel-owned': 1,
      'client-override': 2, // 1 implements + 1 route
      'client-gap': 1,
      external: 1,
      'client-local': 1,
    });

    const by: Record<string, CrossAreaRoute> = Object.fromEntries(
      map.routes.map((r) => [r.route, r])
    );
    expect(by['surface:http:GET:/k1'].label).toBe('kernel-owned');
    expect(by['surface:http:GET:/k2']).toMatchObject({
      label: 'client-override',
      overrideKind: 'implements',
    });
    expect(by['surface:http:GET:/k3'].label).toBe('client-gap');
    expect(by['surface:http:GET:/k4'].label).toBe('external');
    expect(by['surface:http:GET:/k5']).toMatchObject({
      label: 'client-override',
      overrideKind: 'route',
      kernelHandler: 'symbol:php:Kern\\Core\\C5',
      clientHandler: 'symbol:php:App\\Override5',
    });
    expect(by['surface:http:GET:/c1']).toMatchObject({
      label: 'client-local',
      clientHandler: 'symbol:php:App\\Local1',
    });
  });

  it('dedups a kernel route that has more than one handled_by edge', () => {
    const kernelPath = join(root, 'kd', '.lux', 'lux.db');
    const kernelDb = new LuxDatabase(kernelPath);
    kernelDb.upsertStructuralNode({
      id: 'surface:http:GET:/dup',
      node_type: 'capability-surface',
      updated_at: 1,
    });
    for (const h of ['Kern\\Core\\A', 'Kern\\Core\\B']) {
      kernelDb.upsertStructuralNode({ id: `symbol:php:${h}`, node_type: 'symbol', updated_at: 1 });
      kernelDb.upsertStructuralEdge({
        id: `e-${h}`,
        source_node_id: 'surface:http:GET:/dup',
        target_node_id: `symbol:php:${h}`,
        edge_type: 'handled_by',
        confidence: 1,
        confidence_class: 'proven',
        freshness_status: 'fresh',
        dirty_dependency_count: 0,
        updated_at: 1,
      });
    }
    kernelDb.close();

    const clientDb = new LuxDatabase(join(root, 'cd', '.lux', 'lux.db'));
    const kernel: ResolvedKernel = { dbPath: kernelPath, worktree: '', namespace: 'Kern\\Core' };
    const map = classifyCrossAreaOwnership(clientDb, kernel, 'App');
    clientDb.close();

    // the route with two handled_by edges counts ONCE, not twice
    expect(map.summary['kernel-owned']).toBe(1);
    expect(map.routes.filter((r) => r.route === 'surface:http:GET:/dup')).toHaveLength(1);
  });

  it('joins a route the kernel declares in two files to the client route by method and path', () => {
    // The kernel declares GET / twice (package routes and a test skeleton), so each declaration
    // has a file-qualified id; the client declares it once, under the bare id.
    const kernelPath = join(root, 'kq', '.lux', 'lux.db');
    const kernelDb = new LuxDatabase(kernelPath);
    addRoute(kernelDb, 'surface:http:GET:/#file:routes/web.php', 'Kern\\Core\\Site');
    addRoute(kernelDb, 'surface:http:GET:/#file:workbench/routes/web.php', 'Kern\\Core\\Welcome');
    kernelDb.close();

    const clientDb = new LuxDatabase(join(root, 'cq', '.lux', 'lux.db'));
    addRoute(clientDb, 'surface:http:GET:/', 'App\\Home');
    const kernel: ResolvedKernel = { dbPath: kernelPath, worktree: '', namespace: 'Kern\\Core' };
    const map = classifyCrossAreaOwnership(clientDb, kernel, 'App');
    clientDb.close();

    expect(map.routes).toEqual([
      {
        route: 'surface:http:GET:/',
        label: 'client-override',
        overrideKind: 'route',
        kernelHandler: 'symbol:php:Kern\\Core\\Site',
        clientHandler: 'symbol:php:App\\Home',
      },
    ]);
    expect(map.summary).toMatchObject({ 'client-override': 1, 'client-local': 0 });
  });

  it('joins a route the client declares in two files to the kernel route the same way', () => {
    const kernelPath = join(root, 'kr', '.lux', 'lux.db');
    const kernelDb = new LuxDatabase(kernelPath);
    addRoute(kernelDb, 'surface:http:GET:/', 'Kern\\Core\\Site');
    kernelDb.close();

    const clientDb = new LuxDatabase(join(root, 'cr', '.lux', 'lux.db'));
    addRoute(clientDb, 'surface:http:GET:/#file:routes/web.php', 'App\\Home');
    addRoute(clientDb, 'surface:http:GET:/#file:routes/extra.php', 'App\\Other');
    const kernel: ResolvedKernel = { dbPath: kernelPath, worktree: '', namespace: 'Kern\\Core' };
    const map = classifyCrossAreaOwnership(clientDb, kernel, 'App');
    clientDb.close();

    expect(map.routes.map((r) => [r.route, r.label, r.clientHandler])).toEqual([
      ['surface:http:GET:/', 'client-override', 'symbol:php:App\\Home'],
    ]);
  });
});
