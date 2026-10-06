// Config fingerprint tests (spec 15 Part A / Decision 7 / SC-10 / T3b.1). The fingerprint hashes
// the raw lux.yaml bytes (with the checkout root replaced by a placeholder), the raw composer.lock
// bytes (when present), the applied schema_version, and the sorted root-relative realpaths of the
// resolved first-party roots. Over-escalation is the safe
// direction, so a cosmetic YAML edit must change the fingerprint; a missed input would silently
// under-escalate, so the whole file is hashed.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import {
  computeStructuralConfigFingerprint,
  persistStructuralConfigFingerprint,
  structuralConfigFingerprintMatches,
  STRUCTURAL_CONFIG_FINGERPRINT_KEY,
} from '../config-fingerprint.js';

const cleanup: string[] = [];

function makeRoot(luxYaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'lux-fp-'));
  cleanup.push(root);
  writeFileSync(join(root, 'lux.yaml'), luxYaml);
  return root;
}

function makeDb(): LuxDatabase {
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-fp-db-'));
  cleanup.push(dbDir);
  return new LuxDatabase(join(dbDir, 'lux.db'));
}

afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const BASE_YAML = 'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: false\n';

describe('computeStructuralConfigFingerprint (spec 15 Part A)', () => {
  it('is stable across repeated no-op calls', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    const a = computeStructuralConfigFingerprint(root, db);
    const b = computeStructuralConfigFingerprint(root, db);
    expect(a).toBe(b);
    db.close();
  });

  it('changes on a comment-only lux.yaml edit (over-escalation is intended)', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    const before = computeStructuralConfigFingerprint(root, db);
    writeFileSync(join(root, 'lux.yaml'), BASE_YAML + '# a cosmetic comment\n');
    const after = computeStructuralConfigFingerprint(root, db);
    expect(after).not.toBe(before);
    db.close();
  });

  it('changes when composer.lock is added and when its bytes change', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    const absent = computeStructuralConfigFingerprint(root, db);

    writeFileSync(join(root, 'composer.lock'), '{"content-hash":"aaa"}\n');
    const present = computeStructuralConfigFingerprint(root, db);
    expect(present).not.toBe(absent);

    writeFileSync(join(root, 'composer.lock'), '{"content-hash":"bbb"}\n');
    const changed = computeStructuralConfigFingerprint(root, db);
    expect(changed).not.toBe(present);
    db.close();
  });

  it('changes when the applied schema_version advances', () => {
    const root = makeRoot(BASE_YAML);
    const dbV5 = { getAppliedSchemaVersion: () => 5 } as unknown as LuxDatabase;
    const dbV6 = { getAppliedSchemaVersion: () => 6 } as unknown as LuxDatabase;
    const v5 = computeStructuralConfigFingerprint(root, dbV5);
    const v6 = computeStructuralConfigFingerprint(root, dbV6);
    expect(v6).not.toBe(v5);
  });

  it('changes when the first-party root set changes (isolated from lux.yaml/composer.lock bytes)', () => {
    // lux.yaml (with firstParty) and composer.lock are held constant; only the composer
    // installed.json → resolved roots change. installed.json is NOT hashed directly, so any
    // fingerprint delta is attributable solely to the resolved first-party root set.
    const root = makeRoot('firstParty:\n  packages:\n    - "acme/*"\n');
    const db = makeDb();
    const composerDir = join(root, 'vendor', 'composer');
    mkdirSync(composerDir, { recursive: true });
    mkdirSync(join(root, 'vendor', 'acme', 'pkg'), { recursive: true });
    writeFileSync(
      join(composerDir, 'installed.json'),
      JSON.stringify({ packages: [{ name: 'acme/pkg', 'install-path': '../acme/pkg' }] })
    );
    const oneRoot = computeStructuralConfigFingerprint(root, db);

    mkdirSync(join(root, 'vendor', 'acme', 'pkg2'), { recursive: true });
    writeFileSync(
      join(composerDir, 'installed.json'),
      JSON.stringify({
        packages: [
          { name: 'acme/pkg', 'install-path': '../acme/pkg' },
          { name: 'acme/pkg2', 'install-path': '../acme/pkg2' },
        ],
      })
    );
    const twoRoots = computeStructuralConfigFingerprint(root, db);
    expect(twoRoots).not.toBe(oneRoot);
    db.close();
  });

  it('is the same for two checkouts whose lux.yaml names their own absolute root', () => {
    const yamlFor = (root: string) =>
      `lsp:\n  enabled: false\n  workspace_root: ${root}\n  enrichers: []\n` +
      `deps:\n  enabled: false\n# ${root}/scratch is ignored\n`;
    const first = makeRoot(BASE_YAML);
    const second = makeRoot(BASE_YAML);
    writeFileSync(join(first, 'lux.yaml'), yamlFor(first));
    writeFileSync(join(second, 'lux.yaml'), yamlFor(second));
    const db = makeDb();
    expect(computeStructuralConfigFingerprint(first, db)).toBe(
      computeStructuralConfigFingerprint(second, db)
    );
    db.close();
  });

  it('still sees a path that only shares a prefix with the checkout root', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    writeFileSync(join(root, 'lux.yaml'), `lsp:\n  workspace_root: ${root}-a\n`);
    const siblingA = computeStructuralConfigFingerprint(root, db);
    writeFileSync(join(root, 'lux.yaml'), `lsp:\n  workspace_root: ${root}-b\n`);
    const siblingB = computeStructuralConfigFingerprint(root, db);
    expect(siblingA).not.toBe(siblingB);
    db.close();
  });

  it('is unchanged when a markdown file changes (only structural inputs are hashed)', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    const before = computeStructuralConfigFingerprint(root, db);
    writeFileSync(join(root, 'README.md'), '# hello\n');
    const afterAdd = computeStructuralConfigFingerprint(root, db);
    expect(afterAdd).toBe(before);
    writeFileSync(join(root, 'README.md'), '# hello, again\n');
    const afterEdit = computeStructuralConfigFingerprint(root, db);
    expect(afterEdit).toBe(before);
    db.close();
  });
});

describe('persist + match round-trip (spec 15 Part A)', () => {
  it('persists under index_metadata and matches the current config', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    persistStructuralConfigFingerprint(root, db);
    expect(db.getIndexMetadata(STRUCTURAL_CONFIG_FINGERPRINT_KEY)).toBeDefined();
    expect(structuralConfigFingerprintMatches(root, db)).toBe(true);
    db.close();
  });

  it('mismatches after a lux.yaml edit', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    persistStructuralConfigFingerprint(root, db);
    writeFileSync(join(root, 'lux.yaml'), BASE_YAML + '# edited\n');
    expect(structuralConfigFingerprintMatches(root, db)).toBe(false);
    db.close();
  });

  it('mismatches when never recorded (escalate on the safe direction)', () => {
    const root = makeRoot(BASE_YAML);
    const db = makeDb();
    expect(structuralConfigFingerprintMatches(root, db)).toBe(false);
    db.close();
  });
});
