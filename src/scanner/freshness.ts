import type { LuxDatabase } from '../db/index.js';
import type { EdgeFreshnessCounts, StructuralEdge } from '../db/types.js';
import { getDirtyFileEntries, getHeadCommit, isGitRepository } from './git.js';
import { isOverlayRelevantPath } from './incremental.js';
import { loadOverlayTrustState } from './overlay-trust-state.js';

// EdgeFreshnessCounts is defined in the data layer (db/types.ts, alongside the
// per-edge FreshnessStatus it aggregates) so db/index.ts can consume it without an
// upward db→scanner import; re-exported here as part of the freshness module's surface.
export type { EdgeFreshnessCounts } from '../db/types.js';

/** Summary of the freshness layers, never collapsed into one boolean (Decision 1). */
export type FreshnessAssessment =
  | 'clean' // HEAD == indexed commit, tree clean
  | 'dirty-content' // tree dirty, no overlay-relevant files
  | 'dirty-structural' // tree dirty, overlay-relevant files present
  | 'commit-lag' // HEAD != indexed commit (dominates dirty when both)
  | 'unknown'; // not a git repo / git unavailable

export interface WorkingTreeFreshness {
  gitAvailable: boolean;
  indexedCommit?: string;
  headCommit?: string;
  headMatchesIndex: boolean;
  /** Full porcelain set (relative paths, current-path form for renames). */
  dirtyFiles: string[];
  /** Overlay-relevant subset (filtered by isOverlayRelevantPath; rename origin+target both tested). */
  dirtyStructural: string[];
  /** Persisted snapshot of how many files were dirty at the last rebuild (Decision 2). */
  dirtyAtIndexTime?: number;
  edgeFreshness: EdgeFreshnessCounts;
  assessment: FreshnessAssessment;
}

/**
 * Compute the layered freshness signal on read (Decision 1/2). Never persists.
 * Reuses getHeadCommit + delta's getDirtyFileEntries (rename/status-aware) and the
 * shared overlay-relevant filter. commit-lag dominates dirt (a lagging index is a
 * stronger signal than a dirty tree over a matching commit).
 */
export function assessWorkingTreeFreshness(
  corpusPath: string,
  db: LuxDatabase
): WorkingTreeFreshness {
  const indexedCommit = db.getIndexMetadata('last_indexed_commit') ?? undefined;
  const edgeFreshness = db.countEdgesByFreshness();
  const dirtyAtIndexTime = loadOverlayTrustState(db)?.dirtyAtIndexTime;

  if (!isGitRepository(corpusPath)) {
    return {
      gitAvailable: false,
      indexedCommit,
      headMatchesIndex: false,
      dirtyFiles: [],
      dirtyStructural: [],
      dirtyAtIndexTime,
      edgeFreshness,
      assessment: 'unknown',
    };
  }

  let headCommit: string | undefined;
  try {
    headCommit = getHeadCommit(corpusPath);
  } catch {
    // lux-intentional-swallow: reported as gitAvailable: false in the freshness result.
    return {
      gitAvailable: false,
      indexedCommit,
      headMatchesIndex: false,
      dirtyFiles: [],
      dirtyStructural: [],
      dirtyAtIndexTime,
      edgeFreshness,
      assessment: 'unknown',
    };
  }

  const entries = getDirtyFileEntries(corpusPath); // [] on failure (its own try/catch)
  const dirtyFiles = entries.map((e) => e.path);
  // Test BOTH the rename origin and target against the filter — a rename of a
  // structural file into a non-structural extension (or vice-versa) is still a
  // structural change to the origin's overlay facts.
  const dirtyStructural = [
    ...new Set(entries.flatMap((e) => (e.renamedFrom ? [e.renamedFrom, e.path] : [e.path]))),
  ].filter(isOverlayRelevantPath);

  const headMatchesIndex = indexedCommit !== undefined && headCommit === indexedCommit;
  const assessment = deriveAssessment(indexedCommit, headMatchesIndex, dirtyStructural, dirtyFiles);

  return {
    gitAvailable: true,
    indexedCommit,
    headCommit,
    headMatchesIndex,
    dirtyFiles,
    dirtyStructural,
    dirtyAtIndexTime,
    edgeFreshness,
    assessment,
  };
}

function deriveAssessment(
  indexedCommit: string | undefined,
  headMatchesIndex: boolean,
  dirtyStructural: string[],
  dirtyFiles: string[]
): FreshnessAssessment {
  // commit-lag only means something against a recorded baseline; with no indexed
  // commit we cannot claim lag, but we can still report tree dirt honestly.
  if (indexedCommit !== undefined && !headMatchesIndex) return 'commit-lag';
  if (dirtyStructural.length > 0) return 'dirty-structural';
  if (dirtyFiles.length > 0) return 'dirty-content';
  return 'clean';
}

/** Shared text block for `index status` / `overlay status` (Decision 1). */
export function renderFreshnessText(f: WorkingTreeFreshness): string[] {
  const lines: string[] = ['', 'Freshness:'];
  if (!f.gitAvailable) {
    lines.push('  Assessment: unknown (not a git repository or git unavailable)');
    lines.push(
      `  Edge freshness: ${f.edgeFreshness.fresh} fresh, ${f.edgeFreshness['dirty-dependent']} dirty-dependent, ${f.edgeFreshness.stale} stale` +
        (f.edgeFreshness.unknown ? `, ${f.edgeFreshness.unknown} unknown` : '') +
        (f.edgeFreshness.other ? `, ${f.edgeFreshness.other} other` : '')
    );
    return lines;
  }
  lines.push(`  Assessment: ${f.assessment}`);
  lines.push(
    `  HEAD ${f.headCommit?.slice(0, 8) ?? 'unknown'} ` +
      (f.headMatchesIndex ? 'matches' : 'AHEAD OF') +
      ` indexed ${f.indexedCommit?.slice(0, 8) ?? 'none'}`
  );
  if (f.dirtyStructural.length > 0) {
    lines.push(
      `  Working tree: ${f.dirtyFiles.length} dirty file(s), ${f.dirtyStructural.length} structural:`
    );
    for (const p of f.dirtyStructural.slice(0, 20)) lines.push(`    ~ ${p}`);
    lines.push('    → overlay facts for these files describe the last indexed state');
  } else if (f.dirtyFiles.length > 0) {
    lines.push(`  Working tree: ${f.dirtyFiles.length} dirty file(s) (no structural changes)`);
  } else {
    lines.push('  Working tree: clean');
  }
  if (f.dirtyAtIndexTime !== undefined) {
    lines.push(`  Built over ${f.dirtyAtIndexTime} dirty file(s)`);
  }
  lines.push(
    `  Edge freshness: ${f.edgeFreshness.fresh} fresh, ${f.edgeFreshness['dirty-dependent']} dirty-dependent, ${f.edgeFreshness.stale} stale` +
      (f.edgeFreshness.unknown ? `, ${f.edgeFreshness.unknown} unknown` : '') +
      (f.edgeFreshness.other ? `, ${f.edgeFreshness.other} other` : '')
  );
  return lines;
}

export interface StaleSupportSummary {
  staleCount: number;
  /** Up to 20 stale edge ids, for the JSON field + a bounded warning list. */
  staleEdgeIds: string[];
}

/** Summarize how many of the edges backing a result are marked `stale` (Decision 4 / SC-4).
 *  Read-only: this never mutates freshness; it reports what the maintained marks already say. */
export function summarizeStaleSupport(
  edges: Array<Pick<StructuralEdge, 'id' | 'freshness_status'>>
): StaleSupportSummary {
  const stale = edges.filter((e) => e.freshness_status === 'stale');
  return { staleCount: stale.length, staleEdgeIds: stale.slice(0, 20).map((e) => e.id) };
}

/** Standard one-line warning for a stale-supported result. */
export function staleSupportWarning(s: StaleSupportSummary): string | null {
  if (s.staleCount === 0) return null;
  return (
    `${s.staleCount} supporting edge(s) are marked stale — the cited code changed since ` +
    `these facts were derived; re-run "lux index sync --scoped" (or "lux index rebuild") to repair.`
  );
}
