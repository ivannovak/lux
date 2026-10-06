// Downstream reach across the method / class join (issue #40). A route is handled by a controller
// class, while calls and references come from methods, so the reverse walk has to cross between
// the two without claiming more than the code says:
//   - a reached method reaches the routes of its class that name that method;
//   - a method nothing in the application calls explicitly is reached through its class;
//   - a class reached as a whole reaches all its routes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import type { ConfidenceClass, EdgeType } from '../../../db/types.js';
import { walkDownstream, type DownstreamBudget } from '../downstream.js';

const P = 'symbol:php:App\\';
const CTRL = `${P}Http\\OrderController`;
const SERVICE = `${P}Services\\OrderService`;
const RESOURCE = `${P}Http\\Resources\\OrderResource`;
const SHOW = 'surface:http:GET:/orders/{order}';
const STORE = 'surface:http:POST:/orders';

let dir: string;
let db: LuxDatabase;

function symbol(id: string, filePath = 'app/x.php'): void {
  db.upsertStructuralNode({ id, node_type: 'symbol', file_path: filePath, updated_at: 1 });
}

function surface(id: string, controller: string, controllerMethod?: string): void {
  db.upsertStructuralNode({
    id,
    node_type: 'capability-surface',
    metadata: JSON.stringify({ transport: 'http', controllerMethod }),
    updated_at: 1,
  });
  edge(id, controller, 'handled_by');
}

function edge(
  source: string,
  target: string,
  type: EdgeType,
  confidenceClass: ConfidenceClass = 'proven'
): void {
  db.upsertStructuralEdge({
    id: `${source}->${target}:${type}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: type,
    confidence: 1,
    confidence_class: confidenceClass,
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

function budget(over: Partial<DownstreamBudget> = {}): DownstreamBudget {
  return { depth: 6, maxNodes: 2000, maxFanout: 64, minConfidence: 'framework-inferred', ...over };
}

/** `id @ hops` for every HTTP surface the walk reports from the seeds, sorted. */
function reach(seeds: string[], over: Partial<DownstreamBudget> = {}): string[] {
  return walkDownstream(db, seeds, budget(over))
    .entrySurfaces.filter((entry) => entry.kind === 'http')
    .map((entry) => `${entry.id} @ ${entry.hops}`)
    .sort();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-reach-'));
  db = new LuxDatabase(join(dir, 'lux.db'));

  // GET /orders/{order} -> OrderController@show -> OrderService::find -> OrderResource
  // POST /orders        -> OrderController@store (touches none of that)
  for (const id of [
    CTRL,
    `${CTRL}::__construct`,
    `${CTRL}::show`,
    `${CTRL}::store`,
    `${CTRL}::authorizeOrder`,
    SERVICE,
    `${SERVICE}::find`,
    `${SERVICE}::archive`,
    `${SERVICE}::unused`,
    RESOURCE,
    `${RESOURCE}::toArray`,
    `${RESOURCE}::money`,
  ]) {
    symbol(id);
  }
  surface(SHOW, CTRL, 'show');
  surface(STORE, CTRL, 'store');
  edge(`${CTRL}::__construct`, SERVICE, 'references'); // constructor injection, by type hint
  edge(`${CTRL}::show`, `${CTRL}::authorizeOrder`, 'calls');
  edge(`${CTRL}::show`, `${SERVICE}::find`, 'calls');
  edge(`${SERVICE}::find`, RESOURCE, 'references'); // `new OrderResource($order)`
  edge(`${RESOURCE}::toArray`, `${RESOURCE}::money`, 'calls');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('route -> controller method -> service -> resource', () => {
  it('reaches the route at hops 3 from the resource', () => {
    expect(reach([`${RESOURCE}::toArray`])).toEqual([`${SHOW} @ 3`]);
  });

  it('reports the path it took, from the changed symbol to the handler', () => {
    const [entry] = walkDownstream(db, [`${RESOURCE}::toArray`], budget()).entrySurfaces;

    expect(entry.via).toEqual([
      `${RESOURCE}::toArray`,
      RESOURCE, // crossing: toArray is invoked through its class
      `${SERVICE}::find`, // references OrderResource
      `${CTRL}::show`, // calls OrderService::find; the route names show
    ]);
  });

  it('reaches the route at hops 4 from a helper the resource calls on itself', () => {
    expect(reach([`${RESOURCE}::money`])).toEqual([`${SHOW} @ 4`]);
  });

  it('reaches the route at hops 2 from the service', () => {
    expect(reach([`${SERVICE}::find`])).toEqual([`${SHOW} @ 2`]);
  });

  it('reaches only the route that names the changed controller method, at hops 1', () => {
    expect(reach([`${CTRL}::show`])).toEqual([`${SHOW} @ 1`]);
    expect(reach([`${CTRL}::store`])).toEqual([`${STORE} @ 1`]);
  });

  it('reaches a route through a private helper its handler calls, and not its sibling route', () => {
    expect(reach([`${CTRL}::authorizeOrder`])).toEqual([`${SHOW} @ 2`]);
  });
});

describe('a class reached as a whole', () => {
  it('reaches every route of a controller whose own code changed', () => {
    expect(reach([CTRL])).toEqual([`${SHOW} @ 1`, `${STORE} @ 1`]);
  });

  it('treats a changed constructor as a change to the whole class', () => {
    expect(reach([`${CTRL}::__construct`])).toEqual([`${SHOW} @ 1`, `${STORE} @ 1`]);
  });

  it('reaches every route of a controller whose constructor takes a class that changed as a whole', () => {
    expect(reach([SERVICE])).toEqual([`${SHOW} @ 2`, `${STORE} @ 2`]);
  });
});

describe('no reach the code does not support', () => {
  it('does not take a method with an explicit caller to be reached through its class', () => {
    // archive() is called from one place, a console class no route leads to. The controller's
    // constructor mentions OrderService, which says nothing about archive().
    symbol(`${P}Console\\Archiver::run`);
    edge(`${P}Console\\Archiver::run`, `${SERVICE}::archive`, 'calls');

    expect(reach([`${SERVICE}::archive`])).toEqual([]);
  });

  it('takes a method nothing calls explicitly to be reached through its class', () => {
    // unused() has no caller: it is invoked dynamically or by the framework, if at all, by
    // whatever holds an OrderService. The controller is built with one.
    expect(reach([`${SERVICE}::unused`])).toEqual([`${SHOW} @ 2`, `${STORE} @ 2`]);
  });

  it('does not count a test as an explicit caller', () => {
    symbol(`symbol:php:Tests\\OrderServiceTest::it_runs`, 'tests/Unit/OrderServiceTest.php');
    edge(`symbol:php:Tests\\OrderServiceTest::it_runs`, `${SERVICE}::unused`, 'calls');

    expect(reach([`${SERVICE}::unused`])).toEqual([`${SHOW} @ 2`, `${STORE} @ 2`]);
  });

  it('still reaches through the class a framework hook that something also calls explicitly', () => {
    symbol(`${P}Exports\\OrderExport::rows`);
    edge(`${P}Exports\\OrderExport::rows`, `${RESOURCE}::toArray`, 'calls');

    expect(reach([`${RESOURCE}::toArray`])).toEqual([`${SHOW} @ 3`]);
  });

  it('marks a path that goes through a class as inferred, not proven', () => {
    const viaClass = walkDownstream(db, [`${RESOURCE}::toArray`], budget()).entrySurfaces[0];
    const viaCalls = walkDownstream(db, [`${SERVICE}::find`], budget()).entrySurfaces[0];

    expect(viaClass.weakestConfidence).toBe('framework-inferred');
    expect(viaCalls.weakestConfidence).toBe('proven');
  });
});

describe('an invokable controller', () => {
  const INVOKABLE = `${P}Http\\ExportOrders`;
  const EXPORT = 'surface:http:GET:/orders/export';

  beforeEach(() => {
    for (const id of [INVOKABLE, `${INVOKABLE}::__invoke`, `${INVOKABLE}::rows`]) symbol(id);
    surface(EXPORT, INVOKABLE); // `Route::get('/orders/export', ExportOrders::class)`
    edge(`${INVOKABLE}::__invoke`, `${INVOKABLE}::rows`, 'calls');
  });

  it('is reached at hops 1 from __invoke and at hops 2 from what __invoke calls', () => {
    expect(reach([`${INVOKABLE}::__invoke`])).toEqual([`${EXPORT} @ 1`]);
    expect(reach([`${INVOKABLE}::rows`])).toEqual([`${EXPORT} @ 2`]);
  });
});

describe('commands, jobs, schedules and listeners', () => {
  const JOB = `${P}Jobs\\SyncOrders`;
  const COMMAND = `${P}Console\\PruneOrders`;
  const LISTENER = `${P}Listeners\\NotifyWarehouse`;

  function boundary(id: string, kind: 'job' | 'command' | 'event' | 'schedule', handler?: string) {
    db.upsertOperationalBoundary({ id, repo_root: '.', kind, name: id, trust_tier: 5 });
    if (handler) {
      db.upsertOperationalHandler({
        id: `oph:${id}:${handler}`,
        boundary_id: id,
        symbol_id: handler,
        trust_tier: 5,
      });
    }
  }

  function operational(seeds: string[]): string[] {
    return walkDownstream(db, seeds, budget())
      .entrySurfaces.filter((entry) => entry.kind !== 'http')
      .map((entry) => `${entry.kind} ${entry.id}`)
      .sort();
  }

  beforeEach(() => {
    for (const id of [
      JOB,
      `${JOB}::handle`,
      `${JOB}::chunk`,
      `${JOB}::describe`,
      COMMAND,
      `${COMMAND}::handle`,
      LISTENER,
      `${LISTENER}::handle`,
    ]) {
      symbol(id);
    }
    boundary('opb:job:SyncOrders', 'job', JOB);
    boundary('opb:command:orders:prune', 'command', COMMAND);
    boundary('opb:event:OrderShipped', 'event', LISTENER);
    boundary('opb:schedule:command:orders:prune@Kernel.php:9', 'schedule');
    db.upsertOperationalEdge({
      id: 'ope:schedule->prune',
      source_id: 'opb:schedule:command:orders:prune@Kernel.php:9',
      target_id: 'opb:command:orders:prune',
      edge_type: 'TRIGGERS',
      transport: 'sync',
      trust_tier: 5,
    });
    edge(`${JOB}::handle`, `${JOB}::chunk`, 'calls');
    edge(`${JOB}::handle`, `${SERVICE}::find`, 'calls');
    edge(`${COMMAND}::handle`, `${SERVICE}::archive`, 'calls');
    edge(`${LISTENER}::handle`, `${SERVICE}::archive`, 'calls');
    // describe() is called from a console class only; it is not how the job runs.
    symbol(`${P}Console\\Describe::run`);
    edge(`${P}Console\\Describe::run`, `${JOB}::describe`, 'calls');
  });

  it('reaches a job from its handle method and from what handle calls', () => {
    expect(operational([`${JOB}::handle`])).toEqual(['job opb:job:SyncOrders']);
    expect(operational([`${JOB}::chunk`])).toEqual(['job opb:job:SyncOrders']);
  });

  it('does not reach a job from a method of its class that handle never calls', () => {
    expect(operational([`${JOB}::describe`])).toEqual([]);
  });

  it('reaches a job from a service its handle method calls', () => {
    expect(operational([`${SERVICE}::find`])).toEqual(['job opb:job:SyncOrders']);
  });

  it("reaches a command, the schedule that triggers it, and a listener's event", () => {
    expect(operational([`${SERVICE}::archive`])).toEqual([
      'command opb:command:orders:prune',
      'event opb:event:OrderShipped',
      'schedule opb:schedule:command:orders:prune@Kernel.php:9',
    ]);
  });

  it('reaches a job whose class changed as a whole', () => {
    expect(operational([JOB])).toEqual(['job opb:job:SyncOrders']);
  });
});

describe('the budget', () => {
  it('says the walk was cut short when the depth runs out before the route', () => {
    const cut = walkDownstream(db, [`${RESOURCE}::money`], budget({ depth: 3 }));
    expect(cut.entrySurfaces).toEqual([]);
    expect(cut.truncated).toBe(true);

    const whole = walkDownstream(db, [`${RESOURCE}::money`], budget({ depth: 4 }));
    expect(whole.entrySurfaces.map((entry) => entry.id)).toEqual([SHOW]);
    expect(whole.truncated).toBe(false);
  });

  it('says the walk was cut short when the node budget runs out', () => {
    const cut = walkDownstream(db, [`${RESOURCE}::money`], budget({ maxNodes: 2 }));
    expect(cut.truncated).toBe(true);
  });
});
