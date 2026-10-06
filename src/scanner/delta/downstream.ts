import { CONFIDENCE_RANK } from '../associations/trace.js';
import type { LuxDatabase } from '../../db/index.js';
import type { ConfidenceClass, EdgeType } from '../../db/types.js';
import type { AsyncBoundary, EntrySurfaceImpact } from './types.js';
import { bareId, fileQualifiedId } from '../identity/file-qualified-id.js';

// The reverse walk from the changed symbols to the entry surfaces that reach them.
//
// The graph joins two granularities. A route is `handled_by` a controller class, an operational
// boundary is handled by a job, command or listener class, while `calls` and `references` edges
// come from methods. A walk that only follows edges never crosses from a method to the routes of
// its class, so three rules cross it, none of which claims more than the code states:
//
//   1. A reached method reaches the routes of its class that name it: `[C::class, 'show']` for
//      `C::show`, a route to `C::class` alone for `C::__invoke`. It reaches the jobs, commands and
//      listeners its class handles when it is their entry method (`handle`, `__invoke`). Other
//      methods of the class reach them only if the walk gets from them to that method.
//   2. A method the application never calls explicitly is taken to be invoked through its class,
//      by the framework or dynamically (a resource's `toArray`, a policy method): the walk goes on
//      to whatever references the class. A method with an explicit caller is reached through its
//      callers only; that some constructor mentions its class says nothing about it. A caller in
//      a test is not the application, and a framework hook (HOOK_METHODS, magic methods) is taken
//      to be invoked through its class even when something also calls it.
//   3. A class reached as a whole (its own code changed, its constructor changed, or an edge
//      whose source is the class) reaches every route and boundary it handles.
//
// Crossing by rule 2 is an inference, so a path that uses it reports `framework-inferred` at
// best. Crossings cost no hop: hops count edges.

/** Reverse edge set for HTTP-surface reachability (Decision 4). Direction-specific — NOT
 *  trace's forward default. `declares_surface` is redundant-but-harmless (kept; see 12-SPEC). */
const REVERSE_EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  'calls',
  'references',
  'handled_by',
  'declares_surface',
]);

/** rank → class, the inverse of trace's CONFIDENCE_RANK (proven 3 … heuristic 0). */
const RANK_TO_CLASS: ConfidenceClass[] = [
  'heuristic',
  'framework-inferred',
  'artifact-backed',
  'proven',
];

/** The method a route to a bare class, a queued job, a command or a listener enters by. */
const ENTRY_METHODS: ReadonlySet<string> = new Set(['handle', '__invoke']);

/** Methods the framework calls on an object it was handed, whatever else calls them. */
const HOOK_METHODS: ReadonlySet<string> = new Set([
  'handle',
  'toArray',
  'toResponse',
  'jsonSerialize',
  'rules',
  'authorize',
  'render',
  'boot',
  'booted',
  'register',
]);

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|Test\.php$|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** How a node was reached: as a whole, or only as the class through which a method is invoked. */
type Reach = 'whole' | 'holders';

interface Visit {
  id: string;
  reach: Reach;
}

export interface DownstreamBudget {
  depth: number;
  maxNodes: number;
  maxFanout: number;
  minConfidence: ConfidenceClass;
}

export interface DownstreamResult {
  entrySurfaces: EntrySurfaceImpact[];
  asyncBoundaries: AsyncBoundary[];
  truncated: boolean;
  /** The seeds and every node the walk reached as a whole. */
  visitedSymbols: string[];
}

/**
 * Reverse walk from `seeds` (the changed symbols; delta/changed-symbols.ts) to the entry surfaces
 * that reach them.
 */
export function walkDownstream(
  db: LuxDatabase,
  seeds: readonly string[],
  budget: DownstreamBudget
): DownstreamResult {
  const floor = CONFIDENCE_RANK[budget.minConfidence];
  // Confidence classes at or above the floor — pushed into the bounded frontier query so the SQL
  // LIMIT (below) applies to the *qualifying* incoming set, not all incoming edges.
  const allowedClasses = (Object.keys(CONFIDENCE_RANK) as ConfidenceClass[]).filter(
    (c) => CONFIDENCE_RANK[c] >= floor
  );
  const reverseEdgeTypes = [...REVERSE_EDGE_TYPES];
  const incomingTo = (nodeId: string, edgeTypes: readonly string[]) =>
    db.getIncomingStructuralEdges(nodeId, {
      edgeTypes,
      confidenceClasses: allowedClasses,
      limit: budget.maxFanout + 1,
    });

  // bestPathMin[visit] = the strongest (max) over reaching paths of the weakest edge rank on that
  // path. A seed's path is unconstrained (proven). Lets us report the honest weakest-confidence
  // for the *best* path to each surface.
  const keyOf = (visit: Visit): string =>
    visit.reach === 'whole' ? visit.id : `${visit.id}\u0000`;
  const bestPathMin = new Map<string, number>();
  const visited = new Set<string>();
  const whole = new Set<string>();
  const surfaces = new Map<string, { hops: number; weakest: number; from: string }>();
  /** The visit each visit was first reached from; a seed has none. */
  const cameFrom = new Map<string, string | undefined>();
  let truncated = false;

  const reachSurface = (id: string, hops: number, weakest: number, from: Visit): void => {
    const prev = surfaces.get(id);
    if (!prev || weakest > prev.weakest || hops < prev.hops) {
      surfaces.set(id, { hops, weakest, from: keyOf(from) });
    }
  };
  /** Queue a visit unless it was made at least as strongly already, or the budget is spent. */
  const enqueue = (queue: Visit[], visit: Visit, pathMin: number, from?: Visit): void => {
    if (visit.reach === 'holders' && whole.has(visit.id)) return; // the whole class covers it
    const key = keyOf(visit);
    const existing = bestPathMin.get(key);
    if (existing !== undefined && pathMin <= existing) return;
    if (!visited.has(key) && visited.size >= budget.maxNodes) {
      truncated = true;
      return;
    }
    bestPathMin.set(key, pathMin);
    if (visited.has(key)) return;
    visited.add(key);
    cameFrom.set(key, from ? keyOf(from) : undefined);
    if (visit.reach === 'whole') whole.add(visit.id);
    queue.push(visit);
  };

  let frontier: Visit[] = [];
  for (const seed of seeds) enqueue(frontier, { id: seed, reach: 'whole' }, CONFIDENCE_RANK.proven);

  for (let depth = 0; depth < budget.depth && frontier.length > 0; depth++) {
    const next: Visit[] = [];
    // The frontier grows while it is read: a crossing (method to class) costs no hop.
    for (let at = 0; at < frontier.length; at++) {
      const visit = frontier[at];
      const parentMin = bestPathMin.get(keyOf(visit)) ?? CONFIDENCE_RANK.proven;
      // Bounded + filtered in SQL: reverse edge types, at/above the floor, confidence-DESC, capped
      // at maxFanout+1. The +1 keeps `length > maxFanout` a live truncation signal.
      const incoming = incomingTo(visit.id, reverseEdgeTypes);
      if (incoming.length > budget.maxFanout) truncated = true;
      for (const edge of incoming.slice(0, budget.maxFanout)) {
        // edges are confidence-DESC ordered → the fanout cap keeps the strongest
        const pathMin = Math.min(parentMin, CONFIDENCE_RANK[edge.confidence_class]);
        if (edge.source_node_id.startsWith('surface:http:')) {
          // Rule 3. A class visited only for its holders does not reach its routes.
          if (visit.reach === 'whole') reachSurface(edge.source_node_id, depth + 1, pathMin, visit);
          continue; // terminus: stop at the surface, do not expand past it
        }
        enqueue(next, { id: edge.source_node_id, reach: 'whole' }, pathMin, visit);
      }

      const member = memberOf(db, visit.id);
      if (!member) continue;
      // Rule 1: the routes of the class that name this method.
      for (const edge of incomingTo(member.classId, ['handled_by'])) {
        if (!edge.source_node_id.startsWith('surface:http:')) continue;
        if (handlerMethodOf(db, edge.source_node_id) !== member.method) continue;
        reachSurface(
          edge.source_node_id,
          depth + 1,
          Math.min(parentMin, CONFIDENCE_RANK[edge.confidence_class]),
          visit
        );
      }
      // Rules 3 and 2: the constructor stands for the whole class; a method nothing calls
      // explicitly is invoked through the class.
      if (member.method === '__construct') {
        enqueue(frontier, { id: member.classId, reach: 'whole' }, parentMin, visit);
      } else if (invokedThroughItsClass(db, member.method, incoming)) {
        enqueue(
          frontier,
          { id: member.classId, reach: 'holders' },
          Math.min(parentMin, CONFIDENCE_RANK['framework-inferred']),
          visit
        );
      }
    }
    frontier = next;
  }
  if (frontier.length > 0) truncated = true; // depth budget hit with a live frontier

  const entrySurfaces: EntrySurfaceImpact[] = [];
  for (const [id, info] of surfaces) {
    entrySurfaces.push({
      kind: 'http',
      id,
      resolvedVia: 'structural-walk',
      hops: info.hops,
      weakestConfidence: RANK_TO_CLASS[info.weakest] ?? null,
      via: pathTo(info.from, cameFrom),
    });
  }

  // (b) operational surfaces + (c) async boundaries — joined on the classes that handle them:
  // a class reached as a whole, or the class of a reached entry method (rule 1).
  const handlerClasses = new Set(whole);
  for (const id of whole) {
    const member = memberOf(db, id);
    if (member && ENTRY_METHODS.has(member.method)) handlerClasses.add(member.classId);
  }
  const reachSet = [...handlerClasses];
  const opRows = reachSet.length ? db.getOperationalBoundariesForSymbols(reachSet) : [];
  const asyncBoundaries: AsyncBoundary[] = [];
  const seenOp = new Set<string>();
  const seenAsync = new Set<string>();
  const reachBoundary = (kind: EntrySurfaceImpact['kind'], id: string): void => {
    if (seenOp.has(id)) return;
    seenOp.add(id);
    entrySurfaces.push({
      kind,
      id,
      resolvedVia: 'operational-join',
      weakestConfidence: null, // operational_* carry trust_tier, not confidence_class
    });
  };
  for (const b of opRows) {
    // EntrySurfaceImpact['kind'] ≡ OperationalBoundaryKind (frozen contract, types.ts) — b.kind
    // assigns directly; no cast/narrowing needed.
    reachBoundary(b.kind, b.id);
    // A schedule has no handler of its own: it is reached through the command or job it triggers.
    for (const trigger of db.getOperationalEdgesForTarget(b.id)) {
      if (trigger.edge_type !== 'TRIGGERS') continue;
      const source = db.getOperationalBoundary(trigger.source_id);
      if (source) reachBoundary(source.kind, source.id);
    }
    if (
      (b.kind === 'job' || b.kind === 'event' || b.kind === 'schedule') &&
      !seenAsync.has(b.symbol_id)
    ) {
      seenAsync.add(b.symbol_id);
      asyncBoundaries.push({ symbol: b.symbol_id, reachedVia: 'async-boundary' });
    }
  }

  return { entrySurfaces, asyncBoundaries, truncated, visitedSymbols: [...whole] };
}

/** The node ids from a changed symbol to the visit that reached a surface, in that order. */
function pathTo(key: string, cameFrom: ReadonlyMap<string, string | undefined>): string[] {
  const path: string[] = [];
  for (let at: string | undefined = key; at !== undefined; at = cameFrom.get(at)) {
    path.push(at.endsWith('\u0000') ? at.slice(0, -1) : at);
  }
  return path.reverse();
}

/** The class a method node belongs to, and the method's name; null for any other node. */
function memberOf(db: LuxDatabase, id: string): { classId: string; method: string } | null {
  const bare = bareId(id);
  let classBare: string;
  let method: string;
  if (bare.startsWith('symbol:php:')) {
    const at = bare.lastIndexOf('::');
    if (at === -1) return null;
    classBare = bare.slice(0, at);
    method = bare.slice(at + 2);
  } else if (bare.startsWith('symbol:ts:')) {
    const hash = bare.lastIndexOf('#');
    const dot = bare.indexOf('.', hash);
    if (hash === -1 || dot === -1) return null;
    classBare = bare.slice(0, dot);
    method = bare.slice(dot + 1);
  } else {
    return null;
  }
  // A class two files declare is stored file-qualified, like its members.
  const file = id === bare ? undefined : id.slice(bare.length + '#file:'.length);
  const qualified = file === undefined ? undefined : fileQualifiedId(classBare, file);
  const classId =
    qualified !== undefined && db.getStructuralNode(qualified) ? qualified : classBare;
  return { classId, method };
}

/** The controller method a route names; a route to a bare class enters by `__invoke`. */
function handlerMethodOf(db: LuxDatabase, surfaceId: string): string {
  const metadata = db.getStructuralNode(surfaceId)?.metadata;
  if (!metadata) return '__invoke';
  try {
    const named = (JSON.parse(metadata) as { controllerMethod?: unknown }).controllerMethod;
    return typeof named === 'string' && named !== '' ? named : '__invoke';
  } catch {
    // lux-intentional-swallow: surface metadata that is not JSON names no method; the route is then matched as a route to the bare class.
    return '__invoke';
  }
}

/** Rule 2: whether nothing in the application calls this method explicitly, or it is a hook. */
function invokedThroughItsClass(
  db: LuxDatabase,
  method: string,
  incoming: ReadonlyArray<{ edge_type: string; source_node_id: string }>
): boolean {
  if (HOOK_METHODS.has(method) || method.startsWith('__')) return true;
  return !incoming.some((edge) => {
    if (edge.edge_type !== 'calls') return false;
    const path = db.getStructuralNode(edge.source_node_id)?.file_path;
    return !(path && TEST_PATH.test(path));
  });
}
