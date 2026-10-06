import { LuxDatabase } from '../../db/index.js';
import { idPortability } from '../associations/federation.js';
import {
  resolveSiblings,
  siblingFaultRefusal,
  siblingFreshness,
  type SiblingRefusal,
} from '../siblings.js';
import { walkDownstream, type DownstreamBudget } from './downstream.js';
import type { CrossRepoImpact, CrossRepoSiblingImpact, DeltaTouchSet } from './types.js';

/**
 * Cross-repo impact (Decision 9): for each `--against` sibling, which of its entry surfaces this
 * primary-side diff affects. Portable touched ids seed an in-engine intersection (the cheap
 * filter), then the shipped walkDownstream runs in the sibling's graph via openSiblingReadOnly.
 * Read-only toward every sibling; per-sibling degradation (Decision 6) — refusals are returned so
 * the caller can warn (analysis) or fail (--check).
 */
export function computeCrossRepoImpact(
  primary: LuxDatabase,
  corpusPath: string,
  touch: DeltaTouchSet,
  againstNames: string[],
  budget: DownstreamBudget
): { impact: CrossRepoImpact; refusals: SiblingRefusal[] } {
  const primarySchema = primary.getAppliedSchemaVersion();
  // `all` expands to every registered sibling (mirrors the documented --against name[,…]|all + the
  // trace/search/MCP 'all' handling); a literal name list resolves each independently.
  const wanted = againstNames.includes('all') ? ('all' as const) : againstNames;
  const resolutions = resolveSiblings(corpusPath, wanted, primarySchema);

  // Portable seed set (Decision 2/9): namespace-qualified FQCNs always; http surfaces are
  // portable-kernel-only (kept here, filtered per-sibling by role below); bare-name PHP +
  // path-relative are repo-local and never seed a cross-repo walk.
  // Seeded like the primary walk, from the changed symbols (file nodes among the seeds are
  // repo-local and drop out here).
  const portableSeeds = touch.walkSeeds.filter((id) => idPortability(id) !== 'repo-local');

  const siblings: CrossRepoSiblingImpact[] = [];
  const refusals: SiblingRefusal[] = [];

  for (const r of resolutions) {
    if ('refusal' in r) {
      siblings.push({ name: r.name, attached: false, refusal: r.refusal.message });
      refusals.push(r.refusal);
      continue;
    }
    const s = r.sibling;
    // Seed split by role: a peer bridges only on strictly-`portable` ids (namespace-qualified
    // FQCNs); a role:kernel sibling uses the wider `portableSeeds` set, which also admits the
    // portable-kernel-only ids (`surface:http:` routes) — the portable-kernel-only law. NB: a real
    // delta `touch.symbolIds` carries symbol ids only (declared surfaces live in `surfacesDeclared`,
    // not here), so the http-surface widening is a latent, by-design path — exercised directly by
    // the portable-seed-law unit test, dormant for an ordinary primary-side diff.
    const seeds =
      s.role === 'kernel'
        ? portableSeeds
        : portableSeeds.filter((id) => idPortability(id) === 'portable');

    // One read-only handle per sibling: the cheap in-engine intersection (the filter) AND the walk
    // both run on it, opened + closed in a finally. No ATTACH onto the primary — see
    // LuxDatabase.siblingNodeIntersection for why (the MCP prior-write DETACH deadlock).
    //
    // FIX 1 (per-sibling fault isolation): open+intersection+walk run here, AFTER resolve. A fault in
    // any of them — a TOCTOU delete/re-index between resolve and open, a cross-process busy-timeout
    // (the sibling being `lux index rebuild`-written), or a file that passed resolve but faults on
    // re-open — must degrade THIS sibling (close its handle, synthesize the same refusal a
    // resolve-time failure yields, push it to `refusals` so `--check` still exits nonzero — SC-8)
    // and continue, not abort the whole federated call. The `finally` closes the handle on every
    // path, so no handle leaks on a mid-batch throw.
    let sibDb: LuxDatabase | undefined;
    try {
      sibDb = LuxDatabase.openSiblingReadOnly(s.dbPath, primarySchema);
      const matched = sibDb.siblingNodeIntersection(seeds);
      if (matched.length === 0) {
        siblings.push({
          name: s.name,
          attached: true,
          freshness: siblingFreshness(s),
          seedsTotal: seeds.length,
          seedsMatched: 0,
          entrySurfaces: [],
          asyncBoundaries: [],
          budget: { depth: budget.depth, maxNodes: budget.maxNodes, truncated: false },
        });
        continue;
      }
      const walk = walkDownstream(sibDb, matched, budget);
      siblings.push({
        name: s.name,
        attached: true,
        freshness: siblingFreshness(s),
        seedsTotal: seeds.length,
        seedsMatched: matched.length,
        entrySurfaces: walk.entrySurfaces,
        asyncBoundaries: walk.asyncBoundaries,
        budget: { depth: budget.depth, maxNodes: budget.maxNodes, truncated: walk.truncated },
      });
    } catch (error) {
      // lux-intentional-swallow: returned to the caller as a refusal, which reports it.
      const refusal = siblingFaultRefusal(s.name, error);
      siblings.push({ name: s.name, attached: false, refusal: refusal.message });
      refusals.push(refusal);
    } finally {
      sibDb?.close();
    }
  }

  return { impact: { siblings }, refusals };
}
