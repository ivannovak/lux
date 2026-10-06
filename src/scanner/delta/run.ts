import type { Command } from 'commander';
import { LuxDatabase } from '../../db/index.js';
import { resolveRuntimePaths } from '../../utils/runtime-paths.js';
import {
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../overlay-trust-state.js';
import { loadLspConfig } from '../config.js';
import { openIndex } from '../../db/open-policy.js';
import { READ_TELEMETRY, withReadTelemetry } from '../../utils/read-telemetry.js';
import { isRefusal, mapIndexOpenRefusal, resolveDeltaBase } from './preflight.js';
import { isIndexablePath, resolveDeltaChangeSet } from './change-set.js';
import { resolveTouchSet } from './touch.js';
import { walkDownstream } from './downstream.js';
import { resolveOwnershipIntersection } from './ownership.js';
import { resolveInvalidatedSpecTargets } from './spec-evidence.js';
import { diffBaseline } from './baseline.js';
import { computeCrossRepoImpact } from './cross-repo.js';
import { evaluateGates, resolveGateCategories } from './gate.js';
import { assembleDeltaReport, renderDeltaText, type AssembleInput } from './report.js';
import type { DeltaOptions, DeltaRefusal, DeltaReportV1 } from './types.js';

/** Pure orchestrator — no I/O, no exit, no close. Shared by the CLI and MCP surfaces. */
export function computeDelta(
  db: LuxDatabase,
  corpusPath: string,
  opts: DeltaOptions
): { report: DeltaReportV1 } | { refusal: DeltaRefusal } {
  const base = resolveDeltaBase(corpusPath, db, opts.base);
  if (isRefusal(base)) {
    // Analysis mode degrades not-a-git-repo / baseline-unavailable to a warning + empty report
    // (Decision 18); --check turns them into refusals. Hard refusals (config-error) always refuse.
    if (
      !opts.check &&
      (base.reason === 'not-a-git-repo' || base.reason === 'baseline-unavailable')
    ) {
      return { report: emptyReport(db, opts, base) };
    }
    return { refusal: base };
  }

  const changeSet = resolveDeltaChangeSet(corpusPath, db, {
    base,
    committedOnly: opts.committedOnly ?? false,
  });
  const touch = resolveTouchSet(db, changeSet);
  const walk = walkDownstream(db, touch, {
    depth: opts.depth,
    maxNodes: opts.maxNodes,
    maxFanout: opts.maxFanout,
    minConfidence: opts.minConfidence,
  });

  // Budget-truncated blind spot (spec 12/14): an indexable changed file that resolved to zero nodes.
  const indexedNodePaths = new Set(
    touch.nodes.map((n) => n.filePath).filter((p): p is string => Boolean(p))
  );
  const newFileBlindSpot = changeSet.files.some(
    (f) =>
      isIndexablePath(f.path) &&
      f.indexTrust !== 'index-fresh' &&
      !indexedNodePaths.has(f.renamedFrom ?? f.path)
  );
  const truncated = walk.truncated || newFileBlindSpot;

  const ownership = resolveOwnershipIntersection(db, touch, { corpusPath });
  const specTargets = resolveInvalidatedSpecTargets(touch, walk.entrySurfaces);

  // Module rollup dependents (Projection 2 / spec 13).
  const changedModules = [
    ...new Set(changeSet.files.map((f) => f.module).filter((m): m is string => Boolean(m))),
  ];
  const dependentsMap = new Map<string, number>();
  for (const m of changedModules) {
    if (m === '(unscoped)') continue;
    for (const dep of db.getModuleDependencies(m, 'target')) {
      dependentsMap.set(
        dep.source_module,
        (dependentsMap.get(dep.source_module) ?? 0) + dep.reference_count
      );
    }
  }
  const modules = {
    changed: changedModules.filter((m) => m !== '(unscoped)'),
    dependents: [...dependentsMap]
      .map(([module, referenceCount]) => ({ module, referenceCount }))
      .sort((a, b) => b.referenceCount - a.referenceCount),
  };

  const trustLevel = deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state);
  const warnings: string[] = [];

  let baselineDiff: DeltaReportV1['baselineDiff'];
  if (opts.baselineDb) {
    const bd = diffBaseline(db, corpusPath, opts.baselineDb);
    if (isRefusal(bd)) warnings.push(bd.message);
    else baselineDiff = bd;
  }

  let gate: DeltaReportV1['gate'];
  if (opts.check) {
    const categories = resolveGateCategories(opts.failOn, loadLspConfig(corpusPath).delta?.gates);
    if (isRefusal(categories)) return { refusal: categories };
    const deletedFiles = new Set(
      changeSet.files.filter((f) => f.status === 'deleted').map((f) => f.renamedFrom ?? f.path)
    );
    const handlerFiles = new Map<string, string>();
    const deletedHandlerSymbols = new Set<string>();
    for (const n of touch.nodes) {
      if (n.nodeType === 'symbol' && n.filePath) {
        handlerFiles.set(n.id, n.filePath);
        if (deletedFiles.has(n.filePath)) deletedHandlerSymbols.add(n.id);
      }
    }
    gate = evaluateGates({
      categories,
      trustLevel,
      ownership,
      deletedHandlerSymbols,
      handlerFiles,
      downstreamTruncated: truncated,
      baselineDiff,
    });
  }

  // Cross-repo delta (Decision 9): --against runs delta's downstream machinery inside each named
  // sibling's read-only graph, seeded by portable touched ids. Strictly additive — the envelope
  // stays schemaVersion:1. Decision 6: analysis mode warns per refusal + continues; --check turns
  // an explicitly-named unresolvable sibling into a refusal (no silent pass).
  let crossRepoImpact: DeltaReportV1['crossRepoImpact'];
  if (opts.against && opts.against.length) {
    const { impact, refusals } = computeCrossRepoImpact(db, corpusPath, touch, opts.against, {
      depth: opts.depth,
      maxNodes: opts.maxNodes,
      maxFanout: opts.maxFanout,
      minConfidence: opts.minConfidence,
    });
    crossRepoImpact = impact;
    for (const ref of refusals) warnings.push(`--against ${ref.name}: ${ref.message}`);
    if (opts.check && refusals.length > 0) {
      return {
        refusal: {
          reason: 'config-error',
          message: `--against: ${refusals.map((r) => `${r.name} (${r.reason})`).join(', ')}`,
          remediation: refusals[0].remediation,
        },
      };
    }
  }

  const input: AssembleInput = {
    changeSet,
    touch,
    downstream: walk,
    truncated,
    modules,
    ownership,
    specTargets,
    trust: {
      overlay: trustLevel,
      indexedCommit: db.getIndexMetadata('last_indexed_commit') ?? null,
    },
    budget: { depth: opts.depth, maxNodes: opts.maxNodes },
    gate,
    baselineDiff,
    crossRepoImpact,
    warnings,
  };
  return { report: assembleDeltaReport(input) };
}

function emptyReport(db: LuxDatabase, opts: DeltaOptions, refusal: DeltaRefusal): DeltaReportV1 {
  const trustLevel = deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state);
  return assembleDeltaReport({
    changeSet: {
      base: { ref: opts.base ?? '(unresolved)', sha: null, source: opts.base ? 'flag' : 'index' },
      head: { sha: null, workingTreeIncluded: !(opts.committedOnly ?? false) },
      files: [],
      indexPaths: [],
      warnings: [refusal.message],
    },
    touch: {
      nodes: [],
      symbolIds: [],
      surfacesDeclared: [],
      evidenceEdgeCount: 0,
      operationalBoundaries: [],
      orphanedNodeCount: 0,
    },
    downstream: { entrySurfaces: [], asyncBoundaries: [], truncated: false, visitedSymbols: [] },
    truncated: false,
    modules: { changed: [], dependents: [] },
    ownership: {
      kernelConfigured: false,
      kernelResolved: false,
      source: 'unavailable',
      kernelDrift: null,
      transitions: [],
    },
    specTargets: [],
    trust: {
      overlay: trustLevel,
      indexedCommit: db.getIndexMetadata('last_indexed_commit') ?? null,
    },
    budget: { depth: opts.depth, maxNodes: opts.maxNodes },
    warnings: [refusal.message],
  });
}

/** CLI entry point. Opens the existing index strictly read-only and never records usage. */
export function runDeltaCli(program: Command, opts: DeltaOptions): void {
  const runtime = resolveRuntimePaths({
    corpus: program.opts().corpus as string | undefined,
    db: program.opts().db as string | undefined,
  });
  const opened = openIndex(runtime.dbPath, 'read-existing');
  if (!opened.ok) {
    const refusal = mapIndexOpenRefusal(opened.refusal, opened.message);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            error: 'index-open-refused',
            refusal,
            telemetry: READ_TELEMETRY,
          },
          null,
          2
        )
      );
    } else {
      printRefusal(`Error: ${refusal.message}`);
      if (refusal.remediation) printRefusal(`  ${refusal.remediation}`);
    }
    process.exitCode = 1;
    return;
  }

  const db = opened.db;
  try {
    const result = computeDelta(db, runtime.corpusPath, opts);
    if ('refusal' in result) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              error: 'delta-refused',
              refusal: result.refusal,
              telemetry: READ_TELEMETRY,
            },
            null,
            2
          )
        );
      } else {
        printRefusal(`Error: ${result.refusal.message}`);
        if (result.refusal.remediation) printRefusal(`  ${result.refusal.remediation}`);
      }
      process.exitCode = 1;
      return;
    }

    const report = result.report;
    console.log(
      opts.json ? JSON.stringify(withReadTelemetry(report), null, 2) : renderDeltaText(report)
    );
    process.exitCode = opts.check && report.gate ? report.gate.exitCode : 0;
  } finally {
    db.close();
  }
}

/** The `lux delta` command's printer for a refusal, which ends the command with a nonzero exit. */
function printRefusal(line: string): void {
  // eslint-disable-next-line no-restricted-syntax -- the delta command's refusal printer.
  console.error(line);
}
