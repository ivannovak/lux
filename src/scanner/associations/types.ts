// Association engine types: contexts, edges, resolvers, and node identity helpers.
//
// These types are the public contract for the cross-language overlay.
// They parallel the DB types in src/db/types.ts but carry richer in-memory
// provenance data before persistence.

import type { StructuralNode, EdgeType, ConfidenceClass } from '../../db/types.js';
import type { SharedExtractions } from '../ast/extraction-cache.js';
import type { ProgramAnalysisV1 } from '../adapters/program-analysis.js';
import type { SymbolIdCollisions } from '../identity/symbol-collisions.js';

// Re-export node type alias for convenience
export type {
  StructuralNodeType,
  EdgeType,
  ConfidenceClass,
  FreshnessStatus,
} from '../../db/types.js';

// ---------------------------------------------------------------------------
// Association context
// ---------------------------------------------------------------------------

/** All information an AssociationResolver needs to produce edges. */
export interface AssociationContext {
  /** Absolute path to the repository root. */
  rootPath: string;
  /** Structural nodes already known for this workspace. */
  nodes: StructuralNode[];
  /** Lightweight index entries — file path, language, and metadata. */
  entries: Array<{
    filePath: string;
    languageId?: string;
    metadata?: Record<string, unknown>;
  }>;
  /** Current HEAD commit hash, if available. */
  currentCommit?: string;
  /** Relative file paths that are currently dirty in the working tree. */
  dirtyFiles: string[];
  /**
   * Per-rebuild shared AST extraction cache (Lever D), keyed by relative path.
   * When present, AST-based resolvers read from it instead of re-parsing.
   */
  sharedExtractions?: SharedExtractions;
  /** Contract-shaped parser analysis shared by relationship resolvers. */
  programAnalysis?: ProgramAnalysisV1;
  /**
   * Symbol ids more than one file declares (identity/symbol-collisions.ts). Resolvers that build
   * a node id from a definition site pass it on, so their edges meet the file-qualified nodes.
   */
  symbolCollisions?: SymbolIdCollisions;
}

// ---------------------------------------------------------------------------
// In-memory structural relation edge (pre-persistence)
// ---------------------------------------------------------------------------

/** Provenance record attached to a structural relation edge. */
export interface EdgeProvenance {
  /** Name of the resolver that produced this edge. */
  resolver: string;
  /** Kind of evidence (e.g. 'route-match', 'generated-type', 'manifest-entry'). */
  evidenceKind: string;
  /** Source locations supporting this edge. */
  evidenceLocations: Array<{ filePath: string; line?: number; note?: string }>;
  /** Epoch seconds when the evidence was extracted. */
  extractedAt: number;
}

/** A cross-language relation produced by an AssociationResolver. */
export interface StructuralRelationEdge {
  /** Stable unique identifier for this edge. */
  id: string;
  /** Relation kind. */
  edgeType: EdgeType;
  /** Source node ID. */
  sourceNodeId: string;
  /** Target node ID. */
  targetNodeId: string;
  /** Language of the source node, if known. */
  sourceLanguage?: string;
  /** Language of the target node, if known. */
  targetLanguage?: string;
  /** Confidence score in [0, 1]. */
  confidence: number;
  /** Confidence class. Heuristic edges are excluded from default retrieval. */
  confidenceClass: ConfidenceClass;
  /** Full provenance record. */
  provenance: EdgeProvenance;
}

// ---------------------------------------------------------------------------
// Resolver contract
// ---------------------------------------------------------------------------

/**
 * Contract for cross-language association resolvers.
 *
 * Each resolver inspects the indexed knowledge of a workspace and emits
 * structural relation edges. Resolvers are stateless — all context is
 * provided via AssociationContext.
 */
export interface AssociationResolver {
  /** Stable unique name (e.g. 'laravel-routes', 'generated-types'). */
  readonly name: string;

  /**
   * Return true if this resolver can meaningfully run against the given context.
   * A resolver that requires PHP routes, for example, should return false
   * for TypeScript-only workspaces.
   */
  supports(context: AssociationContext): boolean;

  /**
   * Produce structural relation edges from the given context.
   * Should not throw — return [] on error to allow other resolvers to proceed.
   */
  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]>;
}

// ---------------------------------------------------------------------------
// Capability surface node
// ---------------------------------------------------------------------------

/**
 * Metadata stored inside a capability-surface StructuralNode.
 * Serialized as JSON in structural_nodes.metadata.
 */
export interface CapabilitySurfaceMetadata {
  /** Transport type (e.g. "http", "event", "cli"). */
  transport: string;
  /** HTTP method (for HTTP surfaces). */
  method?: string;
  /** Canonical external path (fully composed including group prefixes). */
  path?: string;
  /** Local path fragment as written in the route declaration. */
  localFragment?: string;
  /** Optional explicit route name assigned in the declaration. */
  routeName?: string;
  /** Optional aliases (e.g. parameterized variants, named routes). */
  aliases?: string[];
  /** Explicit provider reference if named in the declaration. */
  explicitProvider?: string;
  /**
   * Controller method name (e.g. 'index') when the route declaration uses
   * the [Controller::class, 'method'] array form.  Stored separately so
   * provider propagation can reconstruct which method was targeted even when
   * the `handled_by` edge points to the class-level node.
   */
  controllerMethod?: string;
  /**
   * How the route declaration supplies its handler. Distinguishes closure-backed
   * surfaces (where no provider exists to resolve) from controller-backed ones
   * (where a named class/action is the target). Retrieval layers should treat
   * `closure` surfaces as honest self-contained handlers rather than as
   * unresolved provider misses.
   *
   *   - `controller`: route targets a named controller class/action
   *   - `closure`:    route targets an inline anonymous function
   *
   * Absence indicates the detector could not classify the declaration form.
   */
  providerKind?: 'controller' | 'closure';
  /** Group prefixes that contribute to the canonical path, outermost first. */
  declarationLineage?: string[];
  /** Helper function name wrapping the path argument (e.g. 'pathLookup'), if path was helper-wrapped. */
  pathWrapper?: string;
  /**
   * Alternate provider candidates preserved from conditional branch consolidation.
   * Present when two or more declarations for the same (method, path) were found
   * and arbitration selected a winner.
   */
  alternateProviders?: Array<{
    rawControllerReference?: string;
    controllerQualifiedName?: string;
    controllerMethod?: string;
  }>;
}

/**
 * A normalized capability surface node ready for DB persistence.
 * Extends StructuralNode with well-typed surface metadata.
 */
export interface CapabilitySurfaceNode {
  id: string;
  /** Canonical handle (e.g. "GET /api/invoices"). Stored as symbol_name. */
  handle: string;
  /** Transport label (e.g. "http"). Stored as language_id. */
  transport: string;
  /** File where the surface is declared (relative path). */
  file_path?: string;
  /** Extra metadata needed for propagation. */
  metadata: CapabilitySurfaceMetadata;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Transport contract metadata
// ---------------------------------------------------------------------------

/**
 * Normalized metadata stored inside a contract StructuralNode.
 *
 * Covers both explicit contract closure (FormRequest, JsonResource, DTO) and
 * coarse transport contract closure (empty-ack, page-response, route-bound-input,
 * etc.). The `shapeConfidence` field distinguishes the two so retrieval can
 * present them honestly without conflating exact schema truth with coarse
 * transport truth.
 */
export interface TransportContractMetadata {
  /** Transport protocol this contract belongs to. */
  transport: 'http' | 'queue' | 'cli' | 'event';
  /** Which side of the surface this contract describes. */
  side: 'request' | 'response';
  /**
   * Normalized contract kind.
   *
   * Exact kinds (always `shapeConfidence: exact`):
   *   - `explicit-class`     FormRequest, JsonResource, or DTO class
   *   - `inline-validator`   $request->validate([...]) or Validator::make(...)
   *
   * Coarse response kinds (`shapeConfidence: coarse`):
   *   - `inline-json`               response()->json([...]) or equivalent
   *   - `empty-ack`                 no meaningful payload (unifies explicit/implicit)
   *   - `redirect-response`         redirect() helper
   *   - `page-response`             Inertia::render(), view(), inertia()
   *   - `scalar-response`           response('ok', 200) or text-plain helpers
   *   - `native-array-response`     array return, not adapter-serialized
   *   - `native-object-response`    object/model return, not adapter-serialized
   *   - `serialized-model-response` adapter-backed serialized model (conservative)
   *   - `serialized-collection-response` adapter-backed serialized collection (conservative)
   *   - `file-response`             download / stream response
   *
   * Coarse request kinds (`shapeConfidence: coarse`):
   *   - `route-bound-input`     typed route model binding
   *   - `implicit-input-shape`  repeated field / query access without FormRequest
   */
  contractKind:
    | 'explicit-class'
    | 'inline-validator'
    | 'inline-json'
    | 'implicit-input-shape'
    | 'route-bound-input'
    | 'empty-ack'
    | 'redirect-response'
    | 'page-response'
    | 'scalar-response'
    | 'native-array-response'
    | 'native-object-response'
    | 'serialized-model-response'
    | 'serialized-collection-response'
    | 'file-response';
  /**
   * Whether Lux is anchored to an explicit schema carrier (`exact`) or is
   * describing the transport shape conservatively (`coarse`).
   */
  shapeConfidence: 'exact' | 'coarse';
  /**
   * Dominant structural role of the surface, when evidence is strong enough
   * to justify a stable label.
   */
  interactionKind?: 'command' | 'query' | 'page' | 'redirect' | 'stream';
  /** Framework that produced the evidence (e.g. 'laravel', 'inertia'). */
  framework?: string;
  /** Specific framework signal that triggered inference. */
  frameworkSignal?: string;
  /** Controller method scope this contract was inferred from. */
  method?: string;
  /** HTTP status code hint, if recoverable. */
  statusCode?: number;
  /** Content-type hint derived from the response helper. */
  contentTypeHint?: string;
  /**
   * Sub-classification within a coarse kind.
   *
   * For `empty-ack`: `explicit-empty-return` | `implicit-fallthrough` | `framework-null-coercion`
   */
  evidenceSubtype?: string;
  /** Route-model binding params (for `route-bound-input`). */
  boundParams?: Array<{ param: string; type: string }>;
  /** Request field or query access signals (for `implicit-input-shape`). */
  inputSignals?: string[];
  /** Response shape signals that informed coarse response classification. */
  responseSignals?: string[];
  /** When true, this node was synthesized by propagation (not a named class). */
  synthetic?: boolean;
  /** Role of this contract relative to the surface ('request' | 'response'). */
  role?: string;
  /** Deprecated legacy field — use contractKind instead. */
  contractKindLegacy?: string;
}

// ---------------------------------------------------------------------------
// Node ID builders
// ---------------------------------------------------------------------------

/** Build a stable file node ID from a relative path. */
export function fileNodeId(relativeFilePath: string): string {
  return `file:${relativeFilePath}`;
}

/** Build a stable PHP symbol node ID. */
export function phpSymbolNodeId(qualifiedName: string): string {
  return `symbol:php:${qualifiedName}`;
}

/** Build a stable TypeScript/JavaScript symbol node ID. */
export function tsSymbolNodeId(relativeFilePath: string, symbolName: string): string {
  return `symbol:ts:${relativeFilePath}#${symbolName}`;
}

/** Build a contract node ID. Prefers explicit schema name if provided. */
export function contractNodeId(schemaName?: string, routeKey?: string): string {
  if (schemaName) return `contract:schema:${schemaName}`;
  if (routeKey) return `contract:route:${routeKey}`;
  return `contract:synthetic:${Math.random().toString(36).slice(2)}`;
}

/**
 * Build a stable HTTP capability-surface node ID.
 *
 * Format: `surface:http:METHOD:/canonical/path`. A route that more than one file declares is
 * stored once per file, under this id file-qualified (identity/file-qualified-id.ts).
 *
 * @param method - HTTP verb in any case (will be uppercased).
 * @param path - The canonical route path (e.g. "/api/invoices").
 */
export function httpSurfaceNodeId(method: string, path: string): string {
  return `surface:http:${method.toUpperCase()}:${path}`;
}

/**
 * Build a generic capability-surface node ID for non-HTTP transports.
 *
 * Format: `surface:{transport}:{handle}`
 */
export function surfaceNodeId(transport: string, handle: string): string {
  return `surface:${transport}:${handle}`;
}
