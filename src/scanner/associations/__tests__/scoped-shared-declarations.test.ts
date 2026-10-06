// A scoped refresh applies the shared-declaration rules a full rebuild applies (issue #13): when a
// change makes a second file declare a route, an event's listeners or a command name, or removes
// that second declaration, the refreshed index holds the rows a cold rebuild of the same commit
// holds. The census that decides a file-qualified id needs every declaring file, and the refresh
// has them because any PHP change widens its repair set to every PHP file.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { LuxDatabase } from '../../../db/index.js';
import { rebuildWithOverlay } from '../../rebuild-orchestrator.js';
import { loadLspConfig } from '../../config.js';
import { refreshOverlayScoped, type ChangedFile } from '../overlay-refresh.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function write(repo: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
}

function commitAll(repo: string): void {
  execSync('git add -A && git commit -q -m change', { cwd: repo });
}

function provider(module: string): string {
  return `<?php
namespace App\\Module\\${module};
use App\\Events\\OrderShipped;
use App\\Module\\${module}\\Listeners\\${module}Listener;
use Illuminate\\Support\\Facades\\Event;
class ServiceProvider
{
    public function boot(): void
    {
        Event::listen(OrderShipped::class, ${module}Listener::class);
    }
}
`;
}

function command(module: string): string {
  return `<?php
namespace App\\Module\\${module}\\Console;
use Illuminate\\Console\\Command;
class SendReport extends Command
{
    protected $signature = 'report:send {--${module.toLowerCase()}}';
}
`;
}

/** One declaration of each fact. */
const FIRST: Record<string, string> = {
  'routes/web.php': `<?php
use App\\Http\\Controllers\\SiteController;
Route::get('/', [SiteController::class, 'index'])->name('homepage');
Route::get('/faq', [SiteController::class, 'faq'])->name('site.faq');
`,
  'app/Http/Controllers/SiteController.php': `<?php
namespace App\\Http\\Controllers;
class SiteController
{
    public function index(): string { return 'home'; }
    public function faq(): string { return 'faq'; }
}
`,
  'src/Module/Alpha/ServiceProvider.php': provider('Alpha'),
  'src/Module/Alpha/Console/SendReport.php': command('Alpha'),
};

/** A second file declaring each of them. */
const SECOND: Record<string, string> = {
  'workbench/routes/web.php': `<?php
Route::get('/', function () {
    return view('welcome');
});
`,
  'src/Module/Beta/ServiceProvider.php': provider('Beta'),
  'src/Module/Beta/Console/SendReport.php': command('Beta'),
};

function makeRepo(): string {
  const repo = tempDir('lux-shared-decl-');
  execSync('git init -q && git config user.email a@b.c && git config user.name x', { cwd: repo });
  write(repo, {
    'lux.yaml': `lsp:\n  enabled: false\n  workspace_root: ${repo}\n`,
    '.gitignore': '.lux/\n',
    'composer.json': JSON.stringify({
      name: 'fixture/app',
      autoload: { 'psr-4': { 'App\\': 'app/' } },
    }),
    ...FIRST,
  });
  commitAll(repo);
  return repo;
}

async function rebuilt(repo: string): Promise<LuxDatabase> {
  const db = new LuxDatabase(join(tempDir('lux-shared-decl-db-'), 'lux.db'));
  await rebuildWithOverlay(db, repo);
  return db;
}

/** The surface and operational rows, without wall-clock fields. */
function declaredFacts(db: LuxDatabase): Record<string, string[]> {
  const surfaces = db.getCapabilitySurfaces();
  const surfaceEdges = new Set<string>();
  for (const surface of surfaces) {
    for (const edge of db.getStructuralEdgesForNode(surface.id)) {
      surfaceEdges.add(`${edge.edge_type} ${edge.source_node_id} -> ${edge.target_node_id}`);
    }
  }
  const boundaries = db.getOperationalBoundaries();
  return {
    surfaces: surfaces.map((node) => `${node.id} | ${node.file_path} | ${node.metadata}`).sort(),
    surfaceEdges: [...surfaceEdges].sort(),
    boundaries: boundaries
      .map((b) => `${b.id} | ${b.file_path ?? '-'} | tier ${b.trust_tier}`)
      .sort(),
    handlers: boundaries
      .flatMap((b) => db.getOperationalHandlersForBoundary(b.id))
      .map((handler) => `${handler.id} | tier ${handler.trust_tier}`)
      .sort(),
    operationalEdges: boundaries
      .flatMap((b) => db.getOperationalEdgesForSource(b.id))
      .map((edge) => `${edge.id} | ${edge.transport ?? '-'} | tier ${edge.trust_tier}`)
      .sort(),
    contracts: boundaries
      .flatMap((b) => db.getOperationalContractsForBoundary(b.id))
      .map((contract) => `${contract.id} | ${contract.payload_schema}`)
      .sort(),
  };
}

function ids(rows: string[]): string[] {
  return rows.map((row) => row.split(' | ')[0]);
}

describe('scoped refresh of facts that a second file starts or stops declaring', () => {
  it('holds the rows of a cold rebuild after the second declarations arrive, and after they go', async () => {
    const repo = makeRepo();
    const db = await rebuilt(repo);
    const config = loadLspConfig(repo);
    const second = Object.keys(SECOND);

    const before = declaredFacts(db);
    expect(ids(before.surfaces)).toEqual(['surface:http:GET:/', 'surface:http:GET:/faq']);

    // The second declarations arrive.
    write(repo, SECOND);
    commitAll(repo);
    const added: ChangedFile[] = second.map((relPath) => ({ relPath, status: 'added' }));
    await refreshOverlayScoped(db, repo, added, config, {});

    const both = declaredFacts(db);
    expect(ids(both.surfaces)).toEqual([
      'surface:http:GET:/#file:routes/web.php',
      'surface:http:GET:/#file:workbench/routes/web.php',
      'surface:http:GET:/faq',
    ]);
    expect(ids(both.boundaries)).toEqual([
      'opb:command:report:send#file:src/Module/Alpha/Console/SendReport.php',
      'opb:command:report:send#file:src/Module/Beta/Console/SendReport.php',
      'opb:event:App\\Events\\OrderShipped',
    ]);
    expect(both.contracts.find((row) => row.startsWith('opc:opb:event:'))).toContain(
      '"registeredIn":["src/Module/Alpha/ServiceProvider.php","src/Module/Beta/ServiceProvider.php"]'
    );
    const coldBoth = await rebuilt(repo);
    expect(both).toEqual(declaredFacts(coldBoth));
    coldBoth.close();

    // The second declarations go: every id returns to its unqualified form, with nothing left over.
    for (const relPath of second) rmSync(join(repo, relPath));
    commitAll(repo);
    const deleted: ChangedFile[] = second.map((relPath) => ({ relPath, status: 'deleted' }));
    await refreshOverlayScoped(db, repo, deleted, config, {});

    const after = declaredFacts(db);
    expect(after).toEqual(before);
    const coldAfter = await rebuilt(repo);
    expect(after).toEqual(declaredFacts(coldAfter));
    coldAfter.close();
    db.close();
  }, 120_000);

  it('still sees every declaring file when the change set also holds a React file', async () => {
    const repo = makeRepo();
    const db = await rebuilt(repo);

    // A React change widens the refresh to the JavaScript universe; the PHP census must not be
    // left with only the changed PHP files because of it.
    const mixed = {
      ...SECOND,
      'resources/js/Widget.tsx':
        "import React from 'react';\nexport function Widget() {\n  return <div>widget</div>;\n}\n",
    };
    write(repo, mixed);
    commitAll(repo);
    const added: ChangedFile[] = Object.keys(mixed).map((relPath) => ({
      relPath,
      status: 'added',
    }));
    await refreshOverlayScoped(db, repo, added, loadLspConfig(repo), {});

    const facts = declaredFacts(db);
    expect(ids(facts.surfaces)).toEqual([
      'surface:http:GET:/#file:routes/web.php',
      'surface:http:GET:/#file:workbench/routes/web.php',
      'surface:http:GET:/faq',
    ]);
    const cold = await rebuilt(repo);
    expect(facts).toEqual(declaredFacts(cold));
    cold.close();
    db.close();
  }, 120_000);
});
