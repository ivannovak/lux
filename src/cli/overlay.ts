// CLI command group for overlay inspection and validation.
//
// Commands:
//   lux overlay status  — display current overlay trust state from the DB
//   lux overlay check   — assert overlay is overlay-complete; exits 1 if degraded

import type { Command } from 'commander';
import { resolveCorpusPath, resolveDbPath, resolveRuntimePaths } from '../utils/runtime-paths.js';
import { loadLspConfig } from '../scanner/config.js';
import { resolveKernel, type ResolvedKernel } from '../scanner/associations/kernel-area.js';
import {
  classifyCrossAreaOwnership,
  resolveAppNamespace,
} from '../scanner/associations/ownership.js';
import { runFeaturePathAsk } from './feature-path.js';
import { runOperationalAsk } from './operational.js';
import { runSpecEvidenceAsk } from './spec-evidence.js';
import { buildOverlayStatusPayload } from './status-payload.js';
import { assessWorkingTreeFreshness, renderFreshnessText } from '../scanner/freshness.js';
import {
  describeOverlayTrustInspection,
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../scanner/overlay-trust-state.js';
import {
  aggregateModuleBoundaryEvidence,
  type ModuleBoundaryAggregate,
} from '../scanner/overlay/module-boundary-analysis.js';
import { compareCodeUnits } from '../scanner/scan-order.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';

type BoundaryFocusDirection = 'inbound' | 'outbound' | 'both';
type BoundaryExploreListKind = 'overview' | 'regions' | 'families';

interface BoundaryRegionSummary {
  region: string;
  inboundCount: number;
  outboundCount: number;
  totalWeight: number;
  neighborCount: number;
  families: string[];
}

interface BoundaryFamilySummary {
  family: string;
  relationshipCount: number;
  totalWeight: number;
  regionCount: number;
  regions: string[];
}

function totalBoundaryWeight(aggregate: ModuleBoundaryAggregate): number {
  return aggregate.directWeight + aggregate.projectedWeight + aggregate.supportingWeight;
}

export function compareByBoundaryWeight(
  left: ModuleBoundaryAggregate,
  right: ModuleBoundaryAggregate
): number {
  return (
    totalBoundaryWeight(right) - totalBoundaryWeight(left) ||
    compareCodeUnits(left.sourceRegion, right.sourceRegion) ||
    compareCodeUnits(left.targetRegion, right.targetRegion)
  );
}

function applyBoundaryFocus(
  aggregates: ModuleBoundaryAggregate[],
  focusRegion?: string,
  focusDirection: BoundaryFocusDirection = 'both'
): ModuleBoundaryAggregate[] {
  if (!focusRegion) return [...aggregates];

  return aggregates.filter((aggregate) => {
    if (focusDirection === 'inbound') {
      return aggregate.targetRegion === focusRegion;
    }

    if (focusDirection === 'outbound') {
      return aggregate.sourceRegion === focusRegion;
    }

    return aggregate.sourceRegion === focusRegion || aggregate.targetRegion === focusRegion;
  });
}

export function buildRegionSummaries(
  aggregates: ModuleBoundaryAggregate[]
): BoundaryRegionSummary[] {
  const summaries = new Map<
    string,
    {
      region: string;
      inboundCount: number;
      outboundCount: number;
      totalWeight: number;
      neighbors: Set<string>;
      families: Set<string>;
    }
  >();

  const upsert = (region: string) => {
    const existing = summaries.get(region);
    if (existing) return existing;

    const created = {
      region,
      inboundCount: 0,
      outboundCount: 0,
      totalWeight: 0,
      neighbors: new Set<string>(),
      families: new Set<string>(),
    };
    summaries.set(region, created);
    return created;
  };

  for (const aggregate of aggregates) {
    const weight = totalBoundaryWeight(aggregate);
    const source = upsert(aggregate.sourceRegion);
    source.outboundCount += 1;
    source.totalWeight += weight;
    source.neighbors.add(aggregate.targetRegion);
    for (const family of aggregate.families) source.families.add(family);

    const target = upsert(aggregate.targetRegion);
    target.inboundCount += 1;
    target.totalWeight += weight;
    target.neighbors.add(aggregate.sourceRegion);
    for (const family of aggregate.families) target.families.add(family);
  }

  return Array.from(summaries.values())
    .map((summary) => ({
      region: summary.region,
      inboundCount: summary.inboundCount,
      outboundCount: summary.outboundCount,
      totalWeight: summary.totalWeight,
      neighborCount: summary.neighbors.size,
      families: Array.from(summary.families).sort(),
    }))
    .sort(
      (left, right) =>
        right.totalWeight - left.totalWeight ||
        right.neighborCount - left.neighborCount ||
        compareCodeUnits(left.region, right.region)
    );
}

export function buildFamilySummaries(
  aggregates: ModuleBoundaryAggregate[]
): BoundaryFamilySummary[] {
  const summaries = new Map<
    string,
    {
      family: string;
      relationshipCount: number;
      totalWeight: number;
      regions: Set<string>;
    }
  >();

  for (const aggregate of aggregates) {
    const weight = totalBoundaryWeight(aggregate);
    for (const family of aggregate.families) {
      const existing = summaries.get(family) ?? {
        family,
        relationshipCount: 0,
        totalWeight: 0,
        regions: new Set<string>(),
      };
      existing.relationshipCount += 1;
      existing.totalWeight += weight;
      existing.regions.add(aggregate.sourceRegion);
      existing.regions.add(aggregate.targetRegion);
      summaries.set(family, existing);
    }
  }

  return Array.from(summaries.values())
    .map((summary) => ({
      family: summary.family,
      relationshipCount: summary.relationshipCount,
      totalWeight: summary.totalWeight,
      regionCount: summary.regions.size,
      regions: Array.from(summary.regions).sort(),
    }))
    .sort(
      (left, right) =>
        right.totalWeight - left.totalWeight ||
        right.relationshipCount - left.relationshipCount ||
        compareCodeUnits(left.family, right.family)
    );
}

function takeTop<T>(items: T[], top?: number): T[] {
  return top === undefined ? items : items.slice(0, top);
}

function runBoundaryExplore(
  program: Command,
  options: {
    json?: boolean;
    list?: string;
    focus?: string;
    top?: number;
  }
): void {
  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });

  const listKind = (options.list ?? 'overview') as BoundaryExploreListKind;
  if (!['overview', 'regions', 'families'].includes(listKind)) {
    console.error('Error: --list must be one of: overview, regions, families.');
    process.exit(1);
  }

  if (options.top !== undefined && (!Number.isFinite(options.top) || options.top < 1)) {
    console.error('Error: --top must be a positive integer.');
    process.exit(1);
  }

  const db = openCliReadIndex(dbPath, options.json ?? false);
  if (!db) return;

  const inspection = inspectOverlayTrustState(db);
  const trustLevel = deriveOverlayTrustLevelFromState(inspection.state);
  const aggregates = aggregateModuleBoundaryEvidence(db, {
    rootPath: corpusPath,
    mode: 'projected',
    minWeight: 0,
  });
  const regionSummaries = buildRegionSummaries(aggregates);
  const familySummaries = buildFamilySummaries(aggregates);

  const availableRegions = regionSummaries.map((summary) => summary.region);
  const availableFamilies = familySummaries.map((summary) => summary.family);
  const focusedNeighborhood = options.focus
    ? aggregates
        .filter(
          (aggregate) =>
            aggregate.sourceRegion === options.focus || aggregate.targetRegion === options.focus
        )
        .sort(compareByBoundaryWeight)
    : [];

  const overview = {
    trustLevel,
    relationshipCount: aggregates.length,
    regionCount: regionSummaries.length,
    familyCount: familySummaries.length,
    topRegions: takeTop(regionSummaries, options.top ?? 10),
    topFamilies: takeTop(familySummaries, options.top ?? 10),
    availableRegions,
    availableFamilies,
    focusRegion: options.focus ?? null,
    neighborhood:
      options.focus === undefined
        ? null
        : {
            region: options.focus,
            count: focusedNeighborhood.length,
            relationships: takeTop(focusedNeighborhood, options.top),
          },
  };

  if (options.json) {
    const payload =
      listKind === 'regions'
        ? {
            trustLevel,
            list: 'regions',
            count: regionSummaries.length,
            regions: takeTop(regionSummaries, options.top),
          }
        : listKind === 'families'
          ? {
              trustLevel,
              list: 'families',
              count: familySummaries.length,
              families: takeTop(familySummaries, options.top),
            }
          : overview;

    console.log(JSON.stringify(withReadTelemetry(payload), null, 2));
    db.close();
    return;
  }

  console.log(`\nBoundary Exploration`);
  console.log(`Trust Level: ${trustLevel}`);
  console.log(`Relationships: ${aggregates.length}`);
  console.log(`Regions: ${regionSummaries.length}`);
  console.log(`Families: ${familySummaries.length}`);

  if (listKind === 'families') {
    console.log('\nFamilies');
    for (const family of takeTop(familySummaries, options.top)) {
      console.log(
        `- ${family.family}  relationships=${family.relationshipCount} regions=${family.regionCount} weight=${family.totalWeight.toFixed(2)}`
      );
    }
    db.close();
    return;
  }

  console.log('\nRegions');
  for (const region of takeTop(regionSummaries, options.top ?? 10)) {
    console.log(
      `- ${region.region}  inbound=${region.inboundCount} outbound=${region.outboundCount} neighbors=${region.neighborCount} weight=${region.totalWeight.toFixed(2)}`
    );
  }

  if (listKind === 'overview') {
    console.log('\nFamilies');
    for (const family of takeTop(familySummaries, options.top ?? 10)) {
      console.log(
        `- ${family.family}  relationships=${family.relationshipCount} regions=${family.regionCount} weight=${family.totalWeight.toFixed(2)}`
      );
    }
  }

  if (options.focus) {
    console.log(`\nNeighborhood: ${options.focus}`);
    if (focusedNeighborhood.length === 0) {
      console.log('No relationships found for that region.');
    } else {
      for (const aggregate of takeTop(focusedNeighborhood, options.top ?? 10)) {
        console.log(
          `- ${aggregate.sourceRegion} -> ${aggregate.targetRegion}  ${aggregate.relationshipKind}  weight=${totalBoundaryWeight(aggregate).toFixed(2)}`
        );
      }
    }
  }

  db.close();
}

function runBoundaryAggregates(
  program: Command,
  options: {
    json?: boolean;
    directOnly?: boolean;
    minWeight?: number;
    focus?: string;
    focusDirection?: string;
    top?: number;
    includePaths?: boolean;
  }
): void {
  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });

  const focusDirection = (options.focusDirection ?? 'both') as BoundaryFocusDirection;
  if (!['inbound', 'outbound', 'both'].includes(focusDirection)) {
    console.error('Error: --focus-direction must be one of: inbound, outbound, both.');
    process.exit(1);
  }

  if (options.top !== undefined && (!Number.isFinite(options.top) || options.top < 1)) {
    console.error('Error: --top must be a positive integer.');
    process.exit(1);
  }

  const db = openCliReadIndex(dbPath, options.json ?? false);
  if (!db) return;

  const inspection = inspectOverlayTrustState(db);
  const trustLevel = deriveOverlayTrustLevelFromState(inspection.state);
  const baseAggregates = aggregateModuleBoundaryEvidence(db, {
    rootPath: corpusPath,
    mode: options.directOnly ? 'direct-only' : 'projected',
    minWeight: options.minWeight ?? 0,
  });
  let aggregates = applyBoundaryFocus(baseAggregates, options.focus, focusDirection).sort(
    compareByBoundaryWeight
  );
  const totalCount = aggregates.length;

  if (options.top !== undefined) {
    aggregates = aggregates.slice(0, options.top);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        withReadTelemetry({
          trustLevel,
          mode: options.directOnly ? 'direct-only' : 'projected',
          focusRegion: options.focus ?? null,
          focusDirection: options.focus ? focusDirection : null,
          totalCount,
          count: aggregates.length,
          aggregates,
        }),
        null,
        2
      )
    );
    db.close();
    return;
  }

  console.log(`\nBoundary Aggregates: ${aggregates.length}`);
  console.log(`Trust Level: ${trustLevel}`);
  console.log(`Mode: ${options.directOnly ? 'direct-only' : 'projected'}`);
  if (options.focus) {
    console.log(`Focus: ${options.focus} (${focusDirection})`);
  }
  if (options.top !== undefined) {
    console.log(`Top: ${aggregates.length} of ${totalCount}`);
  }

  if (aggregates.length === 0) {
    console.log('No module-boundary relationships found.');
    db.close();
    return;
  }

  for (const aggregate of aggregates) {
    console.log(
      `${aggregate.sourceRegion} -> ${aggregate.targetRegion}  ${aggregate.relationshipKind}  ` +
        `direct=${aggregate.directWeight.toFixed(2)} projected=${aggregate.projectedWeight.toFixed(2)} supporting=${aggregate.supportingWeight.toFixed(2)}`
    );
    console.log(`  families: ${aggregate.families.join(', ')}`);
    console.log(`  why: ${aggregate.rationaleSummary}`);
    const samplePaths = options.includePaths
      ? aggregate.samplePaths
      : aggregate.samplePaths.slice(0, 1);
    for (const [index, sample] of samplePaths.entries()) {
      const transit =
        sample.transitFiles && sample.transitFiles.length > 0
          ? ` via ${sample.transitFiles.join(', ')}`
          : '';
      const sampleLabel = samplePaths.length > 1 ? `sample ${index + 1}` : 'sample';
      console.log(`  ${sampleLabel}: ${sample.pathKind}${transit}`);
      if (options.includePaths) {
        for (const provenance of sample.provenanceSummary) {
          console.log(`    - ${provenance}`);
        }
      }
    }
  }

  db.close();
}

export function addOverlayCommands(program: Command): void {
  const overlayCmd = program
    .command('overlay')
    .description('Inspect and validate the structural overlay state.');

  // --------------------------------------------------------------------------
  // overlay status
  // --------------------------------------------------------------------------

  overlayCmd
    .command('status')
    .description('Display the current structural overlay trust state.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .action((options: { json?: boolean }) => {
      const opts = program.opts();
      const runtime = resolveRuntimePaths({
        corpus: opts.corpus as string | undefined,
        db: opts.db as string | undefined,
      });
      const db = openCliReadIndex(runtime.dbPath, options.json ?? false);
      if (!db) return;

      const inspection = inspectOverlayTrustState(db);
      const overlay = inspection.state;
      const diagnostics = describeOverlayTrustInspection(inspection);

      if (options.json) {
        console.log(
          JSON.stringify(withReadTelemetry(buildOverlayStatusPayload(db, runtime)), null, 2)
        );
      } else if (!overlay) {
        console.log('\nOverlay Status: none');
        console.log(`Trust Level: ${diagnostics.trustLevel}`);
        for (const warning of diagnostics.warnings) {
          console.log(warning);
        }
      } else {
        console.log(`\nOverlay Status: ${overlay.mode}`);
        console.log(`Trust Level: ${diagnostics.trustLevel}`);
        console.log(`Surfaces: ${overlay.surfaceCount}`);
        console.log(
          `Provider kinds: ${overlay.controllerBackedCount} controller-backed, ${overlay.closureBackedCount} closure-backed, ${overlay.unknownProviderKindCount} unknown`
        );
        console.log(`Nodes: ${overlay.fileNodeCount} files, ${overlay.symbolNodeCount} symbols`);
        console.log(`Trust source: ${inspection.source}`);
        if (overlay.lastIndexedCommit) {
          console.log(`Indexed commit: ${overlay.lastIndexedCommit.slice(0, 8)}`);
        }
        if (overlay.recordedAt) {
          console.log(`Trust recorded: ${overlay.recordedAt}`);
        }
        for (const w of overlay.warnings) {
          console.warn(`Warning: ${w}`);
        }
      }

      // Freshness (Decision 1) — computed on read, never persisted.
      if (!options.json) {
        for (const line of renderFreshnessText(
          assessWorkingTreeFreshness(runtime.corpusPath, db)
        )) {
          console.log(line);
        }
      }

      db.close();
    });

  // --------------------------------------------------------------------------
  // overlay check
  // --------------------------------------------------------------------------

  overlayCmd
    .command('check')
    .description(
      'Assert that the structural overlay is present and non-degraded.\n' +
        '  Exits 0 when surfaces, file nodes, and symbol nodes are all present.\n' +
        '  Exits 1 with a diagnostic when the overlay is absent or degraded.\n' +
        '  Use this as a pre-flight gate in validation scripts and benchmarks.'
    )
    .action(() => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });
      const db = openCliReadIndex(dbPath, false);
      if (!db) return;

      const inspection = inspectOverlayTrustState(db);
      const overlay = inspection.state;
      const trustLevel = deriveOverlayTrustLevelFromState(overlay);

      db.close();

      if (!overlay) {
        console.error('Error: No structural overlay trust state found in database.');
        console.error('  Trust level: no-overlay');
        console.error('  Run "lux index rebuild" to build the canonical overlay-complete index.');
        process.exit(1);
      }

      if (trustLevel !== 'overlay-complete') {
        console.error(
          `Error: Overlay trust level is ${trustLevel} (persisted mode: ${overlay.mode}), not overlay-complete.`
        );
        for (const warning of overlay.warnings) {
          console.error(`  Warning: ${warning}`);
        }
        console.error('  Run "lux index rebuild" to restore the canonical overlay-complete state.');
        process.exit(1);
      }

      console.log(
        `Overlay check passed: ${overlay.surfaceCount} surface(s), ` +
          `${overlay.fileNodeCount} file node(s), ${overlay.symbolNodeCount} symbol node(s).`
      );
    });

  // --------------------------------------------------------------------------
  // overlay ownership — kernel↔client handler ownership map (E1)
  // --------------------------------------------------------------------------

  overlayCmd
    .command('ownership')
    .description(
      'Show HTTP handler ownership across the app/kernel boundary ' +
        '(kernel-owned / client-override / client-gap / external).'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--kernel [path]',
      'Cross-area mode: classify against the vendored kernel index (overlay.kernel.package)'
    )
    .action((options: { json?: boolean; kernel?: string | boolean }) => {
      const opts = program.opts();
      const runtime = resolveRuntimePaths({
        corpus: opts.corpus as string | undefined,
        db: opts.db as string | undefined,
      });
      const db = openCliReadIndex(runtime.dbPath, options.json ?? false);
      if (!db) return;
      try {
        if (options.kernel !== undefined) {
          // Cross-area mode is opt-in via --kernel; the kernel package comes from lux.yaml.
          // (loadLspConfig is read only here, so a malformed lux.yaml can't affect single-index.)
          const kernelCfg = loadLspConfig(runtime.corpusPath).overlay?.kernel;
          if (!kernelCfg?.package) {
            console.error(
              'Error: cross-area ownership (--kernel) needs `overlay.kernel.package` in lux.yaml.'
            );
            process.exit(1);
          }
          const override = typeof options.kernel === 'string' ? options.kernel : undefined;
          let kernel: ResolvedKernel;
          try {
            kernel = resolveKernel(runtime.corpusPath, kernelCfg, override);
          } catch (error) {
            console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
          }
          const map = classifyCrossAreaOwnership(
            db,
            kernel,
            resolveAppNamespace(runtime.corpusPath)
          );
          const stale = Boolean(
            kernel.indexedCommit && kernel.headCommit && kernel.indexedCommit !== kernel.headCommit
          );
          if (options.json) {
            console.log(
              JSON.stringify(
                withReadTelemetry({
                  kernel: {
                    package: kernelCfg.package,
                    worktree: kernel.worktree,
                    indexedCommit: kernel.indexedCommit ?? null,
                    headCommit: kernel.headCommit ?? null,
                    stale,
                  },
                  summary: map.summary,
                  routes: map.routes,
                }),
                null,
                2
              )
            );
            return;
          }
          const clientLocal = map.summary['client-local'];
          const kernelRoutes = map.routes.length - clientLocal; // the kernel-route partition
          console.log(
            `\nCross-area HTTP handler ownership vs ${kernelCfg.package} (${kernelRoutes} kernel route(s)):`
          );
          for (const label of [
            'kernel-owned',
            'client-override',
            'client-gap',
            'external',
          ] as const) {
            const count = map.summary[label];
            if (count === 0) continue;
            const pct = kernelRoutes > 0 ? ((100 * count) / kernelRoutes).toFixed(1) : '0.0';
            console.log(`  ${label.padEnd(16)} ${String(count).padStart(5)}  (${pct}%)`);
          }
          if (clientLocal > 0) {
            console.log(
              `  ${'client-local'.padEnd(16)} ${String(clientLocal).padStart(5)}  (client's own routes)`
            );
          }
          if (map.summary['client-gap'] > 0) {
            console.log(
              `\n  ${map.summary['client-gap']} client-gap: kernel routes with no handler implemented in this client.`
            );
          }
          if (stale) {
            console.log(
              `\n  ⚠ kernel index (${kernel.indexedCommit?.slice(0, 7)}) differs from the vendored worktree HEAD (${kernel.headCommit?.slice(0, 7)}) — re-index the kernel.`
            );
          }
          return;
        }

        // single-index mode (unchanged)
        const rows = db.getOwnershipBreakdown();
        const total = rows.reduce((n, r) => n + r.count, 0);
        if (options.json) {
          console.log(JSON.stringify(withReadTelemetry({ total, breakdown: rows }), null, 2));
          return;
        }
        console.log(`\nHTTP handler ownership (${total} handler edge(s)):`);
        if (total === 0) {
          console.log('  (no handler edges — run `lux index rebuild`)');
          return;
        }
        for (const r of rows) {
          const label = r.ownership ?? 'unclassified';
          const pct = ((100 * r.count) / total).toFixed(1);
          console.log(`  ${label.padEnd(16)} ${String(r.count).padStart(5)}  (${pct}%)`);
        }
        const gap = rows.find((r) => r.ownership === 'client-gap');
        if (gap && gap.count > 0) {
          console.log(
            `\n  ${gap.count} client-gap: kernel routes with no handler implemented in this app.`
          );
        }
      } finally {
        db.close();
      }
    });

  // --------------------------------------------------------------------------
  // overlay boundaries
  // --------------------------------------------------------------------------

  const boundariesCmd = overlayCmd
    .command('boundaries')
    .description(
      'Aggregate module-boundary relationships from persisted structural evidence.\n' +
        '  Emits explainable region relationships that distinguish direct, projected,\n' +
        '  and supporting evidence tiers.'
    );

  boundariesCmd
    .command('explore')
    .description(
      'List available boundary regions, evidence families, and lightweight neighborhood summaries\n' +
        '  so callers can explore the space before issuing focused boundary queries.'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--list <kind>',
      'What to list: overview, regions, or families (default: overview)',
      'overview'
    )
    .option('--focus <region>', 'Show neighborhood information centered on the given region')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((options: { json?: boolean; list?: string; focus?: string; top?: number }) => {
      runBoundaryExplore(program, options);
    });

  boundariesCmd
    .command('show')
    .description(
      'Show aggregated module-boundary relationships from persisted structural evidence.'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--direct-only',
      'Disable projected-through-glue contribution and show only direct structural paths'
    )
    .option(
      '--min-weight <value>',
      'Filter out low-weight relationships (default: 0)',
      (value) => Number.parseFloat(value),
      0
    )
    .option('--focus <region>', 'Limit output to relationships connected to the given region')
    .option(
      '--focus-direction <direction>',
      'When used with --focus, show inbound, outbound, or both relationships (default: both)',
      'both'
    )
    .option('--top <count>', 'Limit output to the top N relationships after filtering', (value) =>
      Number.parseInt(value, 10)
    )
    .option(
      '--include-paths',
      'In text output, show all available sample paths with provenance instead of just the first sample'
    )
    .action(
      (options: {
        json?: boolean;
        directOnly?: boolean;
        minWeight?: number;
        focus?: string;
        focusDirection?: string;
        top?: number;
        includePaths?: boolean;
      }) => {
        runBoundaryAggregates(program, options);
      }
    );

  boundariesCmd
    .command('list-regions')
    .description('List discovered boundary regions.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((options: { json?: boolean; top?: number }) => {
      runBoundaryExplore(program, { ...options, list: 'regions' });
    });

  boundariesCmd
    .command('list-families')
    .description('List discovered boundary evidence families.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((options: { json?: boolean; top?: number }) => {
      runBoundaryExplore(program, { ...options, list: 'families' });
    });

  boundariesCmd
    .command('neighborhood <region>')
    .description('Show the local boundary neighborhood around a region.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((region: string, options: { json?: boolean; top?: number }) => {
      runBoundaryExplore(program, { ...options, focus: region, list: 'overview' });
    });

  // --------------------------------------------------------------------------
  // overlay operational
  // --------------------------------------------------------------------------

  const operationalCmd = overlayCmd
    .command('operational')
    .description('Inspect evidence-first retrieval views over persisted operational boundaries.');

  operationalCmd
    .command('ask <question...>')
    .description('Return one evidence packet about schedules, dispatch, listeners, or support.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--target <name>', 'Boundary name/signature/event/job to answer about')
    .option('--kind <kind>', 'Disambiguate target kind: command, schedule, job, event, or http')
    .option(
      '--max-depth <count>',
      'Trust-aware neighborhood depth to include for neighborhood questions (default: 2)',
      (value) => Number.parseInt(value, 10),
      2
    )
    .option(
      '--min-trust-tier <tier>',
      'Minimum edge trust tier to include in the neighborhood (default: 1)',
      (value) => Number.parseInt(value, 10),
      1
    )
    .action(
      (
        question: string[],
        options: {
          json?: boolean;
          target?: string;
          kind?: 'command' | 'schedule' | 'job' | 'event' | 'http';
          maxDepth?: number;
          minTrustTier?: number;
        }
      ) => {
        runOperationalAsk(program, question, options);
      }
    );

  // --------------------------------------------------------------------------
  // overlay feature-path
  // --------------------------------------------------------------------------

  const featurePathCmd = overlayCmd
    .command('feature-path')
    .description(
      'Inspect evidence-first retrieval views over persisted feature paths (tranche one).'
    );

  featurePathCmd
    .command('ask <question...>')
    .description(
      'Return one evidence packet for a route-centered feature path: handler, contract, ownership, persisted consumers, downstream.'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--target <fragment>',
      'Override the question fragment used for capability-surface resolution'
    )
    .action((question: string[], options: { json?: boolean; target?: string }) => {
      runFeaturePathAsk(program, question, options);
    });

  // --------------------------------------------------------------------------
  // overlay spec-evidence
  // --------------------------------------------------------------------------

  const specEvidenceCmd = overlayCmd
    .command('spec-evidence')
    .description(
      'Emit source-grounded spec-derivation evidence packets for a single route, handler, job, listener, or command target.'
    );

  specEvidenceCmd
    .command('ask <question...>')
    .description('Return one source-evidence packet for downstream specification derivation.')
    .option('--json', 'Emit the SpecDerivationEvidencePacketV1 JSON contract')
    .option('--target <target>', 'Route, handler, job, listener, or command target to resolve')
    .option('--kind <kind>', 'Target kind: route, handler, job, listener, or command')
    .option('--out <path>', 'Write a single-target JSON or Markdown review artifact')
    .action(
      (
        question: string[],
        options: {
          json?: boolean;
          target?: string;
          kind?: string;
          out?: string;
        }
      ) => {
        runSpecEvidenceAsk(program, question, options);
      }
    );
}
