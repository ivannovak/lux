// Surface-centered retrieval helpers.
//
// Assembles a FeaturePath from the structural overlay around a capability surface:
//
//   consumers → [bridge] → surface → provider → validator / response contract / artifact
//
// Two output layers:
//   - compact: a single-line human-readable path for QA and discovery
//   - block:   a multi-line formatted summary with node IDs and confidence
//
// Retrieval uses only the DB — no re-parsing. Evidence is available but optional.

import { LuxDatabase } from '../../db/index.js';
import type { StructuralNode, EdgeEvidence } from '../../db/types.js';
import type { TransportContractMetadata } from './types.js';

// ---------------------------------------------------------------------------
// FeaturePath
// ---------------------------------------------------------------------------

/**
 * Minimum confidence for a consumer edge to be considered transport-proven.
 * Edges below this threshold are gathered for auditability but not surfaced
 * as primary chain members in compact output.
 */
const PROVEN_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Synthetic provider token used to render closure-backed surfaces as honestly
 * handled in compact output without fabricating a named provider node.
 */
export const CLOSURE_HANDLER_TOKEN = 'closure-handler';

/**
 * A surface-centered feature path assembled from overlay edges.
 *
 * All arrays may be empty — partial paths are valid and useful.
 */
export interface FeaturePath {
  /** The capability-surface node at the center. */
  surface: StructuralNode;
  /**
   * All consumer nodes (calls_surface source side), regardless of confidence.
   * Kept for auditability.
   */
  consumers: StructuralNode[];
  /**
   * Subset of consumers whose edge confidence meets PROVEN_CONFIDENCE_THRESHOLD.
   * Compact path output prefers this set over the full consumers list.
   */
  provenConsumers: StructuralNode[];
  /** Nodes that handle this surface (handled_by target side). */
  providers: StructuralNode[];
  /** Request validator nodes linked to the primary provider (validates_with). */
  validators: StructuralNode[];
  /** Response contract nodes linked to the primary provider (returns_contract). */
  responseContracts: StructuralNode[];
  /** Generated artifact file nodes derived from this surface (derived_from source side). */
  artifacts: StructuralNode[];
  /** The file that declares this surface (declares_surface source side). */
  declaringFile: StructuralNode | null;
  /**
   * How the underlying surface declaration supplies its handler, mirrored from
   * CapabilitySurfaceMetadata.providerKind. Absent when the detector could not
   * classify the declaration form (legacy / non-Laravel surfaces).
   *
   *   - `controller` — route targets a named class/action; `providers` is
   *                    expected to resolve via `handled_by`.
   *   - `closure`    — route targets an inline anonymous function; no provider
   *                    node exists, and retrieval treats the surface as
   *                    first-class handled rather than as an unresolved miss.
   */
  providerKind?: 'controller' | 'closure';
  /**
   * Convenience flag: true iff `providerKind === 'closure'`. Downstream
   * formatters branch on this to emit a synthetic closure-handler token
   * without confusing it for a real provider.
   */
  isClosureBacked: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a FeaturePath for the given surface node ID.
 *
 * Returns null if the surface does not exist in the DB.
 */
export function getSurfaceFeaturePath(db: LuxDatabase, surfaceId: string): FeaturePath | null {
  const ctx = db.getSurfaceCenteredContext(surfaceId);
  if (!ctx) return null;

  const { surface, edges } = ctx;
  const surfaceMeta = parseSurfaceMeta(surface);
  const path: FeaturePath = {
    surface,
    consumers: [],
    provenConsumers: [],
    providers: [],
    validators: [],
    responseContracts: [],
    artifacts: [],
    declaringFile: null,
    providerKind: surfaceMeta.providerKind,
    isClosureBacked: surfaceMeta.providerKind === 'closure',
  };

  // Guard every endpoint resolution against external (vendor-pack) nodes: an
  // app→vendor boundary `calls` edge points at a merged vendor node, which must
  // never surface as a capability's consumer/provider/artifact/declaring-file
  // (ADR-3 / REQ-7). External nodes stay reachable through a trace, not here.
  for (const { edge } of edges) {
    if (edge.edge_type === 'handled_by' && edge.source_node_id === surfaceId) {
      const node = db.getStructuralNode(edge.target_node_id);
      if (node && !LuxDatabase.isExternalNode(node)) path.providers.push(node);
    } else if (edge.edge_type === 'calls_surface' && edge.target_node_id === surfaceId) {
      const node = db.getStructuralNode(edge.source_node_id);
      if (node && !LuxDatabase.isExternalNode(node)) {
        path.consumers.push(node);
        if (edge.confidence >= PROVEN_CONFIDENCE_THRESHOLD) {
          path.provenConsumers.push(node);
        }
      }
    } else if (edge.edge_type === 'derived_from' && edge.target_node_id === surfaceId) {
      const node = db.getStructuralNode(edge.source_node_id);
      if (node && !LuxDatabase.isExternalNode(node)) path.artifacts.push(node);
    } else if (edge.edge_type === 'declares_surface' && edge.target_node_id === surfaceId) {
      if (!path.declaringFile) {
        const node = db.getStructuralNode(edge.source_node_id);
        path.declaringFile = node && !LuxDatabase.isExternalNode(node) ? node : null;
      }
    }
  }

  // Expand provider edges to find validators and response contracts.
  // Only inspects the primary provider to keep the path compact.
  const controllerMethodScope = inferControllerMethodScope(surfaceMeta, path.providers[0]?.id);

  for (const provider of path.providers.slice(0, 1)) {
    const providerEdges = db.getRelatedEdgesWithEvidence(provider.id);
    for (const { edge, evidence } of providerEdges) {
      if (!edgeMatchesControllerMethodScope(edge.id, evidence, controllerMethodScope)) continue;

      if (edge.edge_type === 'validates_with' && edge.source_node_id === provider.id) {
        const node = db.getStructuralNode(edge.target_node_id);
        if (node && !LuxDatabase.isExternalNode(node)) path.validators.push(node);
      } else if (edge.edge_type === 'returns_contract' && edge.source_node_id === provider.id) {
        const node = db.getStructuralNode(edge.target_node_id);
        if (node && !LuxDatabase.isExternalNode(node)) path.responseContracts.push(node);
      }
    }
  }

  path.validators.sort(compareContractsForDisplay);
  path.responseContracts.sort(compareContractsForDisplay);

  return path;
}

/**
 * Assemble feature paths for all surfaces declared in a given file.
 *
 * @param db - Database to query.
 * @param filePath - Relative file path (as stored in node IDs, e.g. "routes/api.php").
 */
export function getFeaturePathsForFile(db: LuxDatabase, filePath: string): FeaturePath[] {
  const surfaces = db.getCapabilitySurfaces();
  const results: FeaturePath[] = [];

  for (const surface of surfaces) {
    if (surface.file_path !== filePath) continue;
    const path = getSurfaceFeaturePath(db, surface.id);
    if (path) results.push(path);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Compact feature-path formatter
// ---------------------------------------------------------------------------

/**
 * Format a FeaturePath as a single-line compact summary.
 *
 * Output format (arrows indicate direction of call/dependency):
 * ```
 * consumer → surface → provider → request:<label> → response:<label> → interaction:<kind>
 * ```
 *
 * Contract labels include fidelity: `exact(ClassName)` or `coarse(empty-ack)`.
 * Tokens use `symbol_name` for readability where available, falling back to node ID.
 *
 * Closure-backed surfaces (`providerKind === 'closure'`) never have a
 * `handled_by` provider, but they are genuinely handled — the route body is
 * an inline anonymous function. To distinguish these from unresolved provider
 * misses, the provider slot renders the synthetic `closure-handler` token
 * instead of being silently dropped. No fabricated class name is emitted.
 */
export function formatFeaturePath(path: FeaturePath): string {
  const parts: string[] = [];

  // Left side: prefer transport-proven consumers; fall back to all consumers for
  // auditability only when nothing proven exists.
  const displayConsumers = path.provenConsumers.length > 0 ? path.provenConsumers : path.consumers;
  for (const c of displayConsumers.slice(0, 2)) {
    parts.push(shortLabel(c));
  }
  if (displayConsumers.length > 2) {
    parts.push(`+${displayConsumers.length - 2} more`);
  }

  // Center: surface
  parts.push(shortLabel(path.surface));

  // Right side: provider → validator/contract
  // Controller-backed surfaces render their resolved provider node.
  // Closure-backed surfaces with no provider emit a synthetic handler token so
  // they appear as first-class handled rather than as an unresolved miss.
  if (path.providers.length > 0) {
    parts.push(shortLabel(path.providers[0]));
  } else if (path.isClosureBacked) {
    parts.push(CLOSURE_HANDLER_TOKEN);
  }

  for (const v of path.validators.slice(0, 1)) {
    parts.push(`request:${formatContractLabel(v)}`);
  }

  for (const r of path.responseContracts.slice(0, 1)) {
    parts.push(`response:${formatContractLabel(r)}`);
  }

  // Artifact(s) shown at the end
  for (const a of path.artifacts.slice(0, 1)) {
    parts.push(shortLabel(a));
  }

  // Interaction kind (if derivable)
  const interactionKind = inferSurfaceInteractionKind(path.validators, path.responseContracts);
  if (interactionKind) {
    parts.push(`interaction:${interactionKind}`);
  }

  return parts.join(' → ');
}

// ---------------------------------------------------------------------------
// Block formatter (multi-line, for context injection)
// ---------------------------------------------------------------------------

/**
 * Format a FeaturePath as a multi-line block suitable for injection into
 * expert discovery context. Includes node IDs, roles, and a compact path line.
 */
export function formatFeaturePathBlock(path: FeaturePath): string {
  const lines: string[] = [];
  const meta = parseSurfaceMeta(path.surface);
  const handle = path.surface.symbol_name ?? path.surface.id;

  lines.push(`Surface: ${handle}`);
  if (meta.routeName) {
    lines.push(`  Route name: ${meta.routeName}`);
  }

  if (path.declaringFile) {
    lines.push(`  Declared in: ${path.declaringFile.file_path ?? path.declaringFile.id}`);
  }

  // Handler classification — controller-backed surfaces list their resolved
  // provider node(s); closure-backed surfaces render an explicit inline
  // handler line so readers can distinguish them from unresolved provider
  // misses (which stay silent, preserving the signal).
  if (path.providers.length > 0) {
    lines.push(`  Provider(s): ${path.providers.map(shortLabel).join(', ')}`);
  } else if (path.isClosureBacked) {
    lines.push(`  Handler: closure (inline)`);
  }

  if (path.validators.length > 0) {
    lines.push(`  Validates with: ${path.validators.map(formatContractLabel).join(', ')}`);
  }

  if (path.responseContracts.length > 0) {
    lines.push(`  Returns: ${path.responseContracts.map(formatContractLabel).join(', ')}`);
  }

  const interactionKind = inferSurfaceInteractionKind(path.validators, path.responseContracts);
  if (interactionKind) {
    lines.push(`  Interaction: ${interactionKind}`);
  }

  if (path.consumers.length > 0) {
    // Annotate consumers that are below the proven threshold as "(candidate)"
    // so the block provides an auditable trail of all evidence.
    const labels = path.consumers.map((c) => {
      const label = shortLabel(c);
      return path.provenConsumers.includes(c) ? label : `${label} (candidate)`;
    });
    lines.push(`  Consumer(s): ${labels.join(', ')}`);
  }

  if (path.artifacts.length > 0) {
    lines.push(`  Artifact(s): ${path.artifacts.map(shortLabel).join(', ')}`);
  }

  const compact = formatFeaturePath(path);
  if (compact) {
    lines.push(`  Path: ${compact}`);
  }

  return lines.join('\n');
}

/**
 * Format all feature paths for a file as a block for overlay context injection.
 * Returns null if no surfaces are associated with this file.
 */
export function formatFileFeaturePathBlock(db: LuxDatabase, filePath: string): string | null {
  const paths = getFeaturePathsForFile(db, filePath);
  if (paths.length === 0) return null;

  const blocks = paths.map((p) => formatFeaturePathBlock(p));
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface SurfaceMeta {
  routeName?: string;
  controllerMethod?: string;
  providerKind?: 'controller' | 'closure';
}

function parseSurfaceMeta(surface: StructuralNode): SurfaceMeta {
  try {
    return JSON.parse(surface.metadata ?? '{}') as SurfaceMeta;
  } catch {
    // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
    return {};
  }
}

function inferControllerMethodScope(
  surfaceMeta: SurfaceMeta,
  providerNodeId?: string
): string | undefined {
  if (surfaceMeta.controllerMethod) return surfaceMeta.controllerMethod;
  if (!providerNodeId) return undefined;

  const match = /@([A-Za-z_][A-Za-z0-9_]*)$/.exec(providerNodeId);
  return match?.[1];
}

function edgeMatchesControllerMethodScope(
  edgeId: string,
  evidence: EdgeEvidence[],
  controllerMethodScope?: string
): boolean {
  if (!controllerMethodScope) return true;

  const idSuffix = `:${controllerMethodScope}`;
  if (edgeId.endsWith(idSuffix)) return true;

  return evidence.some((ev) => ev.note?.includes(`[method:${controllerMethodScope}]`));
}

/**
 * Return a short display label for a structural node.
 * Uses symbol_name when available; falls back to the last segment of the node ID.
 */
function shortLabel(node: StructuralNode): string {
  if (node.symbol_name) return node.symbol_name;

  // Extract the meaningful part of the node ID
  const id = node.id;
  const lastColon = id.lastIndexOf(':');
  return lastColon >= 0 ? id.slice(lastColon + 1) : id;
}

/**
 * Parse TransportContractMetadata from a structural node's metadata JSON.
 * Returns null if the node has no metadata or the metadata is not a contract.
 */
export function parseContractMeta(node: StructuralNode): TransportContractMetadata | null {
  if (node.node_type !== 'contract') return null;
  try {
    const raw = JSON.parse(node.metadata ?? '{}') as Partial<TransportContractMetadata>;
    if (!raw.contractKind) return null;
    return raw as TransportContractMetadata;
  } catch {
    // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
    return null;
  }
}

/**
 * Build a concise contract label showing fidelity and kind.
 *
 * Examples:
 *   - `exact(StoreInvoiceRequest)`
 *   - `coarse(empty-ack)`
 *   - `coarse(page-response)`
 *   - `explicit-class(InvoiceResource)` — explicit class nodes not yet migrated
 */
export function formatContractLabel(node: StructuralNode): string {
  const meta = parseContractMeta(node);
  if (!meta) return shortLabel(node);

  const kind = meta.contractKind;
  const confidence = meta.shapeConfidence;

  if (confidence === 'exact') {
    // Exact contracts: show class name from symbol_name when available
    const name = node.symbol_name ?? kind;
    return `exact(${name})`;
  }

  // Coarse contracts: show kind + optional evidence subtype
  if (meta.evidenceSubtype) {
    return `coarse(${kind}/${meta.evidenceSubtype})`;
  }
  return `coarse(${kind})`;
}

/**
 * Compute a numeric retrieval score for a contract node.
 *
 * Scoring order (higher is better):
 *   5 — explicit exact contract class (FormRequest, JsonResource, DTO)
 *   4 — exact inline validator or inline-json (structured but not class-backed)
 *   3 — coarse with strong semantics: page-response, inline-json, serialized-*
 *   2 — coarse with meaningful semantics: redirect, scalar, route-bound-input, native-*
 *   1 — weak coarse: empty-ack, implicit-input-shape
 *   0 — no contract
 *
 * Page and API surfaces score the same for equivalent contract kinds (transport-neutral).
 */
export function scoreContract(node: StructuralNode): number {
  const meta = parseContractMeta(node);
  if (!meta) {
    // Non-migrated explicit contract nodes: treat as exact class
    if (node.node_type === 'contract') return 5;
    return 0;
  }

  if (meta.shapeConfidence === 'exact') {
    if (meta.contractKind === 'explicit-class') return 5;
    if (meta.contractKind === 'inline-validator' || meta.contractKind === 'inline-json') return 4;
    return 4;
  }

  // Coarse scoring — transport-neutral
  switch (meta.contractKind) {
    case 'page-response':
    case 'inline-json':
    case 'serialized-model-response':
    case 'serialized-collection-response':
      return 3;
    case 'redirect-response':
    case 'scalar-response':
    case 'route-bound-input':
    case 'native-array-response':
    case 'native-object-response':
      return 2;
    case 'empty-ack':
    case 'implicit-input-shape':
    case 'file-response':
      return 1;
    default:
      return 1;
  }
}

/**
 * Extract the dominant interactionKind from a surface's contract nodes.
 *
 * Checks both response contracts (primary) and request contracts for a
 * stable interactionKind label. Returns undefined when no strong evidence
 * exists.
 */
export function inferSurfaceInteractionKind(
  validators: StructuralNode[],
  responseContracts: StructuralNode[]
): TransportContractMetadata['interactionKind'] | undefined {
  // Response contracts carry stronger interactionKind signal
  for (const node of responseContracts) {
    const meta = parseContractMeta(node);
    if (meta?.interactionKind) return meta.interactionKind;
  }
  // Fall back to request contracts
  for (const node of validators) {
    const meta = parseContractMeta(node);
    if (meta?.interactionKind) return meta.interactionKind;
  }
  return undefined;
}

function compareContractsForDisplay(a: StructuralNode, b: StructuralNode): number {
  const scoreDelta = scoreContract(b) - scoreContract(a);
  if (scoreDelta !== 0) return scoreDelta;
  return shortLabel(a).localeCompare(shortLabel(b));
}
