import { describe, expect, it } from 'vitest';
import { resolveInvalidatedSpecTargets } from '../spec-evidence.js';
import type { DeltaTouchSet, EntrySurfaceImpact } from '../types.js';

function touchSet(over: Partial<DeltaTouchSet> = {}): DeltaTouchSet {
  return {
    nodes: [],
    symbolIds: [],
    surfacesDeclared: [],
    evidenceEdgeCount: 0,
    operationalBoundaries: [],
    orphanedNodeCount: 0,
    ...over,
  };
}

describe('delta invalidated spec-evidence (spec 13 Part B, Phase 2b)', () => {
  it('maps an HTTP entry surface to a route target with a decoded label', () => {
    const surfaces: EntrySurfaceImpact[] = [
      {
        kind: 'http',
        id: 'surface:http:GET:/users/{id}',
        resolvedVia: 'structural-walk',
        hops: 2,
        weakestConfidence: 'proven',
      },
    ];
    const out = resolveInvalidatedSpecTargets(touchSet(), surfaces);
    expect(out).toEqual([{ kind: 'route', target: 'GET /users/{id}' }]);
  });

  it('labels a route several files declare by its method and path, once', () => {
    const surface = (file: string): EntrySurfaceImpact => ({
      kind: 'http',
      id: `surface:http:GET:/#file:${file}`,
      resolvedVia: 'structural-walk',
      hops: 1,
      weakestConfidence: 'proven',
    });
    const out = resolveInvalidatedSpecTargets(touchSet(), [
      surface('routes/web.php'),
      surface('workbench/routes/web.php'),
    ]);
    expect(out).toEqual([{ kind: 'route', target: 'GET /' }]);
  });

  it('maps a touched job boundary to a job target (SC-6, declared-boundary path)', () => {
    const touch = touchSet({
      operationalBoundaries: [
        { id: 'op:job:1', repo_root: '/r', kind: 'job', name: 'SendEmailJob', trust_tier: 3 },
      ],
    });
    const out = resolveInvalidatedSpecTargets(touch, []);
    expect(out).toEqual([{ kind: 'job', target: 'SendEmailJob' }]);
  });

  it('maps operational entry-surface kinds to their spec kinds', () => {
    const surfaces: EntrySurfaceImpact[] = [
      { kind: 'event', id: 'op:event:1', resolvedVia: 'operational-join', weakestConfidence: null },
      {
        kind: 'command',
        id: 'op:cmd:1',
        resolvedVia: 'operational-join',
        weakestConfidence: null,
      },
      {
        kind: 'schedule',
        id: 'op:sch:1',
        resolvedVia: 'operational-join',
        weakestConfidence: null,
      },
    ];
    const out = resolveInvalidatedSpecTargets(touchSet(), surfaces);
    expect(out).toEqual([
      { kind: 'listener', target: 'op:event:1' }, // event → listener
      { kind: 'command', target: 'op:cmd:1' },
      { kind: 'command', target: 'op:sch:1' }, // schedule → command
    ]);
  });

  it('dedups targets reached via multiple paths', () => {
    const surfaces: EntrySurfaceImpact[] = [
      {
        kind: 'http',
        id: 'surface:http:GET:/x',
        resolvedVia: 'structural-walk',
        hops: 1,
        weakestConfidence: 'proven',
      },
    ];
    // the same route also appears as a declared surface in the change-set
    const touch = touchSet({
      surfacesDeclared: [
        {
          id: 'surface:http:GET:/x',
          nodeType: 'capability-surface',
          filePath: 'app/X.php',
          qualifiedName: null,
          nodeState: 'present',
        },
      ],
    });
    const out = resolveInvalidatedSpecTargets(touch, surfaces);
    expect(out).toEqual([{ kind: 'route', target: 'GET /x' }]);
  });
});
