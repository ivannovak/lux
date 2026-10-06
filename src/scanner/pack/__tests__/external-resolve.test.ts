import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import { makeExternalTargetResolver } from '../external-resolve.js';

// ADR-3 / REQ-1: makeExternalTargetResolver maps an LSP definition location that
// lands in vendor/ to the id of a merged vendor-pack node, confirming presence +
// externality so boundary edges never dangle.

const testDir = mkdtempSync(join(tmpdir(), 'lux-external-resolve-test-'));
const vendorFile = join(testDir, 'vendor', 'illuminate', 'database', 'Model.php');

// 0-based line indices in the content below.
const MODEL_PHP = [
  '<?php', // 0
  '', // 1
  'namespace Illuminate\\Database\\Eloquent;', // 2
  '', // 3
  'class Model', // 4
  '{', // 5
  '    public function save()', // 6  <- resolveDefinition target for ->save()
  '    {', // 7
  '        return true;', // 8
  '    }', // 9
  '}', // 10
].join('\n');

const SAVE_LINE0 = 6;
const SAVE_ID = 'symbol:php:Illuminate\\Database\\Eloquent\\Model::save';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function saveNode(origin: StructuralNode['origin']): StructuralNode {
  return {
    id: SAVE_ID,
    node_type: 'symbol',
    file_path: 'vendor/illuminate/database/Model.php',
    language_id: 'php',
    symbol_name: 'save',
    qualified_name: 'Illuminate\\Database\\Eloquent\\Model::save',
    origin,
    updated_at: now(),
  };
}

describe('makeExternalTargetResolver (REQ-1)', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'vendor', 'illuminate', 'database'), { recursive: true });
    writeFileSync(vendorFile, MODEL_PHP, 'utf-8');
    db = new LuxDatabase(join(testDir, 'project.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('resolves a vendor definition location to the merged vendor-pack node id', async () => {
    db.upsertStructuralNode(saveNode('vendor-pack'));
    const resolve = makeExternalTargetResolver(db, testDir);
    const id = await resolve(vendorFile, SAVE_LINE0);
    expect(id).toBe(SAVE_ID);
  });

  it('recovers the method when the definition lands on the class and a member name is given', async () => {
    // intelephense returns a method's docblock line, which sits before the
    // method's node range, so line containment lands on the enclosing class.
    // The member name (`save`) recovers `<class>::save`. (REQ-1 granularity fix.)
    db.upsertStructuralNode({
      id: 'symbol:php:Illuminate\\Database\\Eloquent\\Model',
      node_type: 'symbol',
      language_id: 'php',
      origin: 'vendor-pack',
      updated_at: now(),
    });
    db.upsertStructuralNode(saveNode('vendor-pack'));
    const resolve = makeExternalTargetResolver(db, testDir);
    const CLASS_LINE0 = 4; // 0-based `class Model`
    expect(await resolve(vendorFile, CLASS_LINE0)).toBe(
      'symbol:php:Illuminate\\Database\\Eloquent\\Model'
    ); // no member -> class
    expect(await resolve(vendorFile, CLASS_LINE0, 'save')).toBe(SAVE_ID); // member -> method
  });

  it('returns null when the resolved vendor symbol is not present in the pack', async () => {
    // No node inserted — the pack never materialized this symbol.
    const resolve = makeExternalTargetResolver(db, testDir);
    const id = await resolve(vendorFile, SAVE_LINE0);
    expect(id).toBeNull();
  });

  it('returns null when the matched node is local (not a vendor-pack node)', async () => {
    db.upsertStructuralNode(saveNode('local'));
    const resolve = makeExternalTargetResolver(db, testDir);
    const id = await resolve(vendorFile, SAVE_LINE0);
    expect(id).toBeNull();
  });

  it('returns null for non-PHP targets (node_modules is out of scope)', async () => {
    const resolve = makeExternalTargetResolver(db, testDir);
    const id = await resolve(join(testDir, 'vendor', 'dep', 'index.ts'), 3);
    expect(id).toBeNull();
  });
});
