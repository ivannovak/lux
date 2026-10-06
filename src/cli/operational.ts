import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import type {
  OperationalBoundary,
  OperationalBoundaryKind,
  OperationalContract,
  OperationalEdge,
  StructuralNode,
  TrustTier,
} from '../db/types.js';
import {
  getOperationalBoundaryHandlers,
  getOperationalDispatchSourcesForJob,
  getOperationalDispatchedJobs,
  getOperationalEventListeners,
  getOperationalUpstreamTriggers,
  getTrustAwareOperationalNeighborhood,
} from '../scanner/associations/operational/index.js';
import {
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../scanner/overlay-trust-state.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';

export type OperationalQuestionIntent =
  | 'schedule-sources'
  | 'dispatch-sources'
  | 'dispatched-jobs'
  | 'event-listeners'
  | 'neighborhood'
  | 'evidence';

type ResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous';
type ResolutionMatchType = 'exact' | 'prefix' | 'contains';

interface OperationalNodePayload {
  id: string;
  kind: 'boundary' | 'structural-symbol' | 'unresolved';
  boundaryKind?: OperationalBoundaryKind;
  nodeType?: StructuralNode['node_type'];
  name?: string;
  trustTier?: TrustTier;
  filePath?: string | null;
}

interface OperationalContractPayload {
  id: string;
  trustTier: TrustTier;
  payloadSchema: unknown;
}

interface OperationalEvidencePayload {
  edge?: {
    id: string;
    edgeType: OperationalEdge['edge_type'];
    transport: OperationalEdge['transport'] | null;
    trustTier: TrustTier;
  };
  source?: OperationalNodePayload;
  target?: OperationalNodePayload;
  contracts?: OperationalContractPayload[];
  filePath?: string | null;
  note?: string;
}

interface OperationalResolutionPayload {
  query: string;
  status: ResolutionStatus;
  matchedBy?: ResolutionMatchType;
  candidates: OperationalNodePayload[];
}

export interface OperationalAnswerPayload {
  question: string;
  intent: OperationalQuestionIntent;
  overlayTrustLevel: string;
  resolution: OperationalResolutionPayload;
  target: OperationalNodePayload | null;
  primaryAnswer: {
    summary: string;
    confidence: 'high' | 'medium' | 'none';
    items: OperationalNodePayload[];
  };
  trust: {
    targetTrustTier: TrustTier | null;
    evidenceTrustTiers: TrustTier[];
    mixedTrust: boolean;
  };
  transport: Array<{
    edgeId: string;
    edgeType: OperationalEdge['edge_type'];
    transport: OperationalEdge['transport'] | null;
    trustTier: TrustTier;
  }>;
  evidence: OperationalEvidencePayload[];
  context: OperationalEvidencePayload[];
}

export interface OperationalAskOptions {
  json?: boolean;
  target?: string;
  kind?: OperationalBoundaryKind;
  maxDepth?: number;
  minTrustTier?: number;
}

export interface OperationalAskExecutionResult {
  answer: OperationalAnswerPayload;
  rendered: string;
  exitCode: 0 | 1;
}

export interface OperationalIntentResolution {
  intent: OperationalQuestionIntent | null;
}

type BoundaryResolution =
  | {
      status: 'resolved';
      matchedBy: ResolutionMatchType;
      boundary: OperationalBoundary;
      candidates: OperationalBoundary[];
    }
  | {
      status: 'unresolved';
      candidates: OperationalBoundary[];
    }
  | {
      status: 'ambiguous';
      matchedBy: ResolutionMatchType;
      candidates: OperationalBoundary[];
    };

function parsePayloadSchema(payloadSchema?: string): unknown {
  if (!payloadSchema) return null;
  try {
    return JSON.parse(payloadSchema) as unknown;
  } catch {
    // lux-intentional-swallow: a schema that is not JSON is shown as the stored text.
    return payloadSchema;
  }
}

function mapContracts(contracts: OperationalContract[]): OperationalContractPayload[] {
  return contracts.map((contract) => ({
    id: contract.id,
    trustTier: contract.trust_tier,
    payloadSchema: parsePayloadSchema(contract.payload_schema),
  }));
}

function mapEdge(edge: OperationalEdge): NonNullable<OperationalEvidencePayload['edge']> {
  return {
    id: edge.id,
    edgeType: edge.edge_type,
    transport: edge.transport ?? null,
    trustTier: edge.trust_tier,
  };
}

function getNodePayload(db: LuxDatabase, nodeId: string): OperationalNodePayload {
  const boundary = db.getOperationalBoundary(nodeId);
  if (boundary) return boundaryPayload(boundary);

  const node = db.getStructuralNode(nodeId);
  if (node) {
    return {
      id: node.id,
      kind: 'structural-symbol',
      nodeType: node.node_type,
      name: node.symbol_name,
      filePath: node.file_path ?? null,
    };
  }

  return { id: nodeId, kind: 'unresolved' };
}

function boundaryPayload(boundary: OperationalBoundary): OperationalNodePayload {
  return {
    id: boundary.id,
    kind: 'boundary',
    boundaryKind: boundary.kind,
    name: boundary.name,
    trustTier: boundary.trust_tier,
    filePath: boundary.file_path ?? null,
  };
}

function nodeLabel(node: OperationalNodePayload): string {
  if (node.kind === 'boundary') return `${node.boundaryKind}:${node.name}`;
  return node.name ?? node.id;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^opb:/, '')
    .replace(/^command:/, '')
    .replace(/^job:/, '')
    .replace(/^event:/, '')
    .replace(/^schedule:/, '')
    .replace(/@\S+:\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function basenameOf(value: string): string {
  const normalized = normalize(value);
  const phpTail = normalized.split('\\').at(-1) ?? normalized;
  return phpTail.split(':').at(-1) ?? phpTail;
}

function semanticForms(boundary: OperationalBoundary): string[] {
  const forms = new Set<string>();
  forms.add(normalize(boundary.id));
  forms.add(normalize(boundary.name));
  forms.add(basenameOf(boundary.name));
  forms.add(basenameOf(boundary.id));
  return [...forms].filter(Boolean);
}

function rawNormalizedForms(boundary: OperationalBoundary): string[] {
  const forms = new Set<string>();
  forms.add(boundary.id.toLowerCase().trim());
  forms.add(boundary.name.toLowerCase().trim());
  return [...forms].filter(Boolean);
}

function matchesOperationalNeighborhoodCue(normalized: string): boolean {
  // Top-level ask promotion should only intercept explicit persisted-boundary
  // neighborhood requests. Bare "workflow"/"operational" wording is too easy
  // to confuse with architecture or product-reasoning questions, so require a
  // relationship/neighborhood cue as well.
  const hasBoundaryCue = /\b(operational|workflow)\b/.test(normalized);
  if (!hasBoundaryCue) return false;
  return /\b(boundar(y|ies)|neighbou?rhood|reach|upstream|downstream|around|path|paths)\b/.test(
    normalized
  );
}

function inferOperationalAskIntent(question: string): OperationalIntentResolution {
  const normalized = question.toLowerCase();
  if (
    normalized.includes('evidence') ||
    normalized.includes('trust') ||
    normalized.includes('support')
  ) {
    return { intent: 'evidence' };
  }
  if (normalized.includes('listener')) return { intent: 'event-listeners' };
  if (normalized.includes('what handles') || normalized.includes('what handle')) {
    return { intent: 'event-listeners' };
  }
  if (normalized.includes('dispatches') || normalized.includes('dispatched from')) {
    return { intent: 'dispatch-sources' };
  }
  if (normalized.includes('triggered by') || normalized.includes('what command')) {
    return { intent: 'dispatched-jobs' };
  }
  if (normalized.includes('schedule')) return { intent: 'schedule-sources' };
  if (matchesOperationalNeighborhoodCue(normalized)) {
    return { intent: 'neighborhood' };
  }
  return { intent: null };
}

function inferIntent(question: string): OperationalQuestionIntent {
  const inferred = inferOperationalAskIntent(question).intent;
  if (inferred) return inferred;
  const normalized = question.toLowerCase();
  if (normalized.includes('handle')) return 'event-listeners';
  return 'neighborhood';
}

function extractTargetQuestionFragment(
  question: string,
  intent: OperationalQuestionIntent
): string {
  const withoutQuestion = question.replace(/\?$/, '').trim();
  const patterns: RegExp[] = [
    /what\s+dispatches\s+(.+)$/i,
    /where\s+is\s+(.+?)\s+dispatched\s+from$/i,
    /what\s+listeners\s+handle\s+(.+)$/i,
    /what\s+schedules\s+(.+)$/i,
    /what\s+command\s+is\s+triggered\s+by\s+(.+)$/i,
    /around\s+(.+)$/i,
    /support\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = withoutQuestion.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  if (intent === 'neighborhood') return withoutQuestion;
  return withoutQuestion.split(/\s+/).at(-1) ?? withoutQuestion;
}

function preferredKindsForIntent(
  intent: OperationalQuestionIntent,
  explicitKind?: OperationalBoundaryKind,
  targetText?: string
): OperationalBoundaryKind[] | undefined {
  if (explicitKind) return [explicitKind];
  if (intent === 'dispatch-sources') return ['job'];
  if (intent === 'event-listeners') return ['event'];
  if (intent === 'schedule-sources') return ['command', 'job'];
  if (intent === 'dispatched-jobs' && targetText && /@\S+:\d+$/.test(targetText.trim())) {
    return ['schedule', 'command', 'http'];
  }
  if (intent === 'dispatched-jobs') return ['schedule', 'command', 'http'];
  return undefined;
}

function sortResolutionCandidates(
  boundaries: OperationalBoundary[],
  preferredKinds?: OperationalBoundaryKind[],
  query?: string
): OperationalBoundary[] {
  const normalizedQuery = query ? normalize(query) : '';
  const queryBasename = query ? basenameOf(query) : '';

  return [...boundaries].sort((left, right) => {
    const leftKindIndex = preferredKinds ? preferredKinds.indexOf(left.kind) : -1;
    const rightKindIndex = preferredKinds ? preferredKinds.indexOf(right.kind) : -1;
    const normalizedLeftKindIndex = leftKindIndex === -1 ? Number.MAX_SAFE_INTEGER : leftKindIndex;
    const normalizedRightKindIndex =
      rightKindIndex === -1 ? Number.MAX_SAFE_INTEGER : rightKindIndex;

    if (normalizedLeftKindIndex !== normalizedRightKindIndex) {
      return normalizedLeftKindIndex - normalizedRightKindIndex;
    }

    const leftForms = semanticForms(left);
    const rightForms = semanticForms(right);
    const leftExactSemantic =
      leftForms.includes(normalizedQuery) || leftForms.includes(queryBasename);
    const rightExactSemantic =
      rightForms.includes(normalizedQuery) || rightForms.includes(queryBasename);
    if (leftExactSemantic !== rightExactSemantic) return leftExactSemantic ? -1 : 1;

    const leftBase = basenameOf(left.name);
    const rightBase = basenameOf(right.name);
    const leftBaseDistance = Math.abs(leftBase.length - queryBasename.length);
    const rightBaseDistance = Math.abs(rightBase.length - queryBasename.length);
    if (leftBaseDistance !== rightBaseDistance) return leftBaseDistance - rightBaseDistance;

    if (left.name.length !== right.name.length) return left.name.length - right.name.length;
    return left.name.localeCompare(right.name);
  });
}

function dedupeBoundaries(boundaries: OperationalBoundary[]): OperationalBoundary[] {
  const seen = new Set<string>();
  const result: OperationalBoundary[] = [];
  for (const boundary of boundaries) {
    if (seen.has(boundary.id)) continue;
    seen.add(boundary.id);
    result.push(boundary);
  }
  return result;
}

function resolveBoundary(
  db: LuxDatabase,
  repoRoot: string,
  query: string,
  kinds?: OperationalBoundaryKind[]
): BoundaryResolution {
  const boundaries = db
    .getOperationalBoundariesByRepoRoot(repoRoot)
    .filter((boundary) => !kinds || kinds.includes(boundary.kind));
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return { status: 'unresolved', candidates: [] };

  const classifyMatches = (
    matchedBy: ResolutionMatchType,
    matches: OperationalBoundary[]
  ): BoundaryResolution | null => {
    const candidates = dedupeBoundaries(sortResolutionCandidates(matches, kinds, query));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
      return {
        status: 'resolved',
        matchedBy,
        boundary: candidates[0],
        candidates: candidates.slice(0, 5),
      };
    }

    return {
      status: 'ambiguous',
      matchedBy,
      candidates: candidates.slice(0, 5),
    };
  };

  const rawQuery = query.toLowerCase().trim();
  const hasLocationHint = /@\S+:\d+$/.test(rawQuery);

  if (hasLocationHint) {
    const rawExactMatch = classifyMatches(
      'exact',
      boundaries.filter((boundary) => rawNormalizedForms(boundary).includes(rawQuery))
    );
    if (rawExactMatch) return rawExactMatch;
  }

  const exactMatch = classifyMatches(
    'exact',
    boundaries.filter((boundary) => semanticForms(boundary).includes(normalizedQuery))
  );
  if (exactMatch) return exactMatch;

  const prefixMatch = classifyMatches(
    'prefix',
    boundaries.filter((boundary) =>
      semanticForms(boundary).some((form) => form.startsWith(normalizedQuery))
    )
  );
  if (prefixMatch) return prefixMatch;

  const containsMatch = classifyMatches(
    'contains',
    boundaries.filter((boundary) => {
      const normalizedName = normalize(boundary.name);
      return normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName);
    })
  );
  if (containsMatch) return containsMatch;

  const queryTokens = normalizedQuery
    .split(/[^a-z0-9_:\\-]+/i)
    .filter((token) => token.length >= 3);
  const suggestions = dedupeBoundaries(
    sortResolutionCandidates(
      boundaries.filter((boundary) => {
        const forms = semanticForms(boundary);
        return queryTokens.some((token) => forms.some((form) => form.includes(token)));
      }),
      kinds,
      query
    )
  ).slice(0, 5);

  return { status: 'unresolved', candidates: suggestions };
}

function confidenceFor(
  count: number,
  tiers: TrustTier[]
): OperationalAnswerPayload['primaryAnswer']['confidence'] {
  if (count === 0) return 'none';
  return tiers.some((tier) => tier < 4) ? 'medium' : 'high';
}

function buildResolutionPayload(
  query: string,
  status: ResolutionStatus,
  candidates: OperationalNodePayload[],
  matchedBy?: ResolutionMatchType
): OperationalResolutionPayload {
  return {
    query,
    status,
    matchedBy,
    candidates,
  };
}

function buildEmptyAnswer(
  db: LuxDatabase,
  question: string,
  intent: OperationalQuestionIntent,
  target: OperationalNodePayload | null,
  reason: string,
  resolution: OperationalResolutionPayload
): OperationalAnswerPayload {
  return {
    question,
    intent,
    overlayTrustLevel: deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state),
    resolution,
    target,
    primaryAnswer: {
      summary: reason,
      confidence: 'none',
      items: [],
    },
    trust: {
      targetTrustTier: target?.trustTier ?? null,
      evidenceTrustTiers: [],
      mixedTrust: false,
    },
    transport: [],
    evidence: [],
    context: [],
  };
}

function buildOperationalAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  intent: OperationalQuestionIntent,
  resolution: OperationalResolutionPayload,
  options: OperationalAskOptions
): OperationalAnswerPayload {
  if (intent === 'event-listeners') {
    return buildEventListenersAnswer(db, question, target, resolution);
  }
  if (intent === 'dispatch-sources') {
    return buildDispatchSourcesAnswer(db, question, target, resolution);
  }
  if (intent === 'dispatched-jobs') {
    return buildDispatchedJobsAnswer(db, question, target, resolution);
  }
  if (intent === 'schedule-sources') {
    return buildScheduleSourcesAnswer(db, question, target, resolution);
  }
  if (intent === 'evidence') return buildEvidenceAnswer(db, question, target, resolution);
  return buildNeighborhoodAnswer(db, question, target, resolution, options);
}

function evidenceKey(item: OperationalEvidencePayload): string {
  return `${item.edge?.id ?? 'no-edge'}:${item.source?.id ?? 'unknown'}:${item.target?.id ?? 'unknown'}`;
}

function baseAnswer(
  db: LuxDatabase,
  question: string,
  intent: OperationalQuestionIntent,
  target: OperationalBoundary,
  items: OperationalNodePayload[],
  evidence: OperationalEvidencePayload[],
  summary: string,
  resolution: OperationalResolutionPayload,
  context: OperationalEvidencePayload[] = []
): OperationalAnswerPayload {
  const uniqueItems = uniqueNodes(items);
  const uniqueEvidence = uniqueEvidenceItems(evidence);
  const supportKeys = new Set(uniqueEvidence.map(evidenceKey));
  const uniqueContext = uniqueEvidenceItems(context).filter(
    (entry) => !supportKeys.has(evidenceKey(entry))
  );
  const trustEvidence = [...uniqueEvidence, ...uniqueContext];
  const tiers = trustEvidence.flatMap((entry) => {
    if (entry.edge) return [entry.edge.trustTier];
    return (entry.contracts ?? []).map((contract) => contract.trustTier);
  });
  const transport = trustEvidence.flatMap((entry) =>
    entry.edge
      ? [
          {
            edgeId: entry.edge.id,
            edgeType: entry.edge.edgeType,
            transport: entry.edge.transport,
            trustTier: entry.edge.trustTier,
          },
        ]
      : []
  );

  return {
    question,
    intent,
    overlayTrustLevel: deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state),
    resolution,
    target: boundaryPayload(target),
    primaryAnswer: {
      summary,
      confidence: confidenceFor(uniqueItems.length, tiers.length > 0 ? tiers : [target.trust_tier]),
      items: uniqueItems,
    },
    trust: {
      targetTrustTier: target.trust_tier,
      evidenceTrustTiers: tiers,
      mixedTrust: new Set([target.trust_tier, ...tiers]).size > 1,
    },
    transport,
    evidence: uniqueEvidence,
    context: uniqueContext,
  };
}

function uniqueNodes(nodes: OperationalNodePayload[]): OperationalNodePayload[] {
  const seen = new Set<string>();
  const result: OperationalNodePayload[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
  }
  return result;
}

function uniqueEvidenceItems(evidence: OperationalEvidencePayload[]): OperationalEvidencePayload[] {
  const seen = new Set<string>();
  const result: OperationalEvidencePayload[] = [];
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildScheduleSourcesAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  resolution: OperationalResolutionPayload
): OperationalAnswerPayload {
  const upstream = getOperationalUpstreamTriggers(db, target.id);
  const schedules = (upstream?.triggers ?? []).filter(
    (entry) => entry.sourceBoundary.kind === 'schedule'
  );
  const items = schedules.map((entry) => boundaryPayload(entry.sourceBoundary));
  const evidence = schedules.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: boundaryPayload(entry.sourceBoundary),
    target: boundaryPayload(target),
    contracts: mapContracts(entry.sourceContracts),
    filePath: entry.sourceBoundary.file_path ?? null,
  }));
  const summary =
    items.length === 0
      ? `Lux found no persisted schedule trigger for ${nodeLabel(boundaryPayload(target))}.`
      : `${items.map(nodeLabel).join(', ')} schedules ${nodeLabel(boundaryPayload(target))}.`;
  return baseAnswer(db, question, 'schedule-sources', target, items, evidence, summary, resolution);
}

function buildDispatchSourcesAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  resolution: OperationalResolutionPayload
): OperationalAnswerPayload {
  const dispatchSources = getOperationalDispatchSourcesForJob(db, target.id);
  const entries = dispatchSources?.dispatchSources ?? [];
  const items = entries.map((entry) => getNodePayload(db, entry.edge.source_id));
  const evidence = entries.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: getNodePayload(db, entry.edge.source_id),
    target: boundaryPayload(target),
    contracts: mapContracts(entry.sourceContracts),
    filePath: getNodePayload(db, entry.edge.source_id).filePath ?? null,
  }));
  const summary =
    items.length === 0
      ? `Lux found no persisted dispatcher for ${nodeLabel(boundaryPayload(target))}.`
      : `${items.map(nodeLabel).join(', ')} dispatches ${nodeLabel(boundaryPayload(target))}.`;
  return baseAnswer(db, question, 'dispatch-sources', target, items, evidence, summary, resolution);
}

function buildDispatchedJobsAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  resolution: OperationalResolutionPayload
): OperationalAnswerPayload {
  const dispatched = getOperationalDispatchedJobs(db, target.id);
  const dispatchEvidence = dispatched.dispatchedJobs.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: boundaryPayload(target),
    target: boundaryPayload(entry.jobBoundary),
    contracts: mapContracts(entry.jobContracts),
    filePath: entry.jobBoundary.file_path ?? null,
  }));

  const triggerNeighborhood = getTrustAwareOperationalNeighborhood(db, target.id, {
    maxDepth: 1,
    minTrustTier: 1,
  });
  const triggerEvidence = triggerNeighborhood.edges
    .filter((edge) => edge.direction === 'outbound' && edge.edgeType === 'TRIGGERS')
    .map((edge) => {
      const targetBoundary = db.getOperationalBoundary(edge.targetId);
      return {
        edge: {
          id: edge.id,
          edgeType: edge.edgeType,
          transport: edge.transport ?? null,
          trustTier: edge.trustTier,
        },
        source: boundaryPayload(target),
        target: getNodePayload(db, edge.targetId),
        contracts: targetBoundary
          ? mapContracts(db.getOperationalContractsForBoundary(targetBoundary.id))
          : [],
        filePath: targetBoundary?.file_path ?? null,
      };
    });

  const evidence = [...dispatchEvidence, ...triggerEvidence];
  const items = evidence
    .map((entry) => entry.target)
    .filter((entry): entry is OperationalNodePayload => Boolean(entry));
  const summary =
    items.length === 0
      ? `Lux found no persisted triggered command or job for ${nodeLabel(boundaryPayload(target))}.`
      : `${nodeLabel(boundaryPayload(target))} triggers ${items.map(nodeLabel).join(', ')}.`;
  return baseAnswer(db, question, 'dispatched-jobs', target, items, evidence, summary, resolution);
}

function buildEventListenersAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  resolution: OperationalResolutionPayload
): OperationalAnswerPayload {
  const eventListeners = getOperationalEventListeners(db, target.id);
  const entries = eventListeners?.listeners ?? [];
  const items = entries.map((entry) => getNodePayload(db, entry.handler.symbol_id));
  const evidence = entries.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: boundaryPayload(target),
    target: getNodePayload(db, entry.handler.symbol_id),
    contracts: mapContracts(eventListeners?.contracts ?? []),
    filePath: getNodePayload(db, entry.handler.symbol_id).filePath ?? null,
  }));
  const summary =
    items.length === 0
      ? `Lux found no persisted listener for ${nodeLabel(boundaryPayload(target))}.`
      : `${items.map(nodeLabel).join(', ')} handles ${nodeLabel(boundaryPayload(target))}.`;
  return baseAnswer(db, question, 'event-listeners', target, items, evidence, summary, resolution);
}

function buildEvidenceAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  resolution: OperationalResolutionPayload
): OperationalAnswerPayload {
  const handlers = getOperationalBoundaryHandlers(db, target.id)?.handlers ?? [];
  const upstream = getOperationalUpstreamTriggers(db, target.id)?.triggers ?? [];
  const outbound = getOperationalDispatchedJobs(db, target.id).dispatchedJobs;
  const dispatchSources =
    target.kind === 'job'
      ? (getOperationalDispatchSourcesForJob(db, target.id)?.dispatchSources ?? [])
      : [];
  const eventListeners =
    target.kind === 'event' ? (getOperationalEventListeners(db, target.id)?.listeners ?? []) : [];
  const targetContracts = mapContracts(db.getOperationalContractsForBoundary(target.id));

  const evidence: OperationalEvidencePayload[] = [
    ...(targetContracts.length > 0
      ? [
          {
            source: boundaryPayload(target),
            target: boundaryPayload(target),
            contracts: targetContracts,
            filePath: target.file_path ?? null,
            note: 'persisted boundary contract',
          },
        ]
      : []),
    ...upstream.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: boundaryPayload(entry.sourceBoundary),
      target: boundaryPayload(target),
      contracts: mapContracts(entry.sourceContracts),
      filePath: entry.sourceBoundary.file_path ?? null,
    })),
    ...dispatchSources.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: getNodePayload(db, entry.edge.source_id),
      target: boundaryPayload(target),
      contracts: mapContracts(entry.sourceContracts),
      filePath: getNodePayload(db, entry.edge.source_id).filePath ?? null,
    })),
    ...outbound.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: boundaryPayload(target),
      target: boundaryPayload(entry.jobBoundary),
      contracts: mapContracts(entry.jobContracts),
      filePath: entry.jobBoundary.file_path ?? null,
    })),
    ...handlers.flatMap((entry) =>
      entry.edge
        ? [
            {
              edge: mapEdge(entry.edge),
              source: boundaryPayload(target),
              target: getNodePayload(db, entry.handler.symbol_id),
              filePath: getNodePayload(db, entry.handler.symbol_id).filePath ?? null,
              note: `handler tier ${entry.handler.trust_tier}`,
            },
          ]
        : []
    ),
    ...eventListeners.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: boundaryPayload(target),
      target: getNodePayload(db, entry.handler.symbol_id),
      filePath: getNodePayload(db, entry.handler.symbol_id).filePath ?? null,
      note: `handler tier ${entry.handler.trust_tier}`,
    })),
  ];

  const items = evidence
    .map((entry) => entry.source)
    .filter((entry): entry is OperationalNodePayload => Boolean(entry));
  const summary =
    evidence.length === 0
      ? `Lux found no persisted direct operational evidence for ${nodeLabel(boundaryPayload(target))}.`
      : `${nodeLabel(boundaryPayload(target))} is supported by ${evidence.length} persisted operational evidence item(s).`;
  return baseAnswer(db, question, 'evidence', target, items, evidence, summary, resolution);
}

function buildNeighborhoodAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  resolution: OperationalResolutionPayload,
  options: OperationalAskOptions
): OperationalAnswerPayload {
  const minTrustTier = (options.minTrustTier ?? 1) as TrustTier;
  const neighborhood = getTrustAwareOperationalNeighborhood(db, target.id, {
    maxDepth: options.maxDepth ?? 2,
    minTrustTier,
  });
  const items = neighborhood.nodes
    .filter((node) => node.id !== target.id)
    .map((node) => getNodePayload(db, node.id));
  const context = neighborhood.edges.map((edge) => ({
    edge: {
      id: edge.id,
      edgeType: edge.edgeType,
      transport: edge.transport ?? null,
      trustTier: edge.trustTier,
    },
    source: getNodePayload(db, edge.sourceId),
    target: getNodePayload(db, edge.targetId),
  }));
  const summary =
    items.length === 0
      ? `Lux found no persisted operational neighborhood around ${nodeLabel(boundaryPayload(target))}.`
      : `${nodeLabel(boundaryPayload(target))} can reach or be reached by ${items
          .map(nodeLabel)
          .join(', ')}.`;
  return baseAnswer(db, question, 'neighborhood', target, items, [], summary, resolution, context);
}

function describeEvidenceTrust(tiers: TrustTier[]): string {
  if (tiers.length === 0) return 'none';
  const unique = [...new Set(tiers)].sort((left, right) => left - right);
  if (unique.length === 1) return `tier ${unique[0]}`;
  return `mixed tiers ${unique.join(', ')}`;
}

function renderEvidenceSection(
  title: string,
  entries: OperationalEvidencePayload[],
  emptyLabel?: string
): string[] {
  const lines: string[] = [`\n${title}`];
  if (entries.length === 0) {
    if (emptyLabel) lines.push(`- ${emptyLabel}`);
    return lines;
  }

  for (const evidence of entries) {
    const source = evidence.source ? nodeLabel(evidence.source) : 'unknown';
    const target = evidence.target ? nodeLabel(evidence.target) : 'unknown';
    const edge = evidence.edge
      ? `${evidence.edge.edgeType} ${evidence.edge.transport ?? 'n/a'} tier=${evidence.edge.trustTier}`
      : 'no edge';
    lines.push(`- ${source} -> ${target}: ${edge}`);
    if (evidence.filePath) lines.push(`  file: ${evidence.filePath}`);
    if (evidence.contracts && evidence.contracts.length > 0) {
      lines.push(
        `  contracts: ${evidence.contracts
          .map((contract) => `${contract.id} tier=${contract.trustTier}`)
          .join(', ')}`
      );
    }
    if (evidence.note) lines.push(`  ${evidence.note}`);
  }

  return lines;
}

function renderCandidateSection(title: string, candidates: OperationalNodePayload[]): string[] {
  const lines: string[] = [`\n${title}`];
  for (const candidate of candidates) {
    lines.push(
      `- ${nodeLabel(candidate)}${candidate.trustTier ? ` tier=${candidate.trustTier}` : ''}${candidate.filePath ? ` (${candidate.filePath})` : ''}`
    );
  }
  return lines;
}

function renderTextAnswer(payload: OperationalAnswerPayload): string {
  const lines: string[] = [];
  lines.push(payload.primaryAnswer.summary);
  lines.push(`Confidence: ${payload.primaryAnswer.confidence}`);
  lines.push(`Overlay Trust: ${payload.overlayTrustLevel}`);
  if (payload.target) {
    lines.push(
      `Target: ${nodeLabel(payload.target)}${payload.target.filePath ? ` (${payload.target.filePath})` : ''}`
    );
    if (payload.target.trustTier) lines.push(`Target Trust Tier: ${payload.target.trustTier}`);
  }
  lines.push(`Evidence Trust: ${describeEvidenceTrust(payload.trust.evidenceTrustTiers)}`);

  if (payload.resolution.status === 'resolved' && payload.resolution.matchedBy) {
    lines.push(`Resolution Match: ${payload.resolution.matchedBy}`);
  }

  if (payload.resolution.status !== 'resolved') {
    lines.push(`Resolution: ${payload.resolution.status}`);
    if (payload.resolution.candidates.length > 0) {
      lines.push(
        ...renderCandidateSection(
          payload.resolution.status === 'ambiguous' ? 'Candidates' : 'Closest Candidates',
          payload.resolution.candidates
        )
      );
    }
  }

  if (payload.transport.length > 0) {
    lines.push('\nTransport');
    for (const transport of payload.transport) {
      lines.push(
        `- ${transport.edgeType} ${transport.transport ?? 'n/a'} tier=${transport.trustTier} evidence=${transport.edgeId}`
      );
    }
  }

  lines.push(
    ...renderEvidenceSection('Direct Evidence', payload.evidence, 'none persisted for this answer')
  );
  if (payload.context.length > 0) {
    lines.push(...renderEvidenceSection('Context', payload.context));
  }

  return lines.join('\n');
}

function validateOptions(options: OperationalAskOptions): void {
  if (options.kind) {
    const validKinds: OperationalBoundaryKind[] = ['command', 'schedule', 'job', 'event', 'http'];
    if (!validKinds.includes(options.kind)) {
      console.error(`Error: --kind must be one of ${validKinds.join(', ')}.`);
      process.exit(1);
    }
  }

  const maxDepth = options.maxDepth ?? 2;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    console.error('Error: --max-depth must be a positive integer.');
    process.exit(1);
  }

  const minTrustTier = options.minTrustTier ?? 1;
  if (!Number.isInteger(minTrustTier) || minTrustTier < 1 || minTrustTier > 5) {
    console.error('Error: --min-trust-tier must be an integer between 1 and 5.');
    process.exit(1);
  }
}

function executeOperationalAsk(
  db: LuxDatabase,
  question: string,
  options: OperationalAskOptions & { corpusPath: string }
): OperationalAskExecutionResult {
  const intent = inferIntent(question);
  const targetText = options.target ?? extractTargetQuestionFragment(question, intent);
  const resolution = resolveBoundary(
    db,
    options.corpusPath,
    targetText,
    preferredKindsForIntent(intent, options.kind, targetText)
  );

  const payload =
    resolution.status === 'resolved'
      ? buildOperationalAnswer(
          db,
          question,
          resolution.boundary,
          intent,
          buildResolutionPayload(
            targetText,
            'resolved',
            resolution.candidates.map(boundaryPayload),
            resolution.matchedBy
          ),
          options
        )
      : buildEmptyAnswer(
          db,
          question,
          intent,
          null,
          resolution.status === 'ambiguous'
            ? `Multiple persisted operational boundaries matched "${targetText}". Use --kind or a more specific --target.`
            : `Lux could not resolve "${targetText}" to a persisted operational boundary.`,
          buildResolutionPayload(
            targetText,
            resolution.status,
            resolution.candidates.map(boundaryPayload),
            resolution.status === 'ambiguous' ? resolution.matchedBy : undefined
          )
        );

  return {
    answer: payload,
    rendered: options.json
      ? JSON.stringify(withReadTelemetry(payload), null, 2)
      : renderTextAnswer(payload),
    exitCode: resolution.status === 'resolved' ? 0 : 1,
  };
}

export function runOperationalAsk(
  program: Command,
  questionParts: string[],
  options: OperationalAskOptions
): void {
  validateOptions(options);

  const question = questionParts.join(' ').trim();
  if (!question && !options.target) {
    console.error('Error: ask requires a question or --target.');
    process.exit(1);
  }

  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });
  const db = openCliReadIndex(dbPath, options.json ?? false);
  if (!db) return;

  try {
    const result = executeOperationalAsk(db, question, { ...options, corpusPath });
    console.log(result.rendered);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } finally {
    db.close();
  }
}
