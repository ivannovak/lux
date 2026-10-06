// Structural node materializer.
//
// Converts scan results and LSP enrichment data into StructuralNode records
// and persists them to the DB. This is the step that populates the node table
// before the association engine can produce edges.
//
// Two node categories are materialized here:
//   - file   : one per indexed source code file
//   - symbol : top-level symbols from LSP enrichment results

import { FILES_PER_COMMIT, writeInChunks, type LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';
import type { ScanResult, ScannedKnowledge } from '../types.js';
import type { EnrichmentMap, EnrichmentResult } from '../lsp/index.js';
import { fileNodeId, phpSymbolNodeId, tsSymbolNodeId } from './types.js';
import { SymbolIdCollisions } from '../identity/symbol-collisions.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MaterializeResult {
  fileNodes: number;
  symbolNodes: number;
}

/**
 * Materialize and persist all structural nodes from a completed scan.
 *
 * Call this before running AssociationEngine so resolvers can reference
 * real node IDs that exist in the DB.
 *
 * @param db - Database to write nodes into.
 * @param scan - Completed scan result from GeneralScanner.
 * @param enrichments - LSP enrichment results keyed by absolute file path.
 * @param rootPath - Absolute repository root (used to compute relative paths).
 * @param collisions - Symbol ids more than one file declares; those are file-qualified.
 */
export function materializeNodes(
  db: LuxDatabase,
  scan: ScanResult,
  enrichments: EnrichmentMap,
  rootPath: string,
  collisions: SymbolIdCollisions = SymbolIdCollisions.NONE
): MaterializeResult {
  let fileNodes = 0;
  let symbolNodes = 0;

  // Bounded transactions: outside one, every upsert commits on its own, and under the rollback
  // journal each commit costs a journal create/sync/delete (issue #15).
  // A failure stops the pass with the files before it committed, and the error says how far it got.
  const sources = scan.knowledge.filter((entry) => entry.type === 'source-code');
  const written = writeInChunks(db, sources, FILES_PER_COMMIT, (entry) => {
    // File node — one per source file
    const fileNode = buildFileNode(entry, rootPath);
    db.upsertStructuralNode(fileNode);
    fileNodes++;

    // Symbol nodes — from LSP enrichment (may be absent for unenriched files)
    const enrichment = enrichments.get(entry.filePath);
    if (enrichment && enrichment.symbols.length > 0) {
      const symNodes = buildSymbolNodes(
        entry.filePath,
        enrichment,
        rootPath,
        entry.content,
        collisions
      );
      const seenIds = new Set<string>();
      for (const node of symNodes) {
        db.upsertStructuralNode(node);
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          symbolNodes++;
        }
      }
    }
  });
  if (written.error) {
    throw new Error(
      `file-node materialization stopped after ${written.committed} of ${sources.length} files: ` +
        written.error.message,
      { cause: written.error }
    );
  }

  return { fileNodes, symbolNodes };
}

// ---------------------------------------------------------------------------
// Node builders (exported for testing and CLI use)
// ---------------------------------------------------------------------------

/**
 * Build a file StructuralNode from a scanned knowledge entry.
 */
export function buildFileNode(entry: ScannedKnowledge, rootPath: string): StructuralNode {
  const relPath = toRelative(entry.filePath, rootPath);
  const fm = entry.frontmatter;
  const languageId = (fm?.language as string | undefined) ?? undefined;

  return {
    id: fileNodeId(relPath),
    node_type: 'file',
    file_path: relPath,
    language_id: languageId,
    updated_at: nowEpoch(),
  };
}

/**
 * Build symbol StructuralNodes from an enrichment result.
 * Only top-level symbols are materialized (no nested children).
 * Without `collisions` the ids are bare — the form the declaration census reads.
 */
export function buildSymbolNodes(
  absoluteFilePath: string,
  enrichment: EnrichmentResult,
  rootPath: string,
  fileContent?: string,
  collisions: SymbolIdCollisions = SymbolIdCollisions.NONE
): StructuralNode[] {
  const relPath = toRelative(absoluteFilePath, rootPath);
  const lang = enrichment.languageId;
  const nodes: StructuralNode[] = [];
  const ts = nowEpoch();

  // Use the PHP-enrichment-specific qualified name when available.
  // When enrichment only carries short PHP names, derive a file-local FQN from
  // the namespace declaration so duplicate controller/resource short names do
  // not collapse across namespaces.
  const ext = enrichment as unknown as Record<string, unknown>;
  const phpReferences = ext['references'] as
    Array<{ symbolName: string; symbolKind: number }> | undefined;
  const phpQualifiedNames = buildPhpQualifiedNameMap(
    enrichment.symbols.map((symbol) => symbol.name),
    phpReferences,
    fileContent
  );

  for (const symbol of enrichment.symbols) {
    const id = collisions.qualify(
      lang === 'php'
        ? phpSymbolNodeId(phpQualifiedNames.get(symbol.name) ?? symbol.name)
        : tsSymbolNodeId(relPath, symbol.name),
      relPath
    );

    nodes.push({
      id,
      node_type: 'symbol',
      file_path: relPath,
      language_id: lang,
      symbol_name: symbol.name,
      symbol_kind: symbol.kindLabel,
      qualified_name: phpQualifiedNames.get(symbol.name),
      updated_at: ts,
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a short-name → qualified-name map for PHP symbols.
 *
 * Preference order:
 *  1. Namespace declaration in the current file content, when available.
 *  2. Reference-derived names from PHP enrichment (best-effort fallback).
 */
function buildPhpQualifiedNameMap(
  symbolNames: string[],
  references?: Array<{ symbolName: string; symbolKind: number }>,
  fileContent?: string
): Map<string, string> {
  const map = new Map<string, string>();

  const namespace = extractPhpNamespace(fileContent);
  if (namespace) {
    for (const symbolName of symbolNames) {
      map.set(symbolName, `${namespace}\\${symbolName}`);
    }
    return map;
  }

  if (!references) return map;
  for (const ref of references) {
    map.set(ref.symbolName, ref.symbolName);
  }
  return map;
}

function extractPhpNamespace(fileContent?: string): string | undefined {
  if (!fileContent) return undefined;

  const match = /^\s*namespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*;/m.exec(fileContent);
  return match?.[1];
}
