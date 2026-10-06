import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { AssociationEngine } from '../engine.js';
import type { StructuralRelationEdge } from '../types.js';
import { classifyOwnership, classifyHandlerOwnership, resolveAppNamespace } from '../ownership.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-ownership-test-'));
const now = () => Math.floor(Date.now() / 1000);

function symbolNode(id: string, origin: 'local' | 'vendor-pack' = 'local') {
  return {
    id,
    node_type: 'symbol' as const,
    file_path: 'x.php',
    language_id: 'php',
    origin,
    updated_at: now(),
  };
}

function handlerEdge(surface: string, target: string): StructuralRelationEdge {
  return {
    id: `edge:${surface}=>${target}`,
    edgeType: 'handled_by',
    sourceNodeId: surface,
    targetNodeId: target,
    sourceLanguage: 'php',
    targetLanguage: 'php',
    confidence: 1,
    confidenceClass: 'proven',
    provenance: {
      resolver: 'test',
      evidenceKind: 'test',
      evidenceLocations: [],
      extractedAt: now(),
    },
  };
}

describe('classifyOwnership', () => {
  const kernelId = 'symbol:php:Acme\\Core\\Http\\Controllers\\Foo';
  const appId = 'symbol:php:App\\Http\\Controllers\\Foo';
  const vendorId = 'symbol:php:Laravel\\Jetstream\\TeamController';

  it('kernel-owned: present, non-App, project-local target', () => {
    expect(classifyOwnership(kernelId, symbolNode(kernelId, 'local'))).toBe('kernel-owned');
  });
  it('client-override: present App target', () => {
    expect(classifyOwnership(appId, symbolNode(appId, 'local'))).toBe('client-override');
  });
  it('external: present, non-App, vendor-pack target (not kernel-owned)', () => {
    expect(classifyOwnership(vendorId, symbolNode(vendorId, 'vendor-pack'))).toBe('external');
  });
  it('client-gap: absent App target', () => {
    expect(classifyOwnership(appId, null)).toBe('client-gap');
  });
  it('external: absent non-App target', () => {
    expect(classifyOwnership(vendorId, null)).toBe('external');
  });
});

describe('classifyHandlerOwnership', () => {
  let db: LuxDatabase;
  afterEach(() => {
    db?.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('labels + persists ownership across the app/kernel boundary', () => {
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(join(testDir, 'test.db'));

    // present targets: kernel (local, Acme\Core), client override (local, App\),
    // and a MERGED VENDOR controller (vendor-pack origin) — must NOT be kernel-owned.
    db.upsertStructuralNode(
      symbolNode('symbol:php:Acme\\Core\\Http\\Controllers\\KernelFoo', 'local')
    );
    db.upsertStructuralNode(symbolNode('symbol:php:App\\Http\\Controllers\\ClientFoo', 'local'));
    db.upsertStructuralNode(
      symbolNode('symbol:php:Laravel\\Fortify\\AuthController', 'vendor-pack')
    );

    AssociationEngine.persistEdges(db, [
      handlerEdge('surface:http:GET:/a', 'symbol:php:Acme\\Core\\Http\\Controllers\\KernelFoo'), // kernel-owned (present, local)
      handlerEdge('surface:http:GET:/b', 'symbol:php:App\\Http\\Controllers\\ClientFoo'), // client-override (present App)
      handlerEdge('surface:http:GET:/c', 'symbol:php:App\\Http\\Controllers\\MissingFoo'), // client-gap (absent App)
      handlerEdge('surface:http:GET:/d', 'symbol:php:Laravel\\Jetstream\\TeamController'), // external (absent)
      handlerEdge('surface:http:GET:/e', 'symbol:php:Laravel\\Fortify\\AuthController'), // external (present, vendor-pack)
    ]);

    const summary = classifyHandlerOwnership(db);
    expect(summary.classified).toBe(5);
    expect(summary.counts).toEqual({
      'kernel-owned': 1,
      'client-override': 1,
      'client-gap': 1,
      external: 2, // absent Jetstream + present-but-vendor Fortify
    });

    const breakdown = Object.fromEntries(
      db.getOwnershipBreakdown().map((r) => [r.ownership, r.count])
    );
    expect(breakdown['kernel-owned']).toBe(1);
    expect(breakdown['client-gap']).toBe(1);
    expect(breakdown['external']).toBe(2);
  });
});

describe('classifyOwnership — custom app namespace (#1)', () => {
  it('treats the derived app namespace as the client, not the hardcoded App\\', () => {
    // A client rooted at Acme\ : its own controllers are client-override…
    expect(
      classifyOwnership(
        'symbol:php:Acme\\Http\\Controllers\\Foo',
        symbolNode('id', 'local'),
        'Acme'
      )
    ).toBe('client-override');
    expect(classifyOwnership('symbol:php:Acme\\Http\\Controllers\\Foo', null, 'Acme')).toBe(
      'client-gap'
    );
    // …and a promoted kernel under App\ is now kernel-owned (App is NOT this app).
    expect(
      classifyOwnership('symbol:php:App\\Kernel\\Foo', symbolNode('id', 'local'), 'Acme')
    ).toBe('kernel-owned');
  });

  it('does not false-match a namespace that merely starts with the app namespace', () => {
    // appNamespace "App" must not match "Applications\..."
    expect(
      classifyOwnership('symbol:php:Applications\\Foo', symbolNode('id', 'local'), 'App')
    ).toBe('kernel-owned');
  });
});

describe('resolveAppNamespace (#1)', () => {
  const dir = join(testDir, 'app-ns');
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  function withComposer(json: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'composer.json'), json);
    return dir;
  }

  it('derives the PSR-4 root mapping to app/ (strips trailing separator)', () => {
    expect(resolveAppNamespace(withComposer('{"autoload":{"psr-4":{"Acme\\\\":"app/"}}}'))).toBe(
      'Acme'
    );
  });

  it('defaults to App when composer.json is absent', () => {
    mkdirSync(dir, { recursive: true });
    expect(resolveAppNamespace(dir)).toBe('App');
  });

  it('defaults to App when there is no psr-4 autoload', () => {
    expect(resolveAppNamespace(withComposer('{"name":"acme/app"}'))).toBe('App');
  });

  it('prefers the app/ root over other PSR-4 entries', () => {
    expect(
      resolveAppNamespace(
        withComposer('{"autoload":{"psr-4":{"Database\\\\":"database/","App\\\\":"app/"}}}')
      )
    ).toBe('App');
  });
});
