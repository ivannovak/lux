// Federated search — a per-sibling FTS result union with repo attribution (Decision 5). No id joins
// (unlike trace). Each result's path is relative to the root of the repo its group names, as stored
// in that repo's index. bm25 ranks are corpus-relative → grouped by repo, not interleaved (OQ5). Opt-in
// only (--with); the single-repo path is untouched (byte-identical).

import { SearchRefusalError, type LuxDatabase } from '../db/index.js';
import type { FederationBlock } from './siblings.js';

export interface FederatedSearchResultItem {
  type: 'document';
  title: string;
  path: string;
  rank: number;
}

export interface FederatedSearchGroup {
  repo: string;
  results: FederatedSearchResultItem[];
}

export interface FederatedSearchResult {
  query: string;
  groups: FederatedSearchGroup[];
  federation: FederationBlock;
}

/** Per-repo FTS union (main first, then registry order). Each group is independently ranked. */
export function runFederatedSearch(
  primary: LuxDatabase,
  siblings: Array<{ name: string; db: LuxDatabase }>,
  query: string,
  federation: FederationBlock,
  limit: number
): FederatedSearchResult {
  // Re-sourced from the ranked contract (D1): federated groups now carry REAL bm25 (they silently
  // carried rank:0 through the old unranked document funnel before). `searchDocumentsRanked` applies
  // LIMIT ? in SQL, so the prior `.slice(0, limit)` is redundant and dropped. `{ limit }` ≡ `{ limit,
  // contentOnly:false }` — federated search is never content-scoped and buildFtsMatchExpression
  // branches on !contentOnly.
  const search = (db: LuxDatabase): FederatedSearchResultItem[] =>
    db
      .searchDocumentsRanked(query, { limit })
      .map((r) => ({ type: 'document' as const, title: r.title, path: r.filePath, rank: r.rank }));

  // Per-sibling degradation (federation FIX-1 posture): a sibling whose FTS table is missing/broken
  // throws SearchRefusalError('fts-unavailable') — a REPO-level fault, so degrade THAT repo to an
  // empty group rather than abort the union. An 'invalid-query', by contrast, is a QUERY-level fault
  // that fails identically for every group including `main` (e.g. `OR term`, `nope:term`); swallowing
  // it would fabricate an all-empty answer with a valid federation block + exit 0 — the exact
  // fabricated-empty the single-repo path refuses. Re-throw it so the caller surfaces one structured
  // refusal (exit 1 / isError, expression echoed), consistent with single-repo (M1).
  const safeSearch = (db: LuxDatabase): FederatedSearchResultItem[] => {
    try {
      return search(db);
    } catch (err) {
      if (err instanceof SearchRefusalError && err.reason === 'fts-unavailable') return [];
      throw err;
    }
  };

  const groups: FederatedSearchGroup[] = [{ repo: 'main', results: safeSearch(primary) }];
  for (const s of siblings) groups.push({ repo: s.name, results: safeSearch(s.db) });
  return { query, groups, federation };
}
