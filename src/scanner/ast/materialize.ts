// AST symbol materialization into the structural overlay (Phase 4).
//
// Persists `symbol` StructuralNodes derived from tree-sitter for every source
// file, so the overlay has symbol nodes even when LSP enrichment is absent.
// Gated by lux.yaml `ast.enabled`; invoked from rebuildStructuralOverlay before
// the association engine runs, so the AST resolver's edges reference real nodes.

import { ROWS_PER_COMMIT, writeInChunks, type LuxDatabase } from '../../db/index.js';
import type { ScanResult } from '../types.js';
import type { StructuralNode } from '../../db/types.js';
import {
  astLanguageId,
  extractSource,
  getGrammars,
  langForFile,
  type Extraction,
} from './extract.js';
import type { SharedExtractions } from './extraction-cache.js';
import { buildAstSymbolNodes } from './symbols.js';
import { buildAnchorTexts, type PreparedNodeText } from '../anchors/prepare-node-text.js';
import type { WarnFn } from '../reporter.js';
import type { SymbolIdCollisions } from '../identity/symbol-collisions.js';

/**
 * Extract and persist AST symbol nodes for all source-code files in a scan.
 *
 * A parse failure on one file is isolated (logged, skipped) so a single
 * pathological source cannot abort materialization of the rest.
 *
 * @param extractions - Shared per-rebuild extraction cache (Lever D). When
 *   provided, files are read from it instead of re-parsed; a file absent from
 *   the cache (parse failure upstream) is skipped, matching the isolation the
 *   standalone parse path applies.
 * @param collisions - Symbol ids more than one file declares; those are file-qualified.
 * @returns The number of distinct symbol nodes materialized.
 */
export async function materializeAstSymbols(
  db: LuxDatabase,
  scan: ScanResult,
  rootPath: string,
  now: number,
  extractions?: SharedExtractions,
  onWarn?: WarnFn,
  collisions?: SymbolIdCollisions
): Promise<number> {
  // Only parse on demand when no shared cache was supplied.
  const grammars = extractions ? null : await getGrammars();
  const seen = new Set<string>();
  const nodes: StructuralNode[] = [];
  const anchorTexts: PreparedNodeText[] = [];

  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code' || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;

    const relPath = toRelative(entry.filePath, rootPath);
    let extraction: Extraction;
    if (extractions) {
      const cached = extractions.get(relPath);
      if (!cached) continue; // absent from the shared cache — isolated upstream
      extraction = cached;
    } else {
      try {
        extraction = extractSource(grammars!, entry.content, relPath, lang).extraction;
      } catch (error) {
        onWarn?.(
          `AST symbol extraction failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
          `ast-file:${relPath}`
        );
        continue;
      }
    }
    const symbolNodes = buildAstSymbolNodes(relPath, extraction, lang, now, collisions);
    // Force the persisted-language contract at this boundary as well as in the
    // symbol builder; JS/JSX share a grammar but must never be labeled TypeScript.
    const languageId = astLanguageId(lang);
    nodes.push(...symbolNodes.map((node) => ({ ...node, language_id: languageId })));
    // Anchor prep (Decision 5): the extraction's byte ranges + entry.content are both in hand HERE
    // and nowhere downstream — buildAnchorTexts renders one prepared unit per anchor-viable node.
    anchorTexts.push(...buildAnchorTexts(relPath, extraction, lang, entry.content, collisions));
  }

  // Batch the upserts (Lever E) in bounded transactions, so the many small commits become a few
  // without one transaction holding the file lock for the whole pass.
  // A failure stops the pass with the rows before it committed, and the error says how far it got.
  let count = 0;
  const nodesWritten = writeInChunks(db, nodes, ROWS_PER_COMMIT, (node) => {
    db.upsertStructuralNode(node);
    if (!seen.has(node.id)) {
      seen.add(node.id);
      count++;
    }
  });
  if (nodesWritten.error) {
    throw new Error(
      `AST symbol materialization stopped after ${nodesWritten.committed} of ${nodes.length} ` +
        `symbol nodes: ${nodesWritten.error.message}`,
      { cause: nodesWritten.error }
    );
  }
  // Anchor texts second — the FTS join needs the node row to exist. One row per anchor-viable node
  // (Decision 6); a re-materialised same-id node REPLACEs its text + rewrites its FTS row, so a
  // changed body/signature under a stable id yields a fresh content_hash the Phase-3 queue detects.
  const textsWritten = writeInChunks(db, anchorTexts, ROWS_PER_COMMIT, (text) => {
    db.upsertNodeAnchorText({
      node_id: text.nodeId,
      prepared: text.embedText,
      content_hash: text.contentHash,
      name: text.fields.name,
      identifiers: text.fields.identifiers,
      qualified: text.fields.qualified,
      path_segments: text.fields.pathSegments,
      context: text.fields.context,
    });
  });
  if (textsWritten.error) {
    throw new Error(
      `anchor-text materialization stopped after ${textsWritten.committed} of ` +
        `${anchorTexts.length} anchor texts: ${textsWritten.error.message}`,
      { cause: textsWritten.error }
    );
  }

  return count;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
