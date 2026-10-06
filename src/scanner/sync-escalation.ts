import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig, DEFAULT_REFRESH_CONFIG } from './config.js';
import { structuralConfigFingerprintMatches } from './config-fingerprint.js';
import { deriveOverlayTrustLevel } from './overlay-trust-state.js';
import { vendorPackChangedSinceRebuild } from './rebuild-orchestrator.js';
import type { ScopedRefreshEscalation } from './associations/overlay-refresh.js';

export type FullRebuildReason =
  | 'no-overlay' // precondition: refresh repairs, never bootstraps
  | 'pending-migration' // schema not current
  | 'first-party' // Decision 9 — cross-area freshness is Arc 3
  | 'config-changed' // Decision 7 — fingerprint mismatch
  | 'vendor-pack-changed' // the pack a rebuild would merge is not the merged one
  | 'over-budget' // Decision 7 — changed count above maxScopedFiles
  | ScopedRefreshEscalation; // the refresh stopped before writing (overlay-refresh.ts)

export type ScopedDecision =
  | { path: 'scoped'; maxScopedFiles: number; lspBudgetMs: number }
  | { path: 'full'; reason: FullRebuildReason };

/**
 * The conditions under which no scoped refresh can reproduce what a full rebuild of HEAD states,
 * whatever the operator asks for: there is no overlay to repair, the schema is stale, the overlay
 * spans first-party roots the refresh does not re-scan, the structural config (lux.yaml,
 * composer.lock, project resolution inputs) differs from the one the overlay was built under, or
 * the vendor pack differs from the merged one. Each of these changes facts in files the change set
 * does not name.
 */
function soundnessBlocker(db: LuxDatabase, rootPath: string): FullRebuildReason | null {
  const level = deriveOverlayTrustLevel(db);
  if (level === 'no-overlay' || level === 'content-only') return 'no-overlay';
  if (!db.isSchemaUpToDate()) return 'pending-migration';
  const config = loadLspConfig(rootPath);
  if (config.firstParty && config.firstParty.packages.length > 0) return 'first-party';
  if (!structuralConfigFingerprintMatches(rootPath, db)) return 'config-changed';
  if (vendorPackChangedSinceRebuild(db, rootPath, config)) return 'vendor-pack-changed';
  return null;
}

/**
 * Route a structural sync to scoped-vs-full (Phase 3b default): the soundness conditions above,
 * then the changed-count budget. Scoped must never silently skip a structural change that needs a
 * full rebuild.
 */
export function decideScopedEligibility(
  db: LuxDatabase,
  rootPath: string,
  changedStructuralCount: number
): ScopedDecision {
  const blocker = soundnessBlocker(db, rootPath);
  if (blocker) return { path: 'full', reason: blocker };

  const refresh = loadLspConfig(rootPath).refresh ?? DEFAULT_REFRESH_CONFIG; // Part-B constant (OQ1's 100 is one edit site)
  if (changedStructuralCount > refresh.maxScopedFiles)
    return { path: 'full', reason: 'over-budget' };

  return {
    path: 'scoped',
    maxScopedFiles: refresh.maxScopedFiles,
    lspBudgetMs: refresh.lspBudgetMs,
  };
}

/**
 * `--scoped` operator override: bypasses the changed-count budget, which is a cost policy, but not
 * the soundness conditions — a scoped refresh past one of those would leave facts the full rebuild
 * of HEAD does not state, with nothing reporting them.
 */
export function decideForcedScoped(db: LuxDatabase, rootPath: string): ScopedDecision {
  const blocker = soundnessBlocker(db, rootPath);
  if (blocker) return { path: 'full', reason: blocker };
  const refresh = loadLspConfig(rootPath).refresh ?? DEFAULT_REFRESH_CONFIG; // Part-B constant (one edit site)
  return {
    path: 'scoped',
    maxScopedFiles: refresh.maxScopedFiles,
    lspBudgetMs: refresh.lspBudgetMs,
  };
}
