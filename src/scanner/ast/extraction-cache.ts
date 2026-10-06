// Shared per-rebuild AST extraction cache (Lever D).
//
// Historically each source file was tree-sitter parsed THREE times per rebuild:
// once in materializeAstSymbols, once in AstStructuralResolver.resolve, and once
// in resolveTypedReceiverEdges. This cache parses every AST-eligible file exactly
// once; all three consumers read the returned map instead of re-parsing. Keyed by
// path relative to the scanned root, matching every consumer's `toRelative`.

import { isAbsolute, join } from 'node:path';

import type { SourceDiagnosticV1, SourceFactsV1 } from '../contracts/program.js';
import { DEFAULT_PARSER_LIMITS } from '../adapters/types.js';
import { sourceAdapterForLanguage, TREE_SITTER_PRODUCERS } from '../adapters/registry.js';
import { runBoundedExtractionWorker } from '../adapters/worker-host.js';
import type { ScanResult } from '../types.js';
import {
  astLanguageId,
  extractSource,
  getGrammars,
  langForFile,
  type Extraction,
} from './extract.js';
import { extractionToSourceFacts } from './source-facts.js';
import type { WarnFn } from '../reporter.js';

/** Extraction results for a rebuild, keyed by path relative to the scanned root. */
export type SharedExtractions = Map<string, Extraction>;

export interface SharedExtractionBuildV1 {
  extractions: SharedExtractions;
  facts: SourceFactsV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
  producersRun: Set<string>;
}

/**
 * Parse every AST-eligible source file exactly once for this rebuild. A parse
 * failure on one file is isolated (reported via `onWarn`, omitted from the cache)
 * so a single pathological source cannot abort the rest — each consumer then
 * skips the missing entry, matching its own parse-failure isolation.
 */
export async function buildSharedExtractionAnalysis(
  scan: ScanResult,
  rootPath: string,
  onWarn?: WarnFn
): Promise<SharedExtractionBuildV1> {
  const grammars = await getGrammars();
  const result: SharedExtractionBuildV1 = {
    extractions: new Map(),
    facts: [],
    dependencies: [],
    diagnostics: [],
    producersRun: new Set(),
  };

  let startFailure: string | undefined;
  let filesNotStarted = 0;
  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code' || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;

    const relPath = entry.filePath.startsWith(rootPath + '/')
      ? entry.filePath.slice(rootPath.length + 1)
      : entry.filePath;
    if (astLanguageId(lang) === 'javascript') {
      if (!sourceAdapterForLanguage('javascript')) {
        throw new Error('JavaScript source adapter is not registered');
      }
      const absolutePath = isAbsolute(entry.filePath)
        ? entry.filePath
        : join(rootPath, entry.filePath);
      const bounded = await runBoundedExtractionWorker({
        schemaVersion: 1,
        adapterId: TREE_SITTER_PRODUCERS.javascript,
        input: {
          corpusRoot: rootPath,
          allowedRoots: [rootPath],
          filePath: absolutePath,
          limits: { ...DEFAULT_PARSER_LIMITS },
        },
      });
      result.producersRun.add(TREE_SITTER_PRODUCERS.javascript);
      if (!bounded.response.ok) {
        const diagnostic: SourceDiagnosticV1 = {
          ...bounded.response.diagnostic,
          location: { filePath: relPath, line: 1, column: 0 },
        };
        result.diagnostics.push(diagnostic);
        if (diagnostic.code === 'start-timeout') {
          // One worker failing to start fails every file; that is one warning, made below.
          startFailure ??= diagnostic.message;
          filesNotStarted++;
        } else {
          onWarn?.(
            `AST extraction ${diagnostic.code} for ${relPath}: ${diagnostic.message}`,
            `ast-file:${relPath}`
          );
        }
        continue;
      }
      const facts = {
        ...bounded.response.output.facts,
        filePath: relPath,
        declarations: bounded.response.output.facts.declarations.map((declaration) => ({
          ...declaration,
          location: { ...declaration.location, filePath: relPath },
        })),
        references: bounded.response.output.facts.references.map((reference) => ({
          ...reference,
          location: { ...reference.location, filePath: relPath },
        })),
        diagnostics: bounded.response.output.facts.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          ...(diagnostic.location
            ? { location: { ...diagnostic.location, filePath: relPath } }
            : {}),
        })),
      };
      result.facts.push(facts);
      result.dependencies.push(relPath);
      result.diagnostics.push(...facts.diagnostics);
      if (bounded.extraction) {
        // The worker parses the canonical absolute path; overlay consumers key and
        // materialize by repository-relative paths, so normalize extraction provenance.
        for (const node of bounded.extraction.nodes) node.file = relPath;
        for (const edge of bounded.extraction.edges) edge.fromFile = relPath;
        result.extractions.set(relPath, bounded.extraction);
      }
      continue;
    }

    try {
      const extraction = extractSource(grammars, entry.content, relPath, lang).extraction;
      result.extractions.set(relPath, extraction);
      const producer =
        astLanguageId(lang) === 'php'
          ? TREE_SITTER_PRODUCERS.php
          : TREE_SITTER_PRODUCERS.typescript;
      result.producersRun.add(producer);
      const facts = extractionToSourceFacts(relPath, lang, extraction);
      result.facts.push(facts);
      result.dependencies.push(relPath);
      result.diagnostics.push(...facts.diagnostics);
    } catch (error) {
      onWarn?.(
        `AST extraction failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
        `ast-file:${relPath}`
      );
    }
  }
  if (startFailure !== undefined) {
    onWarn?.(
      workerStartFailureWarning('JavaScript', startFailure, filesNotStarted),
      'ast-worker:javascript'
    );
  }

  return result;
}

/** The single warning for a parser worker that failed to start, however many files it cost. */
export function workerStartFailureWarning(
  language: string,
  reason: string,
  fileCount: number
): string {
  return `${language} parser worker failed to start: ${reason} ${fileCount} file(s) were not parsed.`;
}

export async function buildSharedExtractions(
  scan: ScanResult,
  rootPath: string,
  onWarn?: WarnFn
): Promise<SharedExtractions> {
  return (await buildSharedExtractionAnalysis(scan, rootPath, onWarn)).extractions;
}
