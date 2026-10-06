import type { ModuleDependency } from './types.js';

/** A cluster of tightly-coupled modules. */
export interface ModuleCluster {
  /** Cluster identifier (hub module name — highest total degree). */
  name: string;
  /** Member modules. */
  members: string[];
  /** Total internal coupling score (sum of cross-member ref counts). */
  couplingScore: number;
}

export interface ClusterOptions {
  /** Minimum weighted Jaccard similarity to merge clusters (default: 0.15). */
  similarityThreshold?: number;
}

/**
 * Compute module clusters using agglomerative clustering with weighted Jaccard similarity.
 *
 * Algorithm:
 * 1. Build weighted undirected graph from dependencies
 * 2. Start with each module as its own cluster
 * 3. Iteratively merge the pair with highest Jaccard similarity above threshold
 * 4. Name each cluster by the hub module (highest total degree)
 * 5. Sort by coupling score descending
 */
export function computeClusters(
  dependencies: ModuleDependency[],
  options?: ClusterOptions
): ModuleCluster[] {
  const threshold = options?.similarityThreshold ?? 0.15;

  if (dependencies.length === 0) return [];

  // Build weighted undirected adjacency: edge weight = sum of both directions
  const edges = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();

  const ensureNode = (mod: string) => {
    if (!edges.has(mod)) edges.set(mod, new Map());
    if (!degree.has(mod)) degree.set(mod, 0);
  };

  // Merge ties go to the first pair visited, and both the visit order and the order equal-score
  // clusters are returned in follow the order modules are first seen here, so the input is put in
  // a fixed order before anything reads it.
  const ordered = [...dependencies].sort(
    (a, b) =>
      compareModules(a.source_module, b.source_module) ||
      compareModules(a.target_module, b.target_module)
  );

  for (const dep of ordered) {
    ensureNode(dep.source_module);
    ensureNode(dep.target_module);

    const existing = edges.get(dep.source_module)!.get(dep.target_module) ?? 0;
    edges.get(dep.source_module)!.set(dep.target_module, existing + dep.reference_count);
    edges
      .get(dep.target_module)!
      .set(
        dep.source_module,
        (edges.get(dep.target_module)!.get(dep.source_module) ?? 0) + dep.reference_count
      );

    degree.set(dep.source_module, (degree.get(dep.source_module) ?? 0) + dep.reference_count);
    degree.set(dep.target_module, (degree.get(dep.target_module) ?? 0) + dep.reference_count);
  }

  // Initialize clusters: each module is its own cluster
  const clusters = new Map<string, Set<string>>();
  for (const mod of edges.keys()) {
    clusters.set(mod, new Set([mod]));
  }

  // Iteratively merge
  while (true) {
    let bestSim = -1;
    let bestA = '';
    let bestB = '';

    const clusterIds = Array.from(clusters.keys());

    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        const sim = clusterJaccardSimilarity(
          clusters.get(clusterIds[i])!,
          clusters.get(clusterIds[j])!,
          edges
        );
        if (sim > bestSim) {
          bestSim = sim;
          bestA = clusterIds[i];
          bestB = clusterIds[j];
        }
      }
    }

    if (bestSim < threshold) break;

    // Merge bestB into bestA
    const membersB = clusters.get(bestB)!;
    const membersA = clusters.get(bestA)!;
    for (const m of membersB) {
      membersA.add(m);
    }
    clusters.delete(bestB);
  }

  // Build result clusters
  const result: ModuleCluster[] = [];

  for (const members of clusters.values()) {
    const memberArr = Array.from(members).sort();

    // Hub = member with highest degree
    let hub = memberArr[0];
    let maxDeg = degree.get(hub) ?? 0;
    for (const m of memberArr) {
      const d = degree.get(m) ?? 0;
      if (d > maxDeg) {
        maxDeg = d;
        hub = m;
      }
    }

    // Coupling score = sum of edge weights between cluster members
    let couplingScore = 0;
    for (const a of memberArr) {
      for (const b of memberArr) {
        if (a >= b) continue;
        couplingScore += edges.get(a)?.get(b) ?? 0;
      }
    }

    result.push({
      name: hub,
      members: memberArr,
      couplingScore,
    });
  }

  return result.sort((a, b) => b.couplingScore - a.couplingScore);
}

function compareModules(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compute weighted Jaccard similarity between two clusters.
 * |shared_neighbors_weight| / |union_neighbors_weight|
 */
function clusterJaccardSimilarity(
  clusterA: Set<string>,
  clusterB: Set<string>,
  edges: Map<string, Map<string, number>>
): number {
  // Collect neighbor weights for each cluster (excluding members of the other cluster)
  const neighborsA = getClusterNeighborWeights(clusterA, edges);
  const neighborsB = getClusterNeighborWeights(clusterB, edges);

  const allNeighbors = new Set([...neighborsA.keys(), ...neighborsB.keys()]);
  if (allNeighbors.size === 0) return 0;

  let intersection = 0;
  let union = 0;

  for (const n of allNeighbors) {
    const wA = neighborsA.get(n) ?? 0;
    const wB = neighborsB.get(n) ?? 0;
    intersection += Math.min(wA, wB);
    union += Math.max(wA, wB);
  }

  return union === 0 ? 0 : intersection / union;
}

/** Get aggregated neighbor weights for all modules in a cluster. */
function getClusterNeighborWeights(
  cluster: Set<string>,
  edges: Map<string, Map<string, number>>
): Map<string, number> {
  const weights = new Map<string, number>();

  for (const member of cluster) {
    const memberEdges = edges.get(member);
    if (!memberEdges) continue;

    for (const [neighbor, weight] of memberEdges) {
      if (cluster.has(neighbor)) continue; // Skip intra-cluster edges
      weights.set(neighbor, (weights.get(neighbor) ?? 0) + weight);
    }
  }

  return weights;
}
