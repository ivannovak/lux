// vendorPackChangedSinceRebuild: a scoped sync may only repair an overlay whose merged vendor pack is
// the one a full rebuild would merge now. A rebuild records the merged pack; clearing the overlay
// clears the record; anything else that moves the expected pack (a pack built, removed, or a
// different cache) reads as a change.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { loadLspConfig } from '../config.js';
import { rebuildWithOverlay, vendorPackChangedSinceRebuild } from '../rebuild-orchestrator.js';
import {
  deriveComposerLockKey,
  packPathForKey,
  VENDOR_PACK_MERGED_META,
  vendorPackIdentity,
} from '../pack/cache.js';
import { PACK_FORMAT_VERSION, VendorPackWriter } from '../pack/pack-format.js';

let root: string;
let cache: string;
let db: LuxDatabase;
const savedCache = process.env.LUX_PACK_CACHE;

function writeLock(): void {
  writeFileSync(
    join(root, 'composer.lock'),
    '{"packages":[{"name":"laravel/framework","version":"v11.0.0"}]}\n'
  );
}

/** Build a minimal cached pack for the current composer.lock; returns its path. */
function cachePack(): string {
  const key = deriveComposerLockKey(root);
  const packPath = packPathForKey(key);
  mkdirSync(dirname(packPath), { recursive: true });
  const writer = new VendorPackWriter(packPath);
  writer.write(
    [
      {
        id: 'symbol:php:Acme\\Kit',
        node_type: 'symbol',
        file_path: 'vendor/acme/kit/Kit.php',
        language_id: 'php',
        symbol_name: 'Kit',
        symbol_kind: 'Class',
        qualified_name: 'Acme\\Kit',
        updated_at: 1,
      },
    ],
    []
  );
  writer.finalize({
    formatVersion: PACK_FORMAT_VERSION,
    keyScheme: 'composer-lock',
    key: key.digest,
    framework: key.framework,
    depth: 'ast-only',
    nodeCount: 1,
    edgeCount: 0,
    buildDurationMs: 1,
    builtAt: 1,
    luxVersion: '0.0.0-test',
  });
  return packPath;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-pack-change-'));
  cache = mkdtempSync(join(tmpdir(), 'lux-pack-change-cache-'));
  process.env.LUX_PACK_CACHE = cache;
  writeFileSync(join(root, 'composer.json'), '{"name":"acme/app"}\n');
  writeFileSync(join(root, 'lux.yaml'), 'lsp:\n  enabled: false\n');
  db = new LuxDatabase(join(mkdtempSync(join(tmpdir(), 'lux-pack-change-db-')), 'lux.db'));
});

afterEach(() => {
  db.close();
  if (savedCache === undefined) delete process.env.LUX_PACK_CACHE;
  else process.env.LUX_PACK_CACHE = savedCache;
  rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

describe('vendorPackChangedSinceRebuild', () => {
  it('is false when no pack was merged and none would be', () => {
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(false);
  });

  it('is true when a pack for the lock appeared after the rebuild', () => {
    writeLock();
    db.setIndexMetadata(VENDOR_PACK_MERGED_META, 'none');
    cachePack();
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(true);
  });

  it('is false when the merged pack is the one a rebuild would merge', () => {
    writeLock();
    db.setIndexMetadata(VENDOR_PACK_MERGED_META, vendorPackIdentity(cachePack()));
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(false);
  });

  it('is true when the merged pack is no longer the cached one', () => {
    writeLock();
    const packPath = cachePack();
    db.setIndexMetadata(VENDOR_PACK_MERGED_META, vendorPackIdentity(packPath));
    rmSync(packPath);
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(true);
  });

  it('is true when vendorPack.merge is turned off over a merged pack', () => {
    writeLock();
    db.setIndexMetadata(VENDOR_PACK_MERGED_META, vendorPackIdentity(cachePack()));
    writeFileSync(join(root, 'lux.yaml'), 'lsp:\n  enabled: false\nvendorPack:\n  merge: false\n');
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(true);
  });

  it('is true when vendor-pack nodes predate the merge record', () => {
    db.upsertStructuralNode({
      id: 'symbol:php:Acme\\Kit',
      node_type: 'symbol',
      file_path: 'vendor/acme/kit/Kit.php',
      origin: 'vendor-pack',
      updated_at: 1,
    });
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(true);
  });

  it('a rebuild records the pack it merged, and clearing the overlay clears the record', async () => {
    writeLock();
    const packPath = cachePack();
    await rebuildWithOverlay(db, root);
    expect(db.getIndexMetadata(VENDOR_PACK_MERGED_META)).toBe(vendorPackIdentity(packPath));
    expect(vendorPackChangedSinceRebuild(db, root, loadLspConfig(root))).toBe(false);

    db.clearOverlay();
    expect(db.getIndexMetadata(VENDOR_PACK_MERGED_META)).toBeUndefined();
  });
});
