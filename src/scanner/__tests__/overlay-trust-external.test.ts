import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../db/index.js';
import type { StructuralNode, NodeOrigin } from '../../db/types.js';
import { inspectOverlayTrustState } from '../overlay-trust-state.js';

// REQ-7 (ADR-3): the DB-derived overlay trust snapshot behind `lux overlay
// status` counts app-origin nodes only — merged vendor-pack nodes (which can
// number in the hundreds of thousands) must not inflate the counts.

const testDir = mkdtempSync(join(tmpdir(), 'lux-overlay-trust-external-test-'));

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function node(
  id: string,
  nodeType: StructuralNode['node_type'],
  origin: NodeOrigin
): StructuralNode {
  return {
    id,
    node_type: nodeType,
    file_path: `${id}.php`,
    language_id: 'php',
    origin,
    updated_at: now(),
  };
}

describe('overlay trust-state external-node filtering (REQ-7)', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(join(testDir, 'project.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('counts only local file and symbol nodes, excluding merged vendor-pack nodes', () => {
    // 1 local file + 2 local symbols (the real app), plus vendor-pack noise.
    db.upsertStructuralNode(node('file:app/Thing.php', 'file', 'local'));
    db.upsertStructuralNode(node('symbol:php:App\\A::m', 'symbol', 'local'));
    db.upsertStructuralNode(node('symbol:php:App\\B::m', 'symbol', 'local'));
    db.upsertStructuralNode(node('file:vendor/framework/Model.php', 'file', 'vendor-pack'));
    db.upsertStructuralNode(node('symbol:php:Illuminate\\Model::save', 'symbol', 'vendor-pack'));
    db.upsertStructuralNode(
      node('symbol:php:Illuminate\\Model::performInsert', 'symbol', 'vendor-pack')
    );
    db.upsertStructuralNode(node('symbol:php:Illuminate\\Builder::get', 'symbol', 'vendor-pack'));

    const { state, source } = inspectOverlayTrustState(db);
    expect(source).toBe('derived');
    expect(state).not.toBeNull();
    expect(state!.symbolNodeCount).toBe(2); // NOT 5
    expect(state!.fileNodeCount).toBe(1); // NOT 2
  });
});
