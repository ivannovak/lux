import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Canonical MCP tool-definition array — the single source of truth for the tool surface the
 * ListTools handler exposes. `src/mcp/server.ts` imports this for the wire handler, and
 * `scripts/verify-docs-surface.ts` imports the SAME array to assert the three docs-surface lists
 * (docs/MCP-TOOLS.md, README.md, CLAUDE.md) never drift from it.
 *
 * This module is deliberately SIDE-EFFECT-FREE — its only import is the `Tool` type (erased at
 * runtime). server.ts, by contrast, constructs the database and connects the stdio transport at
 * module load; the docs-surface guard must be able to read the registry WITHOUT triggering any of
 * that, which is exactly why the definitions live here rather than in server.ts.
 */
export const TOOLS: Tool[] = [
  {
    name: 'lux_search',
    description:
      'Use for indexed documentation or source-content retrieval when the question is textual rather than structural. Returns ranked document titles and file paths; use lux_anchors for concept-to-symbol discovery and lux_trace/lux_deps_impact for code relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        type: {
          type: 'string',
          enum: ['all', 'knowledge'],
          description: 'Filter by entity type',
          default: 'all',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 20,
        },
        content_only: {
          type: 'boolean',
          description: 'Scope the query to file content only (whole-expression column filter).',
        },
        snippets: {
          type: 'boolean',
          description: 'Include a query-centered FTS5 snippet per result.',
        },
        with: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Federate across registered siblings by name (or ['all']). Returns repo-grouped, " +
            'independently-ranked result groups plus a per-sibling freshness block.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lux_log_event',
    description:
      'Mutating administrative tool: append a caller-supplied event to the local Lux audit trail. Do not use for repository investigation unless the user explicitly asks to record an event.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Event source (e.g., mcp, cli, scanner)',
        },
        event_type: {
          type: 'string',
          description: 'Type of event',
        },
        summary: {
          type: 'string',
          description: 'Event summary',
        },
        payload: {
          type: 'object',
          description: 'Additional event data (optional)',
        },
      },
      required: ['source', 'event_type', 'summary'],
    },
  },
  {
    name: 'lux_get_file',
    description:
      "Read an indexed file returned by Lux. Use to verify important Lux findings against source before drawing conclusions; use the client's ordinary file reader when the path did not come from Lux.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'File path as Lux reported it (relative to the corpus root), or an absolute path',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'lux_rebuild_index',
    description:
      'Mutating administrative tool: rebuild the active workspace index and structural overlay. Use only after status shows a missing/stale/degraded index and make the rebuild explicit; do not run automatically for every investigation.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lux_spec_derivation_evidence',
    description:
      'Use when explaining or specifying one known route, handler, job, listener, or command target. Returns a source-evidence packet only; Lux does not write or approve specifications.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Evidence question for the downstream specification system.',
        },
        target: {
          type: 'string',
          description: 'Single target identifier to resolve.',
        },
        kind: {
          type: 'string',
          enum: ['route', 'handler', 'job', 'listener', 'command'],
          description: 'Target seed kind.',
        },
      },
      required: ['question', 'target', 'kind'],
    },
  },
  {
    name: 'lux_trace',
    description:
      'Use when a symbol is known, or after lux_anchors, to answer call-path, consumer, and ' +
      'cross-boundary behavior questions. Follows calls/references into merged vendor nodes, marks ' +
      'dynamic-dispatch re-entry boundaries, and returns an evidence/confidence-annotated graph.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description:
            'Start symbol: a structural node id, a PHP FQN (Ns\\Class::method), or a leaf name.',
        },
        direction: {
          type: 'string',
          enum: ['outgoing', 'incoming', 'both'],
          description:
            'Traversal direction over canonical stored edges. Incoming/both responses annotate each edge with `traversed`.',
          default: 'outgoing',
        },
        depth: { type: 'number', description: 'Max hops to follow', default: 8 },
        max_nodes: { type: 'number', description: 'Total node budget', default: 2000 },
        max_fanout: {
          type: 'number',
          description: 'Combined per-node edge budget across directions and federated repositories',
          default: 64,
        },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow',
          default: ['calls', 'references'],
        },
        min_confidence: {
          type: 'string',
          enum: ['proven', 'artifact-backed', 'framework-inferred', 'heuristic'],
          description: 'Lowest confidence class to follow',
          default: 'framework-inferred',
        },
        include_external: {
          type: 'boolean',
          description: 'Follow edges into vendor nodes',
          default: true,
        },
        with: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Federate across registered siblings by name (or ['all']). Crosses repo boundaries " +
            'only on portable ids (namespace-qualified PHP FQCNs; HTTP surfaces toward the kernel).',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'lux_anchors',
    description:
      'Use first when the user describes a code concept but does not know the relevant file or ' +
      'symbol. Ranks real structural node ids that lux_trace accepts verbatim. Use lux_search ' +
      'instead for documentation or textual content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The concept to mint anchors from' },
        limit: { type: 'number', description: 'Maximum anchors to return', default: 10 },
        granularity: {
          type: 'string',
          enum: ['node', 'file'],
          description:
            'Result granularity. `node` (default) returns one anchor per ranked symbol; `file` dedupes ' +
            'by file path before the limit, returning one representative anchor per file (a real node id ' +
            'that still round-trips through lux_trace) plus a per-result `fileNodeCount`.',
          default: 'node',
        },
        include_tests: {
          type: 'boolean',
          description:
            'Include test files. Default false: test files are excluded before the limit so the cap ' +
            'means N product-code anchors. Set true to restore them (with granularity=node this is the ' +
            'byte-identical pre-2.12 result set).',
          default: false,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lux_delta',
    description:
      'Use first when asked whether a diff, working-tree change, commit, or PR is safe or what ' +
      'downstream behavior it affects. Reports touched symbols/surfaces, entry surfaces, module ' +
      'dependents, ownership transitions, invalidated evidence, confidence, and truncation. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          description: 'Diff baseline ref/SHA (default: the index last_indexed_commit)',
        },
        committed_only: {
          type: 'boolean',
          description: 'Exclude uncommitted working-tree changes',
          default: false,
        },
        depth: { type: 'number', description: 'Reverse-walk depth budget', default: 6 },
        max_nodes: { type: 'number', description: 'Reverse-walk node budget', default: 2000 },
        min_confidence: {
          type: 'string',
          enum: ['proven', 'artifact-backed', 'framework-inferred', 'heuristic'],
          description: 'Lowest confidence class to follow',
          default: 'framework-inferred',
        },
        against: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Report cross-repo impact in registered siblings by name (or ['all']). Read-only join; " +
            'the sibling entry surfaces this diff affects.',
        },
      },
    },
  },
  {
    name: 'lux_deps_impact',
    description:
      'Use when asked who depends on a known file/module or what its blast radius is. Resolves the ' +
      'file to a module and returns dependent modules with reference counts and sample files. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'File to analyze (absolute, or relative to the corpus root). Resolved to its module ' +
            'via the detected module boundaries.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'lux_overlay_status',
    description:
      'Preflight before structural investigation: report the active workspace, structural-overlay ' +
      'trust, surface/node counts, and working-tree freshness. Use before lux_anchors, lux_trace, ' +
      'lux_delta, or lux_deps_impact unless trust and freshness are already established. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lux_doctor',
    description:
      'Read-only Phase-4 diagnostics with stable check IDs, statuses, remediation, and an optional index status snapshot. Diagnoses absent or incompatible indexes without creating or migrating them. Returns the same versioned report as lux doctor --json.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lux_index_status',
    description:
      'Preflight for indexed content retrieval: report the active workspace, index statistics, ' +
      'overlay trust, and working-tree freshness. Use before lux_search when freshness is unknown. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
