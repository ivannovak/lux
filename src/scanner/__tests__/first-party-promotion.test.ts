import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { LuxDatabase } from '../../db/index.js';
import { generalScan } from '../general.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-first-party-promotion-'));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Synthetic shared-kernel topology: a kernel package defines routes referencing
 * BOTH its own controller and the consuming app's `App\*` controller; the client
 * app supplies one of the two `App\*` controllers. Exercises the real multi-root
 * merge in generalScan (first-party promotion) + ownership classification, so the
 * cross-repo resolution is CI-gated without needing a machine-specific checkout.
 */
describe('first-party promotion (multi-root overlay)', () => {
  let db: LuxDatabase;
  const client = join(testDir, 'client');
  const kernel = join(testDir, 'kernel');

  beforeEach(() => {
    // composer.json markers so both dirs register as source-code repositories.
    write(join(client, 'composer.json'), `{ "name": "acme/app" }\n`);
    write(join(kernel, 'composer.json'), `{ "name": "acme/core" }\n`);

    // Kernel package (promoted as first-party): its provider registers routes under
    // the Acme\Core controller namespace; routes reference an App\ controller
    // (the client's) and the kernel's own controller.
    write(
      join(kernel, 'src/CoreServiceProvider.php'),
      `<?php\nRoute::namespace("Acme\\Core\\Http\\Controllers")->group(__DIR__ . '/../routes/web.php');\n`
    );
    write(
      join(kernel, 'routes/web.php'),
      `<?php\nuse App\\Http\\Controllers\\Web\\EventsController;\n` +
        `Route::get('/inventory', [EventsController::class, 'index']);\n` +
        `Route::get('/missing', [App\\Http\\Controllers\\Web\\GhostController::class, 'index']);\n` +
        `Route::get('/admin', 'Api\\AdminController@index');\n`
    );
    write(
      join(kernel, 'src/Http/Controllers/Api/AdminController.php'),
      `<?php\nnamespace Acme\\Core\\Http\\Controllers\\Api;\nclass AdminController { public function index() {} }\n`
    );

    // Client app (scan root): provides EventsController but NOT GhostController.
    write(
      join(client, 'app/Http/Controllers/Web/EventsController.php'),
      `<?php\nnamespace App\\Http\\Controllers\\Web;\nclass EventsController { public function index() {} }\n`
    );

    mkdirSync(join(testDir, 'db'), { recursive: true });
    db = new LuxDatabase(join(testDir, 'db', 'test.db'));
  });

  afterEach(() => {
    db?.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('surfaces kernel routes and resolves them to client controllers with ownership', async () => {
    await generalScan(client, { firstPartyRoots: [kernel], overlayEnabled: true, db });

    // Kernel routes are now surfaced when scanning the client (they live in the
    // promoted package). Without promotion, running on the client sees none of them.
    const surfaces = db.getOwnershipBreakdown().reduce((n, r) => n + r.count, 0);
    expect(surfaces).toBeGreaterThanOrEqual(3);

    // The client's controller was scanned as an overlay node…
    expect(
      db.getStructuralNode('symbol:php:App\\Http\\Controllers\\Web\\EventsController')
    ).not.toBeNull();
    // …and GhostController (referenced by the kernel, absent from the client) was not.
    expect(
      db.getStructuralNode('symbol:php:App\\Http\\Controllers\\Web\\GhostController')
    ).toBeNull();

    const breakdown = Object.fromEntries(
      db.getOwnershipBreakdown().map((r) => [r.ownership, r.count])
    );
    // /inventory → client's App\ EventsController = client-override
    expect(breakdown['client-override'] ?? 0).toBeGreaterThanOrEqual(1);
    // /admin → kernel's Acme\Core AdminController = kernel-owned
    expect(breakdown['kernel-owned'] ?? 0).toBeGreaterThanOrEqual(1);
    // /missing → App\ GhostController the client doesn't implement = client-gap
    expect(breakdown['client-gap'] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
