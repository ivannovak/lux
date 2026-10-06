#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tool-defs.js';
import { SearchRefusalError, coerceSearchLimit, resolveStoredPath } from '../db/index.js';
import { buildSearchReport, buildSearchRefusalReport } from '../cli/search-envelope.js';
import { GeneralScanner } from '../scanner/index.js';
import { attachEnrichment } from '../scanner/general.js';
import { rebuildWithOverlay } from '../scanner/rebuild-orchestrator.js';
import { persistRebuildTrustState } from '../scanner/overlay-trust-state.js';
import { readFileSync } from 'fs';
import { LUX_VERSION } from '../utils/version.js';
import { computeImpact } from '../cli/deps-impact.js';
import { buildIndexStatusPayload, buildOverlayStatusPayload } from '../cli/status-payload.js';
import { buildDoctorReport, inspectDoctorReport } from '../cli/doctor.js';
import { persistCoverageProducerRuns } from '../scanner/coverage/producer-runs.js';
import { getHeadCommit, isGitRepository } from '../scanner/git.js';
import { executeSpecEvidenceAsk } from '../cli/spec-evidence.js';
import { resolveStartNode, traceFrom } from '../scanner/associations/trace.js';
import {
  traceFromFederated,
  traverseFromFederated,
} from '../scanner/associations/federation-trace.js';
import {
  traverseStructuralGraph,
  type TraversalDirection,
} from '../scanner/associations/traversal/index.js';
import { runFederatedSearch } from '../scanner/search-federation.js';
import { openFederationHandles } from './federation-handles.js';
import { computeDelta } from '../scanner/delta/run.js';
import type { ConfidenceClass, EdgeType, RankedSearchResult } from '../db/types.js';
import {
  createInvocationId,
  emitUsageEvent,
  safeUsageTrustState,
} from '../db/observability/usage-event.js';
import { withReadTelemetry } from '../cli/read-index.js';
import { runAnchorSearch, anchorRefusalCoverage } from '../cli/anchor-search.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import { buildAnchorReport, buildAnchorRefusalReport } from '../cli/anchors-envelope.js';
import { coerceAnchorToolArgs } from './anchor-tool-args.js';
import {
  WorkspaceRuntime,
  WorkspaceUnavailableError,
  workspaceUnavailablePayload,
  type WorkspaceLease,
} from './workspace-runtime.js';
import { installMcpDbNoticeHandler } from './db-notices.js';

// Before anything opens a database, so its notices reach stderr.
installMcpDbNoticeHandler();

/** Confidence classes delta/trace understand. Mirrors the CLI guard (`src/cli/delta.ts`): an
 *  out-of-enum `min_confidence` (e.g. "high") must NOT reach the reverse-walk as an unknown class —
 *  its rank would be `undefined`, the floor comparison always false, and the agent would get a
 *  confidently-wrong EMPTY (non-truncated) result. Fall back to the documented default instead. */
const CONFIDENCE_CLASSES: readonly ConfidenceClass[] = [
  'proven',
  'artifact-backed',
  'framework-inferred',
  'heuristic',
];

function resolveMinConfidence(value: unknown): ConfidenceClass {
  return typeof value === 'string' && (CONFIDENCE_CLASSES as readonly string[]).includes(value)
    ? (value as ConfidenceClass)
    : 'framework-inferred';
}

function resolveTraversalDirection(value: unknown): TraversalDirection {
  if (value === undefined) return 'outgoing';
  if (value === 'outgoing' || value === 'incoming' || value === 'both') return value;
  throw new RangeError('direction must be one of: outgoing, incoming, both');
}

// The runtime is fixed by explicit LUX_* overrides when present. Otherwise, roots-aware MCP clients
// select the active repository and can change it without restarting this long-lived server.
const workspace = new WorkspaceRuntime();

const server = new Server(
  {
    name: 'lux',
    version: LUX_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      'Use Lux first for non-trivial repository structure, concept-to-symbol discovery, call paths, ' +
      'consumers, dependency/change impact, boundaries, and indexed knowledge. Run a status preflight, ' +
      'verify the active workspace, preserve confidence classes, and inspect important source files. ' +
      'Use ordinary text search for a known literal in a known area.',
  }
);

let workspaceConfiguration: Promise<void> | null = null;
function ensureWorkspaceConfigured(): Promise<void> {
  if (!workspaceConfiguration) {
    const capabilities = server.getClientCapabilities();
    workspaceConfiguration = workspace.configureClient(
      capabilities?.roots ? () => server.listRoots() : null
    );
  }
  return workspaceConfiguration;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let lease: WorkspaceLease | null = null;

  try {
    await ensureWorkspaceConfigured();
    // Doctor must diagnose an absent/skewed index instead of failing before its checks. The
    // inspection service performs only a read-existing open and returns the same report as CLI.
    if (name === 'lux_doctor') {
      const runtime = await workspace.resolveRuntime();
      try {
        lease = await workspace.acquire('read-existing');
        const report = buildDoctorReport(lease.db, lease.runtime);
        return {
          content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(report), null, 2) }],
        };
      } catch (error) {
        // An absent/skewed index is a diagnostic input. `inspectDoctorReport` performs a separate
        // strict read-existing inspection so no index is created or migrated.
        if (error instanceof WorkspaceUnavailableError && error.reason === 'database-open-failed') {
          const report = inspectDoctorReport(runtime);
          return {
            content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(report), null, 2) }],
          };
        }
        throw error;
      }
    }

    const openMode =
      name === 'lux_rebuild_index'
        ? 'create-or-migrate'
        : name === 'lux_log_event'
          ? 'write-existing'
          : 'read-existing';
    lease = await workspace.acquire(openMode);
    const { db, runtime } = lease;
    const corpusPath = runtime.corpusPath;
    const dbPath = runtime.dbPath;
    switch (name) {
      case 'lux_search': {
        const {
          query,
          type = 'all',
          limit = 20,
        } = args as {
          query: string;
          type?: string;
          limit?: number;
        };
        // Validate/coerce the limit BEFORE it can reach `LIMIT ?` on EITHER branch (M2). An
        // injectable agent limit (negative → unbounded dump, 0 → fabricated empty, non-integer →
        // WASM hard-abort) is neutralized by the same shared rule the CLI/federated paths use.
        const safeLimit = coerceSearchLimit(limit);

        // Federated branch (Decision 5): opt-in via `with`, strictly additive. The single-repo path
        // below is unchanged. Sibling handles are read-only and closed in a finally (SC-7).
        const searchWith = Array.isArray(args?.with) ? (args.with as string[]) : undefined;
        if (searchWith && searchWith.length) {
          const fed = openFederationHandles(db, corpusPath, searchWith);
          try {
            let result;
            try {
              result = runFederatedSearch(db, fed.handles, query, fed.federation, safeLimit);
            } catch (error) {
              if (!(error instanceof SearchRefusalError)) throw error; // outer catch renders it
              // M1: an invalid FTS5 query fails identically for every group including `main`, so it is
              // a query-level refusal, not a per-sibling degrade. Surface the same structured refusal
              // (isError + refusal.reason, expression echoed) the single-repo path returns.
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      buildSearchRefusalReport({
                        query,
                        type: type === 'knowledge' ? 'knowledge' : 'all',
                        contentOnly: false,
                        limit: safeLimit,
                        refusal: {
                          reason: error.reason,
                          expression: error.expression,
                          message: error.message,
                        },
                      }),
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(result), null, 2) }],
            };
          } finally {
            fed.close();
          }
        }

        const contentOnly = args?.content_only === true;
        const snippets = args?.snippets === true;

        let ranked: RankedSearchResult[];
        try {
          ranked = db.searchDocumentsRanked(query, { contentOnly, snippets, limit: safeLimit });
        } catch (error) {
          if (error instanceof SearchRefusalError) {
            const report = buildSearchRefusalReport({
              query,
              type: type === 'knowledge' ? 'knowledge' : 'all',
              contentOnly,
              limit: safeLimit,
              refusal: {
                reason: error.reason,
                expression: error.expression,
                message: error.message,
              },
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(report), null, 2) }],
              isError: true,
            };
          }
          throw error;
        }

        const report = buildSearchReport({
          query,
          type: type === 'knowledge' ? 'knowledge' : 'all',
          contentOnly,
          limit: safeLimit,
          results: ranked,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(report), null, 2) }],
        };
      }

      case 'lux_log_event': {
        const { source, event_type, summary, payload } = args as {
          source: string;
          event_type: string;
          summary: string;
          payload?: Record<string, unknown>;
        };

        db.insertEvent({
          source,
          event_type,
          summary,
          payload,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }],
        };
      }

      case 'lux_get_file': {
        const { file_path } = args as { file_path: string };

        try {
          // Lux reports corpus-relative paths, so a relative path names a file under the corpus root.
          const content = readFileSync(resolveStoredPath(corpusPath, file_path), 'utf-8');
          return {
            content: [{ type: 'text', text: content }],
          };
        } catch (error) {
          // lux-intentional-swallow: returned to the MCP client as an error result.
          return {
            content: [{ type: 'text', text: `Error reading file: ${String(error)}` }],
            isError: true,
          };
        }
      }

      case 'lux_rebuild_index': {
        const scanner = new GeneralScanner(corpusPath);
        const { result, scanResult } = await rebuildWithOverlay(db, corpusPath);
        const indexedScan = {
          ...scanResult.scan,
          knowledge: scanResult.scan.knowledge.map((entry) =>
            attachEnrichment(entry, scanResult.enrichments)
          ),
        };

        await scanner.index(db, indexedScan);
        const headCommit = isGitRepository(corpusPath) ? getHeadCommit(corpusPath) : null;
        if (headCommit) db.setIndexMetadata('last_indexed_commit', headCommit);
        persistCoverageProducerRuns(db, scanResult);
        const trustState = persistRebuildTrustState(db, result, {
          lastIndexedCommit: headCommit ?? undefined,
        });

        db.insertEvent({
          source: 'mcp',
          event_type: 'index_rebuild',
          summary: `Indexed ${scanResult.scan.knowledge.length} knowledge entries with ${result.surfaceCount} overlay surfaces`,
        });
        emitUsageEvent(db, {
          source: 'mcp',
          surface: 'index-rebuild',
          action: 'overlay-complete',
          invocationId: createInvocationId(),
          commandOutcome: 'success',
          retrievalOutcome: 'not_applicable',
          trustState: safeUsageTrustState(trustState.mode),
          exitCode: 0,
          corpusPath,
          dbPath,
          repoCommit: headCommit ?? undefined,
          attributes: {
            knowledgeEntries: scanResult.scan.knowledge.length,
            surfaceCount: result.surfaceCount,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  indexed: {
                    knowledge: scanResult.scan.knowledge.length,
                  },
                  overlay: {
                    mode: trustState.mode,
                    trustLevel:
                      trustState.mode === 'overlay-complete'
                        ? 'overlay-complete'
                        : trustState.mode === 'content-only'
                          ? 'content-only'
                          : 'degraded-overlay',
                    surfaceCount: trustState.surfaceCount,
                    fileNodeCount: trustState.fileNodeCount,
                    symbolNodeCount: trustState.symbolNodeCount,
                    warnings: trustState.warnings,
                  },
                  runtime: {
                    corpusPath,
                    dbPath,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'lux_spec_derivation_evidence': {
        const { question, target, kind } = args as {
          question: string;
          target: string;
          kind: string;
        };

        const result = executeSpecEvidenceAsk(db, question, {
          target,
          kind,
          json: true,
          corpusPath,
          dbPath,
        });

        return {
          content: [
            { type: 'text', text: JSON.stringify(withReadTelemetry(result.packet), null, 2) },
          ],
          isError: result.exitCode !== 0,
        };
      }

      case 'lux_trace': {
        const {
          symbol,
          direction: rawDirection,
          depth = 8,
          max_nodes: maxNodes = 2000,
          max_fanout: maxFanout = 64,
          edge_types: edgeTypes = ['calls', 'references'],
          min_confidence: minConfidence = 'framework-inferred',
          include_external: includeExternal = true,
        } = args as {
          symbol: string;
          direction?: string;
          depth?: number;
          max_nodes?: number;
          max_fanout?: number;
          edge_types?: string[];
          min_confidence?: string;
          include_external?: boolean;
        };

        const direction = resolveTraversalDirection(rawDirection);
        const resolved = resolveStartNode(db, symbol);
        if ('notFound' in resolved) {
          return {
            content: [
              {
                type: 'text',
                text: `No structural symbol found for: ${symbol}. Rebuild the index or pass a fully-qualified name.`,
              },
            ],
            isError: true,
          };
        }
        if ('ambiguous' in resolved) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ambiguous: true,
                    candidates: resolved.ambiguous.map((c) => ({
                      id: c.id,
                      name: c.qualified_name ?? c.symbol_name,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        const traversalOptions = {
          maxDepth: depth,
          maxNodes,
          edgeTypes: edgeTypes as EdgeType[],
          minConfidenceClass: resolveMinConfidence(minConfidence),
          includeExternal,
        };

        // Federation remains opt-in. The legacy outgoing implementation is deliberately retained
        // for omitted/explicit outgoing requests so its existing JSON bytes do not change.
        const traceWith = Array.isArray(args?.with) ? (args.with as string[]) : undefined;
        if (traceWith && traceWith.length) {
          const fed = openFederationHandles(db, corpusPath, traceWith);
          try {
            const result =
              direction === 'outgoing'
                ? traceFromFederated(
                    db,
                    fed.handles,
                    resolved.nodeId,
                    fed.federation,
                    traversalOptions
                  )
                : traverseFromFederated(db, fed.handles, resolved.nodeId, fed.federation, {
                    ...traversalOptions,
                    direction,
                    maxFanout,
                  });
            return {
              content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(result), null, 2) }],
            };
          } finally {
            fed.close();
          }
        }

        const result =
          direction === 'outgoing'
            ? traceFrom(db, resolved.nodeId, traversalOptions)
            : traverseStructuralGraph(db, resolved.nodeId, {
                ...traversalOptions,
                direction,
                maxFanout,
              });

        return {
          content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(result), null, 2) }],
        };
      }

      case 'lux_delta': {
        const base = typeof args?.base === 'string' ? args.base : undefined;
        // Cross-repo impact (Decision 9): `against` names registered siblings; computeDelta resolves
        // + opens/closes their read-only handles internally, so the handler only forwards the names.
        // An unresolvable name surfaces as attached:false in crossRepoImpact, never silently dropped.
        const against = Array.isArray(args?.against) ? (args.against as string[]) : undefined;
        // --base is validated inside computeDelta (resolveDeltaBase → isSafeGitRef) BEFORE any git
        // call (Decision 17). MCP exposes this verb to prompt-injectable agents, so validation +
        // argv-form git (no shell) is mandatory here, not optional hardening.
        const result = await computeDelta(db, corpusPath, {
          base,
          committedOnly: args?.committed_only === true,
          depth: typeof args?.depth === 'number' ? args.depth : 6,
          maxNodes: typeof args?.max_nodes === 'number' ? args.max_nodes : 2000,
          maxFanout: 64,
          minConfidence: resolveMinConfidence(args?.min_confidence),
          against,
          json: true,
        });
        const payload = 'refusal' in result ? { error: result.refusal } : result.report;
        return {
          content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(payload), null, 2) }],
        };
      }

      case 'lux_anchors': {
        // Defensive arg coercion (shared, unit-tested in anchor-tool-args.test.ts): out-of-enum /
        // wrong-type values fail safe to the defaults rather than throwing on the resident server.
        const { query, limit, granularity, includeTests } = coerceAnchorToolArgs(args);
        try {
          const result = await runAnchorSearch(db, query, {
            limit,
            corpusPath,
            granularity,
            includeTests,
          });
          const report = buildAnchorReport({
            query,
            limit,
            granularity: result.granularity,
            results: result.results,
            lowConfidence: result.lowConfidence,
            filters: result.filters,
            coverage: result.coverage,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(report), null, 2) }],
          };
        } catch (error) {
          if (error instanceof AnchorRefusalError) {
            const report = buildAnchorRefusalReport({
              query,
              limit,
              granularity,
              // A refusal ran no ranking; echo the requested test mode with a zero count so the envelope
              // shape stays uniform with an answered query.
              filters: {
                tests: includeTests ? 'included' : 'excluded',
                excludedTestFiles: 0,
              },
              // Accurate anchor-viable count even for a non-overlay refusal over a populated index
              // (anchor-search.ts anchorRefusalCoverage); a genuine 0 for overlay/texts-absent.
              coverage: anchorRefusalCoverage(db),
              refusal: {
                reason: error.reason,
                expression: error.expression,
                message: error.message,
              },
            });
            return {
              content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(report), null, 2) }],
              isError: true,
            };
          }
          throw error;
        }
      }

      case 'lux_deps_impact': {
        const { file_path: filePath } = args as { file_path: string };

        // Shared blast-radius computation — the CLI `deps impact` action calls the same
        // computeImpact (src/cli/deps-impact.ts); the MCP layer does not fork the query.
        const result = computeImpact(db, corpusPath, filePath);

        if (!result.resolved) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'module-unresolved',
                    file: result.file,
                    message: `Could not resolve file to a module: ${result.file}`,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: 'text', text: JSON.stringify(withReadTelemetry(result.impact), null, 2) },
          ],
        };
      }

      case 'lux_overlay_status': {
        // Reuses the canonical status-payload builder shared with `lux overlay status --json`.
        const payload = buildOverlayStatusPayload(db, runtime);
        return {
          content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(payload), null, 2) }],
        };
      }

      case 'lux_index_status': {
        // Reuses the canonical status-payload builder shared with `lux index status --json`.
        const payload = buildIndexStatusPayload(db, runtime);
        return {
          content: [{ type: 'text', text: JSON.stringify(withReadTelemetry(payload), null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    // lux-intentional-swallow: returned to the MCP client as an error result.
    if (error instanceof WorkspaceUnavailableError) {
      return {
        content: [
          { type: 'text', text: JSON.stringify(workspaceUnavailablePayload(error), null, 2) },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Error: ${String(error)}` }],
      isError: true,
    };
  } finally {
    lease?.release();
  }
});

server.oninitialized = () => {
  void ensureWorkspaceConfigured();
};

server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  await workspace.refreshRoots();
});

server.onclose = () => {
  workspace.dispose();
};
server.onerror = (error) => {
  console.error('MCP protocol error:', error);
};

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lux MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
