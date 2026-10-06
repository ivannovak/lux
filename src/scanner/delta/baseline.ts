import { existsSync } from 'fs';
import { detectModuleBoundaries, resolveModule } from '../imports/module-boundary.js';
import type { LuxDatabase } from '../../db/index.js';
import type { BaselineDiff, DeltaRefusal } from './types.js';

/**
 * Compute the additive `baselineDiff` block (Phase 4, Decision 9). Resolves the raw structural
 * diff in-engine (attachSibling) then rolls new edges up to cross-module edges via resolveModule.
 * A missing/unresolvable baseline is a structured `baseline-unavailable` refusal (Decision 15) —
 * a *configured* Phase-4 gate then fails loud rather than silently passing (gate section).
 */
export function diffBaseline(
  db: LuxDatabase,
  corpusPath: string,
  baselineDbPath: string
): BaselineDiff | DeltaRefusal {
  if (!existsSync(baselineDbPath)) {
    return {
      reason: 'baseline-unavailable',
      message: `No baseline index at ${baselineDbPath}.`,
      remediation:
        'Build it: check out the base ref and `lux index rebuild`, or restore the cached (base SHA, schema_version) artifact.',
    };
  }
  let raw: ReturnType<LuxDatabase['baselineStructuralDiff']>;
  try {
    raw = db.baselineStructuralDiff(baselineDbPath);
  } catch (error) {
    // lux-intentional-swallow: returned to the caller as a refusal, which reports it.
    return {
      reason: 'baseline-unavailable',
      message: `baseline attach/diff failed: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'Re-index the baseline at the current schema (Decision 15).',
    };
  }
  const patterns = detectModuleBoundaries(corpusPath);
  const crossModule = new Map<string, { source: string; target: string; edgeType: string }>();
  for (const e of raw.newEdges) {
    const sm = resolveModule(e.sourceFile, corpusPath, patterns);
    const tm = resolveModule(e.targetFile, corpusPath, patterns);
    if (sm && tm && sm !== tm) {
      crossModule.set(`${sm}->${tm}:${e.edgeType}`, {
        source: sm,
        target: tm,
        edgeType: e.edgeType,
      });
    }
  }
  return {
    surfacesRemoved: raw.surfacesRemoved,
    surfacesAdded: raw.surfacesAdded,
    crossModuleEdgesAdded: [...crossModule.values()],
  };
}
