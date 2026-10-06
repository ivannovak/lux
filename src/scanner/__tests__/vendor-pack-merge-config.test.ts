// lux.yaml `vendorPack.merge: false` turns off the vendor-pack merge, so a rebuild depends on the
// checkout and its config, not on what the machine's pack cache happens to hold.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { loadLspConfig } from '../config.js';
import { deriveComposerLockKey, packPathForKey } from '../pack/cache.js';
import { PACK_FORMAT_VERSION, VendorPackWriter } from '../pack/pack-format.js';
import { rebuildWithOverlay, resolveVendorPackPathForRefresh } from '../rebuild-orchestrator.js';

const VENDOR_NODE_ID = 'symbol:php:Vendor\\Package\\Thing';

let dir: string;
let previousCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-vendor-pack-config-'));
  previousCache = process.env.LUX_PACK_CACHE;
  process.env.LUX_PACK_CACHE = join(dir, 'packs');
});

afterEach(() => {
  if (previousCache === undefined) delete process.env.LUX_PACK_CACHE;
  else process.env.LUX_PACK_CACHE = previousCache;
  rmSync(dir, { recursive: true, force: true });
});

/** A Composer project with one app class, plus a cached pack for its lockfile. */
function projectWithCachedPack(luxYaml: string): string {
  const root = join(dir, 'app');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'composer.json'), '{"name":"fixture/app"}\n');
  writeFileSync(
    join(root, 'composer.lock'),
    JSON.stringify({ packages: [{ name: 'vendor/package', version: '1.0.0' }] })
  );
  writeFileSync(join(root, 'app', 'Local.php'), '<?php\n\nnamespace App;\n\nclass Local {}\n');
  writeFileSync(join(root, 'lux.yaml'), luxYaml);

  const key = deriveComposerLockKey(root);
  const packPath = packPathForKey(key);
  mkdirSync(join(packPath, '..'), { recursive: true });
  const writer = new VendorPackWriter(packPath);
  writer.write(
    [
      {
        id: VENDOR_NODE_ID,
        node_type: 'symbol',
        file_path: 'vendor/vendor/package/src/Thing.php',
        language_id: 'php',
        symbol_name: 'Thing',
        symbol_kind: 'Class',
        qualified_name: 'Vendor\\Package\\Thing',
        updated_at: 1,
      },
    ],
    []
  );
  writer.finalize({
    formatVersion: PACK_FORMAT_VERSION,
    keyScheme: 'composer-lock',
    key: key.digest,
    depth: 'ast-only',
    nodeCount: 1,
    edgeCount: 0,
    buildDurationMs: 1,
    builtAt: 1,
    luxVersion: 'test',
  });
  return root;
}

const LSP_OFF = 'lsp:\n  enabled: false\n';

describe('vendorPack.merge', () => {
  it('resolves the cached pack by default', () => {
    const root = projectWithCachedPack(LSP_OFF);
    expect(resolveVendorPackPathForRefresh(root, loadLspConfig(root))).toBe(
      packPathForKey(deriveComposerLockKey(root))
    );
  });

  it('resolves no pack when merge is false', () => {
    const root = projectWithCachedPack(`${LSP_OFF}vendorPack:\n  merge: false\n`);
    expect(resolveVendorPackPathForRefresh(root, loadLspConfig(root))).toBeNull();
  });

  it('rejects a non-boolean merge value', () => {
    const root = projectWithCachedPack(`${LSP_OFF}vendorPack:\n  merge: "no"\n`);
    expect(() => loadLspConfig(root)).toThrow('vendorPack.merge');
  });

  it('keeps vendor nodes out of a rebuild when merge is false, and merges them otherwise', async () => {
    for (const [yaml, expected] of [
      [LSP_OFF, true],
      [`${LSP_OFF}vendorPack:\n  merge: false\n`, false],
    ] as const) {
      const root = projectWithCachedPack(yaml);
      const db = new LuxDatabase(join(dir, `lux-${String(expected)}.db`));
      try {
        await rebuildWithOverlay(db, root);
        expect(db.getStructuralNode(VENDOR_NODE_ID) !== null).toBe(expected);
        expect(db.getStructuralNode('symbol:php:App\\Local')).not.toBeNull();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
