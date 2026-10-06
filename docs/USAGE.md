# Lux CLI Reference

## Runtime path resolution

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> cwd
- db: `--db` -> `LUX_DB_PATH` -> `<resolved corpus>/.lux/lux.db`

## Index

```bash
lux index rebuild
lux index rebuild --content-only
lux index sync
lux index sync --force
lux index status
lux index status --json
```

Notes:

- `lux index rebuild` is the canonical overlay-complete rebuild path
- `--content-only` skips overlay materialization and is not valid for retrieval-surface validation
- `sync` may escalate to a full rebuild when structural changes are detected
- `index status --json` is the canonical machine-readable status envelope; it includes index stats, overlay trust diagnostics, and runtime corpus/DB provenance
- `overlay status --json` emits the native overlay trust payload plus the same runtime provenance

## Doctor

```bash
lux doctor --json
```

`doctor` is read-only and returns the exact same versioned diagnostic report as MCP `lux_doctor`:
stable checks with statuses/remediation plus the canonical index-status snapshot when readable. It
diagnoses an absent or incompatible index without creating or migrating it.

## Portable init

```bash
lux init --json       # preview only; no writes
lux init --yes        # apply the previewed portable files
```

`init` detects languages and module layouts, creates a checkout-portable `lux.yaml`, and adds
`.lux/` once to `.gitignore`. Existing dirty targets are refused; every apply is hash-checked,
root-confined, symlink-safe, and repeatable. Git hooks remain a separate explicit operation.

## Search

```bash
lux search "query"
lux search '"exact phrase"'
lux search "prov*"
lux search "provider AND photos"
lux search "query" --type knowledge
lux search "query" --content
```

Implemented search type values:

- `all`
- `knowledge`

Result paths (`Path:` in text output, `filePath` in `--json`) are relative to the corpus root.

## Hooks

Hooks now follow the shared runtime path resolver.

- corpus: `--corpus` -> `LUX_CORPUS_PATH` -> cwd
- explicit `--corpus` still wins over env and cwd
- installed post-commit hooks run `lux index sync`
- hook success/skip/error outcomes are emitted as local usage events where possible
- hook failures do not block commits; they print recovery guidance instead
- preferred env vars: `LUX_SKIP_SYNC`, `LUX_SYNC_TIMEOUT`
- legacy env vars still work: `LUX_SKIP_REBUILD`, `LUX_REBUILD_TIMEOUT`
- if you point Lux at a parent folder instead of the actual repo root, hooks and `index sync` may suggest a nested repo such as `./vcs`

```bash
lux hooks install
lux hooks install --corpus /path/to/corpus
lux hooks uninstall
lux hooks uninstall --corpus /path/to/corpus
```

## Migrations

```bash
lux migrate status
lux migrate up
lux migrate create <name>
```

Migration 016 clears an index written by an older Lux, because it stored absolute file paths. It
prints a notice when it does; run `lux index rebuild` afterwards, or let the next `lux index sync`
rebuild in full.

## Usage observability

```bash
lux usage report --since 7d
lux usage report --since 24h --json
lux usage report --surface feature-path --retrieval-outcome unresolved
lux usage report --command-outcome error
lux usage report --trust-state stale
```

Usage observability is local-first. Lux writes normalized `lux_usage_event` records into the repo-local SQLite events table and `lux usage report` summarizes them without external infrastructure.

The event model separates:

- final command outcome (`success` or `error`)
- retrieval attempt outcome (`answered`, `refused`, `ambiguous`, `unresolved`, `fallback`, or `not_applicable`)
- trust/freshness state (`fresh`, `stale`, `degraded`, `content-only`, `absent`, or `unknown`)

This means retrieval refusals and fallbacks remain visible in the local event stream. Standard events hash query text by default and do not store raw prompts, raw model responses, or raw session identifiers. Lux-managed post-commit hooks also emit best-effort hook outcome events, so automated sync behavior is visible without making commits depend on observability writes. JSONL, GELF/Graylog, and OTLP exporters are deferred; SQLite is the canonical first-tranche sink.

## Module dependency analysis

```bash
lux deps graph
lux deps graph --module <name>
lux deps graph --json
lux deps clusters
lux deps impact <file-path>
lux deps coverage
```

Sample files (in `deps graph` text output and `sampleFiles` in `deps impact --json`) are relative to
the corpus root.

## Overlay

```bash
lux overlay status
lux overlay status --json
lux overlay check
lux overlay operational ask "what dispatches App\\Jobs\\RefreshReport?"
lux overlay operational ask "what schedules releases:sync?" --json
lux overlay spec-evidence ask "what source evidence supports this route?" --target "POST /orders/{id}/cancel" --kind route --json
lux overlay spec-evidence ask "what source evidence supports this job?" --target "App\\Jobs\\RefreshReport" --kind job --out /tmp/refresh-report-evidence.md
lux overlay boundaries show
lux overlay boundaries show --focus Listing --include-paths
lux overlay boundaries explore
lux overlay boundaries list-regions
lux overlay boundaries list-families
lux overlay boundaries neighborhood Listing
```

Current operator-facing overlay states:

- `overlay-complete`
- `degraded-overlay`
- `stale-overlay`
- `content-only`
- `no-overlay`

### Overlay trust recovery

| State                    | Meaning                                                                        | Recovery                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `no-overlay`             | No persisted or derivable overlay state exists.                                | Run `lux index rebuild`.                                                                                                    |
| `content-only`           | Content was indexed without structural overlay materialization.                | Run plain `lux index rebuild` before validating retrieval surfaces.                                                         |
| `stale-overlay`          | Content sync advanced after a known overlay baseline and trust may be drifted. | Run `lux index rebuild`; use `lux index sync` only for routine commit-aware catch-up.                                       |
| `degraded-overlay`       | Overlay state exists but is incomplete or warning-bearing.                     | Inspect warnings with `lux index status`; run `lux index rebuild`.                                                          |
| wrong root / nested repo | Lux is pointed at a parent directory or a DB from another corpus.              | Rerun with `--corpus <actual repo root>` and prefer the repo-local DB unless intentionally overriding `--db`/`LUX_DB_PATH`. |

### Boundary exploration

Boundary exploration exposes the module-boundary map through three different lenses:

- `regions`: the places in the map, for example `Listing`, `Billing`, or `Checkout`
- `families`: the structural reason a relationship exists, for example `surface-bridge`, `service-container`, or `async-workflow`
- `neighborhood`: the local view around one region, meaning all relationships that touch that region

Use them for different jobs:

- `lux overlay boundaries list-regions` to discover the main domains Lux sees
- `lux overlay boundaries list-families` to understand which evidence patterns are shaping the graph
- `lux overlay boundaries neighborhood <region>` to inspect one domain before drilling into exact relationships
- `lux overlay boundaries show` to inspect the actual aggregated region-to-region relationships

Practical framing:

- region answers: what parts of the system exist as meaningful domains?
- family answers: what structural patterns are creating the connections?
- neighborhood answers: what is this specific domain connected to right now?

### Spec-derivation evidence

`lux overlay spec-evidence ask` emits a `SpecDerivationEvidencePacketV1` retrieval packet for one target. Lux provides source-grounded evidence for a downstream specification system; it does not write, approve, validate, or lifecycle-manage specifications.

Supported first-tranche seed kinds:

- `route`
- `handler`
- `job`
- `listener`
- `command`

Deferred as seed kinds: `event`, `service`, `region`, arbitrary file/symbol targets, and whole-repository batch catalogs. Events may appear only as context for a listener packet.

Options:

- `--kind route|handler|job|listener|command` selects the target kind
- `--target <target>` provides the route, handler, job, listener, or command identifier
- `--json` emits the packet JSON contract
- `--out <path>` writes a single-target review artifact; `.json` writes packet JSON and `.md` or `.markdown` writes Markdown

The packet separates `sourceFact` from optional `possibleInterpretation`, includes support levels and evidence references for claims, reports missing/unsupported coverage signals, and marks sufficiency as `sufficient`, `partial`, `insufficient`, or `conflicting`.
