import { getDiffNameStatus, getDirtyFileEntries, getHeadCommit } from '../git.js';
import { detectModuleBoundaries, resolveModule } from '../imports/module-boundary.js';
import type { LuxDatabase } from '../../db/index.js';
import type { BaseResolution } from './preflight.js';
import type { DeltaChangeSet, DeltaFile, DeltaFileStatus, IndexTrust } from './types.js';

/**
 * Indexable extensions + the exclusion prefixes the post-commit hook uses (Decision 11). Kept
 * local and minimal: gitignore already screens vendor/node_modules/build output, so this filter
 * only drops scratch files with non-source extensions from the working-tree scan.
 */
const INDEXABLE_EXT = /\.(php|ts|tsx|js|jsx|mjs|cjs|vue|blade\.php)$/i;

export function isIndexablePath(path: string): boolean {
  return INDEXABLE_EXT.test(path);
}

export interface ChangeSetInput {
  base: BaseResolution;
  committedOnly: boolean;
}

/**
 * Produce the delta input set: the committed span (base..HEAD, argv `-M --name-status`) unioned
 * with the working tree (unless `committedOnly`), each file tagged with its module rollup and a
 * conservative per-file index-trust mark (Decision 5). Renames are single entries whose ORIGIN
 * drives the index joins (`indexPaths`) and whose current path drives module/reporting
 * (Decision 12). Deleted files stay in the set — their nodes still exist in the index.
 */
export function resolveDeltaChangeSet(
  corpusPath: string,
  db: LuxDatabase,
  input: ChangeSetInput
): DeltaChangeSet {
  const warnings: string[] = [];
  const patterns = detectModuleBoundaries(corpusPath);
  const moduleOf = (path: string): string | null => {
    const m = resolveModule(path, corpusPath, patterns);
    return m ?? '(unscoped)'; // never hard-fail on an unscoped file (SC-2)
  };

  // committed span: base..HEAD — these files are committed *after* the base, so they are
  // strictly newer than the index only when the index sits at the base; mark conservatively.
  const committed = getDiffNameStatus(corpusPath, input.base.ref);
  const files = new Map<string, DeltaFile>(); // keyed by current path (dedup: WT wins over committed)
  const indexPaths = new Set<string>();

  for (const e of committed) {
    const joinPath = e.status === 'renamed' && e.renamedFrom ? e.renamedFrom : e.path;
    indexPaths.add(joinPath);
    files.set(e.path, {
      path: e.path,
      status: e.status,
      renamedFrom: e.renamedFrom,
      module: moduleOf(e.path),
      indexTrust: 'index-stale', // committed since the base → the index predates it
    });
  }

  // working tree (Decision 5/11): the change the agent is making *right now*.
  if (!input.committedOnly) {
    for (const e of getDirtyFileEntries(corpusPath)) {
      if (e.status === 'untracked' && !isIndexablePath(e.path)) continue; // Decision 11 filter
      const joinPath = e.status === 'renamed' && e.renamedFrom ? e.renamedFrom : e.path;
      indexPaths.add(joinPath);
      const status: DeltaFileStatus = e.status;
      const indexTrust: IndexTrust = e.status === 'untracked' ? 'index-absent' : 'index-stale';
      files.set(e.path, {
        path: e.path,
        status,
        renamedFrom: e.renamedFrom,
        module: moduleOf(e.path),
        indexTrust,
      });
    }
  }

  // OQ4 (Decision 11): the maintained overlay marks are a base-honesty dimension the commit
  // pointer alone cannot express. When delta's base is the index pointer (the default) and the
  // pointer was advanced past an unrepaired overlay (a --mark-only / partial-refresh sync), the
  // files whose overlay edges are `stale` are exactly the ones the commit-based change-set MISSES.
  // Surface them so `lux delta` never reports an empty change-set over a stale overlay. This is a
  // base-resolution addition only — the touch-set still resolves from indexPaths (Decision 3 intact).
  if (input.base.source === 'index') {
    const overlayStale = db.getFilePathsWithStaleEdges();
    let injected = 0;
    for (const filePath of overlayStale) {
      if (files.has(filePath)) continue; // committed / working-tree already covers it
      indexPaths.add(filePath);
      files.set(filePath, {
        path: filePath,
        status: 'modified',
        module: moduleOf(filePath),
        indexTrust: 'index-stale', // overlay stale ⇒ index facts predate the current code
      });
      injected++;
    }
    if (injected > 0) {
      warnings.push(
        `${injected} file(s) surfaced from maintained overlay staleness marks (not in the ` +
          `base..HEAD diff) — the index pointer advanced past an unrepaired overlay. ` +
          `Run "lux index sync --scoped" (or "lux index rebuild") to repair.`
      );
    }
  }

  let head: { sha: string | null; workingTreeIncluded: boolean };
  try {
    head = { sha: getHeadCommit(corpusPath), workingTreeIncluded: !input.committedOnly };
  } catch {
    // lux-intentional-swallow: no HEAD (an unborn branch): the change set reports a null head.
    head = { sha: null, workingTreeIncluded: !input.committedOnly };
  }

  return {
    base: { ref: input.base.ref, sha: input.base.sha, source: input.base.source },
    head,
    files: [...files.values()],
    indexPaths: [...indexPaths],
    warnings,
  };
}
