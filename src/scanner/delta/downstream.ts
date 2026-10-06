import { CONFIDENCE_RANK } from '../associations/trace.js';
import type { LuxDatabase } from '../../db/index.js';
import type { ConfidenceClass, EdgeType } from '../../db/types.js';
import type { AsyncBoundary, EntrySurfaceImpact } from './types.js';

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
  /** Seed + every symbol reached during the reverse walk — the operational-join key set. */
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

  // bestPathMin[node] = the strongest (max) over reaching paths of the weakest edge rank on that
  // path. A seed's path is unconstrained (proven). Lets us report the honest weakest-confidence
  // for the *best* path to each surface.
  const bestPathMin = new Map<string, number>();
  for (const s of seeds) bestPathMin.set(s, CONFIDENCE_RANK.proven);
  const surfaces = new Map<string, { hops: number; weakest: number }>();
  const visited = new Set<string>(seeds);
  let truncated = false;

  let frontier = [...seeds];
  for (let depth = 0; depth < budget.depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const parentMin = bestPathMin.get(nodeId) ?? CONFIDENCE_RANK.proven;
      // Bounded + filtered in SQL: reverse edge types, at/above the floor, confidence-DESC, capped
      // at maxFanout+1. The +1 keeps `length > maxFanout` a live truncation signal.
      const incoming = db.getIncomingStructuralEdges(nodeId, {
        edgeTypes: reverseEdgeTypes,
        confidenceClasses: allowedClasses,
        limit: budget.maxFanout + 1,
      });
      if (incoming.length > budget.maxFanout) truncated = true;
      for (const edge of incoming.slice(0, budget.maxFanout)) {
        // edges are confidence-DESC ordered → the fanout cap keeps the strongest
        const source = edge.source_node_id;
        const pathMin = Math.min(parentMin, CONFIDENCE_RANK[edge.confidence_class]);
        if (source.startsWith('surface:http:')) {
          const prev = surfaces.get(source);
          if (!prev || pathMin > prev.weakest || depth + 1 < prev.hops) {
            surfaces.set(source, { hops: depth + 1, weakest: pathMin });
          }
          continue; // terminus: stop at the surface, do not expand past it
        }
        if (visited.size >= budget.maxNodes) {
          truncated = true;
          continue;
        }
        const existing = bestPathMin.get(source);
        if (existing === undefined || pathMin > existing) {
          bestPathMin.set(source, pathMin);
          if (!visited.has(source)) {
            visited.add(source);
            next.push(source);
          }
        }
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
    });
  }

  // (b) operational surfaces + (c) async boundaries — direct symbol_id join over touched+reached.
  const reachSet = [...visited];
  const opRows = reachSet.length ? db.getOperationalBoundariesForSymbols(reachSet) : [];
  const asyncBoundaries: AsyncBoundary[] = [];
  const seenOp = new Set<string>();
  const seenAsync = new Set<string>();
  for (const b of opRows) {
    if (!seenOp.has(b.id)) {
      seenOp.add(b.id);
      entrySurfaces.push({
        // EntrySurfaceImpact['kind'] ≡ OperationalBoundaryKind (frozen contract, types.ts) — b.kind
        // assigns directly; no cast/narrowing needed.
        kind: b.kind,
        id: b.id,
        resolvedVia: 'operational-join',
        weakestConfidence: null, // operational_* carry trust_tier, not confidence_class
      });
    }
    if (
      (b.kind === 'job' || b.kind === 'event' || b.kind === 'schedule') &&
      !seenAsync.has(b.symbol_id)
    ) {
      seenAsync.add(b.symbol_id);
      asyncBoundaries.push({ symbol: b.symbol_id, reachedVia: 'async-boundary' });
    }
  }

  return { entrySurfaces, asyncBoundaries, truncated, visitedSymbols: reachSet };
}
