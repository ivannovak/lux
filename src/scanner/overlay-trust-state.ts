import type { LuxDatabase } from '../db/index.js';
import { OVERLAY_STATE_COMPONENT, SURFACE_TALLY_COMPONENT } from './rebuild-orchestrator.js';
import type { RebuildMode, RebuildResult } from './rebuild-orchestrator.js';

export const OVERLAY_TRUST_STATE_KEY = 'overlay_trust_state';

export type OverlayTrustStateSource = 'index-rebuild' | 'index-sync' | 'index-refresh' | 'derived';

export interface PersistedOverlayTrustState extends RebuildResult {
  recordedAt: string;
  lastIndexedCommit?: string;
  sourceAction: OverlayTrustStateSource;
}

export interface OverlayTrustInspection {
  state: PersistedOverlayTrustState | null;
  source: 'persisted' | 'derived' | 'none';
}

export interface OverlayTrustDiagnostics {
  mode: RebuildMode | 'none';
  trustLevel: OverlayTrustLevel;
  trustSource: OverlayTrustInspection['source'];
  warnings: string[];
}

export type OverlayTrustLevel =
  'no-overlay' | 'content-only' | 'stale-overlay' | 'degraded-overlay' | 'overlay-complete';

export interface OverlaySyncMutationDetails {
  lastIndexedCommit?: string;
  overlayRelevantPaths: string[];
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  indexedCount: number;
  deletedEntryCount: number;
}

function persistOverlayTrustState(
  db: LuxDatabase,
  state: PersistedOverlayTrustState
): PersistedOverlayTrustState {
  // The repository's location is a fact about this machine, not about the index: it is left out of
  // what is stored, and status output fills it from the corpus path the reader is running with.
  db.setIndexMetadata(OVERLAY_TRUST_STATE_KEY, JSON.stringify({ ...state, repoPath: undefined }));
  return state;
}

export function persistRebuildTrustState(
  db: LuxDatabase,
  result: RebuildResult,
  meta: {
    lastIndexedCommit?: string;
    sourceAction?: Extract<OverlayTrustStateSource, 'index-rebuild'>;
  } = {}
): PersistedOverlayTrustState {
  return persistOverlayTrustState(db, {
    ...result,
    recordedAt: new Date().toISOString(),
    lastIndexedCommit: meta.lastIndexedCommit,
    sourceAction: meta.sourceAction ?? 'index-rebuild',
  });
}

/** The component of the notice that a trust state was inferred from the database's shape. */
const TRUST_INFERRED_COMPONENT = 'trust-inferred';
const NON_DEGRADING: ReadonlySet<string | undefined> = new Set([
  SURFACE_TALLY_COMPONENT,
  TRUST_INFERRED_COMPONENT,
]);

/** The component the residual-stale-edges warning of a scoped refresh is filed under. */
const REFRESH_RESIDUAL_COMPONENT = 'refresh-residual';

/**
 * Settle trust after a scoped overlay refresh (Decision 12). `meta.classified` is the overlay
 * classified from the refreshed database (classifyOverlayFromDb): its counters replace the prior
 * state's, so they describe the index as synced, and its warnings join the run's.
 *
 * `meta.residualStaleEdges` counts BOTH `stale` AND `dirty-dependent` edges (overlay-refresh step
 * 9b drives dirty-dependent to zero on a complete refresh; any leftover of either is an honest
 * settle failure). A non-zero residual raises its own warning, so no output reads the run as clean.
 * A warning carried from the prior state stays until a refresh re-runs the component that raised it
 * without raising it again. Trust is overlay-complete exactly when no warning remains other than
 * the detector-tally mismatch and the inferred-state notice, which do not degrade; otherwise
 * degraded-overlay ⇒ stale-overlay via the source-action derivation. Records sourceAction
 * 'index-refresh' — provenance, not a new trust level (the five levels are frozen).
 */
export function persistRefreshTrustState(
  db: LuxDatabase,
  prior: RebuildResult,
  meta: RunWarningMeta & {
    lastIndexedCommit?: string;
    residualStaleEdges: number;
    classified: RebuildResult;
  }
): PersistedOverlayTrustState {
  const residual = meta.residualStaleEdges;
  const residualWarning =
    `${residual} edge(s) are stale or dirty-dependent after the scoped refresh: an endpoint ` +
    'changed and no re-derivation reached them. Run "lux index rebuild" to settle them.';
  const { warnings, warningComponents } = settleWarnings(prior, {
    warnings: [
      ...(meta.warnings ?? []),
      ...meta.classified.warnings,
      ...(residual > 0 ? [residualWarning] : []),
    ],
    warningComponents: {
      ...meta.warningComponents,
      ...meta.classified.warningComponents,
      ...(residual > 0 ? { [residualWarning]: REFRESH_RESIDUAL_COMPONENT } : {}),
    },
    componentsRun: [...(meta.componentsRun ?? []), REFRESH_RESIDUAL_COMPONENT],
  });

  return persistOverlayTrustState(db, {
    ...meta.classified,
    // The detector-tally mismatch and the inferred-state notice are reported without degrading the
    // overlay, as a rebuild and a state inferred from a complete overlay report them.
    mode: warnings.some((warning) => !NON_DEGRADING.has(warningComponents[warning]))
      ? 'degraded-overlay'
      : 'overlay-complete',
    warnings,
    warningComponents,
    recordedAt: new Date().toISOString(),
    lastIndexedCommit: meta.lastIndexedCommit,
    sourceAction: 'index-refresh',
  });
}

/** The warnings a run produced, which component raised each, and which components it ran. */
export interface RunWarningMeta {
  warnings?: string[];
  warningComponents?: Record<string, string>;
  componentsRun?: string[];
}

/**
 * Merge a run's warnings into the ones a prior state carried. A carried warning is retired when the
 * run re-ran the component that raised it and did not raise it again; any other stays.
 */
function settleWarnings(
  prior: Pick<RebuildResult, 'warnings' | 'warningComponents'>,
  run: RunWarningMeta
): { warnings: string[]; warningComponents: Record<string, string> } {
  const fresh = run.warnings ?? [];
  const ran = new Set(run.componentsRun ?? []);
  const priorComponents = prior.warningComponents ?? {};
  const carried = prior.warnings.filter((warning) => {
    if (fresh.includes(warning)) return false; // raised again: it is this run's warning now
    const component = priorComponents[warning];
    return !(component && ran.has(component));
  });
  const warningComponents: Record<string, string> = {};
  for (const warning of carried) {
    if (priorComponents[warning]) warningComponents[warning] = priorComponents[warning];
  }
  Object.assign(warningComponents, run.warningComponents ?? {});
  return { warnings: [...new Set([...carried, ...fresh])], warningComponents };
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return Object.fromEntries(entries);
}

export function loadOverlayTrustState(db: LuxDatabase): PersistedOverlayTrustState | null {
  const raw = db.getIndexMetadata(OVERLAY_TRUST_STATE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedOverlayTrustState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isRebuildMode(parsed.mode)) return null;
    if (!Array.isArray(parsed.warnings)) return null;

    return {
      mode: parsed.mode,
      repoPath: '', // never stored; see persistOverlayTrustState
      configSource: typeof parsed.configSource === 'string' ? parsed.configSource : 'lux.yaml',
      configLspEnabled: Boolean(parsed.configLspEnabled),
      surfaceCount: asNumber(parsed.surfaceCount),
      detectorEdgeCount: asNumber(parsed.detectorEdgeCount),
      propagatedEdgeCount: asNumber(parsed.propagatedEdgeCount),
      fileNodeCount: asNumber(parsed.fileNodeCount),
      symbolNodeCount: asNumber(parsed.symbolNodeCount),
      controllerBackedCount: asNumber(parsed.controllerBackedCount),
      closureBackedCount: asNumber(parsed.closureBackedCount),
      unknownProviderKindCount: asNumber(parsed.unknownProviderKindCount),
      enrichmentStatus: parsed.enrichmentStatus === 'active' ? 'active' : 'inactive',
      propagationStatus:
        parsed.propagationStatus === 'ran' ||
        parsed.propagationStatus === 'skipped' ||
        parsed.propagationStatus === 'empty'
          ? parsed.propagationStatus
          : 'skipped',
      warnings: parsed.warnings.filter((w): w is string => typeof w === 'string'),
      warningComponents: asStringRecord(parsed.warningComponents),
      recordedAt:
        typeof parsed.recordedAt === 'string' ? parsed.recordedAt : new Date().toISOString(),
      lastIndexedCommit:
        typeof parsed.lastIndexedCommit === 'string' ? parsed.lastIndexedCommit : undefined,
      sourceAction:
        parsed.sourceAction === 'index-rebuild' ||
        parsed.sourceAction === 'index-sync' ||
        parsed.sourceAction === 'index-refresh' ||
        parsed.sourceAction === 'derived'
          ? parsed.sourceAction
          : 'derived',
      dirtyAtIndexTime:
        typeof parsed.dirtyAtIndexTime === 'number' ? parsed.dirtyAtIndexTime : undefined,
    };
  } catch {
    // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
    return null;
  }
}

export function inspectOverlayTrustState(db: LuxDatabase): OverlayTrustInspection {
  const persisted = loadOverlayTrustState(db);
  if (persisted) {
    return { state: persisted, source: 'persisted' };
  }

  const derived = deriveOverlayTrustStateFromDb(db);
  if (derived) {
    return { state: derived, source: 'derived' };
  }

  return { state: null, source: 'none' };
}

export function deriveOverlayTrustLevelFromMode(
  mode: RebuildMode | 'none',
  sourceAction?: OverlayTrustStateSource
): OverlayTrustLevel {
  if (mode === 'none') return 'no-overlay';
  if (mode === 'content-only') return 'content-only';
  if (mode === 'overlay-complete') return 'overlay-complete';
  if (
    mode === 'degraded-overlay' &&
    (sourceAction === 'index-sync' || sourceAction === 'index-refresh')
  ) {
    return 'stale-overlay';
  }
  return 'degraded-overlay';
}

export function deriveOverlayTrustLevelFromState(
  state: PersistedOverlayTrustState | null
): OverlayTrustLevel {
  return deriveOverlayTrustLevelFromMode(state?.mode ?? 'none', state?.sourceAction);
}

export function deriveOverlayTrustLevel(db: LuxDatabase): OverlayTrustLevel {
  return deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state);
}

export function describeOverlayTrustInspection(
  inspection: OverlayTrustInspection
): OverlayTrustDiagnostics {
  if (!inspection.state) {
    return {
      mode: 'none',
      trustLevel: 'no-overlay',
      trustSource: inspection.source,
      warnings: [
        'No overlay trust state recorded. Run "lux index rebuild" to build the canonical overlay path.',
      ],
    };
  }

  return {
    mode: inspection.state.mode,
    trustLevel: deriveOverlayTrustLevelFromMode(
      inspection.state.mode,
      inspection.state.sourceAction
    ),
    trustSource: inspection.source,
    warnings: [...inspection.state.warnings],
  };
}

export function markOverlayTrustAfterSync(
  db: LuxDatabase,
  details: OverlaySyncMutationDetails & RunWarningMeta
): PersistedOverlayTrustState {
  const inspection = inspectOverlayTrustState(db);
  const prior = inspection.state ?? defaultDegradedState(details.lastIndexedCommit);
  // The sync's own warnings (a file it re-read) join the carried ones; a file it re-read cleanly
  // retires a carried warning about that file.
  const settled = settleWarnings(prior, details);
  const fresh = details.warnings ?? [];
  const base = { ...prior, ...settled };

  if (details.overlayRelevantPaths.length === 0) {
    let mode: RebuildMode = base.mode;
    if (mode !== 'content-only') {
      if (fresh.length > 0) mode = 'degraded-overlay';
      // Restored only when this sync retired the last warning behind the degradation; a state
      // degraded for another reason (residual stale edges) has no warnings to retire.
      else if (
        mode === 'degraded-overlay' &&
        prior.warnings.length > 0 &&
        settled.warnings.length === 0
      )
        mode = 'overlay-complete';
    }
    return persistOverlayTrustState(db, {
      ...base,
      mode,
      recordedAt: new Date().toISOString(),
      lastIndexedCommit: details.lastIndexedCommit,
      sourceAction: 'index-sync',
    });
  }

  const syncWarning = buildSyncWarning(details);
  const warnings = dedupeWarnings([...base.warnings, syncWarning]);
  const nextMode: RebuildMode = base.mode === 'content-only' ? 'content-only' : 'degraded-overlay';

  return persistOverlayTrustState(db, {
    ...base,
    mode: nextMode,
    warnings,
    recordedAt: new Date().toISOString(),
    lastIndexedCommit: details.lastIndexedCommit,
    sourceAction: 'index-sync',
  });
}

function deriveOverlayTrustStateFromDb(db: LuxDatabase): PersistedOverlayTrustState | null {
  const stats = db.getStats();
  const surfaces = db.getCapabilitySurfaces();
  // Count app-origin nodes only — merged vendor-pack nodes must not inflate the
  // overlay trust snapshot behind `lux overlay status` (ADR-3 / REQ-7).
  const fileNodes = db.getLocalStructuralNodesByType('file');
  const symbolNodes = db.getLocalStructuralNodesByType('symbol');
  const { controllerBackedCount, closureBackedCount, unknownProviderKindCount } =
    countProviderKinds(surfaces);

  if (stats.knowledge_entries === 0 && surfaces.length === 0 && fileNodes.length === 0) {
    return null;
  }

  let mode: RebuildMode;
  const inferred =
    'Overlay trust state inferred from DB shape because no persisted trust metadata was found.';
  const warnings: string[] = [inferred];

  if (surfaces.length === 0 && fileNodes.length === 0) {
    mode = 'content-only';
    warnings.push(
      'No structural overlay nodes are present in the DB. Run "lux index rebuild" for the canonical overlay-complete path.'
    );
  } else if (symbolNodes.length === 0) {
    mode = 'degraded-overlay';
    warnings.push(
      'Structural overlay nodes exist but no symbol nodes are present, so provider propagation trust is reduced.'
    );
  } else {
    mode = 'overlay-complete';
  }

  return {
    mode,
    repoPath: '',
    configSource: 'lux.yaml',
    configLspEnabled: symbolNodes.length > 0,
    surfaceCount: surfaces.length,
    detectorEdgeCount: 0,
    propagatedEdgeCount: 0,
    fileNodeCount: fileNodes.length,
    symbolNodeCount: symbolNodes.length,
    controllerBackedCount,
    closureBackedCount,
    unknownProviderKindCount,
    enrichmentStatus: symbolNodes.length > 0 ? 'active' : 'inactive',
    propagationStatus:
      surfaces.length === 0 ? 'skipped' : symbolNodes.length === 0 ? 'skipped' : 'empty',
    warnings,
    // The shape-derived warnings are re-derived by any run that classifies the overlay; the notice
    // that the state was inferred stands until a full rebuild records one.
    warningComponents: Object.fromEntries(
      warnings.map((warning) => [
        warning,
        warning === inferred ? TRUST_INFERRED_COMPONENT : OVERLAY_STATE_COMPONENT,
      ])
    ),
    recordedAt: '',
    lastIndexedCommit: db.getIndexMetadata('last_indexed_commit'),
    sourceAction: 'derived',
  };
}

function countProviderKinds(surfaces: Array<{ metadata?: string | null }>): {
  controllerBackedCount: number;
  closureBackedCount: number;
  unknownProviderKindCount: number;
} {
  let controllerBackedCount = 0;
  let closureBackedCount = 0;
  let unknownProviderKindCount = 0;

  for (const surface of surfaces) {
    if (!surface.metadata) {
      unknownProviderKindCount++;
      continue;
    }

    try {
      const meta = JSON.parse(surface.metadata) as Record<string, unknown>;
      if (meta.providerKind === 'controller') controllerBackedCount++;
      else if (meta.providerKind === 'closure') closureBackedCount++;
      else unknownProviderKindCount++;
    } catch {
      // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
      unknownProviderKindCount++;
    }
  }

  return { controllerBackedCount, closureBackedCount, unknownProviderKindCount };
}

function defaultDegradedState(lastIndexedCommit?: string): PersistedOverlayTrustState {
  return {
    mode: 'degraded-overlay',
    repoPath: '',
    configSource: 'lux.yaml',
    configLspEnabled: false,
    surfaceCount: 0,
    detectorEdgeCount: 0,
    propagatedEdgeCount: 0,
    fileNodeCount: 0,
    symbolNodeCount: 0,
    controllerBackedCount: 0,
    closureBackedCount: 0,
    unknownProviderKindCount: 0,
    enrichmentStatus: 'inactive',
    propagationStatus: 'skipped',
    warnings: [
      'Index content advanced without a recorded overlay trust baseline. Run "lux index rebuild" to restore canonical overlay trust state.',
    ],
    recordedAt: new Date().toISOString(),
    lastIndexedCommit,
    sourceAction: 'index-sync',
  };
}

function buildSyncWarning(details: OverlaySyncMutationDetails): string {
  return (
    'Index content was synced without rebuilding the structural overlay — ' +
    `overlay trust may be stale for ${details.overlayRelevantPaths.length} source file(s) ` +
    `(+${details.addedCount} ~${details.modifiedCount} -${details.deletedCount}, ` +
    `${details.indexedCount} indexed, ${details.deletedEntryCount} deleted).`
  );
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRebuildMode(value: unknown): value is RebuildMode {
  return value === 'overlay-complete' || value === 'content-only' || value === 'degraded-overlay';
}
