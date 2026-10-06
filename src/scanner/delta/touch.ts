import type { LuxDatabase } from '../../db/index.js';
import type { DeltaChangeSet, DeltaTouchSet, TouchedNode } from './types.js';
import type { ChangedSymbols } from './changed-symbols.js';

/**
 * Resolve the touch-set from the change-set's index-join paths (Decision 3): touched nodes
 * (files + symbols declared in changed files), the count of edges whose evidence cites a changed
 * file (the invalidation set), and operational surfaces declared in changed files. A node whose
 * declaring file was DELETED is annotated `nodeState: "orphaned"` (file gone, node still indexed)
 * so a consumer distinguishes "changed" from "removed".
 */
export function resolveTouchSet(
  db: LuxDatabase,
  changeSet: DeltaChangeSet,
  changed: ChangedSymbols
): DeltaTouchSet {
  // A renamed file's facts are under its old path when the index sits at the base and under its
  // new path when the index sits at the head; join on both.
  const relPaths = [
    ...new Set([
      ...changeSet.indexPaths,
      ...changeSet.files.filter((f) => f.status === 'renamed').map((f) => f.path),
    ]),
  ];
  const deletedPaths = new Set(
    changeSet.files.filter((f) => f.status === 'deleted').map((f) => f.renamedFrom ?? f.path)
  );

  const rawNodes = relPaths.length ? db.getStructuralNodesForFilePaths(relPaths) : [];
  const nodes: TouchedNode[] = rawNodes.map((n) => ({
    id: n.id,
    nodeType: n.node_type,
    filePath: n.file_path ?? null,
    qualifiedName: n.qualified_name ?? null,
    nodeState: n.file_path && deletedPaths.has(n.file_path) ? 'orphaned' : 'present',
  }));

  const symbolIds = nodes.filter((n) => n.nodeType === 'symbol').map((n) => n.id);
  const surfacesDeclared = nodes.filter(
    (n) => n.nodeType === 'capability-surface' || n.id.startsWith('surface:http:')
  );
  const orphanedNodeCount = nodes.filter((n) => n.nodeState === 'orphaned').length;

  const evidenceEdges = relPaths.length ? db.getEvidenceEdgesForFilePaths(relPaths) : [];
  const operationalBoundaries = relPaths.length
    ? db.getOperationalBoundariesForFilePaths(relPaths)
    : [];

  return {
    nodes,
    symbolIds,
    surfacesDeclared,
    evidenceEdgeCount: evidenceEdges.length,
    operationalBoundaries,
    orphanedNodeCount,
    symbolChanges: changed.changes,
    precision: changed.precision,
    walkSeeds: changed.seeds,
  };
}
