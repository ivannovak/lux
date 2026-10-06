// Every --json list the boundary and cluster commands print is totally ordered: the same items,
// handed over in any order, come out in one order. Upstream reads already arrive in a fixed
// order; these feed the sorts reversed input so each tie-break is checked on its own.

import { describe, expect, it } from 'vitest';
import { buildFamilySummaries, buildRegionSummaries, compareByBoundaryWeight } from '../overlay.js';
import {
  compareAggregates,
  type ModuleBoundaryAggregate,
} from '../../scanner/overlay/module-boundary-analysis.js';
import { computeClusters } from '../../db/clustering.js';
import type { ModuleDependency } from '../../db/types.js';

function aggregate(source: string, target: string, families: string[]): ModuleBoundaryAggregate {
  return {
    sourceRegion: source,
    targetRegion: target,
    relationshipKind: 'depends-on',
    evidenceTiers: ['overlay-backed'],
    directWeight: 2,
    projectedWeight: 0,
    supportingWeight: 0,
    families: families as ModuleBoundaryAggregate['families'],
    trustLevel: 'overlay-complete',
    samplePaths: [],
    rationaleSummary: '',
    dominantDirection: 'outbound',
  };
}

// Equal weights everywhere: only the tie-breaks decide the order. Two disjoint region pairs give
// regions and families equal totals and equal neighbour/relationship counts.
const AGGREGATES = [
  aggregate('Alpha', 'Beta', ['service-container']),
  aggregate('Beta', 'Alpha', ['service-container']),
  aggregate('Gamma', 'Delta', ['async-workflow']),
  aggregate('Delta', 'Gamma', ['async-workflow']),
];

describe('boundary output order', () => {
  it('sorts relationships the same whatever order they arrive in', () => {
    const forward = [...AGGREGATES].sort(compareByBoundaryWeight).map((a) => a.sourceRegion);
    const reverse = [...AGGREGATES]
      .reverse()
      .sort(compareByBoundaryWeight)
      .map((a) => a.sourceRegion);
    expect(reverse).toEqual(forward);
    expect(forward).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  });

  it('sorts aggregates the same whatever order they arrive in', () => {
    const forward = [...AGGREGATES].sort(compareAggregates).map((a) => a.sourceRegion);
    const reverse = [...AGGREGATES]
      .reverse()
      .sort(compareAggregates)
      .map((a) => a.sourceRegion);
    expect(reverse).toEqual(forward);
  });

  it('lists regions and families the same whatever order the relationships arrive in', () => {
    const reversed = [...AGGREGATES].reverse();
    expect(buildRegionSummaries(reversed)).toEqual(buildRegionSummaries(AGGREGATES));
    expect(buildFamilySummaries(reversed)).toEqual(buildFamilySummaries(AGGREGATES));
  });
});

describe('cluster output order', () => {
  function dep(source: string, target: string, count: number): ModuleDependency {
    return {
      id: 0,
      source_module: source,
      target_module: target,
      reference_count: count,
      sample_files: null,
      created_at: 0,
    };
  }

  // Two mirror-image star clusters with equal coupling: every tie the algorithm meets.
  const DEPS = [
    dep('A1', 'Hub1', 2),
    dep('A2', 'Hub1', 2),
    dep('B1', 'Hub2', 2),
    dep('B2', 'Hub2', 2),
  ];

  it('forms and orders clusters the same whatever order dependencies arrive in', () => {
    const forward = computeClusters(DEPS);
    for (const permutation of [
      [...DEPS].reverse(),
      [DEPS[2], DEPS[0], DEPS[3], DEPS[1]],
      [DEPS[3], DEPS[1], DEPS[2], DEPS[0]],
    ]) {
      expect(computeClusters(permutation)).toEqual(forward);
    }
  });
});
