// A route two files declare is two surfaces under file-qualified ids (issue #13). These are the
// consumers that take a route from a person or from another command: each must either resolve
// the route's handle or offer candidates that can be asked for as written.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { resolveFeaturePathTarget } from '../feature-path/resolve.js';
import { assembleFeaturePathAnswer } from '../feature-path/assemble.js';
import { renderFeaturePathAnswerText } from '../feature-path/render.js';
import { resolveSpecDerivationTarget } from '../spec-derivation/resolve.js';
import { resolveInvalidatedSpecTargets } from '../../delta/spec-evidence.js';
import type { EntrySurfaceImpact } from '../../delta/types.js';

const APP = 'surface:http:GET:/#file:routes/web.php';
const SKELETON = 'surface:http:GET:/#file:workbench/routes/web.php';

let dir: string;
let db: LuxDatabase;

function surface(id: string, handle: string, filePath: string, routeName?: string): void {
  const [method, path] = handle.split(' ');
  db.upsertStructuralNode({
    id,
    node_type: 'capability-surface',
    symbol_name: handle,
    language_id: 'http',
    file_path: filePath,
    metadata: JSON.stringify({ transport: 'http', method, path, routeName }),
    updated_at: 1,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-shared-surface-'));
  db = new LuxDatabase(join(dir, 'lux.db'));
  surface(APP, 'GET /', 'routes/web.php', 'homepage');
  surface(SKELETON, 'GET /', 'workbench/routes/web.php');
  surface('surface:http:GET:/faq', 'GET /faq', 'routes/web.php', 'site.faq');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('asking the feature path for a route two files declare', () => {
  it('offers each declaration with its file and route name', () => {
    const resolution = resolveFeaturePathTarget(db, 'GET /');

    expect(resolution.status).toBe('ambiguous');
    expect(
      resolution.candidates.map(({ id, label, filePath, routeName }) => ({
        id,
        label,
        filePath,
        routeName,
      }))
    ).toEqual([
      {
        id: APP,
        label: 'GET / @ routes/web.php',
        filePath: 'routes/web.php',
        routeName: 'homepage',
      },
      {
        id: SKELETON,
        label: 'GET / @ workbench/routes/web.php',
        filePath: 'workbench/routes/web.php',
        routeName: undefined,
      },
    ]);
  });

  it('prints candidates that tell the declarations apart and says how to ask for one', () => {
    const resolution = resolveFeaturePathTarget(db, 'GET /');
    const text = renderFeaturePathAnswerText(
      assembleFeaturePathAnswer(db, {
        question: 'GET /',
        intent: 'route-handler',
        resolution,
        repoRoot: dir,
      })
    );

    expect(text).toContain(
      'Candidates: GET / @ routes/web.php (homepage), GET / @ workbench/routes/web.php'
    );
    expect(text).toContain('Ask for one candidate as written, e.g. "GET / @ routes/web.php".');
  });

  it.each([
    ['GET / @ routes/web.php', APP],
    ['GET / @ workbench/routes/web.php', SKELETON],
    [APP, APP],
    ['homepage', APP],
  ])('resolves %s to one declaration', (query, id) => {
    const resolution = resolveFeaturePathTarget(db, query);

    expect(resolution.status).toBe('resolved');
    expect(resolution.candidates.map((candidate) => candidate.id)).toEqual([id]);
  });

  it('labels a route one file declares by its handle alone', () => {
    const resolution = resolveFeaturePathTarget(db, 'GET /faq');

    expect(resolution.status).toBe('resolved');
    expect(resolution.candidates[0].label).toBe('GET /faq');
  });
});

describe('the spec targets delta hands to spec-evidence', () => {
  const impact = (id: string): EntrySurfaceImpact => ({
    kind: 'http',
    id,
    resolvedVia: 'structural-walk',
    hops: 1,
    weakestConfidence: 'proven',
  });
  const noTouch = {
    nodes: [],
    symbolIds: [],
    surfacesDeclared: [],
    evidenceEdgeCount: 0,
    operationalBoundaries: [],
    orphanedNodeCount: 0,
    symbolChanges: [],
    precision: { fileLevelOnly: [], renamedOnly: [], cosmeticOnly: [], changedOutsideSymbols: [] },
    walkSeeds: [],
  };

  it('names each declaration of a shared route, and each name resolves to that declaration', () => {
    const targets = resolveInvalidatedSpecTargets(noTouch, [
      impact(APP),
      impact(SKELETON),
      impact('surface:http:GET:/faq'),
    ]);

    expect(targets).toEqual([
      { kind: 'route', target: 'GET / @ routes/web.php' },
      { kind: 'route', target: 'GET / @ workbench/routes/web.php' },
      { kind: 'route', target: 'GET /faq' },
    ]);

    const resolved = targets.map((target) => {
      const { target: outcome } = resolveSpecDerivationTarget(db, {
        kind: 'route',
        identifier: target.target,
        corpusPath: dir,
      });
      return [outcome.resolutionState, outcome.resolvedNodeId];
    });
    expect(resolved).toEqual([
      ['resolved', APP],
      ['resolved', SKELETON],
      ['resolved', 'surface:http:GET:/faq'],
    ]);
  });
});
