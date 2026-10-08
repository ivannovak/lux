import { LuxSqlite } from './sqlite-adapter.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { PreparedQueries } from './queries.js';
import { MigrationRunner } from './migrations.js';
import { buildFtsMatchExpression, classifySearchError } from './search-query.js';
import type {
  KnowledgeEntry,
  Event,
  KnowledgeEntryInsert,
  EventInsert,
  SearchQueryOptions,
  RankedSearchResult,
  NodeAnchorTextInsert,
  LexicalAnchorRow,
  NodeEmbeddingRow,
  NodeVectorRow,
  NodeEmbeddingInsert,
  AnchorEmbeddingCoverage,
  UnembeddedAnchorNode,
  ModuleDependency,
  StructuralNode,
  StructuralEdge,
  EdgeEvidence,
  OperationalBoundary,
  OperationalHandler,
  OperationalEdge,
  OperationalContract,
  EdgeFreshnessCounts,
} from './types.js';

// Re-export the refusal type from the DB barrel so CLI/MCP can `instanceof`-check without reaching
// into search-query.js (D3). The shared limit coercer rides the same barrel so every coercing caller
// (federated CLI + MCP, single-repo MCP) imports the ONE rule from here.
export { SearchRefusalError, coerceSearchLimit } from './search-query.js';
export {
  writeInChunks,
  writeAllInChunks,
  ROWS_PER_COMMIT,
  FILES_PER_COMMIT,
} from './chunked-writes.js';
export type { ChunkedWriteResult, ChunkedWriteTarget } from './chunked-writes.js';
export type { SearchRefusalReason } from './search-query.js';
// Re-export the lexical anchor row so the non-fenced ranker (scanner/anchors/lexical-ranker.ts) can
// import it from the DB barrel without reaching into ./types.js directly (mig 014).
export type { LexicalAnchorRow } from './types.js';
// Re-export the embedding row shapes + coverage type so the fenced barrel (scanner/embeddings/index.ts)
// and the hybrid orchestration import them from the DB barrel, never reaching into ./types.js (mig 015).
export type {
  NodeEmbeddingRow,
  NodeVectorRow,
  AnchorEmbeddingCoverage,
  UnembeddedAnchorNode,
} from './types.js';
import { dbNotice } from './notices.js';
import { STORED_CORPUS_ROOT, assertStoredPath } from './stored-path.js';

// The stored-path rule is part of the DB contract: writers convert with it, readers resolve with it.
export { resolveStoredPath, toStoredPath } from './stored-path.js';

/** A kernel HTTP `handled_by` route joined against the client's nodes/routes (cross-area, #62). */
export interface CrossAreaKernelRow {
  route: string; // surface:http:METHOD:/path
  kernel_handler: string; // symbol:php:<FQCN>
  client_node: string | null; // client node id matching the handler FQCN (present → client implements it)
  client_handler: string | null; // client's own handler for the same route (present → client overrides it)
}

/** A client's own HTTP `handled_by` route (for the client-local sweep). */
export interface CrossAreaClientRoute {
  route: string;
  handler: string;
}

export interface LuxDatabaseOptions {
  /** Open the underlying file strictly read-only (sibling graph walks — Decision 4). When set:
   *  the constructor SKIPS the directory-creating mkdir and the `journal_mode = delete` write, and
   *  the adapter skips the pid owner-marker + WAL-header flip. Pair with `autoMigrate=false`. */
  readOnly?: boolean;
  /** Another repository's index (openSiblingReadOnly): no reclaim and no pruning of its owner
   *  registry there. Reading it still takes and releases the lock, which creates and removes the
   *  lock directory and this process's token inside it. */
  foreignIndex?: boolean;
}

/**
 * Clear `${dbPath}.lock` when its owner is provably dead, reporting it as a notice. An open of this
 * repository's own index runs this before its first SQLite handle: an orphaned lock otherwise
 * wedges that handle in SQLITE_BUSY for the full busy timeout.
 */
export function reclaimStaleIndexLock(dbPath: string): void {
  if (LuxSqlite.reclaimStaleLock(dbPath)) {
    dbNotice('notice', 'cleared a stale database lock left by a previously interrupted run.');
  }
}

/** `module_dependencies.sample_files` as a list; a value that is not a JSON string array is empty. */
function parseSampleFiles(sampleFiles: string | null): string[] {
  if (!sampleFiles) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(sampleFiles);
  } catch (error) {
    throw new Error(`module_dependencies.sample_files is not JSON: ${sampleFiles.slice(0, 80)}`, {
      cause: error,
    });
  }
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

/** index_metadata key present while a rebuild is unfinished (beginRebuild / finishRebuild). */
const REBUILD_STARTED_KEY = 'rebuild_started';

export class LuxDatabase {
  private db: LuxSqlite;
  private queries?: PreparedQueries;
  private migrations: MigrationRunner;

  constructor(dbPath: string, autoMigrate = true, options: LuxDatabaseOptions = {}) {
    const readOnly = options.readOnly ?? false;

    // Read-only opens (openSiblingReadOnly) must not build or repair someone else's index. Skip the
    // directory-creating mkdir (never build a tree under a sibling worktree) — the two writable
    // paths keep it. The adapter (below) already skips the pid owner-marker + WAL-header flip for
    // readonly opens (sqlite-adapter.ts:254,261).
    if (!readOnly) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    // Reclaim a VFS lock whose owner is provably dead on every open of this repository's own index,
    // not just `index rebuild`.
    //
    // node-sqlite3-wasm implements SQLite locking as a `${path}.lock` DIRECTORY, which the kernel does
    // not drop when a process dies. reclaimStaleLock() has existed for exactly this since the WASM
    // migration, but was wired into ONE call site (cli/index.ts) out of 28 `new LuxDatabase(...)` opens.
    // Every read path — search, trace, deps, overlay, anchors, the MCP server — therefore died on a lock
    // whose owner was provably gone, permanently, with the cure sitting unused in the same class.
    //
    // Observed 2026-09-02 on a CA substrate: a lock orphaned for 22h alongside 94 dead-pid owner markers
    // dating back six weeks. `lux search` returned `Error: database is locked` on every invocation, and
    // waiting never helped because nothing was ever going to clear it.
    //
    // Safe on a read path, which is why the original restriction was over-cautious: the lock is a VFS
    // artifact, not a consistency marker — SQLite replays or rolls back its journal on reopen (see the
    // journal_mode note below: "a plain process crash still rolls back cleanly on reopen"). A lock is
    // cleared only when the owner named inside it is provably dead; a lock that names no owner, or
    // whose owner is alive or cannot be checked, is left alone (lock-ownership.ts has the full rule
    // and what it does not cover). Reported as a notice rather than cleared in silence.
    // openIndex() runs the same reclaim before its schema probe; by then this call finds no lock.
    if (options.foreignIndex !== true) reclaimStaleIndexLock(dbPath);

    this.db = new LuxSqlite(dbPath, readOnly ? { readonly: true, fileMustExist: true } : {});

    // journal_mode=delete: WASM SQLite has no WAL. Benchmarked faster than `memory`
    // (1.24x vs 1.43x the better-sqlite3/WAL baseline). synchronous=NORMAL keeps the
    // batched-write throughput the app rebuild and the ~818k-row vendor-pack merge depend
    // on; under a rollback journal that trades a narrow power-loss / OS-crash corruption
    // window (a plain process crash still rolls back cleanly on reopen) — acceptable
    // because the Lux DB is derived state, fully recoverable by `lux index rebuild`
    // (ADR-4 / ADR-2).
    //
    // `journal_mode = delete` rewrites the DB header — a write. Skip it for read-only opens; a
    // read-only connection issues no journal anyway. `foreign_keys`/`synchronous` are
    // per-connection settings (no file write), so they stay for query correctness on both paths.
    if (!readOnly) {
      this.db.pragma('journal_mode = delete');
    }
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    // Initialize migration system
    this.migrations = new MigrationRunner(this.db);

    // Run migrations automatically unless disabled
    if (autoMigrate) {
      this.runMigrations();
      this.initQueries();
    }
  }

  /**
   * Open a sibling `.lux` strictly read-only for graph walks (Decision 4), returning a LuxDatabase
   * whose existing prepared wrappers (getStructuralNode, getOutgoingStructuralEdges,
   * getIncomingStructuralEdges, getOperationalBoundariesForSymbols, the FTS statements) work
   * unchanged. NEW plumbing: no shipped path yields a read-only LuxDatabase (resolveKernel opens the
   * raw adapter; openDeltaDatabase opens read-write).
   *
   * The open:
   *   - threads `readOnly` → the adapter {readonly:true, fileMustExist:true} (skips pid-marker +
   *     WAL-flip) and skips the constructor's mkdir + journal_mode=delete write;
   *   - keeps autoMigrate=false and checks schema parity BEFORE initReadQueries() (prepare-order is
   *     load-bearing: initQueries() eagerly prepares ~65 statements that throw on a stale sibling —
   *     the openDeltaDatabase ordering, preflight.ts:27-45).
   *
   * `resolveSiblings` already pre-screens skew at resolve time (Decision 7), so the parity throw
   * here is belt-and-suspenders. Throws on absence or skew; the caller owns close().
   */
  static openSiblingReadOnly(dbPath: string, expectedSchemaVersion: number): LuxDatabase {
    if (!existsSync(dbPath)) {
      throw new Error(`openSiblingReadOnly: no index at ${dbPath}`);
    }
    const db = new LuxDatabase(dbPath, /* autoMigrate */ false, {
      readOnly: true,
      foreignIndex: true,
    });
    const actual = db.getAppliedSchemaVersion();
    if (actual !== expectedSchemaVersion) {
      db.close();
      throw new Error(
        `openSiblingReadOnly(${dbPath}): schema v${actual} != primary v${expectedSchemaVersion}; ` +
          `re-index the sibling at the current schema.`
      );
    }
    db.initReadQueries(); // schema confirmed current → safe to prepare
    return db;
  }

  /**
   * Initialize prepared queries. Must be called after migrations.
   */
  private initQueries() {
    if (!this.queries) {
      this.queries = new PreparedQueries(this.db);
    }
  }

  /**
   * Get prepared queries, ensuring they are initialized.
   */
  private getQueries(): PreparedQueries {
    if (!this.queries) {
      this.initQueries();
    }
    return this.queries!;
  }

  /**
   * Run all pending database migrations.
   */
  runMigrations(): number {
    return this.migrations.runMigrations();
  }

  /**
   * Get migration status information.
   */
  getMigrationStatus() {
    return this.migrations.getStatus();
  }

  /**
   * Check if the database schema is up to date.
   */
  isSchemaUpToDate(): boolean {
    return this.migrations.isUpToDate();
  }

  /** The highest applied migration version (the schema_version the fingerprint pins to). */
  getAppliedSchemaVersion(): number {
    const row = this.db.get('SELECT MAX(version) AS v FROM schema_version') as { v: number | null };
    return row?.v ?? 0;
  }

  // Knowledge entry operations
  insertKnowledgeEntry(entry: KnowledgeEntryInsert): number {
    assertStoredPath(entry.file_path, 'knowledge_entries.file_path');
    const result = this.getQueries().insertKnowledgeEntry.run({
      type: entry.type,
      title: entry.title,
      file_path: entry.file_path,
      tags: entry.tags ? JSON.stringify(entry.tags) : null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      content: entry.content ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getKnowledgeEntriesByType(type: string): KnowledgeEntry[] {
    return this.getQueries().getKnowledgeEntriesByType.all(type) as KnowledgeEntry[];
  }

  getAllKnowledgeEntries(): KnowledgeEntry[] {
    return this.getQueries().getAllKnowledgeEntries.all() as KnowledgeEntry[];
  }

  getKnowledgeEntryByPath(filePath: string): KnowledgeEntry | undefined {
    assertStoredPath(filePath, 'A knowledge entry lookup');
    return this.getQueries().getKnowledgeEntryByPath.get(filePath) as KnowledgeEntry | undefined;
  }

  // Event operations
  insertEvent(event: EventInsert): number {
    const result = this.getQueries().insertEvent.run({
      source: event.source,
      source_id: event.source_id ?? null,
      event_type: event.event_type,
      summary: event.summary ?? null,
      payload: event.payload ? JSON.stringify(event.payload) : null,
    });
    return result.lastInsertRowid as number;
  }

  getRecentEvents(limit = 100): Event[] {
    return this.getQueries().getRecentEvents.all(limit) as Event[];
  }

  // FTS5 Search operations
  /**
   * Ranked full-text search over knowledge_entries (D1–D4). Raw bm25 rank flows to the caller;
   * LIMIT + projection are in SQL (no content materialization); --content scopes the whole
   * expression. Throws SearchRefusalError(invalid-query|fts-unavailable) — never a silent empty
   * answer. A genuine zero-result query returns [].
   */
  searchDocumentsRanked(query: string, opts: SearchQueryOptions): RankedSearchResult[] {
    const expression = buildFtsMatchExpression(query, { contentOnly: opts.contentOnly });
    const stmt = opts.snippets
      ? this.getQueries().searchRankedWithSnippet
      : this.getQueries().searchRanked;
    let rows: Array<{
      id: number;
      type: string;
      title: string;
      file_path: string;
      rank: number;
      snippet?: string;
    }>;
    try {
      rows = stmt.all(expression, opts.limit) as typeof rows;
    } catch (error) {
      throw classifySearchError(error, expression);
    }
    return rows.map((row) => ({
      entryId: row.id,
      entryType: row.type,
      title: row.title,
      filePath: row.file_path,
      rank: row.rank,
      snippet: row.snippet ?? undefined,
    }));
  }

  // Knowledge entry deletion by path
  deleteKnowledgeEntryByPath(filePath: string): void {
    assertStoredPath(filePath, 'A knowledge entry delete');
    this.getQueries().deleteKnowledgeEntryByPath.run(filePath);
  }

  deleteKnowledgeEntry(id: number): void {
    this.getQueries().deleteKnowledgeEntry.run(id);
  }

  // Node anchor lexical index (migration 014 — Decision 4/5). The FTS is standalone, so each write
  // deletes-then-inserts the node's FTS row; the structural_node_texts upsert REPLACEs. Callers run
  // these inside the materialization transaction (materialize.ts).
  //
  // The FTS delete is a full scan of structural_node_fts (node_id is UNINDEXED), so running it for
  // every node made materialization quadratic in the node count. A node has an FTS row only if it has
  // a structural_node_texts row: this method writes the two together, and every delete removes both
  // in one transaction (deleteNodeAnchorRowsForNodeIds, clearOverlay). So the scan runs only for a
  // node whose text already exists, found by primary key.
  upsertNodeAnchorText(row: NodeAnchorTextInsert): void {
    const q = this.getQueries();
    const hadText = q.hasNodeAnchorText.get(row.node_id) !== undefined;
    q.upsertNodeAnchorTextRow.run({
      node_id: row.node_id,
      prepared: row.prepared,
      content_hash: row.content_hash,
    });
    if (hadText) q.deleteNodeFtsRow.run(row.node_id);
    q.insertNodeFtsRow.run({
      node_id: row.node_id,
      name: row.name,
      identifiers: row.identifiers,
      qualified: row.qualified,
      path_segments: row.path_segments,
      context: row.context,
    });
  }

  /** Weighted-bm25 lexical anchor ranking over structural_node_fts joined to structural_nodes.
   *  Throws whatever the FTS MATCH raises (the surface classifies it via classifyAnchorFtsError). */
  rankAnchorsLexical(matchExpression: string, limit: number): LexicalAnchorRow[] {
    return this.getQueries().rankAnchorsLexical.all(matchExpression, limit) as LexicalAnchorRow[];
  }

  /** Delete a victim node's sibling anchor rows (structural_node_texts + structural_node_fts) so a
   *  re-materialized node re-enters the embed queue clean — the scoped-refresh victim delete
   *  (Decision 5). Chunked IN-delete, mirroring deleteStructuralNodesForFiles (:997-1009). Phase 3
   *  EXTENDS this to structural_node_embeddings so a victim's stale vector is swept beside its text/FTS
   *  rows (the delete-path half of the Decision-5 freshness contract; the queue's content_hash<> arm is
   *  the other half). Returns nothing — no caller uses a count (the re-materialization at
   *  overlay-refresh.ts:223 restores surviving nodes' rows). */
  deleteNodeAnchorRowsForNodeIds(nodeIds: string[]): void {
    // One transaction: a text row must never be deleted without its FTS row (upsertNodeAnchorText).
    this.transaction(() => {
      for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
        const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
        if (chunk.length === 0) continue;
        const ph = LuxDatabase.deltaPlaceholders(chunk.length);
        this.db.run(`DELETE FROM structural_node_texts      WHERE node_id IN (${ph})`, chunk);
        this.db.run(`DELETE FROM structural_node_fts        WHERE node_id IN (${ph})`, chunk);
        this.db.run(`DELETE FROM structural_node_embeddings WHERE node_id IN (${ph})`, chunk);
      }
    });
  }

  /** Count of anchor-viable nodes with prepared text (the coverage denominator + the
   *  anchor-texts-absent detector for the surface's refusal logic). */
  getAnchorViableNodeCount(): number {
    return (this.getQueries().countNodeAnchorTexts.get() as { n: number }).n;
  }

  /** True iff the structural overlay has ever been built (≥1 structural_nodes row) — distinguishes
   *  `overlay-missing` (never built) from `anchor-texts-absent` (built, but no anchor texts, e.g.
   *  ast.enabled=false) for the surface's extended refusals (03 §The surface). */
  hasStructuralOverlay(): boolean {
    return (this.getQueries().countStructuralNodes.get() as { n: number }).n > 0;
  }

  // Anchor embeddings operations (migration 015 — D5/D7/D11). Pure pass-through to the sibling
  // table; the codec (scanner/embeddings/codec.ts) is applied by the caller, never here (the DB
  // layer deals only in Uint8Array bytes — the fence forbids it importing scanner/embeddings/).
  upsertNodeEmbedding(row: NodeEmbeddingInsert): void {
    this.getQueries().insertNodeEmbedding.run({
      node_id: row.node_id,
      model: row.model,
      dims: row.dims,
      vector: row.vector,
      content_hash: row.content_hash,
    });
  }

  getUnembeddedAnchorNodes(model: string, limit: number): UnembeddedAnchorNode[] {
    return this.getQueries().getUnembeddedAnchorNodes.all(model, limit) as UnembeddedAnchorNode[];
  }

  getNodeVectorsForModel(model: string): NodeVectorRow[] {
    return this.getQueries().getNodeVectorsForModel.all(model) as NodeVectorRow[];
  }

  getNodeEmbeddingByNode(nodeId: string, model: string): NodeEmbeddingRow | undefined {
    return this.getQueries().getNodeEmbeddingByNode.get(nodeId, model) as
      NodeEmbeddingRow | undefined;
  }

  getAnchorEmbeddingCoverage(model: string): AnchorEmbeddingCoverage {
    const row = this.getQueries().getAnchorEmbeddingCoverage.get(model) as {
      anchorViableNodes: number;
      embeddedNodes: number;
    };
    return { embeddedNodes: row.embeddedNodes, anchorViableNodes: row.anchorViableNodes, model };
  }

  // Index metadata operations
  getIndexMetadata(key: string): string | undefined {
    const result = this.getQueries().getIndexMetadata.get(key) as { value: string } | undefined;
    return result?.value;
  }

  setIndexMetadata(key: string, value: string): void {
    this.getQueries().setIndexMetadata.run({ key, value });
  }

  deleteIndexMetadata(key: string): void {
    this.getQueries().deleteIndexMetadata.run(key);
  }

  // Module dependency operations
  insertModuleDependency(dep: Omit<ModuleDependency, 'id' | 'created_at'>): void {
    for (const file of parseSampleFiles(dep.sample_files)) {
      assertStoredPath(file, 'module_dependencies.sample_files');
    }
    this.getQueries().insertModuleDependency.run({
      source_module: dep.source_module,
      target_module: dep.target_module,
      reference_count: dep.reference_count,
      sample_files: dep.sample_files,
    });
  }

  getModuleDependencies(
    module: string,
    direction: 'source' | 'target' | 'both'
  ): ModuleDependency[] {
    const q = this.getQueries();
    if (direction === 'source') {
      return q.getModuleDependenciesBySource.all(module) as ModuleDependency[];
    }
    if (direction === 'target') {
      return q.getModuleDependenciesByTarget.all(module) as ModuleDependency[];
    }
    // 'both' — union of source and target, deduplicated by id
    const fromSource = q.getModuleDependenciesBySource.all(module) as ModuleDependency[];
    const fromTarget = q.getModuleDependenciesByTarget.all(module) as ModuleDependency[];
    const seen = new Set<number>();
    const result: ModuleDependency[] = [];
    for (const dep of [...fromSource, ...fromTarget]) {
      if (!seen.has(dep.id)) {
        seen.add(dep.id);
        result.push(dep);
      }
    }
    return result;
  }

  getAllModuleDependencies(): ModuleDependency[] {
    return this.getQueries().getAllModuleDependencies.all() as ModuleDependency[];
  }

  clearModuleDependencies(): void {
    this.getQueries().clearModuleDependencies.run();
  }

  getDistinctModules(): string[] {
    const rows = this.getQueries().getDistinctModules.all() as { module: string }[];
    return rows.map((r) => r.module);
  }

  // ---------------------------------------------------------------------------
  // Structural overlay operations
  // ---------------------------------------------------------------------------

  upsertStructuralNode(node: StructuralNode): void {
    this.getQueries().upsertStructuralNode.run({
      id: node.id,
      node_type: node.node_type,
      file_path: node.file_path ?? null,
      language_id: node.language_id ?? null,
      symbol_name: node.symbol_name ?? null,
      symbol_kind: node.symbol_kind ?? null,
      qualified_name: node.qualified_name ?? null,
      metadata: node.metadata ?? null,
      origin: node.origin ?? 'local',
      updated_at: node.updated_at,
    });
  }

  upsertStructuralEdge(edge: StructuralEdge): void {
    this.getQueries().upsertStructuralEdge.run({
      id: edge.id,
      source_node_id: edge.source_node_id,
      target_node_id: edge.target_node_id,
      edge_type: edge.edge_type,
      confidence: edge.confidence,
      confidence_class: edge.confidence_class,
      freshness_status: edge.freshness_status,
      source_commit: edge.source_commit ?? null,
      dirty_dependency_count: edge.dirty_dependency_count,
      provenance_summary: edge.provenance_summary ?? null,
      updated_at: edge.updated_at,
    });
  }

  /**
   * Replace all evidence for an edge atomically.
   * Deletes existing evidence then inserts the new set in a single transaction.
   */
  replaceEdgeEvidence(edgeId: string, evidence: EdgeEvidence[]): void {
    const q = this.getQueries();
    const replaceTransaction = this.db.transaction(() => {
      q.deleteEdgeEvidence.run(edgeId);
      for (const ev of evidence) {
        q.insertEdgeEvidence.run({
          id: ev.id,
          edge_id: ev.edge_id,
          resolver: ev.resolver,
          evidence_kind: ev.evidence_kind,
          file_path: ev.file_path ?? null,
          line: ev.line ?? null,
          note: ev.note ?? null,
          payload_json: ev.payload_json ?? null,
          recorded_at: ev.recorded_at,
        });
      }
    });
    replaceTransaction();
  }

  /**
   * Run `fn` inside a single SQLite transaction and return its result. `fn` must
   * be synchronous (better-sqlite3 transactions cannot span an await). Batches the
   * many small overlay writes into one commit — the write path both the app
   * rebuild and the vendor-pack merge reuse (ADR-6 / ADR-2 / REQ-4).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Whether a transaction is open (see LuxSqlite.inTransaction). */
  inTransaction(): boolean {
    return this.db.inTransaction();
  }

  /**
   * Merge a vendor pack's structural nodes and edges into this project's overlay
   * (ADR-2). The pack is a standalone overlay-shaped SQLite file, built once per
   * `composer.lock` (ADR-1); its tables mirror `structural_nodes` /
   * `structural_edges`. There is no attach-by-reference at query time (a single
   * `new Database` handle), so the merge is a transient merge-time ATTACH + bulk
   * `INSERT OR IGNORE … SELECT`, all in-engine (~818k rows never cross into JS).
   *
   * - Every imported node is stamped `origin='vendor-pack'` (ADR-3).
   * - `INSERT OR IGNORE` means a project (local) node/edge that already occupies
   *   an id WINS — the app's real code over the vendor copy (ADR-2).
   * - `edge_evidence` is NOT imported: vendor edges carry their provenance inline
   *   in `provenance_summary`, and importing per-edge evidence multiplies rows for
   *   marginal trace value.
   *
   * `clearOverlay()` wipes the overlay at the top of each rebuild, so this runs
   * every rebuild; one transaction under `synchronous=NORMAL` keeps it ~1.7s for
   * ~818k rows (REQ-4). ATTACH must happen OUTSIDE the transaction (SQLite forbids
   * ATTACH within a transaction); the write is committed before DETACH.
   *
   * @param packDbPath Absolute path to a built vendor pack DB.
   * @returns Net rows inserted (post-`OR IGNORE`).
   */
  importVendorPack(packDbPath: string): { nodes: number; edges: number } {
    this.getQueries(); // ensure the DB is initialized/migrated before we touch it
    // Transient one-shots (ATTACH / bulk INSERT / DETACH): use the auto-finalizing
    // `run()` so they never enter the finalize registry (the MCP DB is never closed).
    this.db.run('ATTACH DATABASE ? AS pack', packDbPath);
    try {
      let nodes = 0;
      let edges = 0;
      const importAll = this.db.transaction(() => {
        nodes = this.db.run(
          `INSERT OR IGNORE INTO structural_nodes
               (id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, origin, updated_at)
             SELECT id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, 'vendor-pack', updated_at
               FROM pack.structural_nodes`
        ).changes;
        edges = this.db.run(
          `INSERT OR IGNORE INTO structural_edges
               (id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at)
             SELECT id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at
               FROM pack.structural_edges`
        ).changes;
      });
      importAll();
      return { nodes, edges };
    } finally {
      try {
        this.db.run('DETACH DATABASE pack');
      } catch {
        // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
        // best-effort: a failed merge can leave the transaction open (DETACH-in-transaction
        // is illegal), so don't let DETACH mask the original error — the pack detaches when
        // the handle closes anyway.
      }
    }
  }

  /**
   * Run `fn` with a sibling area's `.lux` index ATTACHed read-side as `kernel` (cross-area
   * ownership, #62). Mirrors importVendorPack's ATTACH-outside-transaction / DETACH-in-finally,
   * but performs NO writes on `kernel.*` — read-only is by discipline (node-sqlite3-wasm has no
   * URI read-only open mode). Guards schema parity (client vs kernel `schema_version`) before `fn`.
   */
  attachKernel<T>(kernelDbPath: string, fn: () => T): T {
    this.db.run('ATTACH DATABASE ? AS kernel', kernelDbPath); // outside any transaction
    try {
      const parity = this.db.get(
        `SELECT (SELECT MAX(version) FROM main.schema_version)   AS client,
                (SELECT MAX(version) FROM kernel.schema_version) AS kernel`
      ) as { client: number; kernel: number };
      if (parity.client !== parity.kernel) {
        throw new Error(
          `Cross-area overlay: kernel index schema v${parity.kernel} != client schema v${parity.client}; re-index one.`
        );
      }
      // Engine-enforce the read-only invariant for the attach window: any INSERT/UPDATE/DELETE
      // on kernel.* (or main.*) inside fn now hard-errors, rather than relying on discipline.
      this.db.run('PRAGMA query_only = ON');
      return fn();
    } finally {
      try {
        this.db.run('PRAGMA query_only = OFF');
      } catch {
        // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
        // best-effort
      }
      try {
        this.db.run('DETACH DATABASE kernel');
      } catch {
        // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
        // best-effort: a failed fn can leave state that makes DETACH throw; don't mask the real error.
      }
    }
  }

  /**
   * Read-side rows for the cross-area ownership map (#62): every kernel HTTP `handled_by`
   * route (the classification is by the handler FQCN's namespace, so no join to
   * `kernel.structural_nodes` is needed), plus the client's own routes for the client-local
   * sweep. Runs under {@link attachKernel} (read-only, no writes on `kernel.*`).
   */
  crossAreaOwnership(kernelDbPath: string): {
    kernelRows: CrossAreaKernelRow[];
    clientRoutes: CrossAreaClientRoute[];
  } {
    return this.attachKernel(kernelDbPath, () => {
      // One row per kernel route (GROUP BY dedups a route with >1 handled_by edge; MIN makes
      // the chosen handler deterministic). client_handler is a deterministic correlated subquery
      // (ORDER BY … LIMIT 1) rather than a LEFT JOIN, so a client with >1 handler for a route
      // cannot fan the kernel row out or pick a handler non-deterministically.
      // A route is its method and path on both sides: an id either index file-qualified because
      // several of its files declare the route (`…#file:<path>`) is read without the qualifier,
      // so the two indexes join on the route and not on how many files declare it.
      const route = (column: string): string =>
        `CASE WHEN instr(${column}, '#file:') > 0
              THEN substr(${column}, 1, instr(${column}, '#file:') - 1)
              ELSE ${column} END`;
      const kernelRows = this.db.all(
        `SELECT ke.route,
                ke.kernel_handler,
                cn.id AS client_node,
                (SELECT ce.target_node_id FROM main.structural_edges ce
                  WHERE ${route('ce.source_node_id')} = ke.route AND ce.edge_type = 'handled_by'
                    AND ce.source_node_id LIKE 'surface:http:%'
                  ORDER BY ce.target_node_id LIMIT 1) AS client_handler
           FROM (SELECT ${route('source_node_id')} AS route, MIN(target_node_id) AS kernel_handler
                   FROM kernel.structural_edges
                  WHERE edge_type = 'handled_by' AND source_node_id LIKE 'surface:http:%'
                  GROUP BY 1) ke
           LEFT JOIN main.structural_nodes cn ON cn.id = ke.kernel_handler`
      ) as CrossAreaKernelRow[];
      const clientRoutes = this.db.all(
        `SELECT ${route('source_node_id')} AS route, MIN(target_node_id) AS handler
           FROM main.structural_edges
          WHERE edge_type = 'handled_by' AND source_node_id LIKE 'surface:http:%'
          GROUP BY 1`
      ) as CrossAreaClientRoute[];
      return { kernelRows, clientRoutes };
    });
  }

  /**
   * Run `fn` with a sibling `.lux` index ATTACHed read-only under `alias` (Phase 4 baseline diff,
   * Decision 9). Mirrors attachKernel: ATTACH outside any transaction, schema-parity guard,
   * `PRAGMA query_only = ON` window (engine-enforced read-only for both DBs), DETACH in `finally`.
   * The alias is validated as a SQL identifier (it cannot be a bound parameter in `ATTACH … AS`).
   */
  attachSibling<T>(dbPath: string, alias: string, fn: () => T): T {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(`attachSibling: unsafe alias ${JSON.stringify(alias)}`);
    }
    this.db.run(`ATTACH DATABASE ? AS ${alias}`, dbPath); // outside any transaction
    try {
      const parity = this.db.get(
        `SELECT (SELECT MAX(version) FROM main.schema_version)    AS main,
                (SELECT MAX(version) FROM ${alias}.schema_version) AS sibling`
      ) as { main: number; sibling: number };
      if (parity.main !== parity.sibling) {
        throw new Error(
          `attachSibling(${alias}): schema v${parity.sibling} != main v${parity.main}; ` +
            `re-index the baseline at the current schema (cache key is (base SHA, schema_version)).`
        );
      }
      this.db.run('PRAGMA query_only = ON');
      return fn();
    } finally {
      try {
        this.db.run('PRAGMA query_only = OFF');
      } catch {
        // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
        /* best-effort */
      }
      try {
        this.db.run(`DETACH DATABASE ${alias}`);
      } catch {
        // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
        /* best-effort */
      }
    }
  }

  /**
   * Structural diff of the primary (head) overlay against a baseline `.lux` ATTACHed read-only
   * (Phase 4). Returns surfaces added/removed by id, plus the raw new edges (present at head,
   * absent in baseline) with source/target file paths — module resolution happens in the caller
   * (which has corpusPath + boundary patterns). Runs entirely in-engine under attachSibling.
   */
  baselineStructuralDiff(baselineDbPath: string): {
    surfacesRemoved: string[];
    surfacesAdded: string[];
    newEdges: Array<{
      source: string;
      target: string;
      edgeType: string;
      sourceFile: string;
      targetFile: string;
    }>;
  } {
    return this.attachSibling(baselineDbPath, 'baseline', () => {
      const surfacesRemoved = (
        this.db.all(
          `SELECT b.id FROM baseline.structural_nodes b
             LEFT JOIN main.structural_nodes h ON h.id = b.id
            WHERE (b.node_type = 'capability-surface' OR b.id LIKE 'surface:http:%')
              AND h.id IS NULL`
        ) as Array<{ id: string }>
      ).map((r) => r.id);
      const surfacesAdded = (
        this.db.all(
          `SELECT h.id FROM main.structural_nodes h
             LEFT JOIN baseline.structural_nodes b ON b.id = h.id
            WHERE (h.node_type = 'capability-surface' OR h.id LIKE 'surface:http:%')
              AND b.id IS NULL`
        ) as Array<{ id: string }>
      ).map((r) => r.id);
      const newEdges = this.db.all(
        `SELECT he.source_node_id AS source, he.target_node_id AS target, he.edge_type AS edgeType,
                sn.file_path AS sourceFile, tn.file_path AS targetFile
           FROM main.structural_edges he
           LEFT JOIN baseline.structural_edges be
             ON be.source_node_id = he.source_node_id
            AND be.target_node_id = he.target_node_id
            AND be.edge_type = he.edge_type
           LEFT JOIN main.structural_nodes sn ON sn.id = he.source_node_id
           LEFT JOIN main.structural_nodes tn ON tn.id = he.target_node_id
          WHERE be.id IS NULL AND sn.file_path IS NOT NULL AND tn.file_path IS NOT NULL`
      ) as Array<{
        source: string;
        target: string;
        edgeType: string;
        sourceFile: string;
        targetFile: string;
      }>;
      return { surfacesRemoved, surfacesAdded, newEdges };
    });
  }

  /**
   * Which of `seedIds` exist as nodes (or edge targets) in THIS index — the cheap in-engine filter
   * before a cross-repo walk (Decision 9). Designed to run on an `openSiblingReadOnly` handle: it is
   * a pure `id IN (chunk)` SELECT, so it is engine-read-only and keeps the sibling's rows off the JS
   * heap (only the matched ids — at most `seedIds.length` — cross back). Chunked at DELTA_IN_CHUNK
   * with a cross-chunk `found` Set (a seed present as both a node and an edge target dedups to one).
   *
   * NB: this deliberately does NOT ATTACH the sibling onto the primary connection. A prior write on
   * the primary handle (the long-lived MCP server appends a usage-event per call; a startup
   * migration also writes) leaves node-sqlite3-wasm unable to DETACH the sibling — the swallowed
   * DETACH then deadlocks the subsequent `openSiblingReadOnly` of the same file on the busy-timeout.
   * Running the filter on the sibling's own read-only connection sidesteps that coupling entirely,
   * with the identical heap profile the in-engine ATTACH filter was chosen for.
   */
  siblingNodeIntersection(seedIds: string[]): string[] {
    if (seedIds.length === 0) return [];
    const found = new Set<string>();
    for (let i = 0; i < seedIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = seedIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      const rows = this.db.all(
        `SELECT id FROM structural_nodes WHERE id IN (${ph})
           UNION
         SELECT target_node_id AS id FROM structural_edges WHERE target_node_id IN (${ph})`,
        [...chunk, ...chunk]
      ) as Array<{ id: string }>;
      for (const r of rows) found.add(r.id);
    }
    return [...found];
  }

  // ── delta touch-set + reverse walk: dynamic-IN queries over indexed columns (Decision 3 /
  //    Phase 2a). A variadic IN(...) can't be a fixed prepared statement — use the one-shot
  //    db.all path with generated placeholders + chunking (mirrors crossAreaOwnership). ──

  /** Well under SQLite's variable limit (999 legacy / 32766 modern) — chunk large branch diffs. */
  private static readonly DELTA_IN_CHUNK = 500;

  private static deltaPlaceholders(n: number): string {
    return new Array(n).fill('?').join(',');
  }

  /**
   * Run a placeholder-`IN` SELECT across chunked values, unioning the rows with a cross-chunk
   * DISTINCT (a per-chunk `JOIN … DISTINCT` only dedups within one chunk). The dedup key defaults
   * to `row.id`; callers whose row identity is composite (e.g. boundary × symbol) pass their own
   * key so a legitimately repeated row is not over-deduped. A row with no key (falsy) is not
   * deduped.
   */
  private deltaChunkedIn<T>(
    values: string[],
    sql: (placeholders: string) => string,
    key?: (row: T) => string
  ): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    const keyOf = key ?? ((r: T) => (r as { id?: string }).id ?? '');
    for (let i = 0; i < values.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = values.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const rows = this.db.all(sql(LuxDatabase.deltaPlaceholders(chunk.length)), chunk) as T[];
      for (const r of rows) {
        const k = keyOf(r);
        if (k) {
          if (seen.has(k)) continue;
          seen.add(k);
        }
        out.push(r);
      }
    }
    return out;
  }

  /** structural_nodes (files + symbols declared in changed files) for the given rel paths. */
  getStructuralNodesForFilePaths(relPaths: string[]): StructuralNode[] {
    return this.deltaChunkedIn<StructuralNode>(
      relPaths,
      (ph) => `SELECT * FROM structural_nodes WHERE file_path IN (${ph})`
    );
  }

  /** DISTINCT structural_edges whose recorded evidence cites any changed file (invalidation set). */
  getEvidenceEdgesForFilePaths(relPaths: string[]): StructuralEdge[] {
    return this.deltaChunkedIn<StructuralEdge>(
      relPaths,
      (ph) =>
        `SELECT DISTINCT e.* FROM edge_evidence ev
           JOIN structural_edges e ON e.id = ev.edge_id
          WHERE ev.file_path IN (${ph})`
    );
  }

  /** operational_boundaries declared in any changed file. */
  getOperationalBoundariesForFilePaths(relPaths: string[]): OperationalBoundary[] {
    return this.deltaChunkedIn<OperationalBoundary>(
      relPaths,
      (ph) => `SELECT * FROM operational_boundaries WHERE file_path IN (${ph})`
    );
  }

  /**
   * operational_boundaries reachable from the given symbols via operational_handlers.symbol_id
   * (Phase 2b — the operational graph is separate from structural_edges; this is the only bridge).
   * Carries the matched symbol_id so callers can attribute the reach + async-boundary annotation.
   */
  getOperationalBoundariesForSymbols(
    symbolIds: string[]
  ): Array<OperationalBoundary & { symbol_id: string }> {
    return this.deltaChunkedIn<OperationalBoundary & { symbol_id: string }>(
      symbolIds,
      (ph) =>
        `SELECT DISTINCT b.id, b.repo_root, b.kind, b.name, b.trust_tier, b.file_path, h.symbol_id
           FROM operational_handlers h
           JOIN operational_boundaries b ON b.id = h.boundary_id
          WHERE h.symbol_id IN (${ph})`,
      (r) => `${r.id}::${r.symbol_id}` // identity is (boundary, symbol) — keep every pairing
    );
  }

  /**
   * Single-index ownership labels (E1) for `handled_by` edges targeting any touched handler
   * symbol. `ownership` is the column added by migration 013 (NULL unless a first-party pass ran).
   */
  getHandlerOwnershipForSymbols(
    symbolIds: string[]
  ): Array<{ route: string; handler: string; ownership: string | null }> {
    return this.deltaChunkedIn<{ route: string; handler: string; ownership: string | null }>(
      symbolIds,
      (ph) =>
        `SELECT source_node_id AS route, target_node_id AS handler, ownership
           FROM structural_edges
          WHERE edge_type = 'handled_by' AND target_node_id IN (${ph})`
    );
  }

  /** Incoming structural edges (target_node_id = nodeId), confidence-ordered — the reverse walk
   *  frontier (Phase 2a). Wraps the existing prepared `getStructuralEdgesForTargetNode`
   *  (`queries.ts:300-302`), which had no public wrapper.
   *
   *  With `bound`, the frontier is filtered and capped IN SQL: only the given edge types and
   *  confidence classes, `ORDER BY confidence DESC LIMIT bound.limit`. This stops a hub node from
   *  materializing its whole in-degree into JS before the caller's fanout cap. The filter lives in
   *  SQL (not JS-after) so the LIMIT applies to the *qualifying* set — a burst of higher-confidence
   *  non-matching edges can never crowd the real reverse edges out of the window. Callers pass
   *  `maxFanout + 1` so their `length > maxFanout` truncation test still fires. */
  getIncomingStructuralEdges(
    nodeId: string,
    bound?: { edgeTypes: readonly string[]; confidenceClasses: readonly string[]; limit: number }
  ): StructuralEdge[] {
    if (!bound) {
      return this.getQueries().getStructuralEdgesForTargetNode.all(nodeId) as StructuralEdge[];
    }
    if (bound.edgeTypes.length === 0 || bound.confidenceClasses.length === 0) return [];
    const etPh = LuxDatabase.deltaPlaceholders(bound.edgeTypes.length);
    const ccPh = LuxDatabase.deltaPlaceholders(bound.confidenceClasses.length);
    return this.db.all(
      `SELECT * FROM structural_edges
         WHERE target_node_id = ?
           AND edge_type IN (${etPh})
           AND confidence_class IN (${ccPh})
         ORDER BY confidence DESC
         LIMIT ?`,
      [nodeId, ...bound.edgeTypes, ...bound.confidenceClasses, bound.limit]
    ) as StructuralEdge[];
  }

  /** Explicitly initialize the read-query layer — Decision 14: `autoMigrate=false` skips it.
   *  ⚠️ Must be called only AFTER `isSchemaUpToDate()` confirms the schema is current: the wrapped
   *  `initQueries()` constructs `PreparedQueries`, which eagerly `db.prepare(...)`s ~65 statements
   *  against current-schema tables/columns; on a stale index (missing migration 011/013 objects)
   *  those prepares throw. `openDeltaDatabase` (spec 10 Part B) enforces this ordering. */
  initReadQueries(): void {
    this.initQueries();
  }

  getStructuralNode(id: string): StructuralNode | null {
    return (this.getQueries().getStructuralNode.get(id) as StructuralNode | undefined) ?? null;
  }

  getStructuralNodesByFilePath(filePath: string): StructuralNode[] {
    return this.getQueries().getStructuralNodeByFilePath.all(filePath) as StructuralNode[];
  }

  getStructuralNodesByType(nodeType: string): StructuralNode[] {
    return this.getQueries().getStructuralNodesByType.all(nodeType) as StructuralNode[];
  }

  /**
   * Structural nodes of a type, EXCLUDING imported vendor-pack nodes (ADR-3 /
   * REQ-7). Overlay consumers that must not surface framework internals
   * (module-boundary analysis, retrieval, trust-state counts) use this instead
   * of {@link getStructuralNodesByType}.
   */
  getLocalStructuralNodesByType(nodeType: string): StructuralNode[] {
    return this.getQueries().getLocalStructuralNodesByType.all(nodeType) as StructuralNode[];
  }

  /** Number of project (non-vendor) structural nodes of a type — what an overlay counter reports. */
  countLocalStructuralNodesByType(nodeType: string): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS n FROM structural_nodes WHERE node_type = ? AND origin = 'local'`,
      [nodeType]
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** True when a node was imported from a vendor pack (not project-local). (ADR-3) */
  static isExternalNode(node: Pick<StructuralNode, 'origin'>): boolean {
    return (node.origin ?? 'local') !== 'local';
  }

  getStructuralEdgesForNode(nodeId: string): StructuralEdge[] {
    return this.getQueries().getStructuralEdgesForNode.all(nodeId, nodeId) as StructuralEdge[];
  }

  /**
   * Outgoing structural edges from a node (source_node_id = nodeId), ordered by
   * confidence. Backs the forward call-trace frontier expansion (ADR-5, REQ-8).
   */
  getOutgoingStructuralEdges(nodeId: string): StructuralEdge[] {
    return this.getQueries().getStructuralEdgesForSourceNode.all(nodeId) as StructuralEdge[];
  }

  /** `handled_by` edges from HTTP surfaces, for ownership classification (E1). */
  getHandlerEdgesForOwnership(): Array<{ id: string; target_node_id: string }> {
    return this.getQueries().getHandlerEdgesForOwnership.all() as Array<{
      id: string;
      target_node_id: string;
    }>;
  }

  /** Persist ownership labels on structural edges in one transaction (E1). */
  setEdgeOwnershipBatch(updates: Array<{ id: string; ownership: string }>): void {
    const stmt = this.getQueries().setEdgeOwnership;
    this.db.transaction((rows: Array<{ id: string; ownership: string }>) => {
      for (const r of rows) stmt.run(r.ownership, r.id);
    })(updates);
  }

  /** Ownership breakdown of HTTP handler edges, for `lux overlay ownership` (E1). */
  getOwnershipBreakdown(): Array<{ ownership: string | null; count: number }> {
    return this.getQueries().getOwnershipBreakdown.all() as Array<{
      ownership: string | null;
      count: number;
    }>;
  }

  /**
   * Resolve a user-supplied symbol (node id, PHP FQN, or leaf name) to candidate
   * structural symbol nodes for a trace start (ADR-5). Returns [] if none.
   */
  findStructuralSymbolNodes(term: string, limit = 10): StructuralNode[] {
    const leaf = term.includes('::') ? term.slice(term.lastIndexOf('::') + 2) : term;
    return this.getQueries().findStructuralSymbolNodes.all({
      term,
      suffix: `%\\${term}`,
      leaf,
      limit,
    }) as StructuralNode[];
  }

  getEdgeEvidence(edgeId: string): EdgeEvidence[] {
    return this.getQueries().getEdgeEvidence.all(edgeId) as EdgeEvidence[];
  }

  /**
   * Mark edges that touch any of the given file paths as dirty-dependent.
   * Returns the total number of edges invalidated.
   */
  invalidateEdgesForFiles(filePaths: string[]): number {
    let total = 0;
    const q = this.getQueries();
    for (const filePath of filePaths) {
      const info = q.invalidateEdgesForFile.run(filePath);
      total += info.changes;
    }
    return total;
  }

  /**
   * Mark edges touching file paths as stale (commit baseline no longer valid).
   * Returns total edges marked stale.
   */
  markEdgesStaleForFiles(filePaths: string[]): number {
    let total = 0;
    const q = this.getQueries();
    for (const filePath of filePaths) {
      const info = q.markEdgesStaleForFile.run(filePath);
      total += info.changes;
    }
    return total;
  }

  /**
   * Mark stale every `fresh` edge whose recorded EVIDENCE cites any of the given changed paths —
   * the write-side sibling of getEvidenceEdgesForFilePaths (db/index.ts:607-616), reusing the same
   * chunked IN over idx_edge_evidence_file_path. Closes the node-path-only gap (Decision 3): a
   * handled_by edge whose endpoints are untouched but whose evidence line sits in a changed routes
   * file is invalidated here. Returns the number of edges newly marked stale.
   */
  markEdgesStaleByEvidencePaths(filePaths: string[]): number {
    if (filePaths.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < filePaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = filePaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      const info = this.db.run(
        `UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
          WHERE freshness_status = 'fresh'
            AND id IN (SELECT DISTINCT ev.edge_id FROM edge_evidence ev
                        WHERE ev.file_path IN (${ph}))`,
        chunk
      );
      total += info.changes;
    }
    return total;
  }

  /**
   * Mark all `fresh` edges whose source_commit differs from the given commit as stale.
   * Call this at the start of a rebuild when the HEAD commit has advanced.
   * Returns the number of edges marked stale.
   */
  markEdgesStaleByCommit(currentCommit: string): number {
    const info = this.getQueries().markEdgesStaleByCommit.run(currentCommit);
    return info.changes;
  }

  /** Repo-relative files touched by any `stale` structural edge (node-path OR evidence dimension).
   *  Read-only. The base-honesty dimension `lux delta` consults so a pointer advanced past an
   *  unrepaired overlay does not read as "nothing changed" (OQ4 / Decision 11). */
  getFilePathsWithStaleEdges(): string[] {
    return (this.getQueries().getStaleOverlayFilePaths.all() as Array<{ file_path: string }>).map(
      (r) => r.file_path
    );
  }

  /** Maintained freshness status for a set of structural-edge ids (read-only). Backs the
   *  stale-aware consumer annotations (Decision 4 / SC-4): a consumer holds the ids of the edges
   *  backing its result and asks what the marks already say — it never mutates freshness. Chunked
   *  over the same DELTA_IN_CHUNK machinery as the delta touch-set queries. */
  getEdgeFreshnessByIds(edgeIds: string[]): Array<Pick<StructuralEdge, 'id' | 'freshness_status'>> {
    return this.deltaChunkedIn<Pick<StructuralEdge, 'id' | 'freshness_status'>>(
      edgeIds,
      (ph) => `SELECT id, freshness_status FROM structural_edges WHERE id IN (${ph})`
    );
  }

  /**
   * Number of distinct stored edges with evidence from a resolver named in `resolvers` or starting
   * with `resolverPrefix` — how the overlay counts detector and propagation edges from what is
   * persisted rather than from a per-run tally.
   */
  countEdgesWithEvidenceFrom(selector: { resolvers?: string[]; resolverPrefix?: string }): number {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (selector.resolvers?.length) {
      clauses.push(`ev.resolver IN (${LuxDatabase.deltaPlaceholders(selector.resolvers.length)})`);
      values.push(...selector.resolvers);
    }
    if (selector.resolverPrefix !== undefined) {
      clauses.push(`substr(ev.resolver, 1, ?) = ?`);
      values.push(selector.resolverPrefix.length, selector.resolverPrefix);
    }
    if (clauses.length === 0) return 0;
    const row = this.db.get(
      `SELECT COUNT(DISTINCT e.id) AS n FROM edge_evidence ev
         JOIN structural_edges e ON e.id = ev.edge_id
        WHERE ${clauses.join(' OR ')}`,
      values
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Aggregate structural-edge counts by maintained freshness status. Rides
   *  idx_structural_edges_freshness (008:38). Reports the four first-class buckets
   *  (fresh / dirty-dependent / stale / unknown — the schema-008 default); `other`
   *  catches any TRULY unrecognized status (expected 0 — a regression sentinel).
   *  `unknown` is a legitimate state (vendor-pack edges default to it), so it is
   *  classified explicitly and never folded into the `other` sentinel. */
  countEdgesByFreshness(): EdgeFreshnessCounts {
    const rows = this.getQueries().getEdgeFreshnessCounts.all() as Array<{
      status: string;
      n: number;
    }>;
    const counts: EdgeFreshnessCounts = {
      fresh: 0,
      'dirty-dependent': 0,
      stale: 0,
      unknown: 0,
      other: 0,
    };
    for (const row of rows) {
      if (
        row.status === 'fresh' ||
        row.status === 'dirty-dependent' ||
        row.status === 'stale' ||
        row.status === 'unknown'
      ) {
        counts[row.status] = row.n;
      } else {
        counts.other += row.n;
      }
    }
    return counts;
  }

  // ── Scoped overlay-refresh helpers (Phase 3a / spec 13 Part A) ────────────────
  //    All on the shipped deltaChunkedIn / deltaPlaceholders / this.db.run layer. Evidence rows
  //    are removed with the edges (no FK cascade on edge_evidence in the schema).

  /** Delete structural_nodes (file/symbol/surface) declared in any of the given rel paths. */
  deleteStructuralNodesForFiles(relPaths: string[]): number {
    let total = 0;
    for (let i = 0; i < relPaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = relPaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `DELETE FROM structural_nodes WHERE file_path IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Delete edges whose SOURCE node is in nodeIds (R's outbound edges) + their evidence. */
  deleteEdgesBySourceNodes(nodeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      this.db.run(
        `DELETE FROM edge_evidence WHERE edge_id IN
           (SELECT id FROM structural_edges WHERE source_node_id IN (${ph}))`,
        chunk
      );
      total += this.db.run(
        `DELETE FROM structural_edges WHERE source_node_id IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Delete edges whose recorded EVIDENCE cites any of relPaths (source-side cross-file edges) +
   *  their evidence. An inbound edge C→A (A∈R, C∉R) cites C, so it is NOT matched — inbound edges
   *  from outside R are preserved (Decision 5). */
  deleteEdgesByEvidencePaths(relPaths: string[]): number {
    let total = 0;
    for (let i = 0; i < relPaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = relPaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      const edgeIds = (
        this.db.all(
          `SELECT DISTINCT se.id AS id FROM structural_edges se
             JOIN edge_evidence ev ON ev.edge_id = se.id
            WHERE ev.file_path IN (${ph})`,
          chunk
        ) as Array<{ id: string }>
      ).map((r) => r.id);
      total += this.deleteEdgesByIds(edgeIds);
    }
    return total;
  }

  /** Delete a set of edges by id + their evidence. */
  private deleteEdgesByIds(edgeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < edgeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = edgeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      this.db.run(`DELETE FROM edge_evidence WHERE edge_id IN (${ph})`, chunk);
      total += this.db.run(`DELETE FROM structural_edges WHERE id IN (${ph})`, chunk).changes;
    }
    return total;
  }

  /** Mark stale surviving edges whose TARGET is one of the given (removed) node ids — the
   *  orphaned-inbound residual (Decision 5): an unchanged caller's edge into a symbol that
   *  vanished on re-derivation. Never deleted — the claim about the caller is real.
   *
   *  Promotes both `fresh` and `dirty-dependent`: the scoped refresh's step-1 fence
   *  (invalidateEdgesForFiles is source-OR-target) transiently marks these inbound edges
   *  `dirty-dependent` before the clear, so a `fresh`-only guard could never reach the orphan.
   *  After a settle, any surviving edge into a removed symbol is definitively stale regardless of
   *  the transient fence state (an already-`stale` edge is left untouched). */
  markEdgesStaleByTargetNodes(nodeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
          WHERE freshness_status IN ('fresh', 'dirty-dependent') AND target_node_id IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Promote surviving inbound edges (dirty-dependent → fresh) whose TARGET is one of the given
   *  (surviving, re-materialized) node ids — the symmetric complement of markEdgesStaleByTargetNodes.
   *
   *  The step-1 fence marks EVERY edge touching R dirty-dependent (source OR target in R). The
   *  settle re-derives R's own outbound edges (fresh) and orphans inbound edges into REMOVED symbols
   *  (stale), but a surviving-target inbound edge C→A (A∈R survives, C∉R, not re-derived) is left
   *  untouched — it would stay dirty-dependent forever and drop out of the `fresh` slice, violating
   *  the equivalence contract (SC-7) that a full rebuild leaves C→A `fresh`. This restores it, so a
   *  complete refresh settles to ZERO residual dirty-dependent.
   *
   *  Only promotes `dirty-dependent`: a legitimately `stale` edge (orphaned target, or a skipped-LSP
   *  residual) is left stale; a re-derived edge is already `fresh` and is not matched. */
  markEdgesFreshByTargetNodes(nodeIds: string[]): number {
    let total = 0;
    for (let i = 0; i < nodeIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = nodeIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'fresh', updated_at = unixepoch()
          WHERE freshness_status = 'dirty-dependent' AND target_node_id IN (${ph})`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Evidence-dimension dirty-dependent mark for the pre-repair fence (mirrors invalidateEdgesForFiles
   *  which is node-path only). Marks the victim set's evidence-cited edges dirty-dependent. */
  invalidateEdgesByEvidencePaths(relPaths: string[]): number {
    let total = 0;
    for (let i = 0; i < relPaths.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = relPaths.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      total += this.db.run(
        `UPDATE structural_edges SET freshness_status = 'dirty-dependent', updated_at = unixepoch()
          WHERE freshness_status = 'fresh'
            AND id IN (SELECT DISTINCT ev.edge_id FROM edge_evidence ev WHERE ev.file_path IN (${ph}))`,
        chunk
      ).changes;
    }
    return total;
  }

  /** Delete operational rows (boundaries + their handlers/contracts/edges) declared in relPaths.
   *  Operational inserts are not idempotent, so R's operational slice is cleared before re-extraction. */
  deleteOperationalForFiles(relPaths: string[]): number {
    const boundaryIds = this.deltaChunkedIn<{ id: string }>(
      relPaths,
      (ph) => `SELECT id FROM operational_boundaries WHERE file_path IN (${ph})`
    ).map((r) => r.id);
    if (boundaryIds.length === 0) return 0;
    let removed = 0;
    for (let i = 0; i < boundaryIds.length; i += LuxDatabase.DELTA_IN_CHUNK) {
      const chunk = boundaryIds.slice(i, i + LuxDatabase.DELTA_IN_CHUNK);
      if (chunk.length === 0) continue;
      const ph = LuxDatabase.deltaPlaceholders(chunk.length);
      this.db.run(`DELETE FROM operational_handlers WHERE boundary_id IN (${ph})`, chunk);
      this.db.run(`DELETE FROM operational_contracts WHERE boundary_id IN (${ph})`, chunk);
      this.db.run(
        `DELETE FROM operational_edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`,
        [...chunk, ...chunk]
      );
      removed += this.db.run(
        `DELETE FROM operational_boundaries WHERE id IN (${ph})`,
        chunk
      ).changes;
    }
    return removed;
  }

  /**
   * Symbol ids more than one file declares (stored file-qualified as `<id>#file:<path>`), and the
   * edges that still point at such an id's bare form. Those edges name an ambiguous target and
   * resolve to no node (identity/symbol-collisions.ts).
   */
  getSymbolIdCollisionCounts(): { collidingIds: number; edgesToAmbiguousIds: number } {
    const ambiguous = `SELECT DISTINCT substr(id, 1, instr(id, '#file:') - 1) AS bare
      FROM structural_nodes
      WHERE origin = 'local' AND node_type = 'symbol' AND instr(id, '#file:') > 0`;
    const row = this.db.get(
      `SELECT (SELECT COUNT(*) FROM (${ambiguous})) AS ids,
              (SELECT COUNT(*) FROM structural_edges WHERE target_node_id IN (${ambiguous})) AS edges`
    ) as { ids: number; edges: number };
    return { collidingIds: row.ids, edgesToAmbiguousIds: row.edges };
  }

  /** Symbol node ids declared in the given files — reuses getStructuralNodesForFilePaths (Decision 14
   *  growth gate + orphan detection). */
  getSymbolNodeIdsForFiles(relPaths: string[]): string[] {
    return this.getStructuralNodesForFilePaths(relPaths)
      .filter((n) => n.node_type === 'symbol')
      .map((n) => n.id);
  }

  /**
   * Retrieve all edges for a node plus their evidence in one call.
   * Combines getStructuralEdgesForNode() and getEdgeEvidence() per edge.
   */
  getRelatedEdgesWithEvidence(
    nodeId: string
  ): Array<{ edge: StructuralEdge; evidence: EdgeEvidence[] }> {
    const edges = this.getStructuralEdgesForNode(nodeId);
    return edges.map((edge) => ({
      edge,
      evidence: this.getEdgeEvidence(edge.id),
    }));
  }

  // ---------------------------------------------------------------------------
  // Capability-surface queries
  // ---------------------------------------------------------------------------

  /**
   * Return all capability-surface nodes, most recently updated first.
   */
  /**
   * Capability-surface ids more than one file declares, in their bare form, each with the files
   * that declare it. Each declaration is stored under `<id>#file:<path>`
   * (identity/file-qualified-id.ts).
   */
  getSharedSurfaceIds(): Array<{ id: string; files: string[] }> {
    const rows = this.db.all(
      `SELECT substr(id, 1, instr(id, '#file:') - 1) AS bare, file_path
         FROM structural_nodes
        WHERE node_type = 'capability-surface' AND instr(id, '#file:') > 0
        ORDER BY bare, file_path`
    ) as Array<{ bare: string; file_path: string }>;
    const shared = new Map<string, string[]>();
    for (const row of rows) shared.set(row.bare, [...(shared.get(row.bare) ?? []), row.file_path]);
    return [...shared].map(([id, files]) => ({ id, files }));
  }

  getCapabilitySurfaces(): StructuralNode[] {
    return this.getQueries().getCapabilitySurfaces.all() as StructuralNode[];
  }

  /**
   * Search capability-surface nodes whose canonical handle (symbol_name)
   * matches the given prefix pattern. Use `%` suffix for prefix search or
   * exact string for exact match.
   *
   * @param handlePattern - SQLite LIKE pattern (e.g. `"GET %"` or `"GET /api/invoices"`).
   */
  searchSurfacesByHandle(handlePattern: string): StructuralNode[] {
    return this.getQueries().searchSurfacesByHandle.all(handlePattern) as StructuralNode[];
  }

  /**
   * Retrieve a surface node plus all edges and evidence connected to it.
   * Returns null if the surface node does not exist.
   */
  getSurfaceCenteredContext(surfaceNodeId: string): {
    surface: StructuralNode;
    edges: Array<{ edge: StructuralEdge; evidence: EdgeEvidence[] }>;
  } | null {
    const surface = this.getStructuralNode(surfaceNodeId);
    if (!surface) return null;
    return {
      surface,
      edges: this.getRelatedEdgesWithEvidence(surfaceNodeId),
    };
  }

  // ---------------------------------------------------------------------------
  // Operational boundary queries
  // ---------------------------------------------------------------------------

  upsertOperationalBoundary(boundary: OperationalBoundary): void {
    this.getQueries().upsertOperationalBoundary.run({
      id: boundary.id,
      // Whatever root the scanner ran in, the stored value says only "this index's repository".
      repo_root: STORED_CORPUS_ROOT,
      kind: boundary.kind,
      name: boundary.name,
      trust_tier: boundary.trust_tier,
      file_path: boundary.file_path ?? null,
    });
  }

  getOperationalBoundary(id: string): OperationalBoundary | null {
    return (
      (this.getQueries().getOperationalBoundary.get(id) as OperationalBoundary | undefined) ?? null
    );
  }

  getOperationalBoundariesByKind(kind: OperationalBoundary['kind']): OperationalBoundary[] {
    return this.getQueries().getOperationalBoundariesByKind.all(kind) as OperationalBoundary[];
  }

  /** Every operational boundary of the repository this index describes. */
  getOperationalBoundaries(): OperationalBoundary[] {
    return this.getQueries().getOperationalBoundaries.all() as OperationalBoundary[];
  }

  upsertOperationalHandler(handler: OperationalHandler): void {
    this.getQueries().upsertOperationalHandler.run({
      id: handler.id,
      boundary_id: handler.boundary_id,
      symbol_id: handler.symbol_id,
      trust_tier: handler.trust_tier,
    });
  }

  getOperationalHandlersForBoundary(boundaryId: string): OperationalHandler[] {
    return this.getQueries().getOperationalHandlersForBoundary.all(
      boundaryId
    ) as OperationalHandler[];
  }

  upsertOperationalEdge(edge: OperationalEdge): void {
    this.getQueries().upsertOperationalEdge.run({
      id: edge.id,
      source_id: edge.source_id,
      target_id: edge.target_id,
      edge_type: edge.edge_type,
      transport: edge.transport ?? null,
      trust_tier: edge.trust_tier,
    });
  }

  getOperationalEdgesForSource(sourceId: string): OperationalEdge[] {
    return this.getQueries().getOperationalEdgesForSource.all(sourceId) as OperationalEdge[];
  }

  getOperationalEdgesForTarget(targetId: string): OperationalEdge[] {
    return this.getQueries().getOperationalEdgesForTarget.all(targetId) as OperationalEdge[];
  }

  upsertOperationalContract(contract: OperationalContract): void {
    this.getQueries().upsertOperationalContract.run({
      id: contract.id,
      boundary_id: contract.boundary_id,
      payload_schema: contract.payload_schema ?? null,
      trust_tier: contract.trust_tier,
    });
  }

  getOperationalContractsForBoundary(boundaryId: string): OperationalContract[] {
    return this.getQueries().getOperationalContractsForBoundary.all(
      boundaryId
    ) as OperationalContract[];
  }

  // Utility operations
  clearKnowledgeIndex(): void {
    const queries = this.getQueries();
    queries.clearKnowledgeEntries.run();
    queries.clearModuleDependencies.run();
  }

  clearOverlay(): void {
    const queries = this.getQueries();
    // One transaction: a single commit, and the text and FTS planes are never cleared apart
    // (upsertNodeAnchorText relies on an FTS row never outliving its text row).
    this.transaction(() => {
      queries.clearEdgeEvidence.run();
      queries.clearStructuralEdges.run();
      queries.clearStructuralNodes.run();
      // Anchor plane clear (Decision 5) — a full rebuild regenerates every node id, so it re-indexes
      // (and, Phase 3, re-embeds) the whole anchor plane; clearing here, in the one method that resets
      // the overlay, keeps a populated-then-rebuilt corpus orphan-free. LuxDatabase has no `.exec`; use
      // `this.db.run` (the adapter's raw-SQL entry), the same form the victim delete uses.
      this.db.run('DELETE FROM structural_node_texts');
      this.db.run('DELETE FROM structural_node_fts');
      this.db.run('DELETE FROM structural_node_embeddings'); // Phase 3 (mig 015): the vector plane clears with its siblings.
      queries.clearOperationalContracts.run();
      queries.clearOperationalEdges.run();
      queries.clearOperationalHandlers.run();
      queries.clearOperationalBoundaries.run();
      // The merged vendor pack's nodes and edges went with the overlay, so its record goes too.
      queries.deleteIndexMetadata.run('vendor_pack_merged');
    });
  }

  /** True when the overlay holds any node merged from a vendor pack. */
  hasVendorPackNodes(): boolean {
    return (
      this.db.get(
        `SELECT 1 AS present FROM structural_nodes WHERE origin = 'vendor-pack' LIMIT 1`
      ) !== undefined
    );
  }

  clearRebuildTrustState(): void {
    this.deleteIndexMetadata('overlay_trust_state');
  }

  /**
   * Start a rebuild: drop the trust state the index had, and record that a rebuild began. The record
   * is removed when the rebuild records its outcome (finishRebuild), so a rebuild that dies part-way
   * leaves it behind and the index reads as incomplete rather than as whatever it has on disk.
   */
  beginRebuild(): void {
    this.transaction(() => {
      this.deleteIndexMetadata('overlay_trust_state');
      this.setIndexMetadata(
        REBUILD_STARTED_KEY,
        JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid })
      );
    });
  }

  /** The rebuild recorded its outcome: it is no longer in progress. */
  finishRebuild(): void {
    this.deleteIndexMetadata(REBUILD_STARTED_KEY);
  }

  /** When an unfinished rebuild started, or undefined when none is outstanding. */
  unfinishedRebuildStartedAt(): string | undefined {
    const raw = this.getIndexMetadata(REBUILD_STARTED_KEY);
    if (raw === undefined) return undefined;
    try {
      const startedAt = (JSON.parse(raw) as { startedAt?: unknown }).startedAt;
      return typeof startedAt === 'string' ? startedAt : 'an unknown time';
    } catch {
      // lux-intentional-swallow: a record Lux wrote but cannot read still says a rebuild is unfinished.
      return 'an unknown time';
    }
  }

  clearAll() {
    const queries = this.getQueries();
    this.clearOverlay();
    this.clearKnowledgeIndex();
    queries.clearEvents.run();
  }

  getStats() {
    const queries = this.getQueries();
    const knowledge = queries.countKnowledgeEntries.get() as { count: number };
    const events = queries.countEvents.get() as { count: number };

    return {
      knowledge_entries: knowledge.count,
      events: events.count,
    };
  }

  close() {
    this.db.close();
  }
}
