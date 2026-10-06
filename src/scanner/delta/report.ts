import type {
  BaselineDiff,
  CrossRepoImpact,
  DeltaChangeSet,
  DeltaReportV1,
  DeltaTouchSet,
  GateResult,
  OwnershipProjection,
  SpecTarget,
} from './types.js';
import type { DownstreamResult } from './downstream.js';

export interface AssembleInput {
  changeSet: DeltaChangeSet;
  touch: DeltaTouchSet;
  downstream: DownstreamResult;
  truncated: boolean; // downstream.truncated OR the new-file blind spot
  modules: { changed: string[]; dependents: Array<{ module: string; referenceCount: number }> };
  ownership: OwnershipProjection;
  specTargets: SpecTarget[];
  trust: { overlay: string; indexedCommit: string | null };
  budget: { depth: number; maxNodes: number };
  gate?: GateResult;
  baselineDiff?: BaselineDiff;
  crossRepoImpact?: CrossRepoImpact;
  warnings: string[];
}

export function assembleDeltaReport(inp: AssembleInput): DeltaReportV1 {
  const staleFiles = inp.changeSet.files.filter((f) => f.indexTrust === 'index-stale').length;
  const absentFiles = inp.changeSet.files.filter((f) => f.indexTrust === 'index-absent').length;
  const warnings = [...inp.changeSet.warnings, ...inp.warnings];
  if (inp.ownership.warning) warnings.push(inp.ownership.warning);

  return {
    schemaVersion: 1,
    surface: 'delta',
    changeSet: { base: inp.changeSet.base, head: inp.changeSet.head, files: inp.changeSet.files },
    touched: {
      files: inp.changeSet.files.length,
      symbols: inp.touch.symbolIds.length,
      surfacesDeclared: inp.touch.surfacesDeclared.length,
      evidenceEdges: inp.touch.evidenceEdgeCount,
      orphanedNodes: inp.touch.orphanedNodeCount,
      // Copied, not aliased: the envelope is handed to callers that may hold it
      // past the life of the touch set.
      symbolIds: [...inp.touch.symbolIds],
      symbolSample: inp.touch.symbolIds.slice(0, 10),
      changedSymbols: inp.touch.symbolChanges.length,
      changedSymbolIds: inp.touch.symbolChanges.map((change) => change.id),
      symbolChanges: inp.touch.symbolChanges,
      precision: inp.touch.precision,
    },
    downstream: {
      entrySurfaces: inp.downstream.entrySurfaces,
      asyncBoundaries: inp.downstream.asyncBoundaries,
      budget: { depth: inp.budget.depth, maxNodes: inp.budget.maxNodes, truncated: inp.truncated },
    },
    modules: inp.modules,
    ownership: inp.ownership,
    invalidatedEvidence: { specTargets: inp.specTargets },
    trust: {
      overlay: inp.trust.overlay,
      indexedCommit: inp.trust.indexedCommit,
      staleFiles,
      absentFiles,
      warnings,
    },
    gate: inp.gate,
    baselineDiff: inp.baselineDiff,
    crossRepoImpact: inp.crossRepoImpact,
  };
}

/** Concise human render (analysis mode default). --json emits the envelope instead. */
export function renderDeltaText(r: DeltaReportV1): string {
  const lines: string[] = [];
  const b = r.changeSet.base;
  lines.push(
    `\nlux delta — base ${b.ref}${b.sha ? ` (${b.sha.slice(0, 7)})` : ''} [${b.source}]` +
      `${r.changeSet.head.workingTreeIncluded ? ' + working tree' : ''}`
  );
  lines.push(
    `  changed: ${r.touched.files} file(s) · ${r.touched.symbols} symbol(s) · ` +
      `${r.touched.surfacesDeclared} surface(s) declared · ${r.touched.evidenceEdges} evidence edge(s)` +
      (r.touched.orphanedNodes ? ` · ${r.touched.orphanedNodes} orphaned` : '')
  );
  lines.push(`  ${changedSymbolsLine(r)}`);
  if (r.modules.changed.length) {
    lines.push(`  modules: ${r.modules.changed.join(', ')}`);
    if (r.modules.dependents.length) {
      lines.push(
        `  dependents: ${r.modules.dependents
          .slice(0, 8)
          .map((d) => `${d.module}(${d.referenceCount})`)
          .join(', ')}`
      );
    }
  }
  if (r.downstream.entrySurfaces.length) {
    lines.push(`  downstream entry surfaces (${r.downstream.entrySurfaces.length}):`);
    for (const s of r.downstream.entrySurfaces.slice(0, 20)) {
      const hop = s.hops !== undefined ? ` hops=${s.hops}` : '';
      const wc = s.weakestConfidence ? ` weakest=${s.weakestConfidence}` : '';
      lines.push(`    [${s.kind}] ${s.id}  via ${s.resolvedVia}${hop}${wc}`);
    }
  }
  if (r.downstream.asyncBoundaries.length) {
    lines.push(`  async boundaries (upstream route not statically reachable):`);
    for (const a of r.downstream.asyncBoundaries.slice(0, 10)) lines.push(`    ${a.symbol}`);
  }
  if (r.downstream.budget.truncated) {
    lines.push(
      '  ⚠ blast radius truncated (budget exhausted or a new/unindexed hub) — see budget-truncated.'
    );
  }
  if (r.ownership.source !== 'unavailable') {
    lines.push(
      `  ownership (${r.ownership.source}): ${r.ownership.transitions.length} transition(s)`
    );
    for (const t of r.ownership.transitions.slice(0, 10)) {
      lines.push(`    ${t.route} → ${t.label}  (${t.changedHandler})`);
    }
    if (r.ownership.kernelDrift?.stale) {
      lines.push(
        `    ⚠ kernel index (${r.ownership.kernelDrift.indexedCommit?.slice(0, 7)}) ` +
          `differs from worktree HEAD (${r.ownership.kernelDrift.headCommit?.slice(0, 7)}) — re-index the kernel.`
      );
    }
  } else if (r.ownership.warning) {
    lines.push(`  ownership: ${r.ownership.warning}`);
  }
  if (r.invalidatedEvidence.specTargets.length) {
    lines.push(`  re-derive spec-evidence for (${r.invalidatedEvidence.specTargets.length}):`);
    for (const t of r.invalidatedEvidence.specTargets.slice(0, 20)) {
      lines.push(`    [${t.kind}] ${t.target}`);
    }
  }
  if (r.baselineDiff) {
    lines.push(
      `  baseline diff: -${r.baselineDiff.surfacesRemoved.length} / +${r.baselineDiff.surfacesAdded.length} surface(s), ` +
        `+${r.baselineDiff.crossModuleEdgesAdded.length} cross-module edge(s)`
    );
  }
  if (r.crossRepoImpact) {
    lines.push(`  cross-repo impact (${r.crossRepoImpact.siblings.length} sibling(s)):`);
    for (const s of r.crossRepoImpact.siblings) {
      if (!s.attached) {
        lines.push(`    ⚠ ${s.name}: ${s.refusal ?? 'unresolved'}`);
        continue;
      }
      const drift =
        s.freshness?.stale == null ? 'drift unknown' : s.freshness.stale ? 'STALE' : 'fresh';
      lines.push(
        `    ${s.name}: ${s.seedsMatched ?? 0}/${s.seedsTotal ?? 0} seed(s) matched · ` +
          `${s.entrySurfaces?.length ?? 0} surface(s)` +
          (s.budget?.truncated ? ' (truncated)' : '') +
          ` · ${drift}`
      );
      for (const es of (s.entrySurfaces ?? []).slice(0, 10)) {
        const hop = es.hops !== undefined ? ` hops=${es.hops}` : '';
        const wc = es.weakestConfidence ? ` weakest=${es.weakestConfidence}` : '';
        lines.push(`      [${es.kind}] ${es.id}  via ${es.resolvedVia}${hop}${wc}`);
      }
    }
  }
  lines.push(
    `  trust: overlay=${r.trust.overlay} indexed=${r.trust.indexedCommit?.slice(0, 7) ?? 'none'} ` +
      `stale=${r.trust.staleFiles} absent=${r.trust.absentFiles}`
  );
  for (const w of r.trust.warnings) lines.push(`  ⚠ ${w}`);
  if (r.gate) {
    lines.push(
      `  gate: ${r.gate.exitCode === 0 ? 'PASS' : 'FAIL'} (${r.gate.violations.length} violation(s))`
    );
    for (const v of r.gate.violations) {
      lines.push(`    ✗ [${v.category}] ${v.subject} — ${v.detail}`);
    }
  }
  return lines.join('\n');
}

/** `symbols changed: 3 of 41 in the changed files (2 modified, 1 added)` plus what needs saying. */
function changedSymbolsLine(r: DeltaReportV1): string {
  const counts = new Map<string, number>();
  for (const change of r.touched.symbolChanges) {
    counts.set(change.change, (counts.get(change.change) ?? 0) + 1);
  }
  const kinds = ['modified', 'added', 'removed', 'moved', 'file-level']
    .filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${kind}`);
  const p = r.touched.precision;
  const notes = [
    p.changedOutsideSymbols.length
      ? `${p.changedOutsideSymbols.length} file(s) changed outside any symbol`
      : '',
    p.cosmeticOnly.length
      ? `${p.cosmeticOnly.length} file(s) changed only in comments or spacing`
      : '',
    p.renamedOnly.length ? `${p.renamedOnly.length} file(s) renamed without edits` : '',
    p.fileLevelOnly.length ? `${p.fileLevelOnly.length} file(s) not attributable to symbols` : '',
  ].filter(Boolean);
  return (
    `symbols changed: ${r.touched.changedSymbols} of ${r.touched.symbols} in the changed files` +
    (kinds.length ? ` (${kinds.join(', ')})` : '') +
    (notes.length ? ` · ${notes.join(' · ')}` : '')
  );
}
