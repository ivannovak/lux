import type { LuxDatabase } from '../db/index.js';
import type { RuntimePathResolution } from '../utils/runtime-paths.js';
import {
  describeOverlayTrustInspection,
  inspectOverlayTrustState,
  type OverlayTrustDiagnostics,
  type PersistedOverlayTrustState,
} from '../scanner/overlay-trust-state.js';
import { assessWorkingTreeFreshness, type WorkingTreeFreshness } from '../scanner/freshness.js';
import { buildCoverage, type CoveragePayload } from '../scanner/coverage/builder.js';
import {
  loadSymbolIdCollisionStatus,
  type SymbolIdCollisionStatus,
} from '../scanner/coverage/producer-runs.js';
import {
  loadLspEnrichmentFailures,
  type LspEnrichmentFailure,
} from '../scanner/lsp/enrichment-failures.js';

export interface FreshnessStatusPayload {
  assessment: WorkingTreeFreshness['assessment'];
  indexedCommit: string | null;
  headCommit: string | null;
  headMatchesIndex: boolean;
  dirtyFiles: number;
  dirtyStructural: string[];
  dirtyAtIndexTime: number | null;
  edgeFreshness: WorkingTreeFreshness['edgeFreshness'];
}

function buildFreshnessPayload(db: LuxDatabase, corpusPath: string): FreshnessStatusPayload {
  const f = assessWorkingTreeFreshness(corpusPath, db);
  return {
    assessment: f.assessment,
    indexedCommit: f.indexedCommit ?? null,
    headCommit: f.headCommit ?? null,
    headMatchesIndex: f.headMatchesIndex,
    dirtyFiles: f.dirtyFiles.length,
    dirtyStructural: f.dirtyStructural,
    dirtyAtIndexTime: f.dirtyAtIndexTime ?? null,
    edgeFreshness: f.edgeFreshness,
  };
}

export type OverlayTrustPayload =
  | (PersistedOverlayTrustState & {
      trustLevel: OverlayTrustDiagnostics['trustLevel'];
      trustSource: OverlayTrustDiagnostics['trustSource'];
      warnings: string[];
    })
  | OverlayTrustDiagnostics;

export type OverlayStatusPayload = OverlayTrustPayload | OverlayStatusPayloadWithRuntime;

export interface OverlayStatusPayloadWithRuntime {
  overlay: OverlayTrustPayload;
  runtime: RuntimeStatusPayload;
  freshness?: FreshnessStatusPayload;
}

export interface IndexStatusPayload {
  stats: ReturnType<LuxDatabase['getStats']>;
  overlay: OverlayTrustPayload;
  coverage: CoveragePayload;
  /** Files a language server failed to enrich in the last run (timeout, dead transport), by path. */
  lspEnrichmentFailures: LspEnrichmentFailure[];
  /** Symbol ids more than one file declares, and the references and edges they leave unresolved. */
  symbolIdCollisions: SymbolIdCollisionStatus;
  /**
   * HTTP routes more than one file declares. Each declaration is its own surface, stored under
   * `<id>#file:<path>`; no surface has the bare id listed here.
   */
  surfaceIdCollisions: { collidingIds: number; ids: Array<{ id: string; files: string[] }> };
  runtime?: RuntimeStatusPayload;
  freshness?: FreshnessStatusPayload;
}

export interface RuntimeStatusPayload {
  corpusPath: string;
  corpusSource: RuntimePathResolution['corpusSource'];
  dbPath: string;
  dbSource: RuntimePathResolution['dbSource'];
}

function buildRuntimeStatusPayload(runtime: RuntimePathResolution): RuntimeStatusPayload {
  return {
    corpusPath: runtime.corpusPath,
    corpusSource: runtime.corpusSource,
    dbPath: runtime.dbPath,
    dbSource: runtime.dbSource,
  };
}

function buildOverlayTrustPayload(
  db: LuxDatabase,
  runtime?: RuntimePathResolution
): OverlayTrustPayload {
  const inspection = inspectOverlayTrustState(db);
  const diagnostics = describeOverlayTrustInspection(inspection);

  return inspection.state
    ? {
        ...inspection.state,
        // Not stored in the index: this is the corpus the reader is running against.
        repoPath: runtime?.corpusPath ?? '',
        trustLevel: diagnostics.trustLevel,
        trustSource: diagnostics.trustSource,
        warnings: diagnostics.warnings,
      }
    : diagnostics;
}

export function buildOverlayStatusPayload(
  db: LuxDatabase,
  runtime?: RuntimePathResolution
): OverlayStatusPayload {
  const overlay = buildOverlayTrustPayload(db, runtime);
  return runtime
    ? {
        overlay,
        runtime: buildRuntimeStatusPayload(runtime),
        freshness: buildFreshnessPayload(db, runtime.corpusPath),
      }
    : overlay;
}

export function buildIndexStatusPayload(
  db: LuxDatabase,
  runtime?: RuntimePathResolution
): IndexStatusPayload {
  return {
    stats: db.getStats(),
    overlay: buildOverlayTrustPayload(db, runtime),
    coverage: buildCoverage(db, { corpusPath: runtime?.corpusPath }),
    lspEnrichmentFailures: loadLspEnrichmentFailures(db),
    symbolIdCollisions: loadSymbolIdCollisionStatus(db),
    surfaceIdCollisions: surfaceIdCollisions(db),
    ...(runtime ? { runtime: buildRuntimeStatusPayload(runtime) } : {}),
    ...(runtime ? { freshness: buildFreshnessPayload(db, runtime.corpusPath) } : {}),
  };
}

function surfaceIdCollisions(db: LuxDatabase): IndexStatusPayload['surfaceIdCollisions'] {
  const ids = db.getSharedSurfaceIds();
  return { collidingIds: ids.length, ids };
}
