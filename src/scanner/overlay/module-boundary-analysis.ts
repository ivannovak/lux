import { join } from 'node:path';
import type {
  ConfidenceClass,
  EdgeType,
  ModuleDependency,
  StructuralEdge,
  StructuralNode,
} from '../../db/types.js';
import type { LuxDatabase } from '../../db/index.js';
import { detectModuleBoundaries, resolveModule } from '../imports/module-boundary.js';
import { deriveOverlayTrustLevel, type OverlayTrustLevel } from '../overlay-trust-state.js';
import { compareCodeUnits } from '../scan-order.js';

export type BoundaryEvidenceFamily =
  | 'async-workflow'
  | 'service-container'
  | 'pipeline-lineage'
  | 'contract-lineage'
  | 'shared-contract-family'
  | 'surface-bridge'
  | 'projection-through-glue'
  | 'fallback-structure';

export type BoundaryEvidenceRole =
  'graph-forming' | 'reinforcement-only' | 'projection-support' | 'supporting-only';

export type BoundaryEvidenceTier = 'overlay-backed' | 'projected-overlay' | 'supporting';

export type BoundaryPathKind = 'direct' | 'projected-through-glue';

export type BoundaryAggregationMode = 'projected' | 'direct-only';

export type BoundaryRelationshipKind = 'depends-on' | 'interacts-with' | 'adjacent-to';

export type BoundaryOwnershipKind = 'owned-region' | 'glue' | 'unresolved';

export interface BoundaryNodeOwnership {
  nodeId: string;
  filePath?: string;
  kind: BoundaryOwnershipKind;
  region?: string;
  reason: string;
}

export interface ProjectedBoundaryPath {
  sourceRegion: string;
  targetRegion: string;
  pathKind: BoundaryPathKind;
  directEdgeIds: string[];
  edgeTypes: EdgeType[];
  transitNodeIds?: string[];
  transitFiles?: string[];
  families: BoundaryEvidenceFamily[];
  evidenceTiers: BoundaryEvidenceTier[];
  confidence: number;
  confidenceClass: ConfidenceClass;
  provenanceSummary: string[];
}

export interface SupportingBoundarySignal {
  sourceRegion: string;
  targetRegion: string;
  family: BoundaryEvidenceFamily;
  weight: number;
  provenanceSummary: string;
}

export interface ModuleBoundaryAggregate {
  sourceRegion: string;
  targetRegion: string;
  relationshipKind: BoundaryRelationshipKind;
  evidenceTiers: BoundaryEvidenceTier[];
  directWeight: number;
  projectedWeight: number;
  supportingWeight: number;
  families: BoundaryEvidenceFamily[];
  trustLevel: OverlayTrustLevel;
  samplePaths: ProjectedBoundaryPath[];
  rationaleSummary: string;
  dominantDirection: 'outbound' | 'reciprocal';
}

export interface AggregateModuleBoundaryOptions {
  rootPath: string;
  mode?: BoundaryAggregationMode;
  minWeight?: number;
}

export interface BoundaryEvidenceRubricEntry {
  edgeType: EdgeType;
  family: BoundaryEvidenceFamily;
  role: BoundaryEvidenceRole;
  defaultTier: BoundaryEvidenceTier;
  startingWeight: number;
  canStandAlone: boolean;
  preferredConfidenceClasses: ConfidenceClass[];
}

export interface BoundaryRubricSettings {
  projectedPathDiscount: number;
  reinforcementUpgradeThreshold: number;
  directDependsOnThreshold: number;
  interactsWithThreshold: number;
  adjacentToThreshold: number;
}

export const BOUNDARY_RUBRIC_SETTINGS: BoundaryRubricSettings = {
  projectedPathDiscount: 0.65,
  reinforcementUpgradeThreshold: 0.55,
  directDependsOnThreshold: 1.65,
  interactsWithThreshold: 0.9,
  adjacentToThreshold: 0.35,
};

const MAX_PROJECTED_GLUE_TRANSIT_NODES = 4;
const SAMPLE_PATHS_PER_RELATIONSHIP = 4;

const GRAPH_FORMING_CONFIDENCE_CLASSES: ConfidenceClass[] = [
  'proven',
  'artifact-backed',
  'framework-inferred',
];

const REINFORCEMENT_CONFIDENCE_CLASSES: ConfidenceClass[] = [
  'proven',
  'artifact-backed',
  'framework-inferred',
  'heuristic',
];

const BOUNDARY_EVIDENCE_RUBRIC: Record<EdgeType, Omit<BoundaryEvidenceRubricEntry, 'edgeType'>> = {
  renders_template: {
    family: 'fallback-structure',
    role: 'supporting-only',
    defaultTier: 'supporting',
    startingWeight: 0.1,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  renders_component: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_composable: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_store: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_hook: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  provides_context: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  consumes_context: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  navigates_to: {
    family: 'surface-bridge',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  declares_resource: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_view_model: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  publishes_bus_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  subscribes_bus_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  references_resource: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  produces_artifact: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  consumes_artifact: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  invokes_workflow: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_base_image: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  copies_artifact: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  depends_on_service: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  emits_component_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  handles_component_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  hydrates_component: {
    family: 'fallback-structure',
    role: 'supporting-only',
    defaultTier: 'supporting',
    startingWeight: 0.1,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  implements_contract: {
    family: 'contract-lineage',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.35,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  emits_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.95,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  subscribes_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.9,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  shares_config_key: {
    family: 'fallback-structure',
    role: 'supporting-only',
    defaultTier: 'supporting',
    startingWeight: 0.12,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  declares_surface: {
    family: 'projection-through-glue',
    role: 'projection-support',
    defaultTier: 'projected-overlay',
    startingWeight: 0.3,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  handled_by: {
    family: 'surface-bridge',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.75,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  calls_surface: {
    family: 'surface-bridge',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.7,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_contract: {
    family: 'contract-lineage',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.35,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  returns_contract: {
    family: 'contract-lineage',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.4,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  validates_with: {
    family: 'contract-lineage',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.38,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  derived_from: {
    family: 'contract-lineage',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.32,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  calls: {
    family: 'fallback-structure',
    role: 'supporting-only',
    defaultTier: 'supporting',
    startingWeight: 0.18,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  references: {
    family: 'fallback-structure',
    role: 'supporting-only',
    defaultTier: 'supporting',
    startingWeight: 0.08,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  dispatches_job: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  handles_job: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.9,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  listens_event: {
    family: 'async-workflow',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.9,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  resolves_service: {
    family: 'service-container',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 1,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  binds_service: {
    family: 'service-container',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.92,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  provides_capability: {
    family: 'service-container',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.85,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  imports_pipeline_artifact: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.92,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  exports_pipeline_artifact: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.9,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  syncs_external_record: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.88,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  consumes_reporting_source: {
    family: 'pipeline-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.84,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  transforms_model: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.75,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  uses_contract_family: {
    family: 'contract-lineage',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.42,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  emits_resource_family: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.7,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  validates_contract_family: {
    family: 'contract-lineage',
    role: 'graph-forming',
    defaultTier: 'overlay-backed',
    startingWeight: 0.68,
    canStandAlone: true,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  shares_contract_family: {
    family: 'shared-contract-family',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.3,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  shares_schema_family: {
    family: 'shared-contract-family',
    role: 'reinforcement-only',
    defaultTier: 'supporting',
    startingWeight: 0.3,
    canStandAlone: false,
    preferredConfidenceClasses: REINFORCEMENT_CONFIDENCE_CLASSES,
  },
  projects_through_glue: {
    family: 'projection-through-glue',
    role: 'projection-support',
    defaultTier: 'projected-overlay',
    startingWeight: 0.45,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
  transits_shared_entrypoint: {
    family: 'projection-through-glue',
    role: 'projection-support',
    defaultTier: 'projected-overlay',
    startingWeight: 0.4,
    canStandAlone: false,
    preferredConfidenceClasses: GRAPH_FORMING_CONFIDENCE_CLASSES,
  },
};

export function classifyBoundaryEvidence(edgeType: EdgeType): BoundaryEvidenceRubricEntry {
  return {
    edgeType,
    ...BOUNDARY_EVIDENCE_RUBRIC[edgeType],
  };
}

export function getBoundaryEvidenceWeight(
  edgeType: EdgeType,
  options: {
    pathKind?: BoundaryPathKind;
    mode?: BoundaryAggregationMode;
  } = {}
): number {
  const entry = classifyBoundaryEvidence(edgeType);
  const pathKind = options.pathKind ?? 'direct';
  const mode = options.mode ?? 'projected';

  if (pathKind === 'projected-through-glue') {
    if (mode === 'direct-only') return 0;
    return entry.startingWeight * BOUNDARY_RUBRIC_SETTINGS.projectedPathDiscount;
  }

  return entry.startingWeight;
}

export function classifyBoundaryEvidenceTier(
  edgeType: EdgeType,
  pathKind: BoundaryPathKind
): BoundaryEvidenceTier {
  const entry = classifyBoundaryEvidence(edgeType);
  if (pathKind === 'projected-through-glue') return 'projected-overlay';
  return entry.defaultTier;
}

export function isGraphFormingBoundaryEdgeType(edgeType: EdgeType): boolean {
  return classifyBoundaryEvidence(edgeType).role === 'graph-forming';
}

export function isReinforcementBoundaryEdgeType(edgeType: EdgeType): boolean {
  return classifyBoundaryEvidence(edgeType).role === 'reinforcement-only';
}

export function isProjectionSupportEdgeType(edgeType: EdgeType): boolean {
  return classifyBoundaryEvidence(edgeType).role === 'projection-support';
}

export function canBoundaryEdgeStandAlone(edgeType: EdgeType): boolean {
  return classifyBoundaryEvidence(edgeType).canStandAlone;
}

export function classifyBoundaryNodeOwnership(
  node: StructuralNode,
  rootPath: string,
  patterns?: string[]
): BoundaryNodeOwnership {
  const resolvedPatterns = patterns && patterns.length > 0 ? patterns : [];
  const filePath = node.file_path ?? undefined;

  if (filePath) {
    const region =
      resolvedPatterns.length > 0
        ? resolveModule(join(rootPath, filePath), rootPath, resolvedPatterns)
        : null;
    if (region) {
      return {
        nodeId: node.id,
        filePath,
        kind: 'owned-region',
        region,
        reason: `resolved via module boundary pattern (${region})`,
      };
    }
  }

  if (isGlueNode(node)) {
    return {
      nodeId: node.id,
      filePath,
      kind: 'glue',
      reason: glueReason(node),
    };
  }

  return {
    nodeId: node.id,
    filePath,
    kind: 'unresolved',
    reason: 'no owned region or glue classification matched',
  };
}

export function isGlueNode(node: StructuralNode): boolean {
  if (node.node_type === 'capability-surface' || node.node_type === 'route') return true;

  const filePath = node.file_path ?? '';
  return (
    filePath.startsWith('routes/') ||
    filePath.startsWith('app/Providers/') ||
    filePath.startsWith('src/Providers/') ||
    filePath === 'src/CoreServiceProvider.php' ||
    filePath.endsWith('RouteServiceProvider.php') ||
    filePath.endsWith('EventServiceProvider.php') ||
    (/\/(Http\/Controllers|Controllers)\//.test(filePath) && !/\/Module\//.test(filePath)) ||
    filePath.startsWith('bootstrap/') ||
    filePath.startsWith('public/') ||
    /\/(Adapters?|Transport)\//.test(filePath)
  );
}

export function projectBoundaryPathsThroughGlue(
  db: LuxDatabase,
  options: AggregateModuleBoundaryOptions
): ProjectedBoundaryPath[] {
  const mode = options.mode ?? 'projected';
  const nodes = collectAllStructuralNodes(db);
  const edges = collectAllStructuralEdges(db, nodes);
  const patterns = detectBoundaryPatterns(options.rootPath, nodes);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const ownership = new Map(
    nodes.map((node) => [node.id, classifyBoundaryNodeOwnership(node, options.rootPath, patterns)])
  );
  const outgoingEdgesByNode = groupOutgoingEdges(edges);
  const glueSiblingIdsByNode = groupGlueNodesByFile(nodes, ownership);

  const paths: ProjectedBoundaryPath[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    const sourceOwnership = ownership.get(edge.source_node_id);
    const targetOwnership = ownership.get(edge.target_node_id);
    if (
      sourceOwnership?.kind !== 'owned-region' ||
      targetOwnership?.kind !== 'owned-region' ||
      sourceOwnership.region === targetOwnership.region
    ) {
      continue;
    }

    const path = makePathFromEdges(
      [edge],
      [],
      sourceOwnership.region!,
      targetOwnership.region!,
      'direct'
    );
    if (pathWeight(path, mode) <= 0) continue;
    const key = pathKey(path);
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(path);
    }
  }

  for (const edge of edges) {
    const sourceOwnership = ownership.get(edge.source_node_id);
    const targetOwnership = ownership.get(edge.target_node_id);
    if (sourceOwnership?.kind !== 'owned-region' || targetOwnership?.kind !== 'glue') continue;

    for (const path of projectFromGlueTransit(edge, sourceOwnership.region!, {
      mode,
      nodeMap,
      ownership,
      outgoingEdgesByNode,
      glueSiblingIdsByNode,
    })) {
      const key = pathKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
  }

  return paths;
}

export function aggregateModuleBoundaryEvidence(
  db: LuxDatabase,
  options: AggregateModuleBoundaryOptions
): ModuleBoundaryAggregate[] {
  const mode = options.mode ?? 'projected';
  const minWeight = options.minWeight ?? 0;
  const trustLevel = deriveOverlayTrustLevel(db);
  // The path set is independent of the order the database returns edges in, but the order of the
  // list is not. Weights are summed, families are listed and samples are taken in this order, so it
  // is fixed first: floating-point addition is not associative.
  const paths = projectBoundaryPathsThroughGlue(db, options).sort((a, b) =>
    compareCodeUnits(pathKey(a), pathKey(b))
  );
  const ownedRegions = new Set(paths.flatMap((path) => [path.sourceRegion, path.targetRegion]));
  const supportingSignals = buildSupportingSignals(db, ownedRegions);
  const aggregates = new Map<string, ModuleBoundaryAggregate>();

  for (const path of paths) {
    const key = `${path.sourceRegion}\0${path.targetRegion}`;
    const aggregate = aggregates.get(key) ?? {
      sourceRegion: path.sourceRegion,
      targetRegion: path.targetRegion,
      relationshipKind: 'adjacent-to' as BoundaryRelationshipKind,
      evidenceTiers: [],
      directWeight: 0,
      projectedWeight: 0,
      supportingWeight: 0,
      families: [],
      trustLevel,
      samplePaths: [],
      rationaleSummary: '',
      dominantDirection: 'outbound' as const,
    };

    const directWeight = sumWeightForTier(path, 'overlay-backed', mode);
    const projectedWeight = sumWeightForTier(path, 'projected-overlay', mode);
    const supportingWeight = sumWeightForTier(path, 'supporting', mode);

    aggregate.directWeight += directWeight;
    aggregate.projectedWeight += projectedWeight;
    aggregate.supportingWeight += supportingWeight;
    aggregate.evidenceTiers = unique([...aggregate.evidenceTiers, ...path.evidenceTiers]);
    aggregate.families = unique([...aggregate.families, ...path.families]);
    if (aggregate.samplePaths.length < SAMPLE_PATHS_PER_RELATIONSHIP) {
      aggregate.samplePaths.push(path);
    }
    aggregates.set(key, aggregate);
  }

  for (const signal of supportingSignals) {
    const key = `${signal.sourceRegion}\0${signal.targetRegion}`;
    const aggregate = aggregates.get(key) ?? {
      sourceRegion: signal.sourceRegion,
      targetRegion: signal.targetRegion,
      relationshipKind: 'adjacent-to' as BoundaryRelationshipKind,
      evidenceTiers: [],
      directWeight: 0,
      projectedWeight: 0,
      supportingWeight: 0,
      families: [],
      trustLevel,
      samplePaths: [],
      rationaleSummary: '',
      dominantDirection: 'outbound' as const,
    };

    aggregate.supportingWeight += signal.weight;
    aggregate.evidenceTiers = unique([...aggregate.evidenceTiers, 'supporting']);
    aggregate.families = unique([...aggregate.families, signal.family]);
    aggregates.set(key, aggregate);
  }

  const results = Array.from(aggregates.values())
    .map((aggregate) => {
      aggregate.relationshipKind = classifyRelationshipKind(aggregate);
      aggregate.rationaleSummary = buildRationaleSummary(aggregate);
      return aggregate;
    })
    .filter((aggregate) => totalWeight(aggregate) >= minWeight)
    .sort(compareAggregates);

  const byKey = new Map(
    results.map((aggregate) => [`${aggregate.sourceRegion}\0${aggregate.targetRegion}`, aggregate])
  );
  for (const aggregate of results) {
    const reverse = byKey.get(`${aggregate.targetRegion}\0${aggregate.sourceRegion}`);
    if (!reverse) continue;

    if (Math.abs(structuralWeight(aggregate) - structuralWeight(reverse)) <= 0.25) {
      aggregate.dominantDirection = 'reciprocal';
      if (aggregate.relationshipKind === 'depends-on') {
        aggregate.relationshipKind = 'interacts-with';
        aggregate.rationaleSummary = buildRationaleSummary(aggregate);
      }
    }
  }

  return results;
}

function collectAllStructuralNodes(db: LuxDatabase): StructuralNode[] {
  const nodeTypes: StructuralNode['node_type'][] = [
    'file',
    'symbol',
    'route',
    'template',
    'contract',
    'event',
    'artifact',
    'capability-surface',
  ];

  const seen = new Set<string>();
  const nodes: StructuralNode[] = [];
  for (const nodeType of nodeTypes) {
    // origin='local' only — merged vendor-pack nodes must never enter
    // expert-boundary derivation (ADR-3 / REQ-7, the worst pollution site).
    // collectAllStructuralEdges then naturally drops vendor→vendor edges: it
    // only starts from local nodes, so a boundary edge's vendor target is never
    // a member of `nodes` and is not double-counted as an internal edge.
    for (const node of db.getLocalStructuralNodesByType(nodeType)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }
  return nodes;
}

function collectAllStructuralEdges(db: LuxDatabase, nodes: StructuralNode[]): StructuralEdge[] {
  const seen = new Set<string>();
  const edges: StructuralEdge[] = [];
  for (const node of nodes) {
    for (const edge of db.getStructuralEdgesForNode(node.id)) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      edges.push(edge);
    }
  }
  return edges;
}

function detectBoundaryPatterns(rootPath: string, nodes: StructuralNode[]): string[] {
  const detected = detectModuleBoundaries(rootPath);
  if (detected.length > 0) return detected;

  const patterns = new Set<string>();
  for (const node of nodes) {
    const filePath = node.file_path ?? '';
    if (filePath.startsWith('src/Module/')) patterns.add('src/Module/{name}');
    if (filePath.startsWith('app/Module/')) patterns.add('app/Module/{name}');
    if (filePath.startsWith('app/Modules/')) patterns.add('app/Modules/{name}');
    if (filePath.startsWith('packages/')) patterns.add('packages/{name}');
    if (filePath.startsWith('apps/')) patterns.add('apps/{name}');
    if (filePath.startsWith('libs/')) patterns.add('libs/{name}');
  }
  return Array.from(patterns);
}

function makePathFromEdges(
  edges: StructuralEdge[],
  transitNodes: StructuralNode[],
  sourceRegion: string,
  targetRegion: string,
  pathKind: BoundaryPathKind
): ProjectedBoundaryPath {
  const edgeTypes = unique(edges.map((edge) => edge.edge_type));
  const families = unique(edgeTypes.map((edgeType) => classifyBoundaryEvidence(edgeType).family));
  const evidenceTiers = unique(
    edgeTypes.map((edgeType) => classifyBoundaryEvidenceTier(edgeType, pathKind))
  );

  return {
    sourceRegion,
    targetRegion,
    pathKind,
    directEdgeIds: edges.map((edge) => edge.id),
    edgeTypes,
    ...(transitNodes.length > 0 && { transitNodeIds: transitNodes.map((node) => node.id) }),
    ...(transitNodes.some((node) => node.file_path) && {
      transitFiles: transitNodes.flatMap((node) => (node.file_path ? [node.file_path] : [])),
    }),
    families,
    evidenceTiers,
    confidence: edges.reduce((sum, edge) => sum + edge.confidence, 0) / edges.length,
    confidenceClass: mergeConfidenceClasses(edges.map((edge) => edge.confidence_class)),
    provenanceSummary: unique(
      edges.flatMap((edge) => (edge.provenance_summary ? [edge.provenance_summary] : []))
    ),
  };
}

function glueReason(node: StructuralNode): string {
  if (node.node_type === 'capability-surface') return 'surface node is transit structure';
  if (node.node_type === 'route') return 'route node is transport glue';
  const filePath = node.file_path ?? '';
  if (filePath.startsWith('routes/')) return 'root route file treated as glue';
  if (filePath.endsWith('RouteServiceProvider.php'))
    return 'route service provider treated as glue';
  if (filePath.endsWith('EventServiceProvider.php'))
    return 'event service provider treated as glue';
  if (filePath.startsWith('app/Providers/') || filePath.startsWith('src/Providers/')) {
    return 'shared provider layer treated as glue';
  }
  if (/\/(Http\/Controllers|Controllers)\//.test(filePath) && !/\/Module\//.test(filePath)) {
    return 'shared controller layer treated as glue';
  }
  if (filePath === 'src/CoreServiceProvider.php') return 'root service provider treated as glue';
  return 'file path matches glue heuristics';
}

function groupOutgoingEdges(edges: StructuralEdge[]): Map<string, StructuralEdge[]> {
  const grouped = new Map<string, StructuralEdge[]>();
  for (const edge of edges) {
    const bucket = grouped.get(edge.source_node_id);
    if (bucket) bucket.push(edge);
    else grouped.set(edge.source_node_id, [edge]);
  }
  return grouped;
}

function groupGlueNodesByFile(
  nodes: StructuralNode[],
  ownership: Map<string, BoundaryNodeOwnership>
): Map<string, string[]> {
  const glueIdsByFile = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.file_path) continue;
    if (ownership.get(node.id)?.kind !== 'glue') continue;
    if (node.node_type !== 'file' && node.node_type !== 'symbol') continue;

    const bucket = glueIdsByFile.get(node.file_path);
    if (bucket) bucket.push(node.id);
    else glueIdsByFile.set(node.file_path, [node.id]);
  }

  const siblingIdsByNode = new Map<string, string[]>();
  for (const ids of glueIdsByFile.values()) {
    for (const id of ids) {
      siblingIdsByNode.set(
        id,
        ids.filter((candidateId) => candidateId !== id)
      );
    }
  }
  return siblingIdsByNode;
}

function projectFromGlueTransit(
  initialEdge: StructuralEdge,
  sourceRegion: string,
  context: {
    mode: BoundaryAggregationMode;
    nodeMap: Map<string, StructuralNode>;
    ownership: Map<string, BoundaryNodeOwnership>;
    outgoingEdgesByNode: Map<string, StructuralEdge[]>;
    glueSiblingIdsByNode: Map<string, string[]>;
  }
): ProjectedBoundaryPath[] {
  const results: ProjectedBoundaryPath[] = [];
  if (!context.nodeMap.has(initialEdge.target_node_id)) return results;

  const queue: Array<{
    currentNodeId: string;
    edges: StructuralEdge[];
    transitNodeIds: string[];
    visitedNodeIds: Set<string>;
    provenanceNotes: string[];
  }> = [
    {
      currentNodeId: initialEdge.target_node_id,
      edges: [initialEdge],
      transitNodeIds: [initialEdge.target_node_id],
      visitedNodeIds: new Set([initialEdge.source_node_id, initialEdge.target_node_id]),
      provenanceNotes: [],
    },
  ];

  while (queue.length > 0) {
    const state = queue.shift()!;

    for (const siblingId of context.glueSiblingIdsByNode.get(state.currentNodeId) ?? []) {
      if (state.visitedNodeIds.has(siblingId)) continue;
      if (state.transitNodeIds.length >= MAX_PROJECTED_GLUE_TRANSIT_NODES) continue;

      const siblingNode = context.nodeMap.get(siblingId);
      queue.push({
        currentNodeId: siblingId,
        edges: state.edges,
        transitNodeIds: [...state.transitNodeIds, siblingId],
        visitedNodeIds: new Set([...state.visitedNodeIds, siblingId]),
        provenanceNotes:
          siblingNode?.file_path &&
          !state.provenanceNotes.includes(`same-file glue bridge via ${siblingNode.file_path}`)
            ? [...state.provenanceNotes, `same-file glue bridge via ${siblingNode.file_path}`]
            : state.provenanceNotes,
      });
    }

    for (const edge of context.outgoingEdgesByNode.get(state.currentNodeId) ?? []) {
      const targetOwnership = context.ownership.get(edge.target_node_id);
      if (!targetOwnership) continue;

      if (
        targetOwnership.kind === 'owned-region' &&
        targetOwnership.region !== sourceRegion &&
        canTerminateProjectedPath(edge.edge_type)
      ) {
        const path = makePathFromEdges(
          [...state.edges, edge],
          state.transitNodeIds
            .map((nodeId) => context.nodeMap.get(nodeId))
            .filter((node): node is StructuralNode => Boolean(node)),
          sourceRegion,
          targetOwnership.region!,
          'projected-through-glue'
        );
        path.provenanceSummary = unique([...path.provenanceSummary, ...state.provenanceNotes]);
        if (pathWeight(path, context.mode) > 0) {
          results.push(path);
        }
        continue;
      }

      if (targetOwnership.kind !== 'glue') continue;
      if (state.visitedNodeIds.has(edge.target_node_id)) continue;
      if (state.transitNodeIds.length >= MAX_PROJECTED_GLUE_TRANSIT_NODES) continue;

      queue.push({
        currentNodeId: edge.target_node_id,
        edges: [...state.edges, edge],
        transitNodeIds: [...state.transitNodeIds, edge.target_node_id],
        visitedNodeIds: new Set([...state.visitedNodeIds, edge.target_node_id]),
        provenanceNotes: state.provenanceNotes,
      });
    }
  }

  return results;
}

function canTerminateProjectedPath(edgeType: EdgeType): boolean {
  return isGraphFormingBoundaryEdgeType(edgeType) || isProjectionSupportEdgeType(edgeType);
}

function mergeConfidenceClasses(classes: ConfidenceClass[]): ConfidenceClass {
  const order: ConfidenceClass[] = ['proven', 'artifact-backed', 'framework-inferred', 'heuristic'];

  let worst = 0;
  for (const confidenceClass of classes) {
    const idx = order.indexOf(confidenceClass);
    if (idx > worst) worst = idx;
  }
  return order[worst];
}

function buildSupportingSignals(
  db: LuxDatabase,
  ownedRegions: Set<string>
): SupportingBoundarySignal[] {
  return db
    .getAllModuleDependencies()
    .filter(
      (dependency: ModuleDependency) =>
        dependency.source_module !== 'Global' &&
        dependency.target_module !== 'Global' &&
        ownedRegions.has(dependency.source_module) &&
        ownedRegions.has(dependency.target_module)
    )
    .map((dependency: ModuleDependency) => ({
      sourceRegion: dependency.source_module,
      targetRegion: dependency.target_module,
      family: 'fallback-structure',
      weight: Math.min(0.12 + dependency.reference_count * 0.02, 0.35),
      provenanceSummary: `module-dependencies (${dependency.reference_count} references)`,
    }));
}

function sumWeightForTier(
  path: ProjectedBoundaryPath,
  tier: BoundaryEvidenceTier,
  mode: BoundaryAggregationMode
): number {
  let total = 0;
  for (const edgeType of path.edgeTypes) {
    if (classifyBoundaryEvidenceTier(edgeType, path.pathKind) !== tier) continue;
    total += getBoundaryEvidenceWeight(edgeType, { pathKind: path.pathKind, mode });
  }
  return total;
}

function pathWeight(path: ProjectedBoundaryPath, mode: BoundaryAggregationMode): number {
  return path.edgeTypes.reduce(
    (sum, edgeType) => sum + getBoundaryEvidenceWeight(edgeType, { pathKind: path.pathKind, mode }),
    0
  );
}

function structuralWeight(aggregate: ModuleBoundaryAggregate): number {
  return aggregate.directWeight + aggregate.projectedWeight;
}

function totalWeight(aggregate: ModuleBoundaryAggregate): number {
  return structuralWeight(aggregate) + Math.min(aggregate.supportingWeight, 0.35);
}

function classifyRelationshipKind(aggregate: ModuleBoundaryAggregate): BoundaryRelationshipKind {
  const structural = structuralWeight(aggregate);
  const total = totalWeight(aggregate);

  if (aggregate.directWeight >= BOUNDARY_RUBRIC_SETTINGS.directDependsOnThreshold) {
    return 'depends-on';
  }
  if (structural >= BOUNDARY_RUBRIC_SETTINGS.interactsWithThreshold) {
    return 'interacts-with';
  }
  if (total >= BOUNDARY_RUBRIC_SETTINGS.adjacentToThreshold) {
    return 'adjacent-to';
  }
  return 'adjacent-to';
}

function buildRationaleSummary(aggregate: ModuleBoundaryAggregate): string {
  const tierSummary = [
    aggregate.directWeight > 0 ? `direct ${aggregate.directWeight.toFixed(2)}` : null,
    aggregate.projectedWeight > 0 ? `projected ${aggregate.projectedWeight.toFixed(2)}` : null,
    aggregate.supportingWeight > 0 ? `supporting ${aggregate.supportingWeight.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const familySummary = aggregate.families.join(', ');
  return `${aggregate.relationshipKind} via ${familySummary}${tierSummary ? ` (${tierSummary})` : ''}`;
}

/** Heaviest first; equal weights fall back to the region pair, so the order is total. */
export function compareAggregates(a: ModuleBoundaryAggregate, b: ModuleBoundaryAggregate): number {
  return (
    totalWeight(b) - totalWeight(a) ||
    compareCodeUnits(a.sourceRegion, b.sourceRegion) ||
    compareCodeUnits(a.targetRegion, b.targetRegion)
  );
}

function pathKey(path: ProjectedBoundaryPath): string {
  return [
    path.sourceRegion,
    path.targetRegion,
    path.pathKind,
    path.directEdgeIds.join(','),
    path.transitNodeIds?.join(',') ?? '',
  ].join('\0');
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
