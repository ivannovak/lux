import { realpathSync } from 'fs';
import { join } from 'path';
import { packageToSiblingName, resolveSibling, SiblingResolveError } from '../siblings.js';
import { getHeadCommit } from '../git.js';
import type { KernelOverlayConfig } from '../config.js';

/**
 * A resolved cross-area kernel: the sibling area (a composer path-repo the client vendors)
 * whose already-built `.lux` index is joined read-only for ownership classification (#62).
 * Unchanged public shape — the ownership map's contract.
 */
export interface ResolvedKernel {
  /** `<worktree>/.lux/lux.db` — the kernel's built index. */
  dbPath: string;
  /** `realpath(<corpus>/vendor/<package>)` — the kernel worktree the client actually vendors. */
  worktree: string;
  /** The kernel's root PHP namespace (e.g. `Acme\\Core`), from its composer.json. */
  namespace: string;
  /** The kernel index's `last_indexed_commit`, if recorded. */
  indexedCommit?: string;
  /** The vendored worktree's current git HEAD (for the drift check). */
  headCommit?: string;
}

/**
 * Resolve the kernel from `vendor/<package>` via the general sibling resolver, as a `role: kernel`
 * entry. Fail-loud with the shipped `Cross-area overlay:` messages so `overlay ownership --kernel`
 * behaves identically (Decision 1 sugar). An `override` must equal the vendored worktree realpath.
 */
export function resolveKernel(
  corpusPath: string,
  cfg: KernelOverlayConfig,
  override?: string
): ResolvedKernel {
  let sib;
  try {
    sib = resolveSibling(corpusPath, packageToSiblingName(cfg.package), {
      package: cfg.package,
      role: 'kernel',
    });
  } catch (error) {
    if (error instanceof SiblingResolveError) {
      throw new Error(kernelMessage(error, cfg, corpusPath), { cause: error });
    }
    throw error;
  }

  if (override) {
    let overrideReal: string;
    try {
      overrideReal = realpathSync(override);
    } catch {
      throw new Error(`Cross-area overlay: --kernel path not found: ${override}`);
    }
    if (overrideReal !== sib.worktree) {
      throw new Error(
        `Cross-area overlay: --kernel (${overrideReal}) disagrees with the vendored kernel (${sib.worktree}).`
      );
    }
  }

  if (!sib.worktree) {
    throw new Error(
      `Cross-area overlay: kernel '${cfg.package}' has no worktree to classify against.`
    );
  }
  if (!sib.namespace) {
    throw new Error(
      `Cross-area overlay: could not resolve the kernel namespace from ${sib.worktree}/composer.json.`
    );
  }
  return {
    dbPath: sib.dbPath,
    worktree: sib.worktree,
    namespace: sib.namespace,
    indexedCommit: sib.indexedCommit,
    headCommit: sib.headCommit,
  };
}

/** Translate the generic sibling refusal back to the shipped kernel-area error strings. */
function kernelMessage(
  e: SiblingResolveError,
  cfg: KernelOverlayConfig,
  corpusPath: string
): string {
  switch (e.reason) {
    case 'worktree-missing':
      return `Cross-area overlay: vendor/${cfg.package} not found under ${corpusPath} — expected a symlinked path-repo kernel.`;
    case 'db-absent': {
      // FIX 3: restore the shipped `(${worktree}${at})` suffix (worktree realpath + ` @ <7-char
      // HEAD>`) that the sibling-resolver refactor dropped. resolveSibling threw before returning a
      // ResolvedSibling, so recompute the way main did: realpath(vendor/<package>) — already
      // known-resolvable here, since worktree-missing is a distinct earlier refusal — plus git HEAD.
      const worktree = realpathSync(join(corpusPath, 'vendor', cfg.package));
      let at: string;
      try {
        at = ` @ ${getHeadCommit(worktree).slice(0, 7)}`;
      } catch {
        // lux-intentional-swallow: only decorates a message with the kernel's commit; it is omitted when unknown.
        at = '';
      }
      return `Cross-area overlay: the kernel you vendor (${worktree}${at}) has no Lux index — run \`lux index rebuild\` there first.`;
    }
    default:
      return e.message;
  }
}
