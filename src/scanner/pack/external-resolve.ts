// Map an LSP definition location that lands OUTSIDE the scanned corpus (in
// vendor/) to the id of a merged vendor-pack symbol node, or null (ADR-3 / REQ-1).
//
// The vendor pack was built by running THIS extractor over vendor/, so
// re-extracting the resolved file and computing astSymbolIdentity() reproduces
// the same `symbol:php:<FQN>` id the pack materialized — PHP identity is
// path-independent (symbols.ts:38-47), so it matches regardless of where vendor/
// sits on disk. We confirm the node is present AND external before returning, so
// boundary edges never dangle onto a symbol the pack does not contain.

import { readFileSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { extractSource, getGrammars, langForFile } from '../ast/extract.js';
import { astSymbolIdentity } from '../ast/symbols.js';
import type { ExternalTargetResolver } from '../ast/lsp-resolve.js';

interface VendorDef {
  id: string;
  startLine: number; // 1-based (matches extract.ts AstRange)
  endLine: number;
  startByte: number;
  endByte: number;
}

/**
 * Extract the symbol defs of a vendor PHP file, keyed by the same
 * path-independent `symbol:php:<FQN>` ids the pack materialized. Returns null for
 * an unreadable/unparseable file (drop, as before).
 */
async function extractVendorDefs(
  absFilePath: string,
  rootPath: string
): Promise<VendorDef[] | null> {
  try {
    const grammars = await getGrammars();
    const source = readFileSync(absFilePath, 'utf-8');
    const rel = absFilePath.startsWith(rootPath + '/')
      ? absFilePath.slice(rootPath.length + 1)
      : absFilePath;
    const { extraction } = extractSource(grammars, source, rel, 'php');
    return extraction.nodes.map((def) => {
      const { id } = astSymbolIdentity(rel, def, 'php', extraction.namespace);
      return {
        id,
        startLine: def.range.startLine,
        endLine: def.range.endLine,
        startByte: def.range.startByte,
        endByte: def.range.endByte,
      };
    });
  } catch {
    // lux-intentional-swallow: an unresolvable vendor target is left unresolved, as a miss.
    return null;
  }
}

/**
 * Build an {@link ExternalTargetResolver} bound to the merged overlay. Caches
 * per-file extraction so repeated resolutions into the same vendor file parse
 * once. Vendor packs are PHP-only (portable FQN identity — `node_modules` is out
 * of scope), so non-PHP targets stay dropped.
 */
export function makeExternalTargetResolver(
  db: LuxDatabase,
  rootPath: string
): ExternalTargetResolver {
  const cache = new Map<string, VendorDef[] | null>();

  return async (absFilePath, line0, memberName) => {
    if (langForFile(absFilePath) !== 'php') return null;

    let defs = cache.get(absFilePath);
    if (defs === undefined) {
      defs = await extractVendorDefs(absFilePath, rootPath);
      cache.set(absFilePath, defs);
    }
    if (!defs) return null;

    // Smallest def (by byte span) whose 1-based line range contains the target.
    // Byte span separates a method from its enclosing class when both share a line.
    const target1 = line0 + 1;
    let best: VendorDef | undefined;
    let bestSize = Infinity;
    for (const d of defs) {
      if (d.startLine <= target1 && target1 <= d.endLine) {
        const size = d.endByte - d.startByte;
        if (size < bestSize) {
          best = d;
          bestSize = size;
        }
      }
    }
    if (!best) return null;

    // When we landed on a CLASS but the call names a member, recover
    // `<class>::<member>`: intelephense returns a method's docblock line, which
    // sits in the gap before the method's node range, so line containment lands
    // on the enclosing class instead of the method (REQ-1 granularity).
    let targetId = best.id;
    if (memberName && !best.id.includes('::')) {
      const methodId = `${best.id}::${memberName}`;
      if (defs.some((d) => d.id === methodId)) targetId = methodId;
    }

    // Confirm the pack actually materialized this symbol as an external node, so
    // no boundary edge is emitted to a symbol the pack does not contain.
    const node = db.getStructuralNode(targetId);
    if (!node || !LuxDatabase.isExternalNode(node)) return null;
    return targetId;
  };
}
