// Shared overlay rebuild orchestration contract.
//
// This module is the single trusted path for capability-surface validation.
// All CLI entry points and validation scripts should call these functions
// rather than encoding their own rebuild semantics.
//
// Two paths are provided:
//   rebuildWithOverlay()  — full overlay-complete rebuild with trust signals
//   rebuildContentOnly()  — lightweight content-index rebuild, explicitly not
//                           suitable for capability-surface validation

import { existsSync } from 'fs';
import { join } from 'path';
import type { LuxDatabase } from '../db/index.js';
import { generalScan } from './general.js';
import type { GeneralScanResult } from './general.js';
import { loadLspConfig, type LuxLspConfig } from './config.js';
import { resolveFirstPartyRoots } from './pack/first-party.js';
import { lookupPack, VENDOR_PACK_MERGED_META, vendorPackIdentity } from './pack/cache.js';
import { createDefaultDetectors } from './associations/detectors/index.js';
import type { EnricherRegistry } from './lsp/index.js';
import {
  MODULE_DEPENDENCIES_COMPONENT,
  persistModuleDependencies,
} from './module-dependency-store.js';
import { warnSink, type WarnFn } from './reporter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Completeness classification for a rebuild run. */
export type RebuildMode = 'overlay-complete' | 'content-only' | 'degraded-overlay';

/**
 * Structured result contract for a rebuild.
 *
 * Both CLI renderers and scripts should consume this type to determine
 * whether the run is trustworthy for capability-surface validation.
 */
export interface RebuildResult {
  /** Completeness classification. */
  mode: RebuildMode;
  /** Absolute path to the scanned repo. */
  repoPath: string;
  /** Where configuration was loaded from. */
  configSource: string;
  /** Whether repo config had LSP enabled. */
  configLspEnabled: boolean;
  /** Number of capability-surface nodes detected. */
  surfaceCount: number;
  /** Edges written by the capability-surface detector pass. */
  detectorEdgeCount: number;
  /** Edges added during symbolic propagation. */
  propagatedEdgeCount: number;
  /** File structural nodes materialized. */
  fileNodeCount: number;
  /** Symbol structural nodes materialized from LSP enrichment. */
  symbolNodeCount: number;
  /** Surfaces whose declaration form is controller-backed. */
  controllerBackedCount: number;
  /** Surfaces whose declaration form is closure-backed. */
  closureBackedCount: number;
  /** Surfaces with no recognizable declaration form. */
  unknownProviderKindCount: number;
  /** Whether LSP enrichers ran and produced symbol data. */
  enrichmentStatus: 'active' | 'inactive';
  /** Whether symbolic propagation ran and added edges. */
  propagationStatus: 'ran' | 'skipped' | 'empty';
  /** Trust-relevant warnings. Non-empty when mode is degraded-overlay. */
  warnings: string[];
  /**
   * The component that raised each warning, by message, where one is known. A scoped refresh that
   * re-runs that component cleanly retires the warning.
   */
  warningComponents?: Record<string, string>;
  /** How many files were dirty in the working tree when the overlay was built. */
  dirtyAtIndexTime?: number;
}

/** Options for orchestrated rebuild functions. */
export interface RebuildOptions {
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Include heuristic edges in the overlay (default: false). */
  includeHeuristics?: boolean;
  /**
   * Override the vendor-pack merge (ADR-1/ADR-2). `undefined` ⇒ auto-resolve a
   * cached pack for the project's `composer.lock` (merge iff one exists); an
   * explicit path forces that pack; `null` forces an app-only rebuild (no merge).
   */
  vendorPackPath?: string | null;
  /** Inject a pre-built enricher registry (generalScan's DI seam, for tests and embedding). */
  enricherRegistry?: EnricherRegistry;
}

/**
 * Resolve the cached vendor pack for a project's current `composer.lock`, or null
 * when there is no Composer project, no matching cached pack, or lux.yaml sets
 * `vendorPack.merge: false`. Keyed by the lockfile hash, so a dependency bump
 * misses the cache (no stale merge).
 */
function resolveVendorPackPath(
  rootPath: string,
  config: LuxLspConfig,
  warn?: WarnFn
): string | null {
  if (config.vendorPack?.merge === false) return null;
  try {
    if (!existsSync(join(rootPath, 'composer.lock'))) return null;
    const lookup = lookupPack(rootPath);
    return lookup.hit ? lookup.packPath : null;
  } catch (error) {
    warn?.(
      `vendor pack lookup failed, so this rebuild is app-only — ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Public wrapper (T3a.1) over {@link resolveVendorPackPath} for the scoped overlay-refresh
 * engine (spec 13 Part F). Same composer.lock-keyed cached-pack lookup; `null` ⇒ the facade
 * tier is skipped (`skipped-no-pack`).
 */
export function resolveVendorPackPathForRefresh(
  rootPath: string,
  config: LuxLspConfig,
  warn?: WarnFn
): string | null {
  return resolveVendorPackPath(rootPath, config, warn);
}

/**
 * True when the vendor pack a full rebuild would merge now is not the pack the overlay holds: a pack
 * built, rebuilt or removed since the last rebuild, a different cache, or `vendorPack.merge` turned
 * off. The merged pack is the resolution universe for every app call into vendor code, so no scoped
 * refresh of changed files can bring the overlay in line with it; the sync escalates to a full
 * rebuild instead. An overlay whose vendor nodes predate the merge record counts as changed, since
 * which pack it holds is unknown.
 */
export function vendorPackChangedSinceRebuild(
  db: LuxDatabase,
  rootPath: string,
  config: LuxLspConfig
): boolean {
  const expected = vendorPackIdentity(resolveVendorPackPath(rootPath, config));
  const recorded =
    db.getIndexMetadata(VENDOR_PACK_MERGED_META) ?? (db.hasVendorPackNodes() ? 'unknown' : 'none');
  return expected !== recorded;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an overlay-complete rebuild and return structured trust metadata.
 *
 * This is the canonical path for capability-surface validation. Calls
 * generalScan() with overlayEnabled=true and classifies the resulting
 * overlay state into a RebuildResult with explicit completeness signals.
 *
 * @param db - Initialized database to write overlay state into.
 * @param rootPath - Absolute repository root.
 * @param options - Rebuild options.
 */
export async function rebuildWithOverlay(
  db: LuxDatabase,
  rootPath: string,
  options: RebuildOptions = {}
): Promise<{ result: RebuildResult; scanResult: GeneralScanResult }> {
  const config = loadLspConfig(rootPath);
  options.onProgress?.('Clearing existing content index and structural overlay...');
  db.beginRebuild();
  db.clearOverlay();
  db.clearKnowledgeIndex();

  // ADR-1/ADR-2: locate the cached pack for this dependency set (null ⇒ app-only).
  // An explicit option (incl. null) overrides auto-resolution.
  const lookupWarnings: string[] = [];
  const vendorPackPath =
    options.vendorPackPath !== undefined
      ? options.vendorPackPath
      : resolveVendorPackPath(
          rootPath,
          config,
          warnSink((message) => lookupWarnings.push(message))
        );

  // E1: promote declared first-party packages to app-source (empty ⇒ single-root).
  const firstPartyRoots = config.firstParty
    ? resolveFirstPartyRoots(
        rootPath,
        config.firstParty.packages,
        warnSink((message) => lookupWarnings.push(message))
      ).map((r) => r.sourceRoot)
    : [];

  const scanResult = await generalScan(rootPath, {
    config,
    onProgress: options.onProgress,
    overlayEnabled: true,
    db,
    vendorPackPath,
    firstPartyRoots,
    enricherRegistry: options.enricherRegistry,
  });
  const dependencyWarning = persistModuleDependencies(db, scanResult);

  const classified = classifyResult(rootPath, scanResult, db, 'overlay', config.lsp.enabled, [
    ...lookupWarnings,
    ...scanResult.warnings,
    ...(dependencyWarning ? [dependencyWarning] : []),
  ]);
  const result: RebuildResult = {
    ...classified,
    warningComponents: {
      ...classified.warningComponents,
      ...scanResult.warningComponents,
      ...(dependencyWarning ? { [dependencyWarning]: MODULE_DEPENDENCIES_COMPONENT } : {}),
    },
  };
  return { result, scanResult };
}

/**
 * Run a content-only rebuild (no overlay).
 *
 * Returns a RebuildResult explicitly classified as content-only. This path
 * must NOT be used for capability-surface validation — use rebuildWithOverlay()
 * for that purpose.
 *
 * @param rootPath - Absolute repository root.
 * @param options - Rebuild options.
 */
export async function rebuildContentOnly(
  rootPath: string,
  options: RebuildOptions & { db?: LuxDatabase } = {}
): Promise<{ result: RebuildResult; scanResult: GeneralScanResult }> {
  const config = loadLspConfig(rootPath);
  if (options.db) {
    options.onProgress?.('Clearing existing content index and structural overlay...');
    options.db.beginRebuild();
    options.db.clearOverlay();
    options.db.clearKnowledgeIndex();
  }

  const scanResult = await generalScan(rootPath, {
    config,
    onProgress: options.onProgress,
  });
  const dependencyWarning = options.db ? persistModuleDependencies(options.db, scanResult) : null;

  const result: RebuildResult = {
    ...classifyResult(rootPath, scanResult, null, 'content', config.lsp.enabled, [
      ...scanResult.warnings,
      ...(dependencyWarning ? [dependencyWarning] : []),
    ]),
    warningComponents: scanResult.warningComponents,
  };
  return { result, scanResult };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Derive a RebuildResult from a completed generalScan output.
 * Determines completeness state and collects trust-relevant warnings.
 */
function classifyResult(
  rootPath: string,
  scanResult: GeneralScanResult,
  db: LuxDatabase | null,
  intent: 'overlay' | 'content',
  configLspEnabled: boolean,
  absorbedWarnings: string[]
): RebuildResult {
  if (intent === 'content') {
    return {
      mode: 'content-only',
      repoPath: rootPath,
      configSource: 'lux.yaml',
      configLspEnabled,
      surfaceCount: 0,
      detectorEdgeCount: 0,
      propagatedEdgeCount: 0,
      fileNodeCount: 0,
      symbolNodeCount: 0,
      controllerBackedCount: 0,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
      enrichmentStatus: scanResult.stats.activeEnrichers > 0 ? 'active' : 'inactive',
      propagationStatus: 'skipped',
      warnings: [...absorbedWarnings],
    };
  }

  const overlay = scanResult.overlay;

  if (!overlay) {
    // Bulk writes commit in chunks, so a rebuild that failed part-way leaves what it wrote on
    // disk. Report the index as it is, and why the rebuild stopped.
    const persisted = countPersistedOverlay(db);
    const kinds = countProviderKinds(db);
    return {
      mode: 'degraded-overlay',
      repoPath: rootPath,
      configSource: 'lux.yaml',
      configLspEnabled,
      surfaceCount:
        kinds.controllerBackedCount + kinds.closureBackedCount + kinds.unknownProviderKindCount,
      detectorEdgeCount: 0,
      propagatedEdgeCount: 0,
      fileNodeCount: persisted.fileNodes,
      symbolNodeCount: persisted.symbolNodes,
      ...kinds,
      enrichmentStatus: scanResult.stats.activeEnrichers > 0 ? 'active' : 'inactive',
      propagationStatus: 'skipped',
      warnings: [
        scanResult.overlayError !== undefined
          ? `Overlay rebuild failed: ${scanResult.overlayError}. ${persisted.fileNodes} file ` +
            `node(s) and ${persisted.symbolNodes} symbol node(s) were persisted before it stopped.`
          : 'Overlay rebuild did not produce a result — structural overlay state is absent.',
        ...absorbedWarnings,
      ],
    };
  }

  // The overlay reported any failed phase through the run's warning channel, so it is already one
  // of the absorbed warnings; the counters come from the rows on disk either way.
  return classifyOverlayFromDb(db, {
    repoPath: rootPath,
    configLspEnabled,
    enrichmentActive: scanResult.stats.activeEnrichers > 0,
    dirtyFileCount: overlay.dirtyFileCount,
    absorbedWarnings,
    surfacesDetected: overlay.surfacesDetected,
  });
}

/** The component a warning derived from the overlay's persisted counts is filed under. */
export const OVERLAY_STATE_COMPONENT = 'overlay-state';
/** The component the detector-tally-versus-persisted-surfaces warning is filed under. */
export const SURFACE_TALLY_COMPONENT = 'surface-tally';

/**
 * Classify an overlay from what the database holds. Every counter is read from the persisted rows,
 * so the trust state describes the index a reader queries, whichever path wrote it: a full rebuild
 * and a scoped sync of the same commit report the same numbers.
 *
 * `absorbedWarnings` are problems the run carried on past; they decide the mode with the overlay's
 * own warnings. `surfacesDetected` is the detectors' tally for a run that detected every surface;
 * when given, a divergence from the persisted count is reported without changing the mode. The
 * warnings this function derives are filed under OVERLAY_STATE_COMPONENT and
 * SURFACE_TALLY_COMPONENT, so a later run that re-derives them retires the ones that no longer hold.
 */
export function classifyOverlayFromDb(
  db: LuxDatabase | null,
  input: {
    repoPath: string;
    configLspEnabled: boolean;
    enrichmentActive: boolean;
    dirtyFileCount: number;
    absorbedWarnings: string[];
    surfacesDetected?: number;
  }
): RebuildResult {
  const counts = countOverlay(db);
  const stateWarnings = collectWarnings(counts, input.enrichmentActive);
  const warnings = [...stateWarnings, ...input.absorbedWarnings];
  const mode: RebuildMode = warnings.length > 0 ? 'degraded-overlay' : 'overlay-complete';
  const warningComponents: Record<string, string> = {};
  for (const warning of stateWarnings) warningComponents[warning] = OVERLAY_STATE_COMPONENT;
  if (input.surfacesDetected !== undefined) {
    const mismatch = reconcileSurfaceCounts({
      surfacesDetected: input.surfacesDetected,
      controllerBackedCount: counts.controllerBackedCount,
      closureBackedCount: counts.closureBackedCount,
      unknownProviderKindCount: counts.unknownProviderKindCount,
    }).warnings;
    for (const warning of mismatch) warningComponents[warning] = SURFACE_TALLY_COMPONENT;
    warnings.push(...mismatch);
  }

  const propagationStatus: 'ran' | 'skipped' | 'empty' =
    counts.propagatedEdgeCount > 0 ? 'ran' : counts.surfaceCount > 0 ? 'empty' : 'skipped';

  return {
    mode,
    repoPath: input.repoPath,
    configSource: 'lux.yaml',
    configLspEnabled: input.configLspEnabled,
    ...counts,
    enrichmentStatus: input.enrichmentActive ? 'active' : 'inactive',
    propagationStatus,
    warnings,
    warningComponents,
    dirtyAtIndexTime: input.dirtyFileCount,
  };
}

/**
 * Reconcile the surface total against the provider-kind breakdown.
 *
 * The two are sourced differently: the total from the distinct surface ids the
 * detectors declared in this run, the breakdown from the rows persisted. Both
 * count nodes, so they agree whenever every declared surface became a row. A
 * route several files declare is one id per file by then (detectors qualify
 * it), and a detector that still emits one id for two declarations is named in
 * its own warning by runDetectors, so neither reaches this check.
 *
 * The persisted rows win, because they are what a reader can go and count. A
 * divergence in either direction is reported rather than absorbed: a tally
 * above the rows means a declared surface was not stored, and one below means
 * rows exist that no detector claims to have produced.
 */
export function reconcileSurfaceCounts(input: {
  surfacesDetected: number;
  controllerBackedCount: number;
  closureBackedCount: number;
  unknownProviderKindCount: number;
}): { surfaceCount: number; warnings: string[] } {
  const surfaceCount =
    input.controllerBackedCount + input.closureBackedCount + input.unknownProviderKindCount;

  const warnings: string[] = [];
  if (input.surfacesDetected !== surfaceCount) {
    warnings.push(
      `Surface count mismatch: detectors reported ${input.surfacesDetected} surface(s) but ` +
        `${surfaceCount} capability-surface node(s) are persisted. The persisted count is reported.`
    );
  }

  return { surfaceCount, warnings };
}

/** Project file and symbol nodes on disk. */
function countPersistedOverlay(db: LuxDatabase | null): { fileNodes: number; symbolNodes: number } {
  if (!db) return { fileNodes: 0, symbolNodes: 0 };
  return {
    fileNodes: db.countLocalStructuralNodesByType('file'),
    symbolNodes: db.countLocalStructuralNodesByType('symbol'),
  };
}

type OverlayCounts = Pick<
  RebuildResult,
  | 'surfaceCount'
  | 'detectorEdgeCount'
  | 'propagatedEdgeCount'
  | 'fileNodeCount'
  | 'symbolNodeCount'
  | 'controllerBackedCount'
  | 'closureBackedCount'
  | 'unknownProviderKindCount'
>;

/** Count the overlay's persisted contents: project nodes, detector and propagation edges, surfaces. */
function countOverlay(db: LuxDatabase | null): OverlayCounts {
  const kinds = countProviderKinds(db);
  const persisted = countPersistedOverlay(db);
  return {
    surfaceCount:
      kinds.controllerBackedCount + kinds.closureBackedCount + kinds.unknownProviderKindCount,
    detectorEdgeCount:
      db?.countEdgesWithEvidenceFrom({
        resolvers: createDefaultDetectors().map((detector) => detector.name),
      }) ?? 0,
    propagatedEdgeCount: db?.countEdgesWithEvidenceFrom({ resolverPrefix: 'propagation:' }) ?? 0,
    fileNodeCount: persisted.fileNodes,
    symbolNodeCount: persisted.symbolNodes,
    ...kinds,
  };
}

/** Collect trust-relevant warnings from the overlay's persisted counts. */
function collectWarnings(counts: OverlayCounts, enrichmentActive: boolean): string[] {
  const warnings: string[] = [];

  if (counts.symbolNodeCount === 0) {
    warnings.push(
      'No symbol nodes were materialized — provider propagation trust is reduced. ' +
        (enrichmentActive
          ? 'LSP enrichers ran but produced no symbols.'
          : 'No LSP enrichers were active or configured for this repo.')
    );
  }

  if (counts.propagatedEdgeCount === 0 && counts.surfaceCount > 0) {
    warnings.push(
      `${counts.surfaceCount} surface(s) detected but propagation produced no provider edges.`
    );
  }

  return warnings;
}

/** Count provider-kind classifications across all capability-surface nodes in the DB. */
function countProviderKinds(db: LuxDatabase | null): {
  controllerBackedCount: number;
  closureBackedCount: number;
  unknownProviderKindCount: number;
} {
  if (!db) {
    return { controllerBackedCount: 0, closureBackedCount: 0, unknownProviderKindCount: 0 };
  }

  let controllerBackedCount = 0;
  let closureBackedCount = 0;
  let unknownProviderKindCount = 0;

  for (const surface of db.getCapabilitySurfaces()) {
    if (surface.metadata) {
      try {
        const meta = JSON.parse(surface.metadata) as Record<string, unknown>;
        if (meta.providerKind === 'controller') {
          controllerBackedCount++;
        } else if (meta.providerKind === 'closure') {
          closureBackedCount++;
        } else {
          unknownProviderKindCount++;
        }
      } catch {
        // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
        unknownProviderKindCount++;
      }
    } else {
      unknownProviderKindCount++;
    }
  }

  return { controllerBackedCount, closureBackedCount, unknownProviderKindCount };
}
