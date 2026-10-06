// Database entity types

export interface KnowledgeEntry {
  id: number;
  type: string;
  title: string;
  file_path: string;
  tags?: string; // JSON array
  metadata?: string; // JSON string
  content?: string; // Markdown content
  created_at: number;
  updated_at: number;
}

export interface Event {
  id: number;
  timestamp: number;
  source: string;
  source_id?: string;
  event_type: string;
  summary?: string;
  payload?: string; // JSON string
}

// Input types for insertions (without auto-generated fields)
export interface KnowledgeEntryInsert {
  type: string;
  title: string;
  file_path: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface EventInsert {
  source: string;
  source_id?: string;
  event_type: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

/** Index metadata key-value pair for tracking index state. */
export interface IndexMetadata {
  key: string;
  value: string;
  updated_at: number;
}

export interface ModuleDependency {
  id: number;
  source_module: string;
  target_module: string;
  reference_count: number;
  sample_files: string | null;
  created_at: number;
}

/** Options for the ranked document search contract (replaces the rank-zeroing funnel). */
export interface SearchQueryOptions {
  /** Scope the whole match expression to the `content` column (D4). Valid under every --type. */
  contentOnly?: boolean;
  /** Emit an FTS5 snippet() for each returned row (D2). Off by default — one aux call per row. */
  snippets?: boolean;
  /** Row cap pushed into SQL as `LIMIT ?` (D2). Validated by the caller (>= 1, not NaN). */
  limit: number;
}

/** One ranked search hit. `rank` is raw bm25 (negative, lower = better) — never synthesized (D1). */
export interface RankedSearchResult {
  entryId: number;
  /** knowledge_entries.type — 'source-code' | 'general' | 'architecture' | 'spec' | … */
  entryType: string;
  title: string;
  /** corpus-relative, as stored in knowledge_entries.file_path (see stored-path.ts) */
  filePath: string;
  /** raw bm25 (or weighted bm25 once L1 candidate 2 ships) */
  rank: number;
  /** FTS5 snippet(), present only when opts.snippets was set (D2) */
  snippet?: string;
}

// ---------------------------------------------------------------------------
// Node anchor lexical index (migration 014)
// ---------------------------------------------------------------------------

/** Input for `upsertNodeAnchorText` — the prepared-text row + its split FTS fields, flattened. */
export interface NodeAnchorTextInsert {
  node_id: string;
  prepared: string;
  content_hash: string;
  name: string;
  identifiers: string;
  qualified: string;
  path_segments: string;
  context: string;
}

/** One lexical anchor hit: node metadata (from structural_nodes) + weighted bm25 rank. */
export interface LexicalAnchorRow {
  node_id: string;
  symbol_kind: string;
  symbol_name: string;
  qualified_name: string | null;
  file_path: string;
  rank: number; // weighted bm25 (negative, lower = better)
}

// ---------------------------------------------------------------------------
// Anchor embeddings types (migration 015, Phase 3) — the structural-node vector plane
// ---------------------------------------------------------------------------

/** One stored vector row (migration 015). `vector` is the raw BLOB bytes as the WASM engine hands
 *  them back — decode with `scanner/embeddings/codec.ts`'s `decodeVector`. Keyed on the deterministic
 *  `structural_nodes.id` (TEXT), NOT an integer surrogate. */
export interface NodeEmbeddingRow {
  node_id: string;
  model: string;
  dims: number;
  vector: Uint8Array;
  content_hash: string;
}

/** The NARROW projection the cosine scan reads (D7 hot path). `getNodeVectorsForModel` returns only
 *  the two columns `topCosine` consumes — the node id and the raw vector BLOB — NOT the full
 *  `NodeEmbeddingRow`. Materializing `model`/`dims`/`content_hash` strings for every one of ~40 K rows
 *  on each warm query is pure waste when the scan reads only node_id + vector. */
export interface NodeVectorRow {
  node_id: string;
  vector: Uint8Array;
}

/** Input shape for `upsertNodeEmbedding` (INSERT OR REPLACE). Same shape as `NodeEmbeddingRow` —
 *  there is no auto-generated column on this table (the PK is the caller-supplied `node_id`). */
export interface NodeEmbeddingInsert {
  node_id: string;
  model: string;
  dims: number;
  vector: Uint8Array;
  content_hash: string;
}

/** One row of the widened needs-embedding queue (the LEFT-JOIN anti-join, D5). Carries the persisted
 *  `prepared` text so the embed pass never re-parses (03 §four embed-pass integration points), plus
 *  the `content_hash` to copy verbatim onto the embedding row at embed time. No name/path/signature
 *  fields — those already live baked into `prepared`. */
export interface UnembeddedAnchorNode {
  node_id: string;
  prepared: string;
  content_hash: string;
}

/** Coverage snapshot under one model (D11 — the numerator is model-scoped AND freshness-scoped, the
 *  denominator is the whole anchor-viable set). */
export interface AnchorEmbeddingCoverage {
  embeddedNodes: number;
  anchorViableNodes: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Structural overlay types (migration 008)
// ---------------------------------------------------------------------------

export type StructuralNodeType =
  | 'file'
  | 'symbol'
  | 'route'
  | 'template'
  | 'contract'
  | 'event'
  | 'artifact'
  | 'capability-surface';

export type EdgeType =
  // Legacy overlay edges (kept for backwards compatibility)
  | 'renders_template'
  | 'hydrates_component'
  | 'implements_contract'
  | 'emits_event'
  | 'subscribes_event'
  | 'shares_config_key'
  // Capability-surface edges
  | 'declares_surface'
  | 'handled_by'
  | 'calls_surface'
  | 'uses_contract'
  | 'returns_contract'
  | 'validates_with'
  | 'derived_from'
  | 'calls'
  | 'references'
  // Vue component semantics (Tranche 2, Phases 9–11)
  | 'renders_component'
  | 'uses_composable'
  | 'uses_store'
  | 'emits_component_event'
  | 'handles_component_event'
  // React component, hook, and context semantics (Tranche 3, Phase 15)
  | 'uses_hook'
  | 'provides_context'
  | 'consumes_context'
  | 'navigates_to'
  | 'declares_resource'
  | 'uses_view_model'
  | 'publishes_bus_event'
  | 'subscribes_bus_event'
  | 'references_resource'
  | 'produces_artifact'
  | 'consumes_artifact'
  | 'invokes_workflow'
  | 'uses_base_image'
  | 'copies_artifact'
  | 'depends_on_service'
  // Module-boundary evidence expansion edges
  | 'dispatches_job'
  | 'handles_job'
  | 'listens_event'
  | 'resolves_service'
  | 'binds_service'
  | 'provides_capability'
  | 'imports_pipeline_artifact'
  | 'exports_pipeline_artifact'
  | 'syncs_external_record'
  | 'consumes_reporting_source'
  | 'transforms_model'
  | 'uses_contract_family'
  | 'emits_resource_family'
  | 'validates_contract_family'
  | 'shares_contract_family'
  | 'shares_schema_family'
  | 'projects_through_glue'
  | 'transits_shared_entrypoint';

export type ConfidenceClass = 'proven' | 'artifact-backed' | 'framework-inferred' | 'heuristic';

export type FreshnessStatus = 'fresh' | 'stale' | 'dirty-dependent' | 'unknown';

/** Aggregate structural-edge counts by maintained freshness status
 *  (returned by LuxDatabase.countEdgesByFreshness). Reports the four first-class
 *  buckets; `other` catches any truly unrecognized status (expected 0 — a regression sentinel). */
export interface EdgeFreshnessCounts {
  fresh: number;
  'dirty-dependent': number;
  stale: number;
  /** Legitimately-`unknown` edges (schema-008 default; e.g. a vendor-pack edge). Its own
   *  bucket so it never reads as a false `other` regression sentinel. */
  unknown: number;
  /** Any row with a TRULY unrecognized status (expected 0 — a regression sentinel). */
  other: number;
}

/**
 * Provenance of a structural node (ADR-3). 'local' = materialized from the
 * scanned project corpus; 'vendor-pack' = imported from a merged vendor pack.
 * Defaults to 'local' for every project-materialized node (migration 012).
 */
export type NodeOrigin = 'local' | 'vendor-pack';

export interface StructuralNode {
  id: string;
  node_type: StructuralNodeType;
  file_path?: string;
  language_id?: string;
  symbol_name?: string;
  symbol_kind?: string;
  qualified_name?: string;
  metadata?: string;
  /** Provenance. Defaults to 'local' for all project-materialized nodes (ADR-3). */
  origin?: NodeOrigin;
  updated_at: number;
}

export interface StructuralEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  confidence: number;
  confidence_class: ConfidenceClass;
  freshness_status: FreshnessStatus;
  source_commit?: string;
  dirty_dependency_count: number;
  provenance_summary?: string;
  updated_at: number;
}

export interface EdgeEvidence {
  id: string;
  edge_id: string;
  resolver: string;
  evidence_kind: string;
  file_path?: string;
  line?: number;
  note?: string;
  payload_json?: string;
  recorded_at: number;
}

// ---------------------------------------------------------------------------
// Operational boundary intelligence types (migration 011)
// ---------------------------------------------------------------------------

export type TrustTier = 1 | 2 | 3 | 4 | 5;

export type OperationalBoundaryKind = 'command' | 'schedule' | 'job' | 'event' | 'http';

export type OperationalEdgeType =
  'TRIGGERS' | 'HANDLED_BY' | 'DISPATCHES' | 'CONSUMES' | 'PRODUCES';

export type OperationalTransport = 'sync' | 'async' | 'queue' | 'event-bus';

export interface OperationalBoundary {
  id: string;
  repo_root: string;
  kind: OperationalBoundaryKind;
  name: string;
  trust_tier: TrustTier;
  file_path?: string;
}

export interface OperationalHandler {
  id: string;
  boundary_id: string;
  symbol_id: string;
  trust_tier: TrustTier;
}

export interface OperationalEdge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: OperationalEdgeType;
  transport?: OperationalTransport;
  trust_tier: TrustTier;
}

export interface OperationalContract {
  id: string;
  boundary_id: string;
  payload_schema?: string;
  trust_tier: TrustTier;
}
