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
import type { OverlayRebuildResult } from './associations/overlay-service.js';
import { loadLspConfig, type LuxLspConfig } from './config.js';
import { resolveFirstPartyRoots } from './pack/first-party.js';
import { lookupPack } from './pack/cache.js';
import type { EnricherRegistry } from './lsp/index.js';
import { persistModuleDependencies } from './module-dependency-store.js';
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
  db.clearRebuildTrustState();
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

  const result: RebuildResult = {
    ...classifyResult(rootPath, scanResult, db, 'overlay', config.lsp.enabled, [
      ...lookupWarnings,
      ...scanResult.warnings,
      ...(dependencyWarning ? [dependencyWarning] : []),
    ]),
    warningComponents: scanResult.warningComponents,
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
    options.db.clearRebuildTrustState();
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

  // A phase that failed part-way left its partial writes behind, so the in-run tallies no longer
  // describe the index; count it instead. The failure itself is already one of the absorbed
  // warnings: the overlay reported it through the run's warning channel.
  const phaseFailures = overlay.phaseFailures ?? [];
  const persisted =
    phaseFailures.length > 0
      ? countPersistedOverlay(db)
      : { fileNodes: overlay.fileNodes, symbolNodes: overlay.symbolNodes };
  const warnings = [
    ...collectWarnings(overlay, persisted.symbolNodes, scanResult.stats.activeEnrichers),
    ...absorbedWarnings,
  ];
  const mode: RebuildMode = warnings.length > 0 ? 'degraded-overlay' : 'overlay-complete';

  const { controllerBackedCount, closureBackedCount, unknownProviderKindCount } =
    countProviderKinds(db);

  const propagationStatus: 'ran' | 'skipped' | 'empty' =
    overlay.propagationEdgesAdded > 0 ? 'ran' : overlay.surfacesDetected > 0 ? 'empty' : 'skipped';

  const surfaces = reconcileSurfaceCounts({
    surfacesDetected: overlay.surfacesDetected,
    controllerBackedCount,
    closureBackedCount,
    unknownProviderKindCount,
  });
  warnings.push(...surfaces.warnings);

  return {
    mode,
    repoPath: rootPath,
    configSource: 'lux.yaml',
    configLspEnabled,
    surfaceCount: surfaces.surfaceCount,
    detectorEdgeCount: overlay.surfaceEdgesStored,
    propagatedEdgeCount: overlay.propagationEdgesAdded,
    fileNodeCount: persisted.fileNodes,
    symbolNodeCount: persisted.symbolNodes,
    controllerBackedCount,
    closureBackedCount,
    unknownProviderKindCount,
    enrichmentStatus: scanResult.stats.activeEnrichers > 0 ? 'active' : 'inactive',
    propagationStatus,
    warnings,
    dirtyAtIndexTime: overlay.dirtyFileCount,
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

/** Collect trust-relevant warnings from an overlay rebuild result. */
function collectWarnings(
  overlay: OverlayRebuildResult,
  symbolNodes: number,
  activeEnrichers: number
): string[] {
  const warnings: string[] = [];

  if (symbolNodes === 0) {
    warnings.push(
      'No symbol nodes were materialized — provider propagation trust is reduced. ' +
        (activeEnrichers === 0
          ? 'No LSP enrichers were active or configured for this repo.'
          : 'LSP enrichers ran but produced no symbols.')
    );
  }

  if (overlay.propagationEdgesAdded === 0 && overlay.surfacesDetected > 0) {
    warnings.push(
      `${overlay.surfacesDetected} surface(s) detected but propagation produced no provider edges.`
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
