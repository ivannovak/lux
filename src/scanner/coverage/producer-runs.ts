import type { LuxDatabase } from '../../db/index.js';
import type { GeneralScanResult } from '../general.js';

const COVERAGE_PRODUCER_RUNS_KEY = 'coverage_producer_runs_v1';

export interface ProducerRunSignal {
  status: 'success' | 'partial' | 'failed' | 'not-applicable';
  failures: number;
  completedCandidates: number;
}

export type ProducerRunSignals = Readonly<Record<string, ProducerRunSignal>>;

/** Persist explicit run outcomes in existing index_metadata (no schema migration). */
export function persistCoverageProducerRuns(db: LuxDatabase, scan: GeneralScanResult): void {
  const candidateCounts = new Map<string, number>();
  for (const entry of scan.scan.knowledge) {
    if (entry.type !== 'source-code') continue;
    const language = normalizeLanguage(entry.frontmatter?.language);
    if (language) candidateCounts.set(language, (candidateCounts.get(language) ?? 0) + 1);
  }

  const errorsByLanguage = new Map<string, number>();
  for (const error of scan.stats.enrichmentErrors) {
    const language = languageFromPath(error.filePath);
    if (language) errorsByLanguage.set(language, (errorsByLanguage.get(language) ?? 0) + 1);
  }

  const runs: Record<string, ProducerRunSignal> = {};
  for (const language of ['php', 'typescript'] as const) {
    const candidates = candidateCounts.get(language) ?? 0;
    runs[`${language}-tree-sitter`] = {
      status: candidates === 0 ? 'not-applicable' : scan.overlay ? 'success' : 'failed',
      failures: scan.overlay ? 0 : candidates,
      completedCandidates: scan.overlay ? candidates : 0,
    };
  }

  const javascriptCandidates = candidateCounts.get('javascript') ?? 0;
  const javascriptFacts =
    scan.overlay?.programAnalysis?.facts.filter((facts) => facts.languageId === 'javascript') ?? [];
  const javascriptFailures =
    scan.overlay?.programAnalysis?.diagnostics.filter((diagnostic) =>
      ['timeout', 'limit', 'parse-error', 'path-escape', 'worker-error'].includes(diagnostic.code)
    ).length ?? 0;
  runs['javascript-tree-sitter'] = {
    status:
      javascriptCandidates === 0
        ? 'not-applicable'
        : !scan.overlay || javascriptFacts.length === 0
          ? 'failed'
          : javascriptFailures > 0 || javascriptFacts.length < javascriptCandidates
            ? 'partial'
            : 'success',
    failures: javascriptFailures || (!scan.overlay ? javascriptCandidates : 0),
    completedCandidates: javascriptFacts.length,
  };

  const vueCandidates = candidateCounts.get('vue') ?? 0;
  const vueFacts = scan.overlay?.programAnalysis?.vueFacts ?? [];
  const vueCompilerFailures =
    scan.overlay?.programAnalysis?.diagnostics.filter((diagnostic) =>
      ['timeout', 'limit', 'parse-error', 'path-escape', 'worker-error'].includes(diagnostic.code)
    ).length ?? 0;
  runs['vue-compiler-sfc'] = {
    status:
      vueCandidates === 0
        ? 'not-applicable'
        : !scan.overlay || vueFacts.length === 0
          ? 'failed'
          : vueCompilerFailures > 0 || vueFacts.length < vueCandidates
            ? 'partial'
            : 'success',
    failures: vueCompilerFailures || (!scan.overlay ? vueCandidates : 0),
    completedCandidates: vueFacts.length,
  };

  const vueCompleted = [...scan.enrichments.values()].filter(
    (result) => result.languageId === 'vue'
  ).length;
  const vueFailures = errorsByLanguage.get('vue') ?? 0;
  runs['vue-language-server'] = {
    status:
      vueCandidates === 0
        ? 'not-applicable'
        : vueCompleted === 0
          ? 'failed'
          : vueFailures > 0 || vueCompleted < vueCandidates
            ? 'partial'
            : 'success',
    failures: vueFailures,
    completedCandidates: vueCompleted,
  };

  runs['structural-overlay'] = {
    status: scan.overlay ? 'success' : 'failed',
    failures: scan.overlay ? 0 : 1,
    completedCandidates: scan.overlay?.fileNodes ?? 0,
  };
  db.setIndexMetadata(COVERAGE_PRODUCER_RUNS_KEY, JSON.stringify(runs));
}

export function persistScopedCoverageProducerRuns(
  db: LuxDatabase,
  result: {
    tiers: { ast: 'ran' | 'failed'; lsp: 'ran' | 'skipped-budget' | 'unavailable' };
    refreshedFiles: number;
  },
  changedPaths: string[]
): void {
  const previous = loadCoverageProducerRuns(db) ?? {};
  const next: Record<string, ProducerRunSignal> = { ...previous };
  const touched = countLanguages(changedPaths);

  // A scoped run says nothing about languages outside its refresh set. Preserve their last
  // complete-run evidence rather than fabricating a new success/failure from an unrelated change.
  for (const language of ['php', 'typescript', 'javascript'] as const) {
    const count = touched.get(language) ?? 0;
    if (count === 0) continue;
    const producer = `${language}-tree-sitter`;
    if (result.tiers.ast === 'failed') {
      next[producer] = {
        status: 'partial',
        failures: count,
        completedCandidates: previous[producer]?.completedCandidates ?? 0,
      };
    } else if (!previous[producer]) {
      next[producer] = { status: 'success', failures: 0, completedCandidates: count };
    } else {
      next[producer] = {
        status: 'success',
        failures: 0,
        completedCandidates: previous[producer].completedCandidates,
      };
    }
  }

  const vueCount = touched.get('vue') ?? 0;
  if (vueCount > 0) {
    if (result.tiers.ast === 'failed') {
      next['vue-compiler-sfc'] = {
        status: 'partial',
        failures: vueCount,
        completedCandidates: previous['vue-compiler-sfc']?.completedCandidates ?? 0,
      };
    } else {
      next['vue-compiler-sfc'] = {
        status: 'success',
        failures: 0,
        completedCandidates: previous['vue-compiler-sfc']?.completedCandidates ?? vueCount,
      };
    }
    if (result.tiers.lsp !== 'ran') {
      next['vue-language-server'] = {
        status: 'partial',
        failures: vueCount,
        completedCandidates: previous['vue-language-server']?.completedCandidates ?? 0,
      };
    } else if (!previous['vue-language-server']) {
      next['vue-language-server'] = {
        status: 'success',
        failures: 0,
        completedCandidates: vueCount,
      };
    }
  }

  // The scoped overlay transaction itself completed. Preserve a prior full-run signal, or create
  // one only when this is the first recorded run; AST tier failures make that first run partial.
  if (!previous['structural-overlay']) {
    next['structural-overlay'] = {
      status: result.tiers.ast === 'ran' ? 'success' : 'partial',
      failures: result.tiers.ast === 'ran' ? 0 : result.refreshedFiles,
      completedCandidates: result.refreshedFiles,
    };
  }
  db.setIndexMetadata(COVERAGE_PRODUCER_RUNS_KEY, JSON.stringify(next));
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

function countLanguages(paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const language = languageFromPath(path);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return counts;
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
