// CapabilitySurfaceDetector contract.
//
// Detectors are narrow and explicit. Their only job is:
//   1. detect capability declarations in a workspace
//   2. create normalized surface nodes
//   3. emit only explicit boundary edges (declares_surface, handled_by when explicit)
//   4. attach evidence and provenance
//
// They must NOT:
//   - infer providers through convention or fallback
//   - expand consumer chains
//   - attach contracts or artifacts
//   - do graph-wide inference
//
// Those responsibilities belong to propagation passes.

import type {
  AssociationContext,
  CapabilitySurfaceNode,
  StructuralRelationEdge,
} from '../types.js';

// ---------------------------------------------------------------------------
// Detector contract
// ---------------------------------------------------------------------------

/**
 * A batch of surfaces and explicit boundary edges produced by one detector run.
 * Evidence is embedded in each edge's provenance field and extracted at persist time.
 */
export interface DetectedSurfaceBatch {
  /**
   * Normalized surface nodes to upsert into structural_nodes: one id per declaration. A surface
   * that several files declare is file-qualified by the detector (identity/file-qualified-id.ts);
   * runDetectors warns about an id that still arrives from two files.
   */
  surfaces: CapabilitySurfaceNode[];
  /**
   * Explicit boundary edges only.
   * - `declares_surface` from the declaring file/symbol to the surface
   * - `handled_by` only when the declaration explicitly names the provider
   *
   * Evidence is carried in edge.provenance — not a separate list.
   */
  edges: StructuralRelationEdge[];
}

/**
 * Contract for capability-surface boundary detectors.
 *
 * Implementations must be stateless — all context comes via AssociationContext.
 * Detectors should return an empty batch on error rather than throwing.
 */
export interface CapabilitySurfaceDetector {
  /** Stable unique name (e.g. 'laravel-http-surfaces'). */
  readonly name: string;

  /**
   * Return true if this detector can meaningfully run against the given context.
   * Returning false skips execution entirely.
   */
  supports(context: AssociationContext): boolean;

  /**
   * Detect capability surfaces and produce normalized output.
   * On failure, reject: runDetectors reports a detector that threw as a warning and moves on to
   * the next one. An empty batch means "no surfaces here", so it must not stand in for an error.
   */
  detect(context: AssociationContext): Promise<DetectedSurfaceBatch>;
}
