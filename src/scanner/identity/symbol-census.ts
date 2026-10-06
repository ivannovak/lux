// The declaration census a rebuild takes before it writes any symbol node: every symbol id each
// file would produce, through the same builders the two symbol materializers use (LSP and AST).
// Its result decides which ids are file-qualified (identity/symbol-collisions.ts).

import type { ScanResult } from '../types.js';
import type { EnrichmentMap } from '../lsp/index.js';
import type { SharedExtractions } from '../ast/extraction-cache.js';
import { extractSource, getGrammars, langForFile, type Extraction } from '../ast/extract.js';
import { buildSymbolNodes } from '../associations/materializer.js';
import {
  astDeclarations,
  SymbolIdCollisions,
  type SymbolDeclaration,
} from './symbol-collisions.js';

export interface SymbolCensusInput {
  scan: ScanResult;
  enrichments: EnrichmentMap;
  rootPath: string;
  /** Whether the AST symbol tier will materialize nodes (lux.yaml `ast.enabled`). */
  astEnabled: boolean;
  /** The shared extraction cache; absent ⇒ files are parsed here, as the materializer would. */
  extractions?: SharedExtractions;
}

/** Every symbol declaration the materializers would write, in bare-id form. */
export async function collectSymbolDeclarations(
  input: SymbolCensusInput
): Promise<SymbolDeclaration[]> {
  const { scan, enrichments, rootPath, astEnabled, extractions } = input;
  const grammars = astEnabled && !extractions ? await getGrammars() : null;
  const declarations: SymbolDeclaration[] = [];

  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code') continue;
    const relPath = toRelative(entry.filePath, rootPath);

    const enrichment = enrichments.get(entry.filePath);
    if (enrichment && enrichment.symbols.length > 0) {
      for (const node of buildSymbolNodes(entry.filePath, enrichment, rootPath, entry.content)) {
        declarations.push({ id: node.id, relPath });
      }
    }

    if (!astEnabled || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;
    let extraction: Extraction | undefined;
    if (extractions) {
      extraction = extractions.get(relPath);
    } else {
      try {
        extraction = extractSource(grammars!, entry.content, relPath, lang).extraction;
      } catch {
        // lux-intentional-swallow: the AST materializer parses this file next, skips it the same way and reports the failure.
        extraction = undefined;
      }
    }
    if (extraction) declarations.push(...astDeclarations(relPath, extraction, lang));
  }

  return declarations;
}

/** The collision set for one rebuild's scan. */
export async function buildSymbolIdCollisions(
  input: SymbolCensusInput
): Promise<SymbolIdCollisions> {
  return SymbolIdCollisions.fromDeclarations(await collectSymbolDeclarations(input));
}

function toRelative(absolutePath: string, rootPath: string): string {
  return absolutePath.startsWith(rootPath + '/')
    ? absolutePath.slice(rootPath.length + 1)
    : absolutePath;
}
