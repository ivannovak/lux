# MCP Tools

Current MCP tool surface from `src/mcp/server.ts`. Every tool returns a single `content[0].text`
payload; unless noted, that text is pretty-printed JSON. A tool signals a failure/refusal by setting
`isError: true` on the response alongside a structured error payload — the outer handler also wraps any
unexpected throw as `{ isError: true, text: "Error: <message>" }`.

Every tool runs against one workspace lease. With explicit `LUX_CORPUS_PATH`/`LUX_DB_PATH`, the MCP
server stays fixed to that runtime. Otherwise it follows the client's single MCP `file://` root and
switches repo-local database handles on root-change notifications. Missing, ambiguous, invalid, or
failed roots return `isError: true` with `{ "error": "workspace-unavailable", "reason": ... }`; Lux
does not query an accidental process cwd.

## Live tools

- `lux_search` — full-text search over indexed documents (optionally federated)
- `lux_log_event` — append an event to the audit trail
- `lux_get_file` — read an indexed file by path
- `lux_rebuild_index` — rescan the corpus and rebuild the index + overlay
- `lux_spec_derivation_evidence` — source-evidence packet for one operational target
- `lux_trace` — trace outgoing calls or incoming/bidirectional relationships (optionally federated)
- `lux_anchors` — rank structural-node anchors from a natural-language concept
- `lux_delta` — structural impact of a git change (optionally cross-repo)
- `lux_deps_impact` — blast radius of changing one file
- `lux_overlay_status` — structural-overlay trust state and freshness
- `lux_index_status` — index freshness and knowledge/event stats
- `lux_doctor` — read-only index/trust/freshness and per-language capability diagnostics

## `lux_search`

Search all indexed documents; returns document title and file path, optionally filtered by entity
type. `content_only` scopes the match to file content; `snippets` adds a query-centered FTS5 snippet
per result. `with` federates across registered siblings (names, or `['all']`), returning repo-grouped,
independently-ranked result groups plus a per-sibling freshness block.

```json
{
  "query": "string",
  "type": "all|knowledge",
  "limit": 20,
  "content_only": false,
  "snippets": false,
  "with": ["sibling-name"]
}
```

Each result's `filePath` is relative to the corpus root (`docs/settlement.md`); with `with`, a
result's `path` is relative to the root of the repo its group names. Pass a `filePath` to
`lux_get_file` as it is.

Only `query` is required. `limit` is coerced by the shared search-limit rule before it can reach the
SQL `LIMIT` (a negative, zero, or non-integer limit is neutralized rather than dumping unbounded rows
or hard-aborting WASM). The response is the `buildSearchReport` envelope (query echo + ranked results).

**Refusal behavior:** an invalid FTS5 expression (or an unavailable FTS index) returns `isError: true`
with the `buildSearchRefusalReport` envelope — `refusal.reason` is `invalid-query` or `fts-unavailable`
and the offending expression is echoed back. In the federated path an invalid query fails identically
for every group including `main`, so it surfaces as the same query-level refusal rather than a
per-sibling degrade.

## `lux_log_event`

Append an event to the local audit trail for tracking system activity. This is the explicit
event-log tool surface (see [Usage observability](#usage-observability) for how it differs from the
internal usage-event records).

```json
{
  "source": "string",
  "event_type": "string",
  "summary": "string",
  "payload": {}
}
```

`source`, `event_type`, and `summary` are required; `payload` is an optional free-form object. Returns
`{ "success": true }`.

## `lux_get_file`

Read and return the raw content of a file by path. The returned text is the file contents verbatim
(not JSON).

```json
{
  "file_path": "string"
}
```

`file_path` may be absolute, or relative to the corpus root, which is the form Lux reports paths
in (for example `filePath` in `lux_search` results). Only a file in the index's file universe is
served: in a git repository a tracked file, never an ignored, untracked or out-of-corpus one, and
never a file on the credential deny list (docs/USAGE.md, "Which files are indexed"). **Error
behavior:** an unreadable, missing or refused path returns `isError: true` with the text
`Error reading file: <reason>`.

## `lux_rebuild_index`

Rebuild the entire index by rescanning the content directory, rebuilding the structural overlay, and
persisting overlay trust metadata (plus module dependencies). Run this after content files change. No
inputs.

```json
{}
```

Returns a JSON summary: `success`, `indexed.knowledge` (entry count), `deniedFiles` (credential
files the deny list kept out, by corpus-relative path), an `overlay` block
(`mode`, `trustLevel`, `surfaceCount`, `fileNodeCount`, `symbolNodeCount`, `warnings`), and the
`runtime` (`corpusPath`, `dbPath`) that was rebuilt. Uses the same canonical overlay-complete rebuild
semantics as the CLI `lux index rebuild`.

## `lux_spec_derivation_evidence`

Return a `SpecDerivationEvidencePacketV1` for one route, handler, job, listener, or command target.
Lux returns **source evidence only** — it does not write or approve specifications.

```json
{
  "question": "what source evidence supports this operation?",
  "target": "POST /orders/{id}/cancel",
  "kind": "route"
}
```

All three fields are required. Supported `kind` values: `route`, `handler`, `job`, `listener`,
`command` (deferred seed kinds such as `event`, `service`, `region`, file, and symbol are not
accepted). The response is the packet JSON, the same contract as CLI
`lux overlay spec-evidence ask --json`. **Error behavior:** an unresolved or ambiguous target is
returned with `isError: true` (the packet still carries the `target.resolutionState`).

## `lux_trace`

Trace relationships from a known symbol. `direction` is `outgoing` (default), `incoming`, or `both`;
outgoing follows calls/references into merged vendor nodes, while incoming answers callers and other
consumers. Dynamic-dispatch relationships stop only forward continuation; reverse traversal retains
the stored dispatch annotation and continues to callers. Incoming/both return canonical stored
source/target endpoints plus `traversed: "forward" | "reverse"` and freshness.

```json
{
  "symbol": "Ns\\Class::method",
  "direction": "incoming",
  "depth": 8,
  "max_nodes": 2000,
  "max_fanout": 64,
  "edge_types": ["calls", "references"],
  "min_confidence": "framework-inferred",
  "include_external": true,
  "with": ["sibling-name"]
}
```

Only `symbol` is required (a structural node id, a PHP FQN, or a leaf name). Omitting `direction`, or
setting it to `outgoing`, preserves the established outgoing response. `min_confidence` is one of
`proven`, `artifact-backed`, `framework-inferred`, `heuristic`. `with` federates every direction
across registered siblings, crossing repo boundaries only on portable ids (namespace-qualified
FQCNs; HTTP surfaces toward the kernel); path-bearing and TypeScript ids remain repo-local. The
incoming/both federated response retains edge repo/provenance and uses one global node budget.

**Error behavior:** an unresolvable symbol returns `isError: true` with a plain-text hint to rebuild or
pass a fully-qualified name; an ambiguous symbol returns `isError: true` with
`{ "ambiguous": true, "candidates": [{ "id", "name" }, ...] }`.

## `lux_anchors`

Rank structural-node anchors (symbols) from a natural-language concept query. Returns real structural
node ids that `lux_trace` / feature-path / deps accept verbatim — the entry points for structural ops
on concept-spread questions. For documents/content use `lux_search` instead; this tool returns symbols.

```json
{
  "query": "string",
  "limit": 10,
  "granularity": "node",
  "include_tests": false
}
```

Only `query` is required; `limit` is truncated to a positive integer (defaults to 10).

- `granularity` (`node` | `file`, default `node`) — `node` returns one anchor per ranked symbol.
  `file` dedupes the fused ranking by file path **before** the limit, returning one representative
  anchor per file — the best-ranked node for that file, still a real node id `lux_trace` accepts
  verbatim — with an additive `fileNodeCount` per result (how many ranked nodes the file contributed,
  counted within the pre-cap candidate pool; pool-bounded, see the note below).
- `include_tests` (boolean, default `false`) — test files are **excluded before the limit** by default,
  so the cap means N product-code anchors instead of being flooded by test classes/method-nodes. Set
  `true` to restore them; with `granularity: node` that is byte-identical to the pre-2.12 result set.

> **⚠ Default-mode output can differ from 2.11 beyond test exclusion.** When any filter is active
> (test-exclusion is on by default, or `granularity: file`), the ranker fuses over a **deeper candidate
> pool (200)** than the plain `limit`-sized pool 2.11 used. A deeper pool can **reorder** results,
> **upgrade** a hit's `matchedVia` to `both`, **raise** its `fusedScore`, and **change** `lowConfidence`
> — this can happen even on a corpus with **zero test files**. This is intended (it is what lets
> exclusion/rollup act on more than the top `limit`). The **only** mode byte-identical to 2.11.0 is
> `include_tests: true` **and** `granularity: node`.

**Argument coercion (MCP only, fail-safe):** an out-of-enum `granularity` (e.g. `"File"`, `"symbol"`)
coerces to `node`, and a non-boolean `include_tests` (e.g. the **string** `"true"`) coerces to `false`
— an injectable value must not crash the resident server. (The CLI, a human surface, instead **errors
with exit 2** on a bad `--granularity`.) Consumers should read back the echoed top-level `granularity`
and `filters` to confirm the effective values.

The response is the `buildAnchorReport` envelope: ranked anchor ids, top-level `granularity`, a
`lowConfidence` flag, `filters` (`{ tests: "excluded" | "included", excludedTestFiles }`), and
`coverage`. `filters.excludedTestFiles` counts the **distinct test file paths** removed from the pre-cap
candidate pool; it may exceed `limit`/`results.length` and is pool-bounded (≤ 200, like `fileNodeCount`).
`coverage` keeps the frozen flat fields (`embeddedNodes`/`anchorViableNodes`/`model`, which
are **per-query** — `embeddedNodes`/`model` are `0`/`null` when the semantic half did not contribute,
e.g. the exact-identifier short-circuit) and adds two disambiguating sub-objects:

- `coverage.index` = `{ embeddedNodes, totalNodes, model }` — the **stable corpus fact**, populated on
  every answered query (including the short-circuit) from a cheap count, so "is the corpus embedded?"
  never reads as absent just because a query answered lexically. `totalNodes` is the same count as the
  flat `coverage.anchorViableNodes` (kept flat for back-compat).
- `coverage.query` = `{ semanticUsed, reason }` — the **per-query** semantic-usage fact. `reason` is one
  of `used`, `exact-match-short-circuit`, `no-embedded-nodes`, `weights-not-cached`,
  `below-cosine-floor`, `load-failed`, `disabled`.

**Refusal behavior:** an anchor refusal (e.g. the anchor plane is not embedded/available) returns
`isError: true` with the `buildAnchorRefusalReport` envelope — `refusal.reason`/`expression`, the
echoed `granularity`/`filters`, plus an accurate anchor-viable `coverage` count (non-zero even for a
non-overlay refusal over a populated index; a genuine `0` when the overlay or prepared texts are
absent). A refusal carries the flat `coverage` fields only (no `index`/`query` — it ran no query).

## `lux_delta`

Analyze what a git change touches structurally: touched symbols and declared surfaces, downstream
HTTP/operational entry surfaces (with honest async-boundary annotations), module dependents,
kernel/client ownership transitions, and invalidated spec-evidence targets. Read-only with respect to
structural state. Mirrors CLI `lux delta --json`.

```json
{
  "base": "ref-or-sha",
  "committed_only": false,
  "depth": 6,
  "max_nodes": 2000,
  "min_confidence": "framework-inferred",
  "against": ["sibling-name"]
}
```

All fields are optional; `base` defaults to the index's `last_indexed_commit`. `base` is validated
(`isSafeGitRef`, argv-form git, no shell) before any git call — this verb is exposed to
prompt-injectable agents, so validation is mandatory, not optional hardening. `against` reports
cross-repo impact in registered siblings (a read-only join; an unresolvable name surfaces as
`attached: false` in `crossRepoImpact`, never silently dropped). The response is the frozen
`schemaVersion: 1` delta envelope.

**Refusal behavior:** when the delta cannot be computed (e.g. `baseline-unavailable` for an
unreachable base commit) the tool returns `{ "error": <refusal> }`.

## `lux_deps_impact`

Analyze the blast radius of a change to a file: resolve the file to its module and return every module
that depends on it, with per-dependent reference counts and sample files. Read-only. Mirrors CLI
`lux deps impact <file>` (same `computeImpact`, no forked query).

```json
{
  "file_path": "string"
}
```

`file_path` (required) may be absolute or relative to the corpus root; it is resolved to its module via
the detected module boundaries. On success the response is the `impact` object (`module`, a
`blastRadius` module/reference count summary, and `dependentModules`).

**Error behavior:** a file that cannot be resolved to a module returns `isError: true` with
`{ "error": "module-unresolved", "file": "...", "message": "..." }`.

## `lux_overlay_status`

Report the structural-overlay trust state (`overlay-complete` / `degraded-overlay` / `content-only` /
`none`), surface and node counts, the runtime corpus/db resolution, and working-tree freshness (indexed
commit vs HEAD, dirty structural files). Read-only. Mirrors CLI `lux overlay status --json`. No inputs.

```json
{}
```

Returns the `{ overlay, runtime, freshness }` status payload (`buildOverlayStatusPayload`).

## `lux_index_status`

Report index freshness: knowledge/event stats, the structural-overlay trust state, the runtime
corpus/db resolution, and working-tree freshness (indexed commit vs HEAD, dirty structural files).
Read-only. Mirrors CLI `lux index status --json`. No inputs.

```json
{}
```

Returns the `{ stats, overlay, coverage, runtime, freshness }` status payload (`buildIndexStatusPayload`).

## `lux_doctor`

Return the same versioned, read-only diagnostic report as `lux doctor --json`. Stable check IDs carry
`pass`, `warn`, `fail`, or `not_applicable` plus actionable remediation; a readable index contributes
the canonical index/trust/freshness/`coverage.languages` status snapshot. An absent or incompatible
index is diagnosed without creating or migrating it. Unsupported and not-applicable language states
remain explicit. No inputs.

```json
{}
```

## Usage observability

Repository investigation tools (search, trace, anchors, spec-evidence, delta, deps-impact, and the
status tools) open the active index strictly read-only and do not append local usage records. Their
JSON payloads include `telemetry: { recorded: false, reason: "read-only-index" }`.

The explicitly mutating `lux_rebuild_index` and `lux_log_event` tools use short-lived writer leases;
rebuild retains its normalized usage event. `lux_usage_event` is **not** a callable tool — it is the
internal event-record type. Existing records can be reviewed with the read-only `lux usage report`
CLI command. External event shippers are not part of this surface.
