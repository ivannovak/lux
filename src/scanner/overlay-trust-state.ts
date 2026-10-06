import type { LuxDatabase } from '../db/index.js';
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
  db.setIndexMetadata(OVERLAY_TRUST_STATE_KEY, JSON.stringify(state));
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

/**
 * Settle trust after a scoped overlay refresh (Decision 12). `meta.residualStaleEdges` counts BOTH
 * `stale` AND `dirty-dependent` (overlay-refresh step 9b drives dirty-dependent to zero on a
 * complete refresh; any leftover of either is an honest settle failure), so a non-zero residual
 * yields degraded-overlay ⇒ stale-overlay via the source-action derivation, as does any warning the
 * refresh raised. A warning carried from the prior state stays, and keeps trust degraded, until a
 * refresh re-runs the component that raised it without raising it again; once nothing that degraded
 * the prior state remains, trust is restored. Records sourceAction 'index-refresh' — provenance, not
 * a new trust level (the five levels are frozen).
 */
export function persistRefreshTrustState(
  db: LuxDatabase,
  prior: RebuildResult,
  meta: RunWarningMeta & { lastIndexedCommit?: string; residualStaleEdges: number }
): PersistedOverlayTrustState {
  const fresh = meta.warnings ?? [];
  const { warnings, warningComponents } = settleWarnings(prior, meta);

  let mode: RebuildMode = prior.mode;
  if (meta.residualStaleEdges > 0 || fresh.length > 0) mode = 'degraded-overlay';
  else if (prior.mode === 'degraded-overlay' && warnings.length === 0) mode = 'overlay-complete';

  return persistOverlayTrustState(db, {
    ...prior,
    mode,
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
      repoPath: typeof parsed.repoPath === 'string' ? parsed.repoPath : '',
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
  const warnings: string[] = [
    'Overlay trust state inferred from DB shape because no persisted trust metadata was found.',
  ];

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
