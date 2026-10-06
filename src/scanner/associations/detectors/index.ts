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
  /** Distinct surface ids the detectors declared: the number of nodes they asked to have stored. */
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
  // The declaration stored for each surface id. A detector qualifies an id that several files
  // declare, so one id arriving from two files is a detector fault: one node cannot hold both.
  // The declaration in the first file by path is stored, whatever order they arrived in, and the
  // run warns with the id and its files.
  const stored = new Map<string, CapabilitySurfaceNode>();
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
    const declaringFiles = new Map<string, Set<string>>();
    for (const surface of batch.surfaces) {
      const current = stored.get(surface.id);
      if (!current) {
        stored.set(surface.id, surface);
        continue;
      }
      if (declaringFile(current) === declaringFile(surface)) continue;
      const files = declaringFiles.get(surface.id) ?? new Set([declaringFile(current)]);
      declaringFiles.set(surface.id, files.add(declaringFile(surface)));
      if (declaringFile(surface) < declaringFile(current)) stored.set(surface.id, surface);
    }
    for (const id of [...declaringFiles.keys()].sort()) {
      const files = [...declaringFiles.get(id)!].sort();
      reporter.warn(
        `detector "${detector.name}" declared ${id} in ${files.length} files (${files.join(', ')}); ` +
          `one node cannot hold both, the declaration in ${declaringFile(stored.get(id)!)} is stored.`,
        `detector:${detector.name}`
      );
    }
    db.transaction(() => {
      for (const id of new Set(batch.surfaces.map((surface) => surface.id))) {
        db.upsertStructuralNode(capabilitySurfaceToStructuralNode(stored.get(id)!));
      }
    });

    // Persist boundary edges + evidence using the engine's static helper. An id that arrived
    // from two files keeps only the edges evidenced in the stored declaration's file, so the node
    // and its edges state one declaration.
    // sourceCommit is threaded on the scoped-refresh path (SC-8); undefined on full rebuild.
    const edges = batch.edges.filter((edge) => {
      const shared = [edge.sourceNodeId, edge.targetNodeId].find((id) => declaringFiles.has(id));
      if (shared === undefined) return true;
      const locations = edge.provenance?.evidenceLocations ?? [];
      const storedFile = declaringFile(stored.get(shared)!);
      return locations.length === 0 || locations.some((at) => at.filePath === storedFile);
    });
    if (edges.length > 0) {
      surfaceEdgesStored += AssociationEngine.persistEdges(db, edges, sourceCommit);
    }

    if (batch.surfaces.length > 0 || batch.edges.length > 0) {
      reporter.progress(
        `Detector "${detector.name}": ${batch.surfaces.length} surface(s), ${batch.edges.length} edge(s).`
      );
    }
  }

  return { surfacesDetected: stored.size, surfaceEdgesStored };
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function declaringFile(surface: CapabilitySurfaceNode): string {
  return surface.file_path ?? '(no file)';
}

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
