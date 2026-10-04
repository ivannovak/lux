import { relative } from 'path';
import type { LuxDatabase } from '../../db/index.js';
import type { GeneralScanResult, WorkingTreeProgram } from '../general.js';
import type { ScanResult } from '../types.js';
import type { ProgramAnalysisV1 } from '../adapters/program-analysis.js';
import type { EnrichmentMap } from '../lsp/index.js';
import {
  mergeLspEnrichmentFailures,
  persistLspEnrichmentFailures,
  type LspEnrichmentFailure,
} from '../lsp/enrichment-failures.js';

const COVERAGE_PRODUCER_RUNS_KEY = 'coverage_producer_runs_v1';
const SYMBOL_ID_COLLISIONS_KEY = 'symbol_id_collisions_v1';

/** Shared symbol ids and the references they cost (`lux index status --json` → symbolIdCollisions). */
export interface SymbolIdCollisionStatus {
  /** Ids more than one file declares, each stored once per declaring file. */
  collidingIds: number;
  /** Stored edges that point at a shared id's bare form, and so at no node. */
  edgesToAmbiguousIds: number;
  /** References the last full rebuild dropped because they named a shared id. */
  droppedAmbiguousReferences: number;
}

export function loadSymbolIdCollisionStatus(db: LuxDatabase): SymbolIdCollisionStatus {
  return {
    ...db.getSymbolIdCollisionCounts(),
    droppedAmbiguousReferences: loadDroppedAmbiguousReferences(db),
  };
}

function loadDroppedAmbiguousReferences(db: LuxDatabase): number {
  try {
    const parsed = JSON.parse(db.getIndexMetadata(SYMBOL_ID_COLLISIONS_KEY) ?? '{}') as {
      droppedAmbiguousReferences?: unknown;
    };
    return validCount(parsed.droppedAmbiguousReferences);
  } catch {
    // lux-intentional-swallow: a count this version cannot parse is shown as 0; it is a statistic, and the next full rebuild rewrites it.
    return 0;
  }
}

export interface ProducerRunSignal {
  status: 'success' | 'partial' | 'failed' | 'not-applicable';
  failures: number;
  completedCandidates: number;
}

export type ProducerRunSignals = Readonly<Record<string, ProducerRunSignal>>;

/** What a run's producer signals are computed from, whichever path ran. */
interface ProducerRunInput {
  knowledge: ScanResult['knowledge'];
  analysis?: Pick<ProgramAnalysisV1, 'facts' | 'vueFacts' | 'diagnostics'>;
  /** The structural overlay was built or refreshed. */
  overlayBuilt: boolean;
  fileNodes: number;
  /** Vue files the Vue language server enriched, and those it failed on. */
  vueEnriched: number;
  vueEnrichmentFailures: number;
}

/** One definition of the producer signals, shared by the full rebuild and the scoped sync. */
function producerRuns(input: ProducerRunInput): Record<string, ProducerRunSignal> {
  const candidateCounts = new Map<string, number>();
  for (const entry of input.knowledge) {
    if (entry.type !== 'source-code') continue;
    const language = normalizeLanguage(entry.frontmatter?.language);
    if (language) candidateCounts.set(language, (candidateCounts.get(language) ?? 0) + 1);
  }
  const built = input.overlayBuilt;
  const parserFailures =
    input.analysis?.diagnostics.filter((diagnostic) =>
      ['timeout', 'start-timeout', 'limit', 'parse-error', 'path-escape', 'worker-error'].includes(
        diagnostic.code
      )
    ).length ?? 0;

  const runs: Record<string, ProducerRunSignal> = {};
  for (const language of ['php', 'typescript'] as const) {
    const candidates = candidateCounts.get(language) ?? 0;
    runs[`${language}-tree-sitter`] = {
      status: candidates === 0 ? 'not-applicable' : built ? 'success' : 'failed',
      failures: built ? 0 : candidates,
      completedCandidates: built ? candidates : 0,
    };
  }

  const javascriptCandidates = candidateCounts.get('javascript') ?? 0;
  const javascriptFacts = built
    ? (input.analysis?.facts.filter((facts) => facts.languageId === 'javascript') ?? [])
    : [];
  runs['javascript-tree-sitter'] = {
    status:
      javascriptCandidates === 0
        ? 'not-applicable'
        : !built || javascriptFacts.length === 0
          ? 'failed'
          : parserFailures > 0 || javascriptFacts.length < javascriptCandidates
            ? 'partial'
            : 'success',
    failures: (built ? parserFailures : 0) || (!built ? javascriptCandidates : 0),
    completedCandidates: javascriptFacts.length,
  };

  const vueCandidates = candidateCounts.get('vue') ?? 0;
  const vueFacts = built ? (input.analysis?.vueFacts ?? []) : [];
  runs['vue-compiler-sfc'] = {
    status:
      vueCandidates === 0
        ? 'not-applicable'
        : !built || vueFacts.length === 0
          ? 'failed'
          : parserFailures > 0 || vueFacts.length < vueCandidates
            ? 'partial'
            : 'success',
    failures: (built ? parserFailures : 0) || (!built ? vueCandidates : 0),
    completedCandidates: vueFacts.length,
  };

  runs['vue-language-server'] = {
    status:
      vueCandidates === 0
        ? 'not-applicable'
        : input.vueEnriched === 0
          ? 'failed'
          : input.vueEnrichmentFailures > 0 || input.vueEnriched < vueCandidates
            ? 'partial'
            : 'success',
    failures: input.vueEnrichmentFailures,
    completedCandidates: input.vueEnriched,
  };

  runs['structural-overlay'] = {
    status: built ? 'success' : 'failed',
    failures: built ? 0 : 1,
    completedCandidates: input.fileNodes,
  };
  return runs;
}

/** Persist explicit run outcomes in existing index_metadata (no schema migration). */
export function persistCoverageProducerRuns(db: LuxDatabase, scan: GeneralScanResult): void {
  const runs = producerRuns({
    knowledge: scan.scan.knowledge,
    analysis: scan.overlay?.programAnalysis,
    overlayBuilt: Boolean(scan.overlay),
    fileNodes: scan.overlay?.fileNodes ?? 0,
    vueEnriched: [...scan.enrichments.values()].filter((result) => result.languageId === 'vue')
      .length,
    vueEnrichmentFailures: scan.stats.enrichmentErrors.filter(
      (error) => languageFromPath(error.filePath) === 'vue'
    ).length,
  });
  db.setIndexMetadata(COVERAGE_PRODUCER_RUNS_KEY, JSON.stringify(runs));

  // References dropped because they named an id several files declare (identity/symbol-collisions.ts).
  // Only a full rebuild sees every reference, so only it records the count.
  db.setIndexMetadata(
    SYMBOL_ID_COLLISIONS_KEY,
    JSON.stringify({
      droppedAmbiguousReferences: scan.overlay?.symbolCollisions.ambiguousReferences ?? 0,
    })
  );

  persistLspEnrichmentFailures(db, scan.stats.lspFailures);
}

/**
 * Persist the producer signals after a scoped sync, computed from the whole working tree the
 * refresh read, so they are the ones a full rebuild of the same commit records. The one signal a
 * scoped run cannot always recompute is the Vue language server's: when the refresh did not
 * re-enrich every Vue file, the last recorded signal stands.
 */
export function persistScopedCoverageProducerRuns(
  db: LuxDatabase,
  rootPath: string,
  result: {
    tiers: { ast: 'ran' | 'failed'; lsp: 'ran' | 'skipped-budget' | 'failed' | 'unavailable' };
    refreshedPaths: string[];
    lspEnrichmentFailures: LspEnrichmentFailure[];
    enrichments: EnrichmentMap;
    workingTree?: WorkingTreeProgram;
  }
): void {
  // A tier that ran replaces R's outcomes; one that could not start still records why.
  const failures = result.lspEnrichmentFailures;
  if (result.tiers.lsp === 'ran' || failures.length > 0) {
    mergeLspEnrichmentFailures(db, result.refreshedPaths, failures);
  }
  if (!result.workingTree) return;

  const refreshed = new Set(result.refreshedPaths);
  const everyVueFileRefreshed = result.workingTree.scan.knowledge
    .filter((entry) => entry.type === 'source-code' && /\.vue$/iu.test(entry.filePath))
    .every((entry) => refreshed.has(relative(rootPath, entry.filePath)));
  const runs = producerRuns({
    knowledge: result.workingTree.scan.knowledge,
    // A failed AST tier leaves the overlay without program analysis, as it does a rebuild.
    analysis: result.tiers.ast === 'ran' ? result.workingTree.analysis : undefined,
    overlayBuilt: true,
    fileNodes: db.countLocalStructuralNodesByType('file'),
    vueEnriched: [...result.enrichments.values()].filter((r) => r.languageId === 'vue').length,
    vueEnrichmentFailures: failures.filter(
      (failure) => failure.stage === 'symbols' && languageFromPath(failure.filePath) === 'vue'
    ).length,
  });
  const previous = loadCoverageProducerRuns(db)?.['vue-language-server'];
  if (!(everyVueFileRefreshed && result.tiers.lsp === 'ran') && previous) {
    runs['vue-language-server'] = previous;
  }
  db.setIndexMetadata(COVERAGE_PRODUCER_RUNS_KEY, JSON.stringify(runs));
}

export function loadCoverageProducerRuns(db: LuxDatabase): ProducerRunSignals | null {
  const raw = db.getIndexMetadata(COVERAGE_PRODUCER_RUNS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, ProducerRunSignal> = {};
    for (const [producer, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const signal = value as Partial<ProducerRunSignal>;
      if (
        signal.status !== 'success' &&
        signal.status !== 'partial' &&
        signal.status !== 'failed' &&
        signal.status !== 'not-applicable'
      ) {
        continue;
      }
      result[producer] = {
        status: signal.status,
        failures: validCount(signal.failures),
        completedCandidates: validCount(signal.completedCandidates),
      };
    }
    return result;
  } catch {
    // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
    return null;
  }
}

function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const language = value.trim().toLowerCase();
  if (language === 'ts' || language === 'tsx') return 'typescript';
  if (language === 'js' || language === 'jsx') return 'javascript';
  return language;
}

function languageFromPath(filePath: string): string | null {
  if (/\.vue$/i.test(filePath)) return 'vue';
  if (/\.php$/i.test(filePath)) return 'php';
  if (/\.(?:ts|tsx|mts|cts)$/i.test(filePath)) return 'typescript';
  if (/\.(?:js|jsx|mjs|cjs)$/i.test(filePath)) return 'javascript';
  return null;
}

function validCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
