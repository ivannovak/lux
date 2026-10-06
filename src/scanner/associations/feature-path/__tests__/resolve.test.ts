// Tests for question -> route-surface target resolution.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../../db/index.js';
import { resolveFeaturePathTarget } from '../resolve.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-resolve-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function upsertSurface(
  db: LuxDatabase,
  id: string,
  handle: string,
  method: string,
  path: string,
  filePath: string,
  routeName?: string
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'capability-surface',
    symbol_name: handle,
    language_id: 'http',
    file_path: filePath,
    metadata: JSON.stringify({ transport: 'http', method, path, routeName }),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

describe('resolveFeaturePathTarget', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns unresolved with empty candidates for an empty query', () => {
    const result = resolveFeaturePathTarget(db, '   ');
    expect(result.status).toBe('unresolved');
    expect(result.candidates).toEqual([]);
  });

  it('semantic-exact matches "POST /offers" to a single capability surface', () => {
    upsertSurface(
      db,
      'surface:http:POST:/offers',
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    const result = resolveFeaturePathTarget(db, 'POST /offers');
    expect(result.status).toBe('resolved');
    expect(result.matchedBy).toBe('semantic-exact');
    expect(result.candidates[0]?.id).toBe('surface:http:POST:/offers');
    expect(result.candidates[0]?.surfaceMethod).toBe('POST');
    expect(result.candidates[0]?.routeName).toBe('offers.store');
  });

  it('matches a route by route name', () => {
    upsertSurface(
      db,
      'surface:http:POST:/offers',
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    const result = resolveFeaturePathTarget(db, 'offers.store');
    expect(result.status).toBe('resolved');
    expect(result.candidates[0]?.id).toBe('surface:http:POST:/offers');
  });

  it('returns ambiguous when multiple surfaces share the same path', () => {
    upsertSurface(
      db,
      'surface:http:POST:/offers',
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    upsertSurface(
      db,
      'surface:http:GET:/offers',
      'GET /offers',
      'GET',
      '/offers',
      'routes/api.php',
      'offers.index'
    );
    const result = resolveFeaturePathTarget(db, '/offers');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to prefix match when nothing matches semantically', () => {
    upsertSurface(
      db,
      'surface:http:POST:/offers/internal',
      'POST /offers/internal',
      'POST',
      '/offers/internal',
      'routes/api.php',
      'offers.internal.store'
    );
    const result = resolveFeaturePathTarget(db, 'POST /offers');
    expect(result.status).toBe('resolved');
    expect(result.matchedBy).toBe('prefix');
    expect(result.candidates[0]?.id).toBe('surface:http:POST:/offers/internal');
  });

  it('returns unresolved with token-based suggestions when nothing matches', () => {
    upsertSurface(
      db,
      'surface:http:POST:/offers',
      'POST /offers',
      'POST',
      '/offers',
      'routes/api.php',
      'offers.store'
    );
    const result = resolveFeaturePathTarget(db, 'totally-unrelated-route');
    expect(result.status).toBe('unresolved');
    expect(result.candidates).toEqual([]);
  });

  it('limits candidate output to MAX_CANDIDATES even on broad matches', () => {
    for (let index = 0; index < 8; index += 1) {
      upsertSurface(
        db,
        `surface:http:GET:/api/items/${index}`,
        `GET /api/items/${index}`,
        'GET',
        `/api/items/${index}`,
        'routes/api.php',
        `items.show.${index}`
      );
    }
    const result = resolveFeaturePathTarget(db, '/api/items');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  // Regression: an English-wrapped question that references one route must not
  // silently mis-target a different, shorter root route via the contains tier.
  // See docs/validation/feature-path-tranche-one-promotion-decision-2026-04-29.md
  // (Gap 1) for the failure this guards.
  it('does not let GET / mis-target an English-wrapped question about a deeper route', () => {
    upsertSurface(db, 'surface:http:GET:/', 'GET /', 'GET', '/', 'routes/web.php', 'home');
    upsertSurface(
      db,
      'surface:http:POST:/private-offers',
      'POST /private-offers',
      'POST',
      '/private-offers',
      'routes/web.php',
      'private-offers.store'
    );
    const result = resolveFeaturePathTarget(db, 'what handles POST /private-offers?');
    if (result.status === 'resolved' || result.status === 'ambiguous') {
      // If we resolve at all, it must be the deeper, intended route.
      expect(result.candidates[0]?.id).toBe('surface:http:POST:/private-offers');
      // And we must never target the root via the contains tier.
      const ids = result.candidates.map((candidate) => candidate.id);
      expect(ids).not.toContain('surface:http:GET:/');
    }
  });

  it('does not let single-character forms match unrelated path-bearing queries', () => {
    upsertSurface(db, 'surface:http:GET:/', 'GET /', 'GET', '/', 'routes/web.php', 'home');
    // Query mentions a path that is not in the DB. The contains tier must not
    // bridge to GET / via the single-char "/" form.
    const result = resolveFeaturePathTarget(db, 'what handles GET /unknown-route?');
    expect(result.status).toBe('unresolved');
  });
});
