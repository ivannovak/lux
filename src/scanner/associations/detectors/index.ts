// Detector runner and default detector factory.
//
// runDetectors() is the single entry point called by overlay-service.
// It iterates registered detectors, persists their output, and returns
// aggregate counts.

import type { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import type { AssociationContext, CapabilitySurfaceNode } from '../types.js';
import { AssociationEngine } from '../engine.js';
import type { CapabilitySurfaceDetector, DetectedSurfaceBatch } from './types.js';
import { LaravelHttpSurfaceDetector } from './laravel-http.js';
import { silentReporter, type Reporter } from '../../reporter.js';

// ---------------------------------------------------------------------------
// Runner result
// ---------------------------------------------------------------------------

export interface DetectorRunResult {
  surfacesDetected: number;
  surfaceEdgesStored: number;
}

// ---------------------------------------------------------------------------
// Default detector factory
// ---------------------------------------------------------------------------

/**
 * Return the default detector pack.
 * Add new detectors here as they are implemented.
 */
export function createDefaultDetectors(): CapabilitySurfaceDetector[] {
  return [new LaravelHttpSurfaceDetector()];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run all detectors against the given context, persist their output,
 * and return aggregate counts.
 *
 * @param db - Database to write surface nodes and edges into.
 * @param context - AssociationContext from the overlay rebuild.
 * @param detectors - Detector pack (defaults to createDefaultDetectors()).
 * @param report - Optional progress callback.
 */
export async function runDetectors(
  db: LuxDatabase,
  context: AssociationContext,
  detectors?: CapabilitySurfaceDetector[],
  reporter: Reporter = silentReporter,
  sourceCommit?: string
): Promise<DetectorRunResult> {
  const pack = detectors ?? createDefaultDetectors();
  let surfacesDetected = 0;
  let surfaceEdgesStored = 0;

  for (const detector of pack) {
    if (!detector.supports(context)) continue;
    reporter.ran(`detector:${detector.name}`);

    let batch: DetectedSurfaceBatch;
    try {
      batch = await detector.detect(context);
    } catch (err) {
      reporter.warn(
        `detector "${detector.name}" threw — ${err instanceof Error ? err.message : String(err)}`,
        `detector:${detector.name}`
      );
      continue;
    }

    // Persist surface nodes in one transaction (a commit per node is a journal round-trip each).
    db.transaction(() => {
      for (const surface of batch.surfaces) {
        const node = capabilitySurfaceToStructuralNode(surface);
        db.upsertStructuralNode(node);
        surfacesDetected++;
      }
    });

    // Persist boundary edges + evidence using the engine's static helper.
    // sourceCommit is threaded on the scoped-refresh path (SC-8); undefined on full rebuild.
    if (batch.edges.length > 0) {
      const stored = AssociationEngine.persistEdges(db, batch.edges, sourceCommit);
      surfaceEdgesStored += stored;
    }

    if (batch.surfaces.length > 0 || batch.edges.length > 0) {
      reporter.progress(
        `Detector "${detector.name}": ${batch.surfaces.length} surface(s), ${batch.edges.length} edge(s).`
      );
    }
  }

  return { surfacesDetected, surfaceEdgesStored };
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a CapabilitySurfaceNode (in-memory) to a StructuralNode (DB shape).
 */
function capabilitySurfaceToStructuralNode(surface: CapabilitySurfaceNode): StructuralNode {
  return {
    id: surface.id,
    node_type: 'capability-surface',
    symbol_name: surface.handle,
    language_id: surface.transport,
    file_path: surface.file_path,
    metadata: JSON.stringify(surface.metadata),
    updated_at: surface.updated_at,
  };
}
