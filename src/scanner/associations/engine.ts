// Association engine: collects nodes, runs resolvers, persists edges + evidence.
//
// The engine is the single entry point for building or refreshing the
// cross-language structural overlay. It does not perform graph projection —
// it only produces and persists flat edge records with evidence.

import { ROWS_PER_COMMIT, writeAllInChunks, type LuxDatabase } from '../../db/index.js';
import type { StructuralEdge, EdgeEvidence } from '../../db/types.js';
import type { AssociationContext, AssociationResolver, StructuralRelationEdge } from './types.js';

// ---------------------------------------------------------------------------
// AssociationEngine
// ---------------------------------------------------------------------------

/** Options for AssociationEngine. */
export interface AssociationEngineOptions {
  /**
   * Include heuristic edges in the output.
   * Defaults to false — heuristic edges are excluded unless corroborated
   * by at least one non-heuristic edge between the same node pair.
   */
  includeHeuristics?: boolean;
  /** Progress callback. */
  onProgress?: (message: string) => void;
}

/**
 * The AssociationEngine orchestrates the cross-language overlay rebuild.
 *
 * Usage:
 * ```
 * const engine = new AssociationEngine(db, resolvers);
 * await engine.rebuild(context);
 * ```
 */
export class AssociationEngine {
  private readonly resolvers: AssociationResolver[];
  private readonly db: LuxDatabase;
  private readonly options: Required<AssociationEngineOptions>;

  constructor(
    db: LuxDatabase,
    resolvers: AssociationResolver[],
    options: AssociationEngineOptions = {}
  ) {
    this.db = db;
    this.resolvers = resolvers;
    this.options = {
      includeHeuristics: options.includeHeuristics ?? false,
      onProgress: options.onProgress ?? (() => {}),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Rebuild the structural overlay for the given context.
   *
   * Steps:
   * 1. Run all enabled resolvers.
   * 2. Normalize and deduplicate edges.
   * 3. Filter heuristics unless corroborated.
   * 4. Persist edges and evidence.
   */
  async rebuild(context: AssociationContext): Promise<AssociationEngineResult> {
    const report = this.options.onProgress;
    const allEdges: StructuralRelationEdge[] = [];

    // 1. Run enabled resolvers
    for (const resolver of this.resolvers) {
      if (!resolver.supports(context)) {
        report(`Resolver ${resolver.name}: not applicable, skipping.`);
        continue;
      }

      report(`Running resolver: ${resolver.name}...`);
      try {
        const edges = await resolver.resolve(context);
        report(`  → ${edges.length} edges produced.`);
        allEdges.push(...edges);
      } catch (error) {
        report(
          `  → Error in resolver ${resolver.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // 2. Deduplicate edges (last write wins by edge ID)
    const dedupedMap = new Map<string, StructuralRelationEdge>();
    for (const edge of allEdges) {
      dedupedMap.set(edge.id, edge);
    }
    const deduped = Array.from(dedupedMap.values());

    // 3. Filter heuristics unless corroborated
    const toStore = this.options.includeHeuristics
      ? deduped
      : this.filterUncorroboratedHeuristics(deduped);

    report(
      `Persisting ${toStore.length} edges (${deduped.length - toStore.length} heuristics filtered).`
    );

    // 4. Persist — batch edge + evidence writes into bounded transactions (Lever E).
    // The inner replaceEdgeEvidence transaction is promoted to a savepoint when
    // nested, so behaviour is unchanged beyond collapsing many commits into few.
    const ts = Math.floor(Date.now() / 1000);
    writeAllInChunks(this.db, toStore, ROWS_PER_COMMIT, (rel) => {
      const dbEdge = this.toDbEdge(rel, context, ts);
      this.db.upsertStructuralEdge(dbEdge);

      const evidence = this.toDbEvidence(rel, ts);
      this.db.replaceEdgeEvidence(rel.id, evidence);
    });

    return {
      resolversRun: this.resolvers.filter((r) => r.supports(context)).length,
      edgesProduced: allEdges.length,
      edgesStored: toStore.length,
      heuristicsFiltered: deduped.length - toStore.length,
    };
  }

  // -------------------------------------------------------------------------
  // Static helpers (used by the detector runner)
  // -------------------------------------------------------------------------

  /**
   * Persist a set of pre-built StructuralRelationEdges without heuristic
   * filtering or dirty-dependent tracking. Intended for detector output,
   * which only emits explicit high-confidence boundary edges.
   *
   * @returns Number of edges persisted.
   */
  static persistEdges(
    db: LuxDatabase,
    edges: StructuralRelationEdge[],
    sourceCommit?: string
  ): number {
    const ts = Math.floor(Date.now() / 1000);

    // Batch edge + evidence writes into bounded transactions (Lever E).
    writeAllInChunks(db, edges, ROWS_PER_COMMIT, (rel) => {
      const dbEdge: StructuralEdge = {
        id: rel.id,
        source_node_id: rel.sourceNodeId,
        target_node_id: rel.targetNodeId,
        edge_type: rel.edgeType,
        confidence: rel.confidence,
        confidence_class: rel.confidenceClass,
        freshness_status: 'fresh',
        // Was absent (⇒ NULL), which born these tiers' edges exempt from the commit-based
        // staleness guard (SC-8 / Decision 13). The scoped settle passes HEAD; the full-rebuild
        // path omits it (unchanged NULL — the propagation tier's documented exclusion).
        source_commit: sourceCommit,
        dirty_dependency_count: 0,
        provenance_summary: `${rel.provenance.resolver} [${rel.provenance.evidenceKind}]`,
        updated_at: ts,
      };
      db.upsertStructuralEdge(dbEdge);

      const evidence: EdgeEvidence[] = rel.provenance.evidenceLocations.map((loc, i) => ({
        id: `${rel.id}:ev:${i}`,
        edge_id: rel.id,
        resolver: rel.provenance.resolver,
        evidence_kind: rel.provenance.evidenceKind,
        file_path: loc.filePath,
        line: loc.line,
        note: loc.note,
        recorded_at: ts,
      }));
      db.replaceEdgeEvidence(rel.id, evidence);
    });

    return edges.length;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Remove heuristic edges that have no corroborating non-heuristic edge
   * between the same node pair.
   */
  private filterUncorroboratedHeuristics(
    edges: StructuralRelationEdge[]
  ): StructuralRelationEdge[] {
    // Build set of (sourceNodeId, targetNodeId) pairs backed by non-heuristics
    const corroboratedPairs = new Set<string>();
    for (const edge of edges) {
      if (edge.confidenceClass !== 'heuristic') {
        corroboratedPairs.add(`${edge.sourceNodeId}\0${edge.targetNodeId}`);
        corroboratedPairs.add(`${edge.targetNodeId}\0${edge.sourceNodeId}`);
      }
    }

    return edges.filter((edge) => {
      if (edge.confidenceClass !== 'heuristic') return true;
      const pair = `${edge.sourceNodeId}\0${edge.targetNodeId}`;
      return corroboratedPairs.has(pair);
    });
  }

  /** Convert an in-memory StructuralRelationEdge to a DB StructuralEdge. */
  private toDbEdge(
    rel: StructuralRelationEdge,
    context: AssociationContext,
    ts: number
  ): StructuralEdge {
    const dirtySet = new Set(context.dirtyFiles);
    const sourceNode = this.getNodeFilePath(rel.sourceNodeId);
    const targetNode = this.getNodeFilePath(rel.targetNodeId);
    const isDirty =
      (sourceNode !== null && dirtySet.has(sourceNode)) ||
      (targetNode !== null && dirtySet.has(targetNode));

    const dirtyCount = [sourceNode, targetNode].filter(
      (fp): fp is string => fp !== null && dirtySet.has(fp)
    ).length;

    return {
      id: rel.id,
      source_node_id: rel.sourceNodeId,
      target_node_id: rel.targetNodeId,
      edge_type: rel.edgeType,
      confidence: rel.confidence,
      confidence_class: rel.confidenceClass,
      freshness_status: isDirty ? 'dirty-dependent' : 'fresh',
      source_commit: context.currentCommit,
      dirty_dependency_count: dirtyCount,
      provenance_summary: this.buildProvenanceSummary(rel),
      updated_at: ts,
    };
  }

  /** Convert provenance into EdgeEvidence records for the DB. */
  private toDbEvidence(rel: StructuralRelationEdge, ts: number): EdgeEvidence[] {
    return rel.provenance.evidenceLocations.map((loc, i) => ({
      id: `${rel.id}:ev:${i}`,
      edge_id: rel.id,
      resolver: rel.provenance.resolver,
      evidence_kind: rel.provenance.evidenceKind,
      file_path: loc.filePath,
      line: loc.line,
      note: loc.note,
      recorded_at: ts,
    }));
  }

  /** Build a concise provenance summary string for display. */
  private buildProvenanceSummary(rel: StructuralRelationEdge): string {
    const { resolver, evidenceKind, evidenceLocations } = rel.provenance;
    const locationStr = evidenceLocations
      .slice(0, 3)
      .map((l) => (l.line !== undefined ? `${l.filePath}:${l.line}` : l.filePath))
      .join(', ');
    return `${resolver} [${evidenceKind}] ${locationStr}`;
  }

  /**
   * Attempt to extract the file path from a node ID (file: prefix) or
   * from the DB node record.
   */
  private getNodeFilePath(nodeId: string): string | null {
    if (nodeId.startsWith('file:')) {
      return nodeId.slice(5);
    }
    const node = this.db.getStructuralNode(nodeId);
    return node?.file_path ?? null;
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AssociationEngineResult {
  resolversRun: number;
  edgesProduced: number;
  edgesStored: number;
  heuristicsFiltered: number;
}
