import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { LuxDatabase } from '../../db/index.js';
import type { StructuralEdge } from '../../db/types.js';
import type { RuntimePathResolution } from '../../utils/runtime-paths.js';
import { buildIndexStatusPayload, buildOverlayStatusPayload } from '../status-payload.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-status-payload-'));
const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..');

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(
    join(testDir, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function edge(id: string, status: string): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: status as StructuralEdge['freshness_status'],
    dirty_dependency_count: 0,
    updated_at: now(),
  };
}

function runtimeFor(dbPath: string): RuntimePathResolution {
  // corpusPath need not be a git repo — the freshness block is still populated
  // (assessment 'unknown'), which is all the payload shape assertion needs.
  return {
    corpusPath: testDir,
    corpusSource: 'explicit',
    dbPath,
    dbSource: 'explicit',
  };
}

describe('status payload freshness block (spec 10D)', () => {
  let db: LuxDatabase;
  beforeEach(() => {
    db = makeDb();
    db.upsertStructuralEdge(edge('e:f1', 'fresh'));
    db.upsertStructuralEdge(edge('e:f2', 'fresh'));
    db.upsertStructuralEdge(edge('e:s1', 'stale'));
  });
  afterEach(() => {
    db.close();
  });

  it('buildIndexStatusPayload(db, runtime) carries the freshness block incl. the edgeFreshness buckets', () => {
    const payload = buildIndexStatusPayload(db, runtimeFor('t'));
    // freshness present with runtime
    expect(payload.freshness).toBeDefined();
    expect(payload.freshness?.edgeFreshness).toEqual({
      fresh: 2,
      'dirty-dependent': 0,
      stale: 1,
      unknown: 0,
      other: 0,
    });
    expect(payload.freshness?.assessment).toBe('unknown'); // testDir is not a git repo
  });

  it('buildIndexStatusPayload(db) (no runtime) omits the freshness block', () => {
    const payload = buildIndexStatusPayload(db);
    expect(payload.freshness).toBeUndefined();
    expect(payload.runtime).toBeUndefined();
  });

  it('buildOverlayStatusPayload(db, runtime) carries the freshness block', () => {
    const payload = buildOverlayStatusPayload(db, runtimeFor('t'));
    expect('freshness' in payload).toBe(true);
    if ('freshness' in payload) {
      expect(payload.freshness?.edgeFreshness.fresh).toBe(2);
      expect(payload.freshness?.edgeFreshness.stale).toBe(1);
    }
  });

  it('buildOverlayStatusPayload(db) (no runtime) has no freshness/runtime wrapper', () => {
    const payload = buildOverlayStatusPayload(db);
    expect('freshness' in payload).toBe(false);
    expect('runtime' in payload).toBe(false);
  });
});

describe('SC-1 grep-guard', () => {
  it('the bare string "Index is up to date" is absent from production source', () => {
    // Exclude __tests__ so this assertion string does not match itself.
    const out = execSync(
      'grep -rl "Index is up to date" src --include=*.ts --exclude-dir=__tests__ || true',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' }
    ).trim();
    expect(out).toBe('');
  });
});
