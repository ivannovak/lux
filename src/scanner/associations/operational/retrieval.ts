import type { LuxDatabase } from '../../../db/index.js';
import type {
  OperationalBoundary,
  OperationalContract,
  OperationalEdge,
  OperationalHandler,
  OperationalBoundaryKind,
  TrustTier,
} from '../../../db/types.js';

export interface BoundaryHandlerLink {
  handler: OperationalHandler;
  edge: OperationalEdge | null;
}

export interface OperationalBoundaryHandlersResult {
  boundary: OperationalBoundary;
  handlers: BoundaryHandlerLink[];
  contracts: OperationalContract[];
}

export interface OperationalUpstreamTrigger {
  edge: OperationalEdge;
  sourceBoundary: OperationalBoundary;
  sourceContracts: OperationalContract[];
}

export interface OperationalUpstreamTriggersResult {
  boundary: OperationalBoundary;
  triggers: OperationalUpstreamTrigger[];
}

export interface OperationalDispatchSource {
  edge: OperationalEdge;
  sourceBoundary: OperationalBoundary | null;
  sourceKind: OperationalBoundaryKind | 'structural-symbol';
  sourceContracts: OperationalContract[];
}

export interface OperationalDispatchSourcesResult {
  jobBoundary: OperationalBoundary;
  dispatchSources: OperationalDispatchSource[];
}

export interface OperationalDispatchedJob {
  edge: OperationalEdge;
  jobBoundary: OperationalBoundary;
  jobContracts: OperationalContract[];
}

export interface OperationalDispatchedJobsResult {
  sourceId: string;
  sourceBoundary: OperationalBoundary | null;
  dispatchedJobs: OperationalDispatchedJob[];
}

export interface OperationalEventListener {
  edge: OperationalEdge;
  handler: OperationalHandler;
}

export interface OperationalEventListenersResult {
  eventBoundary: OperationalBoundary;
  listeners: OperationalEventListener[];
  contracts: OperationalContract[];
}

export interface OperationalNeighborhoodNode {
  id: string;
  kind: 'boundary' | 'structural-symbol';
  boundaryKind?: OperationalBoundaryKind;
  name?: string;
  trustTier?: TrustTier;
  depth: number;
}

export interface OperationalNeighborhoodEdge {
  id: string;
  direction: 'inbound' | 'outbound';
  sourceId: string;
  targetId: string;
  edgeType: OperationalEdge['edge_type'];
  transport?: OperationalEdge['transport'];
  trustTier: TrustTier;
  sourceBoundaryKind?: OperationalBoundaryKind;
}

export interface OperationalNeighborhoodResult {
  seedId: string;
  maxDepth: number;
  minTrustTier: TrustTier;
  nodes: OperationalNeighborhoodNode[];
  edges: OperationalNeighborhoodEdge[];
  trustSummary: {
    minTrustTier: TrustTier;
    maxTrustTier: TrustTier;
    mixedTrust: boolean;
  };
}

export function getOperationalBoundaryHandlers(
  db: LuxDatabase,
  boundaryId: string
): OperationalBoundaryHandlersResult | null {
  const boundary = db.getOperationalBoundary(boundaryId);
  if (!boundary) return null;

  const handlers = db.getOperationalHandlersForBoundary(boundaryId);
  const handlerEdges = db
    .getOperationalEdgesForSource(boundaryId)
    .filter((edge) => edge.edge_type === 'HANDLED_BY');
  const contracts = db.getOperationalContractsForBoundary(boundaryId);

  return {
    boundary,
    handlers: handlers.map((handler) => ({
      handler,
      edge:
        handlerEdges.find(
          (edge) => edge.target_id === handler.symbol_id && edge.edge_type === 'HANDLED_BY'
        ) ?? null,
    })),
    contracts,
  };
}

export function getOperationalUpstreamTriggers(
  db: LuxDatabase,
  boundaryId: string
): OperationalUpstreamTriggersResult | null {
  const boundary = db.getOperationalBoundary(boundaryId);
  if (!boundary) return null;

  const triggerEdges = db
    .getOperationalEdgesForTarget(boundaryId)
    .filter((edge) => edge.edge_type === 'TRIGGERS');

  const triggers: OperationalUpstreamTrigger[] = [];
  for (const edge of triggerEdges) {
    const sourceBoundary = db.getOperationalBoundary(edge.source_id);
    if (!sourceBoundary) continue;

    triggers.push({
      edge,
      sourceBoundary,
      sourceContracts: db.getOperationalContractsForBoundary(sourceBoundary.id),
    });
  }

  triggers.sort(
    (left, right) =>
      right.edge.trust_tier - left.edge.trust_tier ||
      left.sourceBoundary.kind.localeCompare(right.sourceBoundary.kind) ||
      left.sourceBoundary.name.localeCompare(right.sourceBoundary.name)
  );

  return {
    boundary,
    triggers,
  };
}

export function getOperationalDispatchSourcesForJob(
  db: LuxDatabase,
  jobBoundaryId: string
): OperationalDispatchSourcesResult | null {
  const jobBoundary = db.getOperationalBoundary(jobBoundaryId);
  if (!jobBoundary || jobBoundary.kind !== 'job') return null;

  const dispatchEdges = db
    .getOperationalEdgesForTarget(jobBoundary.id)
    .filter((edge) => edge.edge_type === 'DISPATCHES');

  const dispatchSources: OperationalDispatchSource[] = dispatchEdges.map((edge) => {
    const sourceBoundary = db.getOperationalBoundary(edge.source_id);

    return {
      edge,
      sourceBoundary,
      sourceKind: sourceBoundary?.kind ?? 'structural-symbol',
      sourceContracts: sourceBoundary
        ? db.getOperationalContractsForBoundary(sourceBoundary.id)
        : [],
    };
  });

  dispatchSources.sort((left, right) => right.edge.trust_tier - left.edge.trust_tier);

  return {
    jobBoundary,
    dispatchSources,
  };
}

export function getOperationalDispatchedJobs(
  db: LuxDatabase,
  sourceId: string
): OperationalDispatchedJobsResult {
  const sourceBoundary = db.getOperationalBoundary(sourceId);
  const dispatchEdges = db
    .getOperationalEdgesForSource(sourceId)
    .filter((edge) => edge.edge_type === 'DISPATCHES');

  const dispatchedJobs: OperationalDispatchedJob[] = [];

  for (const edge of dispatchEdges) {
    const boundary = db.getOperationalBoundary(edge.target_id);
    if (!boundary || boundary.kind !== 'job') continue;

    dispatchedJobs.push({
      edge,
      jobBoundary: boundary,
      jobContracts: db.getOperationalContractsForBoundary(boundary.id),
    });
  }

  dispatchedJobs.sort(
    (left, right) =>
      right.edge.trust_tier - left.edge.trust_tier || left.edge.id.localeCompare(right.edge.id)
  );

  return {
    sourceId,
    sourceBoundary,
    dispatchedJobs,
  };
}

export function getOperationalEventListeners(
  db: LuxDatabase,
  eventBoundaryId: string
): OperationalEventListenersResult | null {
  const eventBoundary = db.getOperationalBoundary(eventBoundaryId);
  if (!eventBoundary || eventBoundary.kind !== 'event') return null;

  const handlers = db.getOperationalHandlersForBoundary(eventBoundaryId);
  const handlerBySymbol = new Map(handlers.map((handler) => [handler.symbol_id, handler]));

  const listeners: OperationalEventListener[] = [];
  for (const edge of db.getOperationalEdgesForSource(eventBoundaryId)) {
    if (edge.edge_type !== 'HANDLED_BY') continue;

    const handler = handlerBySymbol.get(edge.target_id);
    if (!handler) continue;

    listeners.push({ edge, handler });
  }

  listeners.sort((left, right) => right.edge.trust_tier - left.edge.trust_tier);

  return {
    eventBoundary,
    listeners,
    contracts: db.getOperationalContractsForBoundary(eventBoundaryId),
  };
}

export function getTrustAwareOperationalNeighborhood(
  db: LuxDatabase,
  seedId: string,
  options?: {
    maxDepth?: number;
    minTrustTier?: TrustTier;
  }
): OperationalNeighborhoodResult {
  const maxDepth = options?.maxDepth ?? 2;
  const minTrustTier = options?.minTrustTier ?? 1;

  const nodes = new Map<string, OperationalNeighborhoodNode>();
  const edges = new Map<string, OperationalNeighborhoodEdge>();
  const seenDepth = new Map<string, number>([[seedId, 0]]);
  const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    upsertNeighborhoodNode(nodes, db, current.id, current.depth);

    if (current.depth >= maxDepth) {
      continue;
    }

    const outboundEdges = db.getOperationalEdgesForSource(current.id);
    for (const edge of outboundEdges) {
      if (edge.trust_tier < minTrustTier) continue;

      const edgeId = `outbound:${edge.id}`;
      edges.set(edgeId, {
        id: edge.id,
        direction: 'outbound',
        sourceId: edge.source_id,
        targetId: edge.target_id,
        edgeType: edge.edge_type,
        transport: edge.transport,
        trustTier: edge.trust_tier,
        sourceBoundaryKind: db.getOperationalBoundary(edge.source_id)?.kind,
      });

      const nextDepth = current.depth + 1;
      upsertNeighborhoodNode(nodes, db, edge.target_id, nextDepth);
      const seen = seenDepth.get(edge.target_id);
      if (seen === undefined || nextDepth < seen) {
        seenDepth.set(edge.target_id, nextDepth);
        queue.push({ id: edge.target_id, depth: nextDepth });
      }
    }

    const inboundEdges = db.getOperationalEdgesForTarget(current.id);
    for (const edge of inboundEdges) {
      if (edge.trust_tier < minTrustTier) continue;

      const edgeId = `inbound:${edge.id}`;
      edges.set(edgeId, {
        id: edge.id,
        direction: 'inbound',
        sourceId: edge.source_id,
        targetId: edge.target_id,
        edgeType: edge.edge_type,
        transport: edge.transport,
        trustTier: edge.trust_tier,
        sourceBoundaryKind: db.getOperationalBoundary(edge.source_id)?.kind,
      });

      const nextDepth = current.depth + 1;
      upsertNeighborhoodNode(nodes, db, edge.source_id, nextDepth);
      const seen = seenDepth.get(edge.source_id);
      if (seen === undefined || nextDepth < seen) {
        seenDepth.set(edge.source_id, nextDepth);
        queue.push({ id: edge.source_id, depth: nextDepth });
      }
    }
  }

  const edgeValues = Array.from(edges.values());
  const trustTiers =
    edgeValues.length > 0 ? edgeValues.map((edge) => edge.trustTier) : [minTrustTier];

  return {
    seedId,
    maxDepth,
    minTrustTier,
    nodes: Array.from(nodes.values()).sort(
      (left, right) => left.depth - right.depth || left.id.localeCompare(right.id)
    ),
    edges: edgeValues.sort(
      (left, right) => right.trustTier - left.trustTier || left.id.localeCompare(right.id)
    ),
    trustSummary: {
      minTrustTier: Math.min(...trustTiers) as TrustTier,
      maxTrustTier: Math.max(...trustTiers) as TrustTier,
      mixedTrust: new Set(trustTiers).size > 1,
    },
  };
}

export function formatOperationalNeighborhoodSummary(
  neighborhood: OperationalNeighborhoodResult
): string {
  const lines: string[] = [];
  lines.push(`Seed: ${neighborhood.seedId}`);
  lines.push(
    `Trust: tier ${neighborhood.trustSummary.minTrustTier}-${neighborhood.trustSummary.maxTrustTier}` +
      (neighborhood.trustSummary.mixedTrust ? ' (mixed)' : '')
  );
  lines.push(`Nodes: ${neighborhood.nodes.length}`);
  lines.push(`Edges: ${neighborhood.edges.length}`);

  for (const edge of neighborhood.edges.slice(0, 8)) {
    const transportLabel = edge.transport ? ` [${edge.transport}]` : '';
    lines.push(
      `- ${edge.sourceId} -> ${edge.targetId} ${edge.edgeType}${transportLabel} (tier ${edge.trustTier}, ${edge.direction})`
    );
  }

  return lines.join('\n');
}

/** `_repoRoot` is unused: an index describes one repository, so every stored boundary is its own. */
export function formatFileOperationalBoundaryBlock(
  db: LuxDatabase,
  _repoRoot: string,
  filePath: string
): string | null {
  const boundaries = db
    .getOperationalBoundaries()
    .filter((boundary) => boundary.file_path === filePath);
  if (boundaries.length === 0) return null;

  const lines: string[] = ['Operational Boundaries:'];

  for (const boundary of boundaries) {
    lines.push(`- ${boundary.kind}:${boundary.name} (tier ${boundary.trust_tier})`);

    const handlers = getOperationalBoundaryHandlers(db, boundary.id);
    if (handlers && handlers.handlers.length > 0) {
      const handlerSummary = handlers.handlers
        .slice(0, 3)
        .map(
          (entry) =>
            `${entry.handler.symbol_id}${entry.edge?.transport ? ` [${entry.edge.transport}]` : ''}`
        )
        .join(', ');
      lines.push(`  handlers: ${handlerSummary}`);
    }

    const upstream = getOperationalUpstreamTriggers(db, boundary.id);
    if (upstream && upstream.triggers.length > 0) {
      const upstreamSummary = upstream.triggers
        .slice(0, 3)
        .map(
          (entry) =>
            `${entry.sourceBoundary.kind}:${entry.sourceBoundary.name} [${entry.edge.transport ?? 'n/a'}|tier ${entry.edge.trust_tier}]`
        )
        .join(', ');
      lines.push(`  upstream: ${upstreamSummary}`);
    }

    if (boundary.kind === 'job') {
      const sources = getOperationalDispatchSourcesForJob(db, boundary.id);
      if (sources && sources.dispatchSources.length > 0) {
        const sourceSummary = sources.dispatchSources
          .slice(0, 3)
          .map(
            (entry) =>
              `${entry.edge.source_id} [${entry.edge.transport ?? 'n/a'}|tier ${entry.edge.trust_tier}]`
          )
          .join(', ');
        lines.push(`  dispatch-sources: ${sourceSummary}`);
      }
    }

    if (boundary.kind === 'event') {
      const listeners = getOperationalEventListeners(db, boundary.id);
      if (listeners && listeners.listeners.length > 0) {
        const listenerSummary = listeners.listeners
          .slice(0, 3)
          .map(
            (entry) =>
              `${entry.handler.symbol_id} [${entry.edge.transport ?? 'n/a'}|tier ${entry.edge.trust_tier}]`
          )
          .join(', ');
        lines.push(`  listeners: ${listenerSummary}`);
      }
    }
  }

  return lines.join('\n');
}

function upsertNeighborhoodNode(
  nodes: Map<string, OperationalNeighborhoodNode>,
  db: LuxDatabase,
  nodeId: string,
  depth: number
): void {
  const existing = nodes.get(nodeId);
  if (existing && existing.depth <= depth) return;

  const boundary = db.getOperationalBoundary(nodeId);
  if (boundary) {
    nodes.set(nodeId, {
      id: boundary.id,
      kind: 'boundary',
      boundaryKind: boundary.kind,
      name: boundary.name,
      trustTier: boundary.trust_tier,
      depth,
    });
    return;
  }

  nodes.set(nodeId, {
    id: nodeId,
    kind: 'structural-symbol',
    depth,
  });
}
