// The id-portability law — the correctness contract of cross-repo federation (Decisions 2, 3).
//
// A portable id is ONE logical node across the federation; a repo-local id is N distinct nodes that
// must never merge or be walked across. Getting the classifier wrong does not merely miss joins — it
// FABRICATES them (two repos' `file:routes/web.php` silently fused), a false structural claim the
// substrate must never emit. The PHP `\` test is the crux: the id builders fall back to the bare
// short name when no namespace resolves (`astSymbolIdentity` → `phpSymbolNodeId(qualifiedName ??
// def.name)`, ast/symbols.ts:46; materializer.ts:124, `?? symbol.name`), so a global-namespace
// `symbol:php:helper` collides across repos exactly like a path-relative id.

import { isFileQualifiedSymbolId } from '../identity/symbol-collisions.js';

/** A repo in the federation frontier. `main` is the primary; siblings carry their registry role. */
export type FederationRole = 'primary' | 'kernel' | 'peer';

export interface FederationRepo {
  /** 'main' for the primary, else the sibling registry name. */
  name: string;
  role: FederationRole;
}

export type IdPortability = 'portable' | 'portable-kernel-only' | 'repo-local';

/**
 * Classify a node id's cross-repo portability (Decision 2). The ONLY law that lets an id bridge a
 * repo boundary.
 *   - portable: namespace-qualified PSR-4 FQCN (repo-independent, verified byte-stable). The `\`
 *     test is load-bearing — the id builders fall back to the bare short name when no namespace
 *     resolves (symbols.ts:46 / materializer.ts:124), and a global-namespace `symbol:php:<bareName>`
 *     collides across repos.
 *   - portable-kernel-only: an HTTP surface id names one URL space only within a shared assembly
 *     (kernel/client) — bridged only toward the single role:kernel sibling.
 *   - repo-local: bare-name symbol:php:*, file-qualified symbol ids (`<id>#file:<rel>`, a name
 *     the repo declares in more than one file), file:<rel>, symbol:ts:<rel>#<name>, non-http
 *     surfaces, contract:*, operational ids — never bridged (bridging would fabricate joins).
 */
export function idPortability(nodeId: string): IdPortability {
  if (isFileQualifiedSymbolId(nodeId)) return 'repo-local';
  if (nodeId.startsWith('symbol:php:') && nodeId.includes('\\')) return 'portable';
  if (nodeId.startsWith('surface:http:')) return 'portable-kernel-only';
  return 'repo-local';
}

/** True for the primary or the one role:kernel sibling — the shared-URL-space set. */
export function isKernelSet(repo: FederationRepo): boolean {
  return repo.role === 'primary' || repo.role === 'kernel';
}

/**
 * The visited/merge key for `(repo, nodeId)` under the three-class law (Decision 3):
 *   - portable            → bare id, globally (one logical node across the federation);
 *   - portable-kernel-only → bare id within {primary ∪ role:kernel}, (repo,id) toward peers;
 *   - repo-local          → (repo, id) throughout.
 * The separator is `\0` (NUL). NUL cannot occur in any node id, so `(repo,id)` keys provably never
 * collide with a bare id or with each other. A space would NOT be safe here: node ids DO contain
 * spaces (e.g. `file:my file.ts`, or a spaced PHP short name), so a space-joined key could
 * re-parse ambiguously — NUL is the only separator with the injectivity the false-merge guard needs.
 */
export function federationKey(repo: FederationRepo, nodeId: string): string {
  const portability = idPortability(nodeId);
  if (portability === 'portable') return nodeId;
  if (portability === 'portable-kernel-only') {
    return isKernelSet(repo) ? nodeId : `${repo.name}\0${nodeId}`;
  }
  return `${repo.name}\0${nodeId}`;
}

/**
 * May a node with `nodeId` be resolved/expanded in `target` when it is homed in `home`? The walk
 * uses this to decide which repos to fetch out-edges from (spec 13).
 *   - same repo            → always;
 *   - portable             → any repo;
 *   - portable-kernel-only → only within {primary ∪ role:kernel};
 *   - repo-local           → never crosses.
 */
export function idBridges(nodeId: string, home: FederationRepo, target: FederationRepo): boolean {
  if (home.name === target.name) return true;
  switch (idPortability(nodeId)) {
    case 'portable':
      return true;
    case 'portable-kernel-only':
      return isKernelSet(home) && isKernelSet(target);
    case 'repo-local':
      return false;
  }
}
