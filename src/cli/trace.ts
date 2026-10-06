import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import {
  resolveStartNode,
  traceFrom,
  type TraceNode,
  type TraceResult,
} from '../scanner/associations/trace.js';
import {
  traverseStructuralGraph,
  type TraversalDirection,
  type TraversalNodeV1,
  type TraversalResultV1,
} from '../scanner/associations/traversal/index.js';
import type { ConfidenceClass, EdgeType } from '../db/types.js';
import { summarizeStaleSupport, staleSupportWarning } from '../scanner/freshness.js';
import {
  resolveSiblings,
  buildFederationBlock,
  siblingFaultRefusal,
  type SiblingResolution,
} from '../scanner/siblings.js';
import {
  traceFromFederated,
  traverseFromFederated,
  type FederatedTraceNode,
  type FederatedTraceResult,
  type FederatedTraversalResult,
} from '../scanner/associations/federation-trace.js';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';

export function addTraceCommand(program: Command): void {
  program
    .command('trace <symbol>')
    .description('Trace calls from a symbol across the app→vendor boundary')
    .option(
      '--direction <direction>',
      'Traversal direction: outgoing, incoming, or both',
      'outgoing'
    )
    .option('--depth <n>', 'Max hops to follow', (v) => parseInt(v, 10), 8)
    .option('--max-nodes <n>', 'Total node budget', (v) => parseInt(v, 10), 2000)
    .option(
      '--max-fanout <n>',
      'Combined per-node edge budget across directions and repositories',
      (v) => parseInt(v, 10),
      64
    )
    .option('--edge-types <list>', 'Comma-separated edge types', 'calls,references')
    .option(
      '--min-confidence <class>',
      'proven|artifact-backed|framework-inferred|heuristic',
      'framework-inferred'
    )
    .option('--no-external', 'Do not follow edges into vendor nodes')
    .option('--with <list>', 'Federate the trace across registered siblings (name[,name…]|all)')
    .option('--json', 'Output as JSON')
    .action(
      (
        symbol: string,
        options: {
          direction: string;
          depth: number;
          maxNodes: number;
          maxFanout: number;
          edgeTypes: string;
          minConfidence: string;
          external: boolean;
          with?: string;
          json?: boolean;
        }
      ) => {
        if (!isTraversalDirection(options.direction)) {
          console.error('Error: --direction must be one of: outgoing, incoming, both.');
          process.exitCode = 1;
          return;
        }
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
        const dbPath = resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined });
        const db = openCliReadIndex(dbPath, options.json ?? false);
        if (!db) return;

        try {
          const resolved = resolveStartNode(db, symbol);
          if ('notFound' in resolved) {
            console.error(`No structural symbol found for: ${symbol}`);
            console.error('Run "lux index rebuild" first, or pass a fully-qualified name.');
            process.exitCode = 1;
            return;
          }
          if ('ambiguous' in resolved) {
            console.error(
              `Ambiguous symbol "${symbol}" — ${resolved.ambiguous.length} candidates:`
            );
            for (const c of resolved.ambiguous) {
              console.error(`  ${c.qualified_name ?? c.symbol_name}  (${c.id})`);
            }
            console.error('Re-run with a fully-qualified name or the exact node id.');
            process.exitCode = 1;
            return;
          }

          // Federated branch (Decision 5): opt-in via --with, strictly additive. Returns BEFORE the
          // shipped traceFrom + staleSupport path below, so a no-`--with` invocation is byte-identical
          // to current main (688c5e8). Sibling handles are read-only and closed in a finally (SC-7).
          if (options.with) {
            const primarySchema = db.getAppliedSchemaVersion();
            const names =
              options.with === 'all'
                ? ('all' as const)
                : options.with
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
            const resolutions = resolveSiblings(corpusPath, names, primarySchema);
            const handles: Array<{ name: string; role: 'kernel' | 'peer'; db: LuxDatabase }> = [];
            // FIX 1: opening a resolved sibling runs AFTER resolve, so a post-resolve fault (TOCTOU
            // delete/re-index, cross-process busy-timeout, or a file that faults on re-open) must
            // degrade THAT sibling — not abort the whole federated trace. Rewrite its resolution to a
            // refusal so the federation block stays consistent (attached:false + reason), warn, and
            // continue with the healthy handles. The finally below closes every opened handle (SC-7).
            const effectiveResolutions: SiblingResolution[] = [];
            try {
              for (const r of resolutions) {
                if (!('sibling' in r)) {
                  // Decision 6: an unresolvable named sibling degrades — warn, never silently drop
                  // (it stays visible as attached:false in the federation block).
                  effectiveResolutions.push(r);
                  console.error(`  ⚠ sibling '${r.name}': ${r.refusal.message}`);
                  continue;
                }
                try {
                  const handle = LuxDatabase.openSiblingReadOnly(r.sibling.dbPath, primarySchema);
                  handles.push({ name: r.sibling.name, role: r.sibling.role, db: handle });
                  effectiveResolutions.push(r);
                } catch (error) {
                  // lux-intentional-swallow: reported to the user as a sibling refusal just below.
                  const refusal = siblingFaultRefusal(r.sibling.name, error);
                  effectiveResolutions.push({ name: r.sibling.name, refusal });
                  console.error(`  ⚠ sibling '${r.sibling.name}': ${refusal.message}`);
                }
              }
              const traversalOptions = {
                maxDepth: options.depth,
                maxNodes: options.maxNodes,
                edgeTypes: options.edgeTypes.split(',').map((s) => s.trim()) as EdgeType[],
                minConfidenceClass: options.minConfidence as ConfidenceClass,
                includeExternal: options.external,
              };
              const federation = buildFederationBlock(effectiveResolutions);
              if (options.direction === 'outgoing') {
                // Keep the established federated function and renderer intact: omitted direction
                // and explicit `outgoing` retain the shipped result bytes.
                const result = traceFromFederated(
                  db,
                  handles,
                  resolved.nodeId,
                  federation,
                  traversalOptions
                );
                console.log(
                  options.json
                    ? JSON.stringify(withReadTelemetry(result), null, 2)
                    : renderFederatedTrace(result)
                );
              } else {
                const result = traverseFromFederated(db, handles, resolved.nodeId, federation, {
                  ...traversalOptions,
                  direction: options.direction,
                  maxFanout: options.maxFanout,
                });
                console.log(
                  options.json
                    ? JSON.stringify(withReadTelemetry(result), null, 2)
                    : renderFederatedTraversal(result)
                );
              }
            } finally {
              for (const h of handles) h.db.close();
            }
            return;
          }

          if (options.direction !== 'outgoing') {
            const result = traverseStructuralGraph(db, resolved.nodeId, {
              direction: options.direction,
              maxDepth: options.depth,
              maxNodes: options.maxNodes,
              maxFanout: options.maxFanout,
              edgeTypes: options.edgeTypes.split(',').map((s) => s.trim()) as EdgeType[],
              minConfidenceClass: options.minConfidence as ConfidenceClass,
              includeExternal: options.external,
            });
            console.log(
              options.json
                ? JSON.stringify(withReadTelemetry(result), null, 2)
                : renderTraversalTrace(result)
            );
            return;
          }

          // Keep the established outgoing implementation and renderers intact: an omitted
          // direction and explicit --direction outgoing retain the shipped byte contract.
          const result = traceFrom(db, resolved.nodeId, {
            maxDepth: options.depth,
            maxNodes: options.maxNodes,
            edgeTypes: options.edgeTypes.split(',').map((s) => s.trim()) as EdgeType[],
            minConfidenceClass: options.minConfidence as ConfidenceClass,
            includeExternal: options.external,
          });

          // Stale-aware annotation (Decision 4 / SC-4): read-only — report how many of the traced
          // path edges the maintained marks already flag `stale`. Never changes the resolution.
          const staleSupport = summarizeStaleSupport(
            db.getEdgeFreshnessByIds(result.edges.map((e) => e.id))
          );

          if (options.json) {
            console.log(JSON.stringify(withReadTelemetry({ ...result, staleSupport }), null, 2));
            return;
          }
          const staleWarning = staleSupportWarning(staleSupport);
          if (staleWarning) console.warn('Warning: ' + staleWarning);
          printTrace(result);
        } finally {
          db.close();
        }
      }
    );
}

function isTraversalDirection(value: string): value is TraversalDirection {
  return value === 'outgoing' || value === 'incoming' || value === 'both';
}

/** Pretty-print the trace DAG as an indented tree rooted at the start node. */
function printTrace(result: TraceResult): void {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, { edge: (typeof result.edges)[number]; targetId: string }[]>();
  for (const e of result.edges) {
    if (!childrenOf.has(e.sourceId)) childrenOf.set(e.sourceId, []);
    childrenOf.get(e.sourceId)!.push({ edge: e, targetId: e.targetId });
  }

  const start = byId.get(result.startId);
  if (!start) return;

  console.log(`\nTrace from ${start.label}`);
  console.log(
    `  depth≤${result.options.maxDepth}  edges:${result.options.edgeTypes.join('/')}  ` +
      `min-confidence:${result.options.minConfidenceClass}\n`
  );

  const seen = new Set<string>();
  const line = (node: TraceNode, prefix: string, edge?: (typeof result.edges)[number]) => {
    const tag = node.external ? ' [vendor]' : '';
    const conf = edge ? `  {${abbrev(edge.confidenceClass)} ${edge.confidence.toFixed(2)}}` : '';
    const term = terminusLabel(node);
    console.log(`${prefix}${node.label}${tag}${conf}${term}`);
  };

  const render = (
    id: string,
    prefix: string,
    isLast: boolean,
    edge?: (typeof result.edges)[number]
  ) => {
    const node = byId.get(id);
    if (!node) return;
    const branch = prefix === '' ? '' : isLast ? '└─ ' : '├─ ';
    line(node, prefix + branch, edge);
    if (seen.has(id)) return; // cycle / shared node — print once, don't recurse
    seen.add(id);
    if (node.terminus === 'dynamic-dispatch-boundary') return; // stop at boundary
    const kids = (childrenOf.get(id) ?? []).filter((k) => !k.edge.revisit);
    const childPrefix = prefix + (prefix === '' ? '' : isLast ? '   ' : '│  ');
    kids.forEach((k, i) => render(k.targetId, childPrefix, i === kids.length - 1, k.edge));
  };

  render(result.startId, '', true);

  console.log(
    `\n${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges, ` +
      `${result.stats.externalCount} vendor, ${result.stats.dispatchBoundaries} dispatch boundaries` +
      (result.stats.truncated ? ' (truncated — raise --depth/--max-nodes)' : '')
  );
}

/** Render a directional traversal while retaining each edge's stored source → target endpoints. */
function renderTraversalTrace(result: TraversalResultV1): string {
  const lines: string[] = [];
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const start = byId.get(result.startId);

  lines.push(`\nTrace ${result.options.direction} from ${start?.label ?? result.startId}`);
  lines.push(
    `  depth≤${result.options.maxDepth}  edges:${result.options.edgeTypes.join('/')}  ` +
      `min-confidence:${result.options.minConfidenceClass}\n`
  );

  for (const node of result.nodes) {
    lines.push(`${'  '.repeat(node.depth)}${traversalNodeLabel(node)}`);
    for (const edge of result.edges.filter((candidate) =>
      candidate.traversed === 'forward'
        ? candidate.source_node_id === node.id
        : candidate.target_node_id === node.id
    )) {
      const marker = edge.traversed === 'forward' ? '→' : '←';
      lines.push(
        `${'  '.repeat(node.depth + 1)}${marker} ` +
          `${edge.source_node_id} → ${edge.target_node_id}  ` +
          `[${edge.edge_type}, ${edge.traversed}]  ` +
          `{${abbrev(edge.confidence_class)} ${edge.confidence.toFixed(2)}}`
      );
    }
  }

  const freshness = result.stats.freshness;
  lines.push(
    `\n${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges, ` +
      `${result.stats.externalCount} vendor, ${result.stats.dispatchBoundaries} dispatch boundaries` +
      (result.stats.truncated ? ' (truncated — raise --depth/--max-nodes)' : '')
  );
  lines.push(
    `Freshness: ${freshness.fresh} fresh, ${freshness.stale} stale, ` +
      `${freshness.dirtyDependent} dirty-dependent, ${freshness.unknown} unknown`
  );
  return lines.join('\n');
}

function traversalNodeLabel(node: TraversalNodeV1): string {
  const vendor = node.external ? ' [vendor]' : '';
  const term = terminusLabel(node);
  return `${node.label}${vendor}${term}`;
}

function abbrev(c: ConfidenceClass): string {
  return { proven: 'prv', 'artifact-backed': 'art', 'framework-inferred': 'fwk', heuristic: 'heu' }[
    c
  ];
}

function terminusLabel(n: TraceNode): string {
  switch (n.terminus) {
    case 'dynamic-dispatch-boundary':
      return `  ⟿ dispatch boundary (${n.dispatch?.dispatchKind}, re-entry deferred)`;
    case 'depth-limit':
      return '  ⋯ depth limit';
    case 'node-budget':
      return '  ⋯ node budget';
    case 'fanout-cap':
      return '  ⋯ fan-out capped';
    case 'leaf':
      return '';
    default:
      return '';
  }
}

/** Render directional federation with canonical endpoints and per-edge traversal/provenance. */
function renderFederatedTraversal(r: FederatedTraversalResult): string {
  const lines: string[] = [];
  const start = r.nodes.find((node) => node.id === r.startId && node.repo === 'main');
  lines.push(`\nFederated trace ${r.options.direction} from ${start?.label ?? r.startId}`);
  lines.push(
    `  repos: ${r.stats.reposReached.join(', ')}  ·  ${r.stats.nodeCount} nodes, ` +
      `${r.stats.edgeCount} edges, ${r.stats.bridgedCount} bridged` +
      (r.stats.truncated ? ' (truncated — raise --depth/--max-nodes)' : '')
  );
  for (const edge of r.edges) {
    const marker = edge.traversed === 'forward' ? '→' : '←';
    lines.push(
      `  ${marker} ${edge.source_node_id} → ${edge.target_node_id}  ` +
        `[${edge.edge_type}, ${edge.traversed}; ${edge.repos.join(', ')}]  ` +
        `{${abbrev(edge.confidence_class)} ${edge.confidence.toFixed(2)}}`
    );
  }
  const freshness = r.stats.freshness;
  lines.push(
    `Freshness: ${freshness.fresh} fresh, ${freshness.stale} stale, ` +
      `${freshness.dirtyDependent} dirty-dependent, ${freshness.unknown} unknown`
  );
  for (const sibling of r.federation.siblings) {
    if (sibling.attached && sibling.freshness) {
      const drift =
        sibling.freshness.stale == null
          ? 'drift unknown'
          : sibling.freshness.stale
            ? 'STALE'
            : 'fresh';
      lines.push(
        `  sibling ${sibling.name}: schema ${sibling.freshness.dbSchemaVersion ?? '?'}  ${drift}`
      );
    } else if (sibling.refusal) {
      lines.push(`  ⚠ sibling ${sibling.name}: ${sibling.refusal.message}`);
    }
  }
  return lines.join('\n');
}

/** Compact renderer for a federated trace: nodes grouped by repo, bridged/×N/vendor marks, then the
 *  per-sibling freshness block (SC-9). Distinct from printTrace — a different result shape. */
function renderFederatedTrace(r: FederatedTraceResult): string {
  const lines: string[] = [];
  const start = r.nodes.find((n) => n.id === r.startId);
  lines.push(`\nFederated trace from ${start?.label ?? r.startId}`);
  lines.push(
    `  repos: ${r.stats.reposReached.join(', ')}  ·  ${r.stats.nodeCount} nodes, ` +
      `${r.stats.edgeCount} edges, ${r.stats.bridgedCount} bridged` +
      (r.stats.truncated ? ' (truncated — raise --depth/--max-nodes)' : '')
  );
  const byRepo = new Map<string, FederatedTraceNode[]>();
  for (const n of r.nodes) {
    if (!byRepo.has(n.repo)) byRepo.set(n.repo, []);
    byRepo.get(n.repo)!.push(n);
  }
  for (const [repo, ns] of byRepo) {
    lines.push(`\n  [${repo}] (${ns.length})`);
    for (const n of ns.slice(0, 40)) {
      const marks = [
        n.bridged ? 'bridged' : '',
        n.repos && n.repos.length > 1 ? `×${n.repos.length}` : '',
        n.external ? 'vendor' : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`    ${n.label}${marks ? `  [${marks}]` : ''}`);
    }
  }
  lines.push('');
  for (const s of r.federation.siblings) {
    if (s.attached && s.freshness) {
      const drift =
        s.freshness.stale == null ? 'drift unknown' : s.freshness.stale ? 'STALE' : 'fresh';
      lines.push(`  sibling ${s.name}: schema ${s.freshness.dbSchemaVersion ?? '?'}  ${drift}`);
    } else if (s.refusal) {
      lines.push(`  ⚠ sibling ${s.name}: ${s.refusal.message}`);
    }
  }
  return lines.join('\n');
}
