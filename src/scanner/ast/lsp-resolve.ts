// Typed-receiver cross-file resolution via LSP (Step 2 of cross-file resolution).
//
// Resolves the call edges AST cannot settle syntactically — `db.method()` /
// `$service->method()`, where the callee's owner is a typed value whose type
// only LSP knows. Each such callee token is resolved with `textDocument/definition`
// (deduped per distinct `receiver.method` to bound request volume — the arm-D
// efficiency), and the target location is mapped back to a symbol node via the
// same extractions.
//
// These are the AST tier's only `proven` edges — they are LSP-confirmed. Runs as
// a dedicated pass while the LSP registry is still alive (see general.ts). Per
// CANONICAL-DECISIONS §8 this stays a DISTINCT pass AFTER materialization (so
// Phase 3 can insert its step-8a merge before it), but is upgraded here to run
// its per-file loop under a bounded pool + one warm document open per file
// (Lever B) and to consume the shared per-rebuild extraction cache (Lever D).

import { realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { StructuralRelationEdge } from '../associations/types.js';
import {
  extractSource,
  getGrammars,
  langForFile,
  type AstLang,
  type Extraction,
} from './extract.js';
import type { SharedExtractions } from './extraction-cache.js';
import { mapWithConcurrency } from '../lsp/pool.js';
import { astSymbolIdentity } from './symbols.js';

/** On-demand definition resolver: (absFile, 0-based line, 0-based char) -> target. */
export type ResolveDefinition = (
  filePath: string,
  line: number,
  character: number
) => Promise<{ filePath: string; line: number } | null>;

/**
 * Warm batch resolver: resolve every call-site position in one file under a
 * single document open. Result order matches the input positions.
 */
export type ResolveDefinitionsInFile = (
  filePath: string,
  positions: Array<{ line: number; character: number }>
) => Promise<Array<{ filePath: string; line: number } | null>>;

/**
 * Resolve an LSP definition location that lands OUTSIDE the scanned corpus
 * (in `vendor/`) to the id of a merged vendor-pack symbol node, or null. This is
 * what turns the app→vendor boundary from a drop into a `proven` edge (ADR-3 /
 * REQ-1). Defined here (the ast layer) so `resolveOne`/`mapLocToTarget` can type
 * it without importing the pack layer; the implementation lives in
 * `src/scanner/pack/external-resolve.ts`. When omitted, out-of-corpus targets are
 * dropped exactly as before.
 */
export type ExternalTargetResolver = (
  absFilePath: string,
  line0: number,
  memberName?: string
) => Promise<string | null>;

/** Optional upgrades to the typed-receiver pass (Levers B + D; + boundary resolution). */
export interface TypedReceiverResolveOptions {
  /**
   * Preferred per-file resolver: opens each document once and resolves all of
   * its call-sites warm (Lever B). Falls back to per-position `resolveDefinition`
   * when omitted, preserving the original open-per-call behaviour.
   */
  resolveInFile?: ResolveDefinitionsInFile;
  /** Shared per-rebuild extraction cache (Lever D) — skips re-parsing. */
  sharedExtractions?: SharedExtractions;
  /** Max files resolved concurrently (Lever B pool). Default 1 (serial). */
  concurrency?: number;
  /**
   * Resolve out-of-corpus (vendor) definition targets to merged vendor-pack
   * nodes, emitting the `proven` app→vendor boundary edge instead of dropping it
   * (ADR-3 / REQ-1). Supplied only when a vendor pack is merged.
   */
  resolveExternalTarget?: ExternalTargetResolver;
}

/** Confidence for LSP-confirmed cross-file edges. */
const LSP_CONFIDENCE = 0.9;

interface FileRec {
  relPath: string;
  absPath: string;
  lang: AstLang;
  extraction: Extraction;
}

interface DefRange {
  id: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

/** A collected typed-receiver call-site awaiting LSP resolution. */
interface CallSite {
  /** `${source.id}::${toRaw}` — the per-(scope+receiver) correlation key. */
  key: string;
  sourceId: string;
  /** 0-based token position handed to LSP. */
  line: number;
  character: number;
  /** Receiver expression as written (evidence note). */
  toRaw: string;
  /** 1-based line of the call expression (evidence line). */
  startLine: number;
}

/**
 * Resolve typed-receiver cross-file calls to `proven` `calls` edges via LSP.
 *
 * @param entries - Source files with their content (absolute paths).
 * @param resolveDefinition - Per-position LSP resolver (used when
 *   `options.resolveInFile` is omitted).
 * @param options - Levers B (`resolveInFile` + `concurrency`) and D
 *   (`sharedExtractions`) upgrades. Omitting all of them preserves the original
 *   serial, re-parsing, open-per-call behaviour (kept for tests).
 */
export async function resolveTypedReceiverEdges(
  entries: Array<{ filePath: string; content: string }>,
  rootPath: string,
  resolveDefinition: ResolveDefinition,
  now: number,
  options?: TypedReceiverResolveOptions
): Promise<StructuralRelationEdge[]> {
  const shared = options?.sharedExtractions;
  const resolveExternalTarget = options?.resolveExternalTarget;
  // Only load grammars when we have to parse ourselves.
  const grammars = shared ? null : await getGrammars();

  const files: FileRec[] = [];
  const symbolIds = new Set<string>();
  const defRangesByRel = new Map<string, DefRange[]>();

  for (const entry of entries) {
    const lang = langForFile(entry.filePath);
    if (!lang) continue;
    const relPath = toRelative(entry.filePath, rootPath);
    let extraction: Extraction;
    if (shared) {
      const cached = shared.get(relPath);
      if (!cached) continue; // absent from the shared cache — isolated upstream
      extraction = cached;
    } else {
      extraction = extractSource(grammars!, entry.content, relPath, lang).extraction;
    }
    files.push({ relPath, absPath: entry.filePath, lang, extraction });
    const ranges = extraction.nodes.map((def) => ({
      id: astSymbolIdentity(relPath, def, lang, extraction.namespace).id,
      startByte: def.range.startByte,
      endByte: def.range.endByte,
      startLine: def.range.startLine,
      endLine: def.range.endLine,
    }));
    defRangesByRel.set(relPath, ranges);
    for (const r of ranges) symbolIds.add(r.id);
  }

  // Prefer the warm per-file batch resolver (one document open per file). Fall
  // back to per-position resolveDefinition (open-per-call) when not supplied.
  const resolveInFile: ResolveDefinitionsInFile =
    options?.resolveInFile ??
    (async (filePath, positions) => {
      const out: Array<{ filePath: string; line: number } | null> = [];
      for (const p of positions) {
        out.push(await resolveDefinition(filePath, p.line, p.character));
      }
      return out;
    });

  const edges: StructuralRelationEdge[] = [];
  const seenEdge = new Set<string>();

  // Example Dashboardcile symlinked paths before keying resolved targets. A composer path-repo
  // kernel resolves through `vendor/<pkg>` (a directory symlink), while the scan
  // keyed those files by their realpath (`resolveFirstPartyRoots`), so the language
  // server's symlink-path definition and the scan's realpath key never match and
  // the edge is dropped. Canonicalize the RESOLVED side to the realpath form the
  // scan already uses — at the two read consumers only (never inside `toRelative`,
  // which also keys the scan side). Memoized on the directory (only the package-root
  // component `vendor/<pkg>` is expected to be symlinked, not the leaf file; a leaf
  // or nested-subdir symlink below the root would simply drop, never mis-map, since
  // the scan keys only the realpath'd package root). Degrades to the raw path on a
  // broken symlink so the pass never throws.
  const realDirCache = new Map<string, string>();
  const canonPath = (p: string): string => {
    const dir = dirname(p);
    let realDir = realDirCache.get(dir);
    if (realDir === undefined) {
      try {
        realDir = realpathSync(dir);
      } catch {
        // lux-intentional-swallow: a path that cannot be canonicalized is used as written.
        realDir = dir;
      }
      realDirCache.set(dir, realDir);
    }
    return join(realDir, basename(p));
  };
  // `rootPath` is constant across the pass — canonicalize once so a symlinked corpus
  // prefix can't mis-key in-root files against the canonicalized resolved paths.
  let rootPathReal: string;
  try {
    rootPathReal = realpathSync(rootPath);
  } catch {
    // lux-intentional-swallow: a path that cannot be canonicalized is used as written.
    rootPathReal = rootPath;
  }

  await mapWithConcurrency(files, options?.concurrency ?? 1, async (f) => {
    const defs = defRangesByRel.get(f.relPath) ?? [];
    const langId = f.lang === 'php' ? 'php' : 'typescript';

    // Collect this file's distinct typed-receiver call-sites. Only member calls
    // (`obj.m()` / `$svc->m()`) reach LSP — identifier/`this` calls are settled
    // syntactically by the AST resolver, so routing them here would double-resolve.
    // Dedup per (enclosing scope + receiver expression): two identical receiver
    // expressions in the SAME function share a binding, but the same text in a
    // different function may be a different-typed value, so it stays distinct.
    const sites: CallSite[] = [];
    const seenKey = new Set<string>();
    for (const edge of f.extraction.edges) {
      if (edge.type !== 'call' || edge.callKind !== 'member' || !edge.nameRange) continue;
      const source = enclosingByByte(defs, edge.range.startByte);
      if (!source) continue;
      const key = `${source.id}::${edge.toRaw}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      sites.push({
        key,
        sourceId: source.id,
        line: edge.nameRange.startLine - 1,
        character: edge.nameRange.startColumn,
        toRaw: edge.toRaw,
        startLine: edge.range.startLine,
      });
    }
    if (sites.length === 0) return;

    const locs = await resolveInFile(
      f.absPath,
      sites.map((s) => ({ line: s.line, character: s.character }))
    );

    // Resolve each call-site to a target id. In-corpus targets map synchronously;
    // an out-of-corpus (vendor) target is resolved to its merged vendor-pack node
    // via the async boundary resolver (ADR-3 / REQ-1). Both happen HERE, before
    // the synchronous emit stretch below — so that stretch keeps its no-await
    // invariant and the shared seenEdge check-and-set stays race-free.
    const targetIds: Array<string | null> = [];
    for (let i = 0; i < sites.length; i++) {
      const loc = locs[i];
      const memberName = memberLeafName(sites[i].toRaw);
      let targetId = mapLocToTarget(
        loc,
        rootPathReal,
        defRangesByRel,
        symbolIds,
        memberName,
        canonPath
      );
      if (
        !targetId &&
        loc &&
        resolveExternalTarget &&
        isOutOfCorpus(loc, rootPathReal, defRangesByRel, canonPath)
      ) {
        targetId = await resolveExternalTarget(loc.filePath, loc.line, memberName);
      }
      targetIds.push(targetId);
    }

    // Emit the edges. This synchronous stretch never awaits, so concurrent file
    // tasks cannot interleave the seenEdge check-and-set — the shared edge set
    // stays consistent.
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      const targetId = targetIds[i];
      if (!targetId || targetId === site.sourceId) continue;

      const id = `${site.sourceId}→${targetId}:calls:lsp`;
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      edges.push({
        id,
        edgeType: 'calls',
        sourceNodeId: site.sourceId,
        targetNodeId: targetId,
        sourceLanguage: langId,
        targetLanguage: langId,
        confidence: LSP_CONFIDENCE,
        confidenceClass: 'proven',
        provenance: {
          resolver: 'ast-structural',
          evidenceKind: 'ast-lsp-typed-receiver',
          evidenceLocations: [{ filePath: f.relPath, line: site.startLine, note: site.toRaw }],
          extractedAt: now,
        },
      });
    }
  });

  return edges;
}

/**
 * The called member's leaf name from a receiver expression: `save` from
 * `$x->save`, `make` from `$this->app->make`. Empty string when none (e.g. a bare
 * identifier), which callers treat as "no member name".
 */
export function memberLeafName(toRaw: string): string | undefined {
  const leaf = toRaw.split(/->|::/).pop()?.trim();
  return leaf ? leaf : undefined;
}

/**
 * Map an LSP definition location back to a scanned symbol id (or null).
 *
 * When the location lands on a CLASS (not a method) but the call names a member,
 * recover `<class>::<member>`: intelephense returns a method's docblock line,
 * which sits in the gap before the method's node range, so line containment
 * otherwise resolves to the enclosing class. `memberName` closes that gap.
 */
function mapLocToTarget(
  loc: { filePath: string; line: number } | null,
  rootPath: string,
  defRangesByRel: Map<string, DefRange[]>,
  symbolIds: Set<string>,
  memberName: string | undefined,
  canon: (p: string) => string
): string | null {
  if (!loc) return null;
  const targetRel = toRelative(canon(loc.filePath), rootPath);
  const trDefs = defRangesByRel.get(targetRel);
  if (!trDefs) return null; // target outside the scanned corpus (vendor / node_modules)
  const def = enclosingByLine(trDefs, loc.line + 1);
  if (!def) return null;
  if (memberName && !def.id.includes('::')) {
    const methodId = `${def.id}::${memberName}`;
    if (symbolIds.has(methodId)) return methodId;
  }
  return symbolIds.has(def.id) ? def.id : null;
}

/**
 * True when a resolved definition landed OUTSIDE the scanned corpus (its file is
 * not among the extracted app files) — i.e. in `vendor/` / `node_modules/`. This
 * distinguishes a boundary target (try the external resolver) from an in-corpus
 * target the AST simply could not map (do not).
 */
function isOutOfCorpus(
  loc: { filePath: string; line: number },
  rootPath: string,
  defRangesByRel: Map<string, DefRange[]>,
  canon: (p: string) => string
): boolean {
  return !defRangesByRel.has(toRelative(canon(loc.filePath), rootPath));
}

function enclosingByByte(defs: DefRange[], byte: number): DefRange | undefined {
  let best: DefRange | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.startByte <= byte && byte < d.endByte && d.endByte - d.startByte < bestSize) {
      best = d;
      bestSize = d.endByte - d.startByte;
    }
  }
  return best;
}

function enclosingByLine(defs: DefRange[], line: number): DefRange | undefined {
  // Among defs whose line span contains the target, pick the smallest by BYTE
  // span. Byte span (not line span) is what separates a method from its class
  // when both sit on the same line (`class A { run() {} }`), where a line-span
  // tie would otherwise pick the outer class.
  let best: DefRange | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.startLine <= line && line <= d.endLine) {
      const size = d.endByte - d.startByte;
      if (size < bestSize) {
        best = d;
        bestSize = size;
      }
    }
  }
  return best;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
