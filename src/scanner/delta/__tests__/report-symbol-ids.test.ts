// The envelope must carry the FULL touched-symbol list, not a preview of it.
//
// `symbolSample` is capped at 10 entries. A consumer intersecting the touched
// set against its own symbol list — the whole point of `touched.symbols` being
// reported — cannot do that against a 10-item slice of a 581-item set, and
// nothing in the envelope says the list was cut, so a partial intersection
// looks like a complete one. `symbolIds` carries the whole set; `symbolSample`
// is preserved unchanged for existing readers.

import { describe, it, expect } from 'vitest';
import { assembleDeltaReport, type AssembleInput } from '../report.js';
import type { DeltaChangeSet, DeltaTouchSet } from '../types.js';
import type { DownstreamResult } from '../downstream.js';

const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `symbol:ts:src/File${i}.ts#fn${i}`);

function input(symbolIds: string[]): AssembleInput {
  const changeSet: DeltaChangeSet = {
    base: { ref: 'HEAD', sha: 'a'.repeat(40), source: 'flag' },
    head: { sha: 'b'.repeat(40), workingTreeIncluded: false },
    files: [],
    indexPaths: [],
    warnings: [],
  };
  const touch: DeltaTouchSet = {
    nodes: [],
    symbolIds,
    surfacesDeclared: [],
    evidenceEdgeCount: 0,
    operationalBoundaries: [],
    orphanedNodeCount: 0,
    symbolChanges: [],
    precision: { fileLevelOnly: [], renamedOnly: [], cosmeticOnly: [], changedOutsideSymbols: [] },
    walkSeeds: symbolIds,
  };
  const downstream: DownstreamResult = {
    entrySurfaces: [],
    asyncBoundaries: [],
    truncated: false,
  } as unknown as DownstreamResult;

  return {
    changeSet,
    touch,
    downstream,
    truncated: false,
    modules: { changed: [], dependents: [] },
    ownership: {} as AssembleInput['ownership'],
    specTargets: [],
    trust: { overlay: 'overlay-complete', indexedCommit: 'c'.repeat(40) },
    budget: { depth: 6, maxNodes: 2000 },
    warnings: [],
  };
}

describe('delta envelope — touched.symbolIds', () => {
  it('carries every touched symbol, not the first ten', () => {
    const all = ids(25);
    const report = assembleDeltaReport(input(all));

    expect(report.touched.symbolIds).toEqual(all);
    expect(report.touched.symbolIds).toHaveLength(25);
  });

  it('agrees with the reported count, so a consumer can trust the length', () => {
    const report = assembleDeltaReport(input(ids(581)));
    expect(report.touched.symbolIds).toHaveLength(report.touched.symbols);
  });

  it('keeps symbolSample capped at ten, unchanged for existing readers', () => {
    const all = ids(25);
    const report = assembleDeltaReport(input(all));

    expect(report.touched.symbolSample).toEqual(all.slice(0, 10));
    expect(report.touched.symbolSample).toHaveLength(10);
  });

  it('leaves both fields equal when the set is smaller than the sample cap', () => {
    const all = ids(3);
    const report = assembleDeltaReport(input(all));

    expect(report.touched.symbolSample).toEqual(all);
    expect(report.touched.symbolIds).toEqual(all);
  });

  it('emits an empty list, not a missing key, for an empty change', () => {
    const report = assembleDeltaReport(input([]));

    expect(report.touched.symbolIds).toEqual([]);
    expect(report.touched.symbols).toBe(0);
    // Present in the SERIALIZED form — an undefined optional would vanish here,
    // and a consumer cannot distinguish "no symbols" from "field not supported".
    expect(JSON.parse(JSON.stringify(report)).touched).toHaveProperty('symbolIds');
  });

  it('does not mutate or alias the input array', () => {
    const all = ids(12);
    const report = assembleDeltaReport(input(all));

    expect(all).toHaveLength(12);
    report.touched.symbolSample.push('mutant');
    expect(report.touched.symbolIds).toHaveLength(12);
  });

  it('stays schemaVersion 1 — the addition is additive', () => {
    const report = assembleDeltaReport(input(ids(5)));
    expect(report.schemaVersion).toBe(1);
  });
});
