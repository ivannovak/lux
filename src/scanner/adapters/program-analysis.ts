import { relative, sep } from 'node:path';

import type { ScanResult } from '../types.js';
import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceFactsV1,
} from '../contracts/program.js';
import { isVueSfcFacts, type VueSfcFactsV1 } from '../vue/types.js';
import { extractVueEvents } from '../vue/event-extract.js';
import { DEFAULT_PARSER_LIMITS } from './types.js';
import { sourceAdapterForLanguage } from './registry.js';
import { resetParserWorkerStartFailures } from './worker-host.js';
import {
  buildSharedExtractionAnalysis,
  workerStartFailureWarning,
  type SharedExtractionBuildV1,
} from '../ast/extraction-cache.js';
import { buildProjectResolutionContext } from '../project-resolution/context.js';
import type { WarnFn } from '../reporter.js';

export interface ProgramAnalysisV1 {
  facts: readonly SourceFactsV1[];
  vueFacts: readonly VueSfcFactsV1[];
  project: ProjectResolutionContextV1;
  dependencies: readonly string[];
  diagnostics: readonly SourceDiagnosticV1[];
  producersRun: ReadonlySet<string>;
}

export interface ProgramAnalysisBuildV1 extends ProgramAnalysisV1 {
  /** Internal compatibility substrate consumed by existing overlay materializers/resolvers. */
  shared: SharedExtractionBuildV1;
}

/**
 * Build the canonical parser analysis once for an overlay run. The public facts are
 * contract-shaped while `shared` preserves the legacy extraction substrate until all
 * materializers consume SourceFactsV1 directly.
 */
export async function analyzeProgram(
  scan: ScanResult,
  rootPath: string,
  onWarn?: WarnFn
): Promise<ProgramAnalysisBuildV1> {
  // A new analysis is a new run: try again any parser worker that failed to start in the last one.
  resetParserWorkerStartFailures();
  const shared = await buildSharedExtractionAnalysis(scan, rootPath, onWarn);
  const vueFacts: VueSfcFactsV1[] = [];
  let vueStartFailure: string | undefined;
  let vueFilesNotStarted = 0;
  const vueAdapter = sourceAdapterForLanguage('vue');
  if (vueAdapter) {
    for (const entry of scan.knowledge) {
      if (entry.type !== 'source-code' || !entry.filePath.toLowerCase().endsWith('.vue')) continue;
      const output = await vueAdapter.extract({
        corpusRoot: rootPath,
        allowedRoots: [rootPath],
        filePath: entry.filePath,
        limits: DEFAULT_PARSER_LIMITS,
      });
      shared.producersRun.add(vueAdapter.id);
      shared.dependencies.push(...output.dependencies);
      shared.diagnostics.push(...output.diagnostics);
      const notStarted = output.diagnostics.find((item) => item.code === 'start-timeout');
      if (notStarted) {
        vueStartFailure ??= notStarted.message;
        vueFilesNotStarted++;
      }
      if (isVueSfcFacts(output.facts)) {
        const source = entry.content ?? '';
        const eventFacts = source ? extractVueEvents(source, output.facts.filePath) : undefined;
        const enriched = eventFacts
          ? {
              ...output.facts,
              events: eventFacts.events,
              templateListeners: eventFacts.listeners,
              diagnostics: [...output.facts.diagnostics, ...eventFacts.diagnostics],
            }
          : output.facts;
        vueFacts.push(enriched);
        shared.facts.push(enriched);
      }
    }
  }
  if (vueStartFailure !== undefined) {
    onWarn?.(
      workerStartFailureWarning('Vue', vueStartFailure, vueFilesNotStarted),
      'ast-worker:vue'
    );
  }
  const sourceFiles = new Set(
    scan.knowledge
      .filter((entry) => entry.type === 'source-code')
      .map((entry) => toRelative(entry.filePath, rootPath))
  );
  const project = await buildProjectResolutionContext({
    rootPath,
    allowedRoots: [rootPath],
    sourceFiles,
    facts: shared.facts,
    extractions: shared.extractions,
  });

  return {
    facts: shared.facts,
    vueFacts,
    project: project.context,
    dependencies: [
      ...new Set([...shared.dependencies, ...project.context.fingerprintInputs]),
    ].sort(),
    diagnostics: [...shared.diagnostics, ...project.diagnostics],
    producersRun: shared.producersRun,
    shared,
  };
}

function toRelative(filePath: string, rootPath: string): string {
  const value = relative(rootPath, filePath);
  if (value !== '' && value !== '..' && !value.startsWith(`..${sep}`)) {
    return value.split(sep).join('/');
  }
  return filePath.split(sep).join('/');
}
