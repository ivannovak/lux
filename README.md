# Lux

Internal reference for the current Lux CLI and MCP server.

## Runtime path resolution

Shared resolver: `src/utils/runtime-paths.ts`

- CLI corpus: `--corpus` -> `LUX_CORPUS_PATH` -> current working directory
- CLI database: `--db` -> `LUX_DB_PATH` -> `<resolved corpus>/.lux/lux.db`
- MCP corpus: explicit `LUX_CORPUS_PATH`/`LUX_DB_PATH`, otherwise exactly one client-provided MCP
  `file://` root
- MCP root changes atomically switch subsequent tool calls to the new repo-local index; missing,
  ambiguous, or invalid roots return `workspace-unavailable` rather than querying an accidental cwd

## Versioning

Git tags and their GitHub releases are the authoritative version record. The in-tree
`package.json` `version` is deliberately pinned to the `0.0.0-dev` sentinel ("source tree, not a
release"); `semantic-release` computes the real version from conventional commits and
`@semantic-release/npm` stamps it into `package.json` in the CI workspace at publish, so released
artifacts carry their tag version. A source-tree checkout therefore reports `0.0.0-dev` from
`lux --version` (and from the MCP server metadata) by design. Both read the version from
`package.json` via the single shared resolver `src/utils/version.ts`.

## Current CLI surface

- `lux index rebuild|sync|status`
- `lux search`
- `lux init [--json|--yes]`
- `lux doctor [--json]`
- `lux hooks install|uninstall`
- `lux migrate status|up|create`
- `lux deps graph|clusters|impact|coverage`
- `lux trace <symbol> [--direction outgoing|incoming|both] [--max-fanout <n>] [--with <siblings>]`
- `lux anchors <query> [--limit <n>] [--granularity node|file] [--include-tests] [--json]`
- `lux delta [--base <ref>] [--check] [--fail-on <list>] [--json]`
- `lux vendor-pack build|status`
- `lux usage report`
- `lux siblings status`
- `lux overlay status|check|ownership|boundaries|operational ask|feature-path ask|spec-evidence ask`

## Current MCP surface

From `src/mcp/server.ts`:

- `lux_search`
- `lux_log_event`
- `lux_get_file`
- `lux_rebuild_index`
- `lux_trace`
- `lux_delta`
- `lux_spec_derivation_evidence`
- `lux_anchors`
- `lux_deps_impact`
- `lux_overlay_status`
- `lux_index_status`
- `lux_doctor`

## `lux delta` — diff-scoped structural delta

Answers "what does this change touch structurally" from a git diff: touched symbols/surfaces,
downstream HTTP/operational entry surfaces, module dependents, kernel/client ownership transitions,
and invalidated spec-evidence targets. Read-only with respect to structural/overlay state; the base
ref is validated (argv-form git, no shell) before any git call. `--json` emits the stable
`schemaVersion:1` envelope (exposed identically as the `lux_delta` MCP tool).

`--check` turns it into a CI gate: exit nonzero on a gate violation or degraded overlay, exit 0
otherwise. Gate categories come from `--fail-on <comma-list>`, else `lux.yaml delta.gates`, else the
default `overlay-not-complete`. Unknown categories hard-error; a configured-but-unevaluable gate
(e.g. `client-gap-created` with no fresh kernel) fails loud rather than silently passing.

```yaml
# lux.yaml
delta:
  gates:
    - overlay-not-complete # overlay trust below overlay-complete
    - client-gap-created # diff removes a client handler a kernel route expects
    - budget-truncated # reverse walk exhausted its budget — blast radius unknown
    # Phase 4, require --baseline-db:
    - boundary-edge-added
    - surface-removed
```

### CI gate (GitHub Actions)

`--base` defaults to the index's `last_indexed_commit`; the base commit must be reachable in the
checkout, so fetch full history (`fetch-depth: 0`) — a shallow clone yields a `baseline-unavailable`
refusal.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # delta needs the base commit reachable (no shallow clone)
- run: npm ci && npx lux index rebuild
- run: npx lux delta --check --fail-on overlay-not-complete,client-gap-created --base "$GITHUB_BASE_REF"
```

### Pre-push hook

```sh
# .git/hooks/pre-push  (chmod +x)
#!/bin/sh
lux delta --check --fail-on overlay-not-complete || {
  echo "lux delta gate failed — see the report above." >&2
  exit 1
}
```

## Anchor embeddings (`lux anchors`)

`lux anchors <query>` mints ranked structural-node anchors (real symbol ids) from a natural-language
concept. The ranker's lexical half always runs; a semantic half fuses in once the anchor plane is
embedded. Embedding is **opt-in** and, by default, **native-free and fully on-machine**:

- `--granularity file` dedupes the ranking by file **before** the limit, returning one representative
  anchor per file (still a real node id) with a `fileNodeCount`, so `--limit N` means N distinct files.
  The default `node` returns one anchor per symbol.
- Test files are **excluded before the limit** by default (so the cap isn't flooded by test
  classes/method-nodes); pass `--include-tests` to restore them. The `--json` envelope reports what the
  filter did in `filters` and splits `coverage` into a stable `coverage.index` (is the corpus embedded?)
  and a per-query `coverage.query` (did this query use the semantic half, and why).

> **Note — 2.12 default output can differ from 2.11 beyond dropping tests.** With any filter active
> (test-exclusion is on by default, or `--granularity file`), ranking fuses over a **deeper candidate
> pool (200)** than 2.11's `limit`-sized pool, which can **reorder** results, upgrade `matchedVia` to
> `both`, raise `fusedScore`, and flip `lowConfidence` — even on a corpus with **no test files**. This
> is intentional. Only `--include-tests --granularity node` reproduces 2.11.0 byte-identically.
> `filters.excludedTestFiles` and `fileNodeCount` count within that pool, so both are bounded at 200.

- Default install: no embeddings. `lux index rebuild --embeddings` fetches the pinned local bge model
  (~34 MB, one-time) and embeds the plane; nothing leaves the machine.
- Routine `lux index rebuild`/`sync` stay cached-only — they embed iff the weights are already local
  and never trigger a network fetch.

### `lux.yaml` config reference

```yaml
# lux.yaml — the entire embedding config surface (optional; absent ⇒ native-free local default)
embedding:
  provider: openai # optional: openai (the sole shipped provider)
  model: text-embedding-3-small # optional: provider default applies
  # NO token key. The API path is selected by the LUX_EMBEDDING_TOKEN env var; an inline
  # `embedding.token` here is REJECTED at load (fail-closed) and must be rotated — a key written to
  # a committed file must be considered leaked.
```

### `LUX_EMBEDDING_TOKEN` — the API embedder opt-in (off-machine export)

Setting `LUX_EMBEDDING_TOKEN` switches the active embedder to the configured API provider (OpenAI),
using `provider`/`model` from `lux.yaml` above. The key is read from the environment **only** — never
from `lux.yaml`.

> **`LUX_EMBEDDING_TOKEN` sends your codebase's identifier surface off-machine.** With the env token
> set, `lux index` sends the prepared text for every in-scope node — symbols' names, identifiers,
> qualified names, file paths, signature lines, and leading doc-comments (never full file bodies) — to
> the configured third-party embedding provider (OpenAI). Egress is not limited to indexing: with the
> token set, `lux anchors <query>` also sends the natural-language **query** text to the same provider
> at query time (it must be embedded for the semantic half). This is a deliberate, operator-initiated
> export gated on the env var; the default install embeds locally with the native-free bge model and
> sends **nothing** off-machine. Turning on the key ships the codebase's identifier surface and
> documentation comments to an external service — set it only where that is acceptable.

## Reproducible rebuilds

For a fixed commit, config and toolchain, `lux index rebuild` writes the same index and every
`--json` command prints the same bytes, on any machine and in any clone location, provided the
environmental inputs below are pinned:

- **Vendor pack.** A rebuild merges a vendor pack from the machine-wide cache (`~/.lux/packs`,
  keyed by `composer.lock`), so a machine whose cache holds a matching pack builds a larger index.
  To make the index a function of the checkout alone, turn the merge off:

  ```yaml
  # lux.yaml
  vendorPack:
    merge: false # default true
  ```

- **Embeddings.** Without `--embeddings`, a rebuild on a machine that already has the model cached
  runs one embed pass on a 30 s budget, so which nodes get embedded depends on machine speed and on
  earlier runs. Deterministic output needs either `lux index rebuild --embeddings` (drains the queue
  to full coverage) or no embedding model in the cache (no embeddings at all).
- **Language servers.** Everything a language server left missing is listed under
  `lspEnrichmentFailures` in `lux index status --json`, and a run that records anything prints one
  `Warning: LSP output incomplete — <stage>: …` line per stage and closes on ⚠ instead of ✓.
  The contract: **output is deterministic when `lspEnrichmentFailures` is empty; otherwise the
  index names exactly what is missing.** A consumer that needs byte-identical output should refuse
  an index whose list is non-empty. Each entry has a `stage` and a `reason`:

  | `stage`      | what is missing                                                                         |
  | ------------ | --------------------------------------------------------------------------------------- |
  | `init`       | the whole language: its server failed to start (`filePath: "."`)                        |
  | `index`      | a complete index: the server was still indexing at `init_timeout_ms`                    |
  | `capability` | one request kind for the language: the server declared it, then answered MethodNotFound |
  | `symbols`    | the file's LSP enrichment, or one request of it                                         |
  | `calls`      | the file's LSP-resolved call edges, or one request of them                              |

  `reason` is one of:
  - `timeout` — the server did not answer the request in `request_timeout_ms`, and did not answer
    it when it was sent once more (see "Language-server requests" below);
  - `transport` — the server died. Every later request fails the same way, so each file it leaves
    without data is recorded; a server that dies before its language's files come up is recorded
    once for the language, at stage `init`;
  - `response` — the server answered a request with an error; the entry carries the `method` and
    `code`;
  - `unresponsive` — the server stopped answering part-way through. Nothing more was sent to it;
    one entry per stage, with `filePath: "."` and `fileCount`, the number of files that stage
    could not complete (see "Language-server requests" below);
  - `error` — anything else that was thrown (a Lux defect, or a failure the three above do not
    name); the entry carries the `message`, and the warning line quotes the first one. A
    request for a capability the server did not declare is never sent, and is not a failure. An
    error answer counts as an empty result only if it is on the allowlist in
    `src/scanner/lsp/requester.ts`, whose entries each cite why that answer means "nothing here".

  intelephense is started with a fresh storage directory each run (its default keeps the workspace
  index in `$TMPDIR/intelephense/` between runs; Lux's is `$TMPDIR/lux-intelephense-<pid>-*`,
  removed at shutdown or process exit, and swept by the next run if the process was killed
  outright) and pinned `files.exclude` settings, and
  enrichment waits for its `indexingEnded` notification. typescript-language-server is started
  without its syntax-only server and without automatic type acquisition.

  **Language-server requests.** Lux sends a language server one request at a time, so
  `request_timeout_ms` measures the server's work on that request. intelephense, tsserver and the
  Vue language server each answer one request at a time; a second request sent early only waits in
  the server's queue with its timeout running. Measured on a 9.6k-file Laravel/Vue repository
  (enrichment time for all files of the language, load average about 20):

  | server                     | in flight: 1 | 2    | 4         | 8       | one `references` request on a 6k-reference class |
  | -------------------------- | ------------ | ---- | --------- | ------- | ------------------------------------------------ |
  | intelephense               | 54–57 s      | 61 s | 50 s      | 48–53 s | 2.5 s alone; 10–12 s with 8 in flight            |
  | typescript-language-server | 11–12 s      | 10 s | 11 s      | 9–10 s  | —                                                |
  | vue-language-server        | 129–143 s    | —    | 123–140 s | 129 s   | —                                                |

  Run-to-run spread on that machine is about ±6 %, which covers every difference in the table:
  sending more at once does not finish sooner, it only makes each request look slower.

  - `max_concurrency` under `lsp.enrichers` is therefore no longer used. A `lux.yaml` that still
    sets it gets one warning per run naming the enrichers that do; remove the key.
  - A request that times out is cancelled with `$/cancelRequest` and sent once more under a new
    id. An answer that arrives later for the cancelled id is dropped. The next request is not
    sent until the server has answered the cancelled one or another `request_timeout_ms` has
    passed, so one slow request is not charged to the request after it.
  - A server answers `initialize` before it has finished starting (tsserver is spawned and the
    project loaded on the first request). The first request sent to a server is therefore
    given `init_timeout_ms` (only the first: a server that never answers costs one such wait).
  - A server that leaves two requests and their retries in a row without a response of any kind
    — four attempts, each with no answer in its timeout and none to the cancellation in the
    wait after it, eight timeout periods in all — has stopped answering. Nothing more is sent to
    it for the rest of the run, it is not restarted (a restart mid-run would make the output
    depend on when it happened), and the files it leaves are recorded as one `unresponsive`
    entry per stage. Any response, a late or an error one included, starts the count again, so
    one pathological file between healthy ones does not lose the language. A scoped
    `lux index sync` keeps a recorded `unresponsive` count; only a full rebuild clears it.
  - Up to 12 files are still read and opened in the server ahead of their requests; opening a
    document is a notification and is not timed.

What the rebuild guarantees itself:

- Files are processed in a canonical order (sorted by path), and every `--json` list has an
  explicit tie-break, so equal weights never reorder between runs.
- LSP locations are stored without machine paths: `workspace:<path>` inside the workspace,
  `external:…` outside it.
- Float aggregates (boundary weights) are summed in a fixed order; samples
  (`module_dependencies.sample_files`, boundary `samplePaths`) are taken in path order, not by
  which file was reached first.
- **Stored paths are relative to the corpus root.** `knowledge_entries.file_path` and
  `module_dependencies.sample_files` hold `src/Module/Users/readme.md`, never
  `/home/me/repo/src/…`, the overlay trust state no longer records where the repository was, and
  `operational_boundaries.repo_root` holds `.` (an index describes one repository).
  Two checkouts of one commit therefore store the same rows, and an index can be moved or shipped.
  Output follows: `filePath` in `search --json` and `sampleFiles` in `deps impact --json` are
  corpus-relative, and in federated search each result's path is relative to the repo its group
  names. The only path-valued output fields that still name this machine say where the command
  ran: `runtime.corpusPath`, `runtime.dbPath` and `overlay.repoPath` in `index status`,
  `overlay status` and `doctor` (`repoPath` is now filled from the running corpus path, not read
  from the index). An index written before this (schema 15 or older) is not read: reads refuse it
  as `schema-too-old`, and migrating clears it, with a notice, so the next `lux index rebuild` or
  `lux index sync` rebuilds it in full.
- `structural_config_fingerprint` does not include the checkout's location: the root path in
  `lux.yaml` (e.g. an absolute `lsp.workspace_root`) is masked before hashing.
- **Symbol ids are unique by construction.** PHP symbol ids are not file-qualified
  (`symbol:php:<FQCN>::<member>`, or a bare name outside any namespace), so two files can declare
  the same id — two `config/aliases.php` each holding `$aliases`, a class declared twice under one
  FQCN. Before writing any node, the rebuild censuses every declaration. An id declared by exactly
  one file keeps its form. An id declared by two or more files is file-qualified for **every**
  declarer, none keeping the bare id: `<id>#file:<repo-relative path>`, e.g.
  `symbol:php:$aliases#file:src/Module/Users/config/aliases.php`. `#` cannot occur in a PHP name, so
  the qualified form never meets a bare id. A reference that names only the shared id (a `use` of a
  twice-declared FQCN) is ambiguous and resolves to neither declaration; `lux index status --json`
  counts these under `symbolIdCollisions`.

  Contract notes. `lux delta --json` (`DeltaReportV1`, still `schemaVersion: 1`) can carry ids of
  the form `<id>#file:<path>` in `touched.symbolIds`; consumers treat ids as opaque, and unique
  ids are unchanged. A qualified id is repo-local, so a FQCN one repository declares twice no
  longer bridges to the same FQCN in a federated sibling. Whether an id is qualified depends on
  every declaration the rebuild sees: when a file's LSP enrichment fails, its LSP-only
  declarations drop out of the census, which can turn another file's id from qualified to bare or
  back. Such a run always lists the failed file in `lspEnrichmentFailures`, which is why stable
  ids, like every other determinism guarantee here, hold only for a run whose list is empty.
- **One fact declared in several files follows a stated rule, never processing order.**
  - *HTTP routes.* A route (method and path) that two files declare is stored once per file, under
    the same file-qualified form: `surface:http:GET:/#file:routes/web.php` and
    `surface:http:GET:/#file:workbench/routes/web.php`, each with its own handler, route name and
    edges; no node keeps `surface:http:GET:/`. Laravel itself keeps whichever was registered last,
    an order set by provider boot and stated in no route file, and the two files are often not in
    one application at all (a package's routes and its Testbench skeleton's). A route one file
    declares is unchanged. `lux index status --json` lists these under `surfaceIdCollisions`.
    One declaration is asked for as `GET / @ routes/web.php` (or by its id, or its route name):
    `overlay feature-path ask "GET /"` lists the declarations in that form, and `lux delta` emits
    its spec targets in it, so `overlay spec-evidence ask --kind route` resolves each one.
    `overlay ownership --kernel` compares kernel and client by method and path, so a route either
    side declares in several files is still one row.
  - *Events.* One boundary per event class. Laravel adds every provider's listeners to the
    dispatcher, so the contract lists every registering file (`registeredIn`) and the union of
    their listeners; `file_path` is the first registering file by path.
  - *Artisan commands.* A class declaring the name outranks the scheduler's reference to it. Two
    files declaring one name are each stored file-qualified
    (`opb:command:report:send#file:<path>`); the scheduler's reference stays on the bare name.
  - *Jobs.* One boundary per job class. A scheduler declaration outranks a dispatch-site
    inference. The `HANDLED_BY` edge from a job to its class is shared by every site that reaches
    the job, so it states no transport; each site's transport is on its own `DISPATCHES` (or the
    scheduler's `TRIGGERS`) edge.

  A detector or extractor that still hands over one id for two declarations is reported in a
  warning naming the id and the files, and the declaration in the first file by path is stored,
  with that declaration's edges only.
  `Surface count mismatch` therefore compares distinct declared ids with stored rows, and no
  longer fires for a route two files declare.

## Agent integration

The canonical Agent Skill lives at `skills/lux-code-intel/SKILL.md`. It teaches compatible agents
when to select Lux, requires workspace/trust preflight, routes structural questions to the right MCP
tool, and preserves confidence classes in reported findings. The root `plugin.json` lets Goose and
other Open Plugins clients install the repository as a plugin; Goose imports the skill as
`lux:lux-code-intel`. The npm `version` lifecycle keeps the plugin manifest version synchronized
with released packages.

Use the Skill and MCP server together: the Skill supplies selection/evidence policy, while the MCP
server supplies typed tools and roots-aware repository binding. `npm run verify:docs-surface` checks
that the Skill never references a removed MCP tool and still covers every required investigation
route.

## Read safety

Repository investigation commands open only an existing, current-schema index and never create,
migrate, or append usage records. JSON read envelopes report
`telemetry: { recorded: false, reason: "read-only-index" }`. Index creation/migration, rebuilds,
hook-event logging, and explicit MCP event logging remain intentional write operations.

## Working rules

- corpus files are source of truth
- db is derived state
- `lux index rebuild` is the canonical rebuild path
- `lux overlay check` is the hard gate for overlay-complete validation
- trust code over stale prose

## Pointers

- `CLAUDE.md`
- `docs/README.md`
- `docs/USAGE.md`
- `docs/MCP-CONFIGURATION.md`
- `docs/MCP-TOOLS.md`
