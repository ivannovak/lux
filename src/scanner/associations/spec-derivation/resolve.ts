import type { LuxDatabase } from '../../../db/index.js';
import type {
  OperationalBoundary,
  OperationalBoundaryKind,
  StructuralNode,
  TrustTier,
} from '../../../db/types.js';
import { getSurfaceFeaturePath, type FeaturePath } from '../surface-retrieval.js';
import { resolveFeaturePathTarget } from '../feature-path/resolve.js';
import type {
  SpecDerivationResolutionKind,
  SpecDerivationTarget,
  SpecDerivationTargetCandidate,
  SpecDerivationTargetKind,
} from './contract.js';

type ResolutionMatchType = 'exact' | 'semantic-exact' | 'prefix' | 'contains';

export interface ResolvedSpecDerivationTarget {
  target: SpecDerivationTarget;
  featurePath?: FeaturePath;
  routeSurface?: StructuralNode | null;
  operationalBoundary?: OperationalBoundary;
  listenerEventBoundary?: OperationalBoundary;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^opb:/, '')
    .replace(/^command:/, '')
    .replace(/^job:/, '')
    .replace(/^event:/, '')
    .replace(/^listener:/, '')
    .replace(/@\S+:\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function basenameOf(value: string): string {
  const normalized = normalize(value);
  const phpTail = normalized.split('\\').at(-1) ?? normalized;
  return phpTail.split(':').at(-1) ?? phpTail;
}

function supportFromTrustTier(tier?: TrustTier): SpecDerivationTargetCandidate['support'] {
  if (tier === undefined) return 'contextual';
  if (tier >= 4) return 'direct';
  if (tier >= 2) return 'contextual';
  return 'weak';
}

function operationalForms(boundary: OperationalBoundary): string[] {
  return [
    normalize(boundary.id),
    normalize(boundary.name),
    basenameOf(boundary.id),
    basenameOf(boundary.name),
  ].filter(Boolean);
}

function boundaryCandidate(
  boundary: OperationalBoundary,
  kind: SpecDerivationResolutionKind = boundary.kind as SpecDerivationResolutionKind
): SpecDerivationTargetCandidate {
  return {
    id: boundary.id,
    kind,
    label: `${boundary.kind}:${boundary.name}`,
    filePath: boundary.file_path ?? null,
    support: supportFromTrustTier(boundary.trust_tier),
  };
}

function structuralCandidate(
  node: StructuralNode,
  kind: SpecDerivationResolutionKind
): SpecDerivationTargetCandidate {
  return {
    id: node.id,
    kind,
    label: node.qualified_name ?? node.symbol_name ?? node.id,
    filePath: node.file_path ?? null,
    support: 'direct',
  };
}

function classifyOperationalMatches(
  targetKind: SpecDerivationTargetKind,
  identifier: string,
  _matchedBy: ResolutionMatchType,
  matches: OperationalBoundary[]
): ResolvedSpecDerivationTarget | null {
  const candidates = matches.slice(0, 5);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const boundary = candidates[0];
    return {
      target: {
        kind: targetKind,
        identifier,
        location: boundary.file_path,
        resolutionState: 'resolved',
        resolvedNodeId: boundary.id,
        candidates: [boundaryCandidate(boundary, targetKind)],
      },
      operationalBoundary: boundary,
    };
  }

  return {
    target: {
      kind: targetKind,
      identifier,
      resolutionState: 'ambiguous',
      candidates: candidates.map((candidate) => boundaryCandidate(candidate, targetKind)),
    },
  };
}

function resolveOperationalBoundary(
  db: LuxDatabase,
  identifier: string,
  targetKind: Extract<SpecDerivationTargetKind, 'job' | 'command'>,
  boundaryKind: OperationalBoundaryKind
): ResolvedSpecDerivationTarget {
  const boundaries = db
    .getOperationalBoundaries()
    .filter((boundary) => boundary.kind === boundaryKind);
  const query = normalize(identifier);
  if (!query) {
    return unresolvedTarget(targetKind, identifier, []);
  }

  const exact = classifyOperationalMatches(
    targetKind,
    identifier,
    'exact',
    boundaries.filter((boundary) => operationalForms(boundary).includes(query))
  );
  if (exact) return exact;

  const prefix = classifyOperationalMatches(
    targetKind,
    identifier,
    'prefix',
    boundaries.filter((boundary) =>
      operationalForms(boundary).some((form) => form.startsWith(query))
    )
  );
  if (prefix) return prefix;

  const contains = classifyOperationalMatches(
    targetKind,
    identifier,
    'contains',
    boundaries.filter((boundary) => {
      const name = normalize(boundary.name);
      return name.includes(query) || query.includes(name);
    })
  );
  if (contains) return contains;

  const suggestions = boundaries
    .filter((boundary) =>
      operationalForms(boundary).some((form) => query.includes(form) || form.includes(query))
    )
    .slice(0, 5);
  return unresolvedTarget(
    targetKind,
    identifier,
    suggestions.map((candidate) => boundaryCandidate(candidate, targetKind))
  );
}

function unresolvedTarget(
  kind: SpecDerivationTargetKind,
  identifier: string,
  candidates: SpecDerivationTargetCandidate[]
): ResolvedSpecDerivationTarget {
  return {
    target: {
      kind,
      identifier,
      resolutionState: 'unresolved',
      candidates,
    },
  };
}

function resolveRouteTarget(
  db: LuxDatabase,
  identifier: string,
  targetKind: Extract<SpecDerivationTargetKind, 'route' | 'handler'>
): ResolvedSpecDerivationTarget {
  const resolution = resolveFeaturePathTarget(db, identifier);
  if (resolution.status === 'resolved') {
    const routeTarget = resolution.candidates[0];
    const featurePath = getSurfaceFeaturePath(db, routeTarget.id) ?? undefined;
    const surface = db.getStructuralNode(routeTarget.id);
    return {
      target: {
        kind: targetKind,
        identifier,
        location: routeTarget.filePath ?? undefined,
        resolutionState: 'resolved',
        resolvedNodeId:
          targetKind === 'handler'
            ? (featurePath?.providers[0]?.id ?? routeTarget.id)
            : routeTarget.id,
        candidates: [
          {
            id: routeTarget.id,
            kind: targetKind,
            label: routeTarget.label ?? routeTarget.id,
            filePath: routeTarget.filePath,
            support: 'direct',
          },
        ],
      },
      featurePath,
      routeSurface: surface,
    };
  }

  if (targetKind === 'handler') {
    const handlerResolution = resolveHandlerByFeaturePathProvider(db, identifier);
    if (handlerResolution) return handlerResolution;
  }

  return {
    target: {
      kind: targetKind,
      identifier,
      resolutionState: resolution.status,
      candidates: resolution.candidates.map((candidate) => ({
        id: candidate.id,
        kind: targetKind,
        label: candidate.label ?? candidate.id,
        filePath: candidate.filePath,
        support: 'contextual',
      })),
    },
  };
}

function resolveHandlerByFeaturePathProvider(
  db: LuxDatabase,
  identifier: string
): ResolvedSpecDerivationTarget | null {
  const query = normalize(identifier);
  const matches: Array<{
    surface: StructuralNode;
    featurePath: FeaturePath;
    provider: StructuralNode;
  }> = [];

  for (const surface of db.getCapabilitySurfaces()) {
    const featurePath = getSurfaceFeaturePath(db, surface.id);
    if (!featurePath) continue;
    for (const provider of featurePath.providers) {
      const forms = [
        normalize(provider.id),
        normalize(provider.symbol_name ?? ''),
        normalize(provider.qualified_name ?? ''),
        basenameOf(provider.id),
        basenameOf(provider.symbol_name ?? ''),
        basenameOf(provider.qualified_name ?? ''),
      ].filter(Boolean);
      if (forms.includes(query)) matches.push({ surface, featurePath, provider });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return {
      target: {
        kind: 'handler',
        identifier,
        resolutionState: 'ambiguous',
        candidates: matches
          .slice(0, 5)
          .map((match) => structuralCandidate(match.provider, 'handler')),
      },
    };
  }

  const match = matches[0];
  return {
    target: {
      kind: 'handler',
      identifier,
      location: match.provider.file_path,
      resolutionState: 'resolved',
      resolvedNodeId: match.provider.id,
      candidates: [structuralCandidate(match.provider, 'handler')],
    },
    featurePath: match.featurePath,
    routeSurface: match.surface,
  };
}

function resolveListenerTarget(db: LuxDatabase, identifier: string): ResolvedSpecDerivationTarget {
  const query = normalize(identifier);
  const events = db.getOperationalBoundaries().filter((boundary) => boundary.kind === 'event');
  const matches: Array<{
    eventBoundary: OperationalBoundary;
    handlerNode: StructuralNode | null;
    symbolId: string;
    trustTier: TrustTier;
  }> = [];

  for (const eventBoundary of events) {
    for (const handler of db.getOperationalHandlersForBoundary(eventBoundary.id)) {
      const node = db.getStructuralNode(handler.symbol_id);
      const forms = [
        normalize(handler.symbol_id),
        normalize(node?.symbol_name ?? ''),
        normalize(node?.qualified_name ?? ''),
        basenameOf(handler.symbol_id),
        basenameOf(node?.symbol_name ?? ''),
        basenameOf(node?.qualified_name ?? ''),
        ...operationalForms(eventBoundary),
      ].filter(Boolean);
      if (forms.includes(query)) {
        matches.push({
          eventBoundary,
          handlerNode: node,
          symbolId: handler.symbol_id,
          trustTier: handler.trust_tier,
        });
      }
    }
  }

  if (matches.length === 0) return unresolvedTarget('listener', identifier, []);
  if (matches.length > 1) {
    return {
      target: {
        kind: 'listener',
        identifier,
        resolutionState: 'ambiguous',
        candidates: matches.slice(0, 5).map((match) => ({
          id: match.symbolId,
          kind: 'listener',
          label:
            match.handlerNode?.qualified_name ?? match.handlerNode?.symbol_name ?? match.symbolId,
          filePath: match.handlerNode?.file_path ?? match.eventBoundary.file_path ?? null,
          support: supportFromTrustTier(match.trustTier),
        })),
      },
    };
  }

  const match = matches[0];
  return {
    target: {
      kind: 'listener',
      identifier,
      location: match.handlerNode?.file_path ?? match.eventBoundary.file_path,
      resolutionState: 'resolved',
      resolvedNodeId: match.symbolId,
      candidates: [
        {
          id: match.symbolId,
          kind: 'listener',
          label:
            match.handlerNode?.qualified_name ?? match.handlerNode?.symbol_name ?? match.symbolId,
          filePath: match.handlerNode?.file_path ?? match.eventBoundary.file_path ?? null,
          support: supportFromTrustTier(match.trustTier),
        },
        boundaryCandidate(match.eventBoundary, 'event-context'),
      ],
    },
    operationalBoundary: match.eventBoundary,
    listenerEventBoundary: match.eventBoundary,
  };
}

export function resolveSpecDerivationTarget(
  db: LuxDatabase,
  input: {
    kind: SpecDerivationTargetKind;
    identifier: string;
    corpusPath: string;
  }
): ResolvedSpecDerivationTarget {
  if (input.kind === 'route' || input.kind === 'handler') {
    return resolveRouteTarget(db, input.identifier, input.kind);
  }
  if (input.kind === 'job') {
    return resolveOperationalBoundary(db, input.identifier, 'job', 'job');
  }
  if (input.kind === 'command') {
    return resolveOperationalBoundary(db, input.identifier, 'command', 'command');
  }
  return resolveListenerTarget(db, input.identifier);
}
