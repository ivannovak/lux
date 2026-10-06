import { classifyCrossAreaOwnership, resolveAppNamespace } from '../associations/ownership.js';
import { resolveKernel } from '../associations/kernel-area.js';
import { loadLspConfig } from '../config.js';
import type { LuxDatabase } from '../../db/index.js';
import type { DeltaTouchSet, OwnershipProjection, OwnershipTransition } from './types.js';

export interface OwnershipContext {
  corpusPath: string;
  /** `--kernel <path>` override (must match the vendored symlink; passed through to resolveKernel). */
  kernelOverride?: string;
}

export function resolveOwnershipIntersection(
  db: LuxDatabase,
  touch: DeltaTouchSet,
  ctx: OwnershipContext
): OwnershipProjection {
  const touchedSymbols = new Set(touch.symbolIds);
  const kernelCfg = loadLspConfig(ctx.corpusPath).overlay?.kernel;

  // (b) cross-area recompute — the acme-res path (SC-4)
  if (kernelCfg?.package) {
    try {
      const kernel = resolveKernel(ctx.corpusPath, kernelCfg, ctx.kernelOverride);
      const map = classifyCrossAreaOwnership(db, kernel, resolveAppNamespace(ctx.corpusPath));
      const stale = Boolean(
        kernel.indexedCommit && kernel.headCommit && kernel.indexedCommit !== kernel.headCommit
      );
      const transitions: OwnershipTransition[] = [];
      for (const r of map.routes) {
        const changedHandler =
          r.clientHandler && touchedSymbols.has(r.clientHandler)
            ? r.clientHandler
            : r.kernelHandler && touchedSymbols.has(r.kernelHandler)
              ? r.kernelHandler
              : null;
        if (changedHandler) {
          transitions.push({ route: r.route, label: r.label, changedHandler });
        }
      }
      return {
        kernelConfigured: true,
        kernelResolved: true,
        source: 'cross-area-recompute',
        kernelDrift: {
          indexedCommit: kernel.indexedCommit ?? null,
          headCommit: kernel.headCommit ?? null,
          stale,
        },
        transitions,
      };
    } catch (error) {
      // lux-intentional-swallow: returned to the caller as a refusal, which reports it.
      // Configured but unresolvable (unindexed/missing kernel, schema mismatch): never classify
      // against stale/absent kernel data — surface it. --check fails loud (gate section).
      return {
        kernelConfigured: true,
        kernelResolved: false,
        source: 'unavailable',
        kernelDrift: null,
        transitions: [],
        warning: `cross-area ownership unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // (a) single-index labels
  const labels = touch.symbolIds.length ? db.getHandlerOwnershipForSymbols(touch.symbolIds) : [];
  const labelled = labels.filter((l) => l.ownership != null);
  if (labelled.length > 0) {
    return {
      kernelConfigured: false,
      kernelResolved: false,
      source: 'single-index',
      kernelDrift: null,
      transitions: labelled.map((l) => ({
        route: l.route,
        label: l.ownership as string,
        changedHandler: l.handler,
      })),
    };
  }

  return {
    kernelConfigured: false,
    kernelResolved: false,
    source: 'unavailable',
    kernelDrift: null,
    transitions: [],
  };
}
