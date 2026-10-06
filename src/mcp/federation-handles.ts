import { LuxDatabase } from '../db/index.js';
import {
  buildFederationBlock,
  resolveSiblings,
  siblingFaultRefusal,
  type SiblingResolution,
} from '../scanner/siblings.js';

export interface OpenedFederation {
  handles: Array<{ name: string; role: 'kernel' | 'peer'; db: LuxDatabase }>;
  federation: ReturnType<typeof buildFederationBlock>;
  close: () => void;
}

/**
 * Resolve `with`/`against` names → open read-only sibling handles + the federation block (Decision 5).
 * Refusals surface in the block (attached:false); the caller warns, never silently drops. The caller
 * MUST invoke close() in a finally — sibling `.lux` handles are read-only (SC-7).
 *
 * FIX 1 (per-sibling fault isolation): opening a resolved sibling runs AFTER resolve, and the
 * long-lived MCP server has no per-request process to reap leaked handles. A post-resolve open fault
 * (a TOCTOU delete/re-index, a cross-process busy-timeout from a concurrent `lux index rebuild`, or a
 * file that passed resolve but faults on re-open) must degrade THAT sibling — not throw out of the
 * loop and leak every handle already opened in the batch. Matching the CLI's graceful degrade, the
 * faulted sibling's resolution is rewritten to a refusal so the federation block stays consistent
 * (attached:false + reason), and the loop continues with the healthy handles. Because the loop never
 * throws, the returned `close()` is always constructed and closes every opened handle.
 *
 * Extracted from the server module so this pure resolve/open logic is unit-testable (the server entry
 * connects stdio at import time and cannot be imported into a test).
 */
export function openFederationHandles(
  primary: LuxDatabase,
  corpusPath: string,
  names: string[]
): OpenedFederation {
  const primarySchema = primary.getAppliedSchemaVersion();
  const resolutions = resolveSiblings(
    corpusPath,
    names.includes('all') ? 'all' : names,
    primarySchema
  );
  const handles: Array<{ name: string; role: 'kernel' | 'peer'; db: LuxDatabase }> = [];
  const effectiveResolutions: SiblingResolution[] = [];
  for (const r of resolutions) {
    if (!('sibling' in r)) {
      effectiveResolutions.push(r);
      continue;
    }
    try {
      const handle = LuxDatabase.openSiblingReadOnly(r.sibling.dbPath, primarySchema);
      handles.push({ name: r.sibling.name, role: r.sibling.role, db: handle });
      effectiveResolutions.push(r);
    } catch (error) {
      // lux-intentional-swallow: returned to the caller as a refusal, which reports it.
      effectiveResolutions.push({
        name: r.sibling.name,
        refusal: siblingFaultRefusal(r.sibling.name, error),
      });
    }
  }
  return {
    handles,
    federation: buildFederationBlock(effectiveResolutions),
    close: () => {
      for (const h of handles) h.db.close();
    },
  };
}
