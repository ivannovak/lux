import type { LuxSqlite, Stmt } from './sqlite-adapter.js';

/**
 * Prepared statements for the Lux database.
 * These statements are initialized once and reused for better performance.
 */
export class PreparedQueries {
  // Knowledge entry queries
  readonly insertKnowledgeEntry: Stmt;
  readonly getKnowledgeEntriesByType: Stmt;
  readonly getAllKnowledgeEntries: Stmt;
  readonly getKnowledgeEntryByPath: Stmt;
  readonly deleteKnowledgeEntry: Stmt;

  // Event queries
  readonly insertEvent: Stmt;
  readonly getRecentEvents: Stmt;

  // Stats queries
  readonly countKnowledgeEntries: Stmt;
  readonly countEvents: Stmt;

  // Clear queries
  readonly clearEvents: Stmt;
  readonly clearKnowledgeEntries: Stmt;
  readonly clearStructuralNodes: Stmt;
  readonly clearStructuralEdges: Stmt;
  readonly clearEdgeEvidence: Stmt;
  readonly clearOperationalBoundaries: Stmt;
  readonly clearOperationalHandlers: Stmt;
  readonly clearOperationalEdges: Stmt;
  readonly clearOperationalContracts: Stmt;

  // FTS5 ranked search queries (D1/D2): raw bm25 rank out, LIMIT + projection in SQL.
  readonly searchRanked: Stmt;
  readonly searchRankedWithSnippet: Stmt;

  // Index metadata queries
  readonly getIndexMetadata: Stmt;
  readonly setIndexMetadata: Stmt;
  readonly deleteIndexMetadata: Stmt;

  // Delete knowledge entry by path
  readonly deleteKnowledgeEntryByPath: Stmt;

  // Module dependency queries
  readonly insertModuleDependency: Stmt;
  readonly getModuleDependenciesBySource: Stmt;
  readonly getModuleDependenciesByTarget: Stmt;
  readonly getAllModuleDependencies: Stmt;
  readonly getModuleDependency: Stmt;
  readonly clearModuleDependencies: Stmt;
  readonly getDistinctModules: Stmt;

  // Structural overlay queries — nodes
  readonly upsertStructuralNode: Stmt;
  readonly getStructuralNode: Stmt;
  readonly getStructuralNodesByType: Stmt;
  readonly getLocalStructuralNodesByType: Stmt;
  readonly findStructuralSymbolNodes: Stmt;
  readonly getStructuralNodeByFilePath: Stmt;

  // Structural overlay queries — edges
  readonly upsertStructuralEdge: Stmt;
  readonly getStructuralEdge: Stmt;
  readonly getStructuralEdgesForSourceNode: Stmt;
  readonly getStructuralEdgesForTargetNode: Stmt;
  readonly getStructuralEdgesForNode: Stmt;
  readonly invalidateEdgesForFile: Stmt;
  readonly markEdgesStaleForFile: Stmt;
  readonly markEdgesStaleByCommit: Stmt;
  readonly getEdgeFreshnessCounts: Stmt;
  readonly getStaleOverlayFilePaths: Stmt;

  // Structural overlay queries — evidence
  readonly insertEdgeEvidence: Stmt;
  readonly deleteEdgeEvidence: Stmt;
  readonly getEdgeEvidence: Stmt;
  readonly getEdgeEvidenceByResolver: Stmt;

  // Capability-surface queries
  readonly getCapabilitySurfaces: Stmt;
  readonly searchSurfacesByHandle: Stmt;

  // Operational boundary queries
  readonly upsertOperationalBoundary: Stmt;
  readonly getOperationalBoundary: Stmt;
  readonly getOperationalBoundariesByKind: Stmt;
  readonly getOperationalBoundariesByRepoRoot: Stmt;
  readonly upsertOperationalHandler: Stmt;
  readonly getOperationalHandlersForBoundary: Stmt;
  readonly upsertOperationalEdge: Stmt;
  readonly getOperationalEdgesForSource: Stmt;
  readonly getOperationalEdgesForTarget: Stmt;
  readonly upsertOperationalContract: Stmt;
  readonly getOperationalContractsForBoundary: Stmt;

  // Ownership classification (E1)
  readonly getHandlerEdgesForOwnership: Stmt;
  readonly setEdgeOwnership: Stmt;
  readonly getOwnershipBreakdown: Stmt;

  // Node anchor lexical index (Decision 4/5). Standalone FTS maintained by delete-then-insert.
  readonly upsertNodeAnchorTextRow: Stmt;
  readonly hasNodeAnchorText: Stmt;
  readonly deleteNodeFtsRow: Stmt;
  readonly insertNodeFtsRow: Stmt;
  readonly rankAnchorsLexical: Stmt;
  readonly countNodeAnchorTexts: Stmt;
  readonly countStructuralNodes: Stmt;

  // Anchor embeddings (D5/D7/D11): sibling-table read/write, the widened freshness queue, coverage.
  readonly insertNodeEmbedding: Stmt;
  readonly getUnembeddedAnchorNodes: Stmt;
  readonly getNodeVectorsForModel: Stmt;
  readonly getNodeEmbeddingByNode: Stmt;
  readonly getAnchorEmbeddingCoverage: Stmt;

  constructor(db: LuxSqlite) {
    // Knowledge entry queries
    this.insertKnowledgeEntry = db.prepare(`
      INSERT INTO knowledge_entries (type, title, file_path, tags, metadata, content)
      VALUES (@type, @title, @file_path, @tags, @metadata, @content)
    `);

    this.getKnowledgeEntriesByType = db.prepare(`
      SELECT * FROM knowledge_entries WHERE type = ?
    `);

    this.getAllKnowledgeEntries = db.prepare(`
      SELECT * FROM knowledge_entries
    `);

    this.getKnowledgeEntryByPath = db.prepare(`
      SELECT * FROM knowledge_entries WHERE file_path = ?
    `);

    this.deleteKnowledgeEntry = db.prepare(`
      DELETE FROM knowledge_entries WHERE id = ?
    `);

    // Event queries
    this.insertEvent = db.prepare(`
      INSERT INTO events (source, source_id, event_type, summary, payload)
      VALUES (@source, @source_id, @event_type, @summary, @payload)
    `);

    this.getRecentEvents = db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `);

    // Stats queries
    this.countKnowledgeEntries = db.prepare(`
      SELECT COUNT(*) as count FROM knowledge_entries
    `);

    this.countEvents = db.prepare(`
      SELECT COUNT(*) as count FROM events
    `);

    // Clear queries (used by clearAll)
    this.clearEvents = db.prepare(`DELETE FROM events`);
    this.clearKnowledgeEntries = db.prepare(`DELETE FROM knowledge_entries`);
    this.clearEdgeEvidence = db.prepare(`DELETE FROM edge_evidence`);
    this.clearStructuralEdges = db.prepare(`DELETE FROM structural_edges`);
    this.clearStructuralNodes = db.prepare(`DELETE FROM structural_nodes`);
    this.clearOperationalContracts = db.prepare(`DELETE FROM operational_contracts`);
    this.clearOperationalEdges = db.prepare(`DELETE FROM operational_edges`);
    this.clearOperationalHandlers = db.prepare(`DELETE FROM operational_handlers`);
    this.clearOperationalBoundaries = db.prepare(`DELETE FROM operational_boundaries`);

    // Ranked document search (D1/D2): raw bm25 rank flows out; LIMIT + projection in SQL; no content
    // hauled. Column order for bm25/snippet is (0)type (1)title (2)tags (3)metadata (4)content.
    this.searchRanked = db.prepare(`
      SELECT k.id, k.type, k.title, k.file_path,
             knowledge_entries_fts.rank AS rank
      FROM knowledge_entries k
      JOIN knowledge_entries_fts ON k.id = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    // Same, plus a query-term-centered snippet from the content column (index 4) — opt-in --snippets.
    this.searchRankedWithSnippet = db.prepare(`
      SELECT k.id, k.type, k.title, k.file_path,
             knowledge_entries_fts.rank AS rank,
             snippet(knowledge_entries_fts, 4, '<mark>', '</mark>', '…', 12) AS snippet
      FROM knowledge_entries k
      JOIN knowledge_entries_fts ON k.id = knowledge_entries_fts.rowid
      WHERE knowledge_entries_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    // Index metadata queries
    this.getIndexMetadata = db.prepare(`
      SELECT value FROM index_metadata WHERE key = ?
    `);

    this.setIndexMetadata = db.prepare(`
      INSERT INTO index_metadata (key, value, updated_at)
      VALUES (@key, @value, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = unixepoch()
    `);

    this.deleteIndexMetadata = db.prepare(`
      DELETE FROM index_metadata WHERE key = ?
    `);

    // Delete knowledge entry by file path
    this.deleteKnowledgeEntryByPath = db.prepare(`
      DELETE FROM knowledge_entries WHERE file_path = ?
    `);

    // Module dependency queries
    this.insertModuleDependency = db.prepare(`
      INSERT OR REPLACE INTO module_dependencies (source_module, target_module, reference_count, sample_files)
      VALUES (@source_module, @target_module, @reference_count, @sample_files)
    `);

    this.getModuleDependenciesBySource = db.prepare(`
      SELECT * FROM module_dependencies WHERE source_module = ?
      ORDER BY reference_count DESC, target_module ASC
    `);

    this.getModuleDependenciesByTarget = db.prepare(`
      SELECT * FROM module_dependencies WHERE target_module = ?
      ORDER BY reference_count DESC, source_module ASC
    `);

    this.getAllModuleDependencies = db.prepare(`
      SELECT * FROM module_dependencies
      ORDER BY reference_count DESC, source_module ASC, target_module ASC
    `);

    this.getModuleDependency = db.prepare(`
      SELECT * FROM module_dependencies WHERE source_module = ? AND target_module = ?
    `);

    this.clearModuleDependencies = db.prepare(`DELETE FROM module_dependencies`);

    this.getDistinctModules = db.prepare(`
      SELECT DISTINCT module FROM (
        SELECT source_module AS module FROM module_dependencies
        UNION
        SELECT target_module AS module FROM module_dependencies
      ) ORDER BY module
    `);

    // Structural overlay — node queries
    this.upsertStructuralNode = db.prepare(`
      INSERT INTO structural_nodes (id, node_type, file_path, language_id, symbol_name, symbol_kind, qualified_name, metadata, origin, updated_at)
      VALUES (@id, @node_type, @file_path, @language_id, @symbol_name, @symbol_kind, @qualified_name, @metadata, @origin, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        node_type = excluded.node_type,
        file_path = excluded.file_path,
        language_id = excluded.language_id,
        symbol_name = excluded.symbol_name,
        symbol_kind = excluded.symbol_kind,
        qualified_name = excluded.qualified_name,
        metadata = excluded.metadata,
        origin = excluded.origin,
        updated_at = excluded.updated_at
    `);

    this.getStructuralNode = db.prepare(`
      SELECT * FROM structural_nodes WHERE id = ?
    `);

    this.getStructuralNodesByType = db.prepare(`
      SELECT * FROM structural_nodes WHERE node_type = ? ORDER BY updated_at DESC
    `);

    // origin='local' only — excludes merged vendor-pack nodes (ADR-3 / REQ-7).
    this.getLocalStructuralNodesByType = db.prepare(`
      SELECT * FROM structural_nodes
      WHERE node_type = ? AND origin = 'local'
      ORDER BY updated_at DESC
    `);

    // Resolve a user-supplied symbol to structural symbol nodes for a trace start
    // (ADR-5). Exact id / qualified_name / symbol_name wins; app (local) nodes
    // rank above vendor-pack nodes so `lux trace Foo::bar` picks authored code.
    this.findStructuralSymbolNodes = db.prepare(`
      SELECT * FROM structural_nodes
      WHERE node_type = 'symbol'
        AND (id = @term OR qualified_name = @term OR symbol_name = @term
             OR qualified_name LIKE @suffix OR symbol_name = @leaf)
      ORDER BY
        (id = @term OR qualified_name = @term) DESC,
        (origin = 'local') DESC,
        updated_at DESC
      LIMIT @limit
    `);

    this.getStructuralNodeByFilePath = db.prepare(`
      SELECT * FROM structural_nodes WHERE file_path = ? ORDER BY node_type
    `);

    // Structural overlay — edge queries
    this.upsertStructuralEdge = db.prepare(`
      INSERT INTO structural_edges (id, source_node_id, target_node_id, edge_type, confidence, confidence_class, freshness_status, source_commit, dirty_dependency_count, provenance_summary, updated_at)
      VALUES (@id, @source_node_id, @target_node_id, @edge_type, @confidence, @confidence_class, @freshness_status, @source_commit, @dirty_dependency_count, @provenance_summary, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        edge_type = excluded.edge_type,
        confidence = excluded.confidence,
        confidence_class = excluded.confidence_class,
        freshness_status = excluded.freshness_status,
        source_commit = excluded.source_commit,
        dirty_dependency_count = excluded.dirty_dependency_count,
        provenance_summary = excluded.provenance_summary,
        updated_at = excluded.updated_at
    `);

    this.getStructuralEdge = db.prepare(`
      SELECT * FROM structural_edges WHERE id = ?
    `);

    this.getStructuralEdgesForSourceNode = db.prepare(`
      SELECT * FROM structural_edges WHERE source_node_id = ? ORDER BY confidence DESC
    `);

    this.getStructuralEdgesForTargetNode = db.prepare(`
      SELECT * FROM structural_edges WHERE target_node_id = ? ORDER BY confidence DESC
    `);

    this.getStructuralEdgesForNode = db.prepare(`
      SELECT * FROM structural_edges
      WHERE source_node_id = ? OR target_node_id = ?
      ORDER BY confidence DESC
    `);

    // Only downgrades `fresh` edges (matches the evidence-dimension fence
    // invalidateEdgesByEvidencePaths, index.ts): a pre-existing `stale` mark is a real
    // claim about changed cited code and must survive the fence, and an unconditional
    // overwrite would clobber it back to `dirty-dependent` (masking the honest stale).
    // The crash-floor contract is preserved — no `fresh` edge in the victim set survives.
    this.invalidateEdgesForFile = db.prepare(`
      UPDATE structural_edges SET freshness_status = 'dirty-dependent', updated_at = unixepoch()
      WHERE freshness_status = 'fresh'
        AND id IN (
          SELECT se.id FROM structural_edges se
          JOIN structural_nodes sn ON se.source_node_id = sn.id OR se.target_node_id = sn.id
          WHERE sn.file_path = ?
        )
    `);

    this.markEdgesStaleForFile = db.prepare(`
      UPDATE structural_edges SET freshness_status = 'stale', updated_at = unixepoch()
      WHERE id IN (
        SELECT se.id FROM structural_edges se
        JOIN structural_nodes sn ON se.source_node_id = sn.id OR se.target_node_id = sn.id
        WHERE sn.file_path = ?
      )
    `);

    this.markEdgesStaleByCommit = db.prepare(`
      UPDATE structural_edges
      SET freshness_status = 'stale', updated_at = unixepoch()
      WHERE freshness_status = 'fresh'
        AND source_commit IS NOT NULL
        AND source_commit != ?
    `);

    this.getEdgeFreshnessCounts = db.prepare(`
      SELECT freshness_status AS status, COUNT(*) AS n
      FROM structural_edges
      GROUP BY freshness_status
    `);

    // UNION already deduplicates across the two dimensions, so no outer SELECT DISTINCT is needed.
    this.getStaleOverlayFilePaths = db.prepare(`
      SELECT sn.file_path AS file_path
        FROM structural_edges se
        JOIN structural_nodes sn
          ON sn.id = se.source_node_id OR sn.id = se.target_node_id
       WHERE se.freshness_status = 'stale' AND sn.file_path IS NOT NULL
      UNION
      SELECT ev.file_path AS file_path
        FROM structural_edges se
        JOIN edge_evidence ev ON ev.edge_id = se.id
       WHERE se.freshness_status = 'stale' AND ev.file_path IS NOT NULL
    `);

    // Structural overlay — evidence queries
    this.insertEdgeEvidence = db.prepare(`
      INSERT INTO edge_evidence (id, edge_id, resolver, evidence_kind, file_path, line, note, payload_json, recorded_at)
      VALUES (@id, @edge_id, @resolver, @evidence_kind, @file_path, @line, @note, @payload_json, @recorded_at)
    `);

    this.deleteEdgeEvidence = db.prepare(`
      DELETE FROM edge_evidence WHERE edge_id = ?
    `);

    this.getEdgeEvidence = db.prepare(`
      SELECT * FROM edge_evidence WHERE edge_id = ? ORDER BY recorded_at ASC
    `);

    this.getEdgeEvidenceByResolver = db.prepare(`
      SELECT * FROM edge_evidence WHERE edge_id = ? AND resolver = ? ORDER BY recorded_at ASC
    `);

    // Capability-surface queries
    this.getCapabilitySurfaces = db.prepare(`
      SELECT * FROM structural_nodes WHERE node_type = 'capability-surface' ORDER BY updated_at DESC
    `);

    // Search surfaces by symbol_name (canonical handle) prefix or exact match
    this.searchSurfacesByHandle = db.prepare(`
      SELECT * FROM structural_nodes
      WHERE node_type = 'capability-surface'
        AND symbol_name LIKE ?
      ORDER BY updated_at DESC
    `);

    // Operational boundary queries
    this.upsertOperationalBoundary = db.prepare(`
      INSERT INTO operational_boundaries (id, repo_root, kind, name, trust_tier, file_path)
      VALUES (@id, @repo_root, @kind, @name, @trust_tier, @file_path)
      ON CONFLICT(id) DO UPDATE SET
        repo_root = excluded.repo_root,
        kind = excluded.kind,
        name = excluded.name,
        trust_tier = excluded.trust_tier,
        file_path = excluded.file_path
    `);

    this.getOperationalBoundary = db.prepare(`
      SELECT * FROM operational_boundaries WHERE id = ?
    `);

    this.getOperationalBoundariesByKind = db.prepare(`
      SELECT * FROM operational_boundaries WHERE kind = ? ORDER BY name ASC
    `);

    this.getOperationalBoundariesByRepoRoot = db.prepare(`
      SELECT * FROM operational_boundaries WHERE repo_root = ? ORDER BY kind ASC, name ASC
    `);

    this.upsertOperationalHandler = db.prepare(`
      INSERT INTO operational_handlers (id, boundary_id, symbol_id, trust_tier)
      VALUES (@id, @boundary_id, @symbol_id, @trust_tier)
      ON CONFLICT(id) DO UPDATE SET
        boundary_id = excluded.boundary_id,
        symbol_id = excluded.symbol_id,
        trust_tier = excluded.trust_tier
    `);

    this.getOperationalHandlersForBoundary = db.prepare(`
      SELECT * FROM operational_handlers WHERE boundary_id = ? ORDER BY symbol_id ASC
    `);

    this.upsertOperationalEdge = db.prepare(`
      INSERT INTO operational_edges (id, source_id, target_id, edge_type, transport, trust_tier)
      VALUES (@id, @source_id, @target_id, @edge_type, @transport, @trust_tier)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        edge_type = excluded.edge_type,
        transport = excluded.transport,
        trust_tier = excluded.trust_tier
    `);

    this.getOperationalEdgesForSource = db.prepare(`
      SELECT * FROM operational_edges WHERE source_id = ? ORDER BY edge_type ASC, target_id ASC
    `);

    this.getOperationalEdgesForTarget = db.prepare(`
      SELECT * FROM operational_edges WHERE target_id = ? ORDER BY edge_type ASC, source_id ASC
    `);

    this.upsertOperationalContract = db.prepare(`
      INSERT INTO operational_contracts (id, boundary_id, payload_schema, trust_tier)
      VALUES (@id, @boundary_id, @payload_schema, @trust_tier)
      ON CONFLICT(id) DO UPDATE SET
        boundary_id = excluded.boundary_id,
        payload_schema = excluded.payload_schema,
        trust_tier = excluded.trust_tier
    `);

    this.getOperationalContractsForBoundary = db.prepare(`
      SELECT * FROM operational_contracts WHERE boundary_id = ? ORDER BY id ASC
    `);

    // Ownership classification (E1) — cached one-shots hoisted from index.ts so the
    // never-closed MCP DB does not accumulate a fresh statement handle every rebuild.
    this.getHandlerEdgesForOwnership = db.prepare(`
      SELECT id, target_node_id FROM structural_edges
      WHERE edge_type = 'handled_by' AND source_node_id LIKE 'surface:http:%'
    `);

    this.setEdgeOwnership = db.prepare(`UPDATE structural_edges SET ownership = ? WHERE id = ?`);

    // `ownership ASC` breaks count ties. SQLite returns GROUP BY groups in key order today, but only
    // by implementation: https://www.sqlite.org/lang_select.html documents no order for GROUP BY
    // output, and says "the order in which two rows for which all ORDER BY expressions evaluate to
    // equal values are returned is undefined".
    this.getOwnershipBreakdown = db.prepare(`
      SELECT ownership, COUNT(*) as count FROM structural_edges
      WHERE edge_type = 'handled_by' AND source_node_id LIKE 'surface:http:%'
      GROUP BY ownership ORDER BY count DESC, ownership ASC
    `);

    // structural_node_texts upsert (INSERT OR REPLACE on the node_id PK: a re-materialization of the
    // same id fully replaces the row, including content_hash + updated_at).
    this.upsertNodeAnchorTextRow = db.prepare(`
      INSERT OR REPLACE INTO structural_node_texts (node_id, prepared, content_hash, updated_at)
      VALUES (@node_id, @prepared, @content_hash, unixepoch())
    `);

    // Whether a node already has prepared text — and therefore an FTS row (see upsertNodeAnchorText).
    this.hasNodeAnchorText = db.prepare(
      `SELECT 1 AS present FROM structural_node_texts WHERE node_id = ?`
    );

    // structural_node_fts is a standalone (non-external-content) table keyed on an UNINDEXED node_id,
    // so it has no INSERT OR REPLACE semantics — maintained by delete-then-insert per node. The
    // UNINDEXED column cannot be searched by index, so this delete scans the whole FTS table.
    this.deleteNodeFtsRow = db.prepare(`DELETE FROM structural_node_fts WHERE node_id = ?`);
    this.insertNodeFtsRow = db.prepare(`
      INSERT INTO structural_node_fts (node_id, name, identifiers, qualified, path_segments, context)
      VALUES (@node_id, @name, @identifiers, @qualified, @path_segments, @context)
    `);

    // Weighted-bm25 lexical anchor ranking (Decision 4). Column order for bm25 is
    // (0)node_id[UNINDEXED] (1)name (2)identifiers (3)qualified (4)path_segments (5)context — the
    // weight vector favours name/identifier hits over context hits; benchmark-tuned in T1.8 (spec 12).
    this.rankAnchorsLexical = db.prepare(`
      SELECT n.id AS node_id, n.symbol_kind, n.symbol_name, n.qualified_name, n.file_path,
             bm25(structural_node_fts, 0.0, 5.0, 4.0, 2.0, 2.0, 1.0) AS rank
      FROM structural_node_fts
      JOIN structural_nodes n ON n.id = structural_node_fts.node_id
      WHERE structural_node_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.countNodeAnchorTexts = db.prepare(`SELECT COUNT(*) AS n FROM structural_node_texts`);
    this.countStructuralNodes = db.prepare(`SELECT COUNT(*) AS n FROM structural_nodes`);

    // Anchor embeddings (D5/D7/D11). INSERT OR REPLACE on the node_id PK: a re-embed (model change
    // or content_hash miss) fully replaces the one active vector for that node, including updated_at.
    this.insertNodeEmbedding = db.prepare(`
      INSERT OR REPLACE INTO structural_node_embeddings (node_id, model, dims, vector, content_hash, updated_at)
      VALUES (@node_id, @model, @dims, @vector, @content_hash, unixepoch())
    `);

    // The widened needs-embedding / resume queue (D5 — this plane's divergence). Drives off
    // structural_node_texts (mig 014, Phase 1): every anchor-viable node with no fresh vector under
    // the bound model. Two arms:
    //   e.node_id IS NULL       -> never-embedded nodes, AND (post-victim-delete) changed-and-
    //                             re-materialized nodes whose sibling row was already swept.
    //   e.content_hash <> t...  -> a SURVIVING embedding row under a STABLE node id whose prepared
    //                             text changed — the freshness bug a NULL-only queue would leave on
    //                             the deterministic-id plane (the primitive never needed this arm
    //                             because its ids churned; ours don't).
    // Both compared columns are stored (the WASM engine exposes no sha256()), so the comparison is a
    // plain indexed anti-join — cheap when coverage is already complete, which is what lets the embed
    // pass run on every sync path for free (03 §four embed-pass integration points).
    this.getUnembeddedAnchorNodes = db.prepare(`
      SELECT t.node_id, t.prepared, t.content_hash
      FROM structural_node_texts t
      LEFT JOIN structural_node_embeddings e ON e.node_id = t.node_id AND e.model = ?
      WHERE e.node_id IS NULL OR e.content_hash <> t.content_hash
      LIMIT ?
    `);

    // Consumer scan source (D7/D11): every vector under one model, full table order, NARROWED to the
    // two columns topCosine actually reads (node_id + vector). The cosine kernel (cosine.ts) reads ONLY
    // through this — never an unfiltered scan — so a mid-model-change corpus that transiently holds two
    // model spaces can never yield a cross-model cosine. Projecting just node_id+vector avoids
    // materializing model/dims/content_hash strings for every one of ~40 K rows on the warm read path.
    this.getNodeVectorsForModel = db.prepare(`
      SELECT node_id, vector
      FROM structural_node_embeddings
      WHERE model = ?
    `);

    // Single-row point read for fixtures/tests (03 §Data-layer methods) and any future point-read
    // caller. Scoped by model so a stale-model row for the same node is not mistaken for the current.
    this.getNodeEmbeddingByNode = db.prepare(`
      SELECT node_id, model, dims, vector, content_hash
      FROM structural_node_embeddings
      WHERE node_id = ? AND model = ?
    `);

    // Coverage read (D11). Denominator = the WHOLE anchor-viable set (every structural_node_texts
    // row IS an anchor-viable node — 03 §Population scope). Numerator = only vectors that are BOTH
    // under the bound model AND fresh (content_hash still matches the current prepared text), so a
    // stale-content_hash row (mid-change) counts as un-embedded-under-current and never inflates the
    // reported percentage — mirroring D11's stale-model exclusion for a stale-content row.
    this.getAnchorEmbeddingCoverage = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM structural_node_texts) AS anchorViableNodes,
        (SELECT COUNT(*) FROM structural_node_embeddings e
           JOIN structural_node_texts t ON t.node_id = e.node_id
           WHERE e.model = ? AND e.content_hash = t.content_hash) AS embeddedNodes
    `);
  }
}
