// One fact declared in more than one file (issue #13): the stored rows follow a stated rule per
// kind and never the order the files were processed in. Every case runs the same entries forwards
// and reversed and requires the two databases to hold the same rows.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import { WarningLog } from '../../reporter.js';
import type { AssociationContext, CapabilitySurfaceNode } from '../types.js';
import { runDetectors } from '../detectors/index.js';
import type { CapabilitySurfaceDetector } from '../detectors/types.js';
import { runOperationalExtractors } from '../operational/index.js';
import { emptyOperationalBatch, type OperationalExtractor } from '../operational/types.js';
import { LaravelCommandExtractor } from '../framework/laravel/commands.js';
import { LaravelSchedulerExtractor } from '../framework/laravel/scheduler.js';
import { LaravelJobDispatchExtractor } from '../framework/laravel/jobs.js';

const ROOT = '/app';

interface Entry {
  filePath: string;
  content: string;
}

function makeContext(entries: Entry[]): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((entry) => ({
      filePath: entry.filePath,
      languageId: 'php',
      metadata: { content: entry.content },
    })),
    dirtyFiles: [],
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(): LuxDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'lux-collisions-'));
  dirs.push(dir);
  return new LuxDatabase(join(dir, 'test.db'));
}

interface SurfaceRun {
  surfaces: StructuralNode[];
  /** `edge_type source -> target @ evidence file`, sorted. */
  edges: string[];
  surfacesDetected: number;
  warnings: string[];
}

async function detectSurfaces(
  entries: Entry[],
  detectors?: CapabilitySurfaceDetector[]
): Promise<SurfaceRun> {
  const db = makeDb();
  const log = new WarningLog();
  try {
    const result = await runDetectors(db, makeContext(entries), detectors, log.reporter);
    const surfaces = db.getCapabilitySurfaces().sort((a, b) => (a.id < b.id ? -1 : 1));
    const edges = new Set<string>();
    for (const surface of surfaces) {
      for (const edge of db.getStructuralEdgesForNode(surface.id)) {
        const evidence = db
          .getEdgeEvidence(edge.id)
          .map((row) => row.file_path)
          .sort()
          .join(',');
        edges.add(
          `${edge.edge_type} ${edge.source_node_id} -> ${edge.target_node_id} @ ${evidence}`
        );
      }
    }
    return {
      surfaces,
      edges: [...edges].sort(),
      surfacesDetected: result.surfacesDetected,
      warnings: [...log.messages],
    };
  } finally {
    db.close();
  }
}

/** A surface row without its wall-clock fields, for comparing two runs. */
function comparable(surfaces: StructuralNode[]): unknown[] {
  return surfaces.map((node) => ({
    id: node.id,
    file_path: node.file_path,
    symbol_name: node.symbol_name,
    metadata: node.metadata,
  }));
}

function meta(node: StructuralNode): Record<string, unknown> {
  return JSON.parse(node.metadata ?? '{}') as Record<string, unknown>;
}

const APP_ROUTES: Entry = {
  filePath: 'routes/web.php',
  content: `<?php
use App\\Http\\Controllers\\Web\\SiteController;
Route::get('/', [SiteController::class, 'index'])->name('homepage');
Route::get('/faq', [SiteController::class, 'faq'])->name('site.faq');
`,
};

const SKELETON_ROUTES: Entry = {
  filePath: 'workbench/routes/web.php',
  content: `<?php
Route::get('/', function () {
    return view('welcome');
});
`,
};

describe('an HTTP route declared in two route files', () => {
  const APP_ID = 'surface:http:GET:/#file:routes/web.php';
  const SKELETON_ID = 'surface:http:GET:/#file:workbench/routes/web.php';

  it('stores one surface per declaration, each under a file-qualified id', async () => {
    const run = await detectSurfaces([APP_ROUTES, SKELETON_ROUTES]);

    expect(run.surfaces.map((node) => node.id)).toEqual([
      APP_ID,
      SKELETON_ID,
      'surface:http:GET:/faq',
    ]);
  });

  it('takes every field of a surface, and its edges, from the one declaration it names', async () => {
    const run = await detectSurfaces([APP_ROUTES, SKELETON_ROUTES]);
    const app = run.surfaces.find((node) => node.id === APP_ID)!;
    const skeleton = run.surfaces.find((node) => node.id === SKELETON_ID)!;

    expect(app.file_path).toBe('routes/web.php');
    expect(meta(app)).toMatchObject({
      method: 'GET',
      path: '/',
      providerKind: 'controller',
      routeName: 'homepage',
      explicitProvider: 'App\\Http\\Controllers\\Web\\SiteController',
      controllerMethod: 'index',
    });

    expect(skeleton.file_path).toBe('workbench/routes/web.php');
    expect(meta(skeleton)).toMatchObject({ method: 'GET', path: '/', providerKind: 'closure' });
    expect(meta(skeleton).routeName).toBeUndefined();
    expect(meta(skeleton).explicitProvider).toBeUndefined();

    const controller = 'symbol:php:App\\Http\\Controllers\\Web\\SiteController';
    expect(run.edges).toEqual([
      `declares_surface file:routes/web.php -> ${APP_ID} @ routes/web.php`,
      `declares_surface file:routes/web.php -> surface:http:GET:/faq @ routes/web.php`,
      `declares_surface file:workbench/routes/web.php -> ${SKELETON_ID} @ workbench/routes/web.php`,
      `handled_by ${APP_ID} -> ${controller} @ routes/web.php`,
      `handled_by surface:http:GET:/faq -> ${controller} @ routes/web.php`,
    ]);
  });

  it('stores the same rows whichever file is processed first', async () => {
    const forwards = await detectSurfaces([APP_ROUTES, SKELETON_ROUTES]);
    const reversed = await detectSurfaces([SKELETON_ROUTES, APP_ROUTES]);

    expect(comparable(reversed.surfaces)).toEqual(comparable(forwards.surfaces));
    expect(reversed.edges).toEqual(forwards.edges);
  });

  it('counts as many detected surfaces as it stores, and warns about nothing', async () => {
    const run = await detectSurfaces([APP_ROUTES, SKELETON_ROUTES]);

    expect(run.surfacesDetected).toBe(run.surfaces.length);
    expect(run.warnings).toEqual([]);
  });

  it('leaves a route only one file declares under its bare id', async () => {
    const run = await detectSurfaces([APP_ROUTES]);

    expect(run.surfaces.map((node) => node.id)).toEqual([
      'surface:http:GET:/',
      'surface:http:GET:/faq',
    ]);
  });
});

describe('a detector that emits one surface id for two declarations', () => {
  function surface(
    filePath: string,
    providerKind: 'controller' | 'closure'
  ): CapabilitySurfaceNode {
    return {
      id: 'surface:http:GET:/dup',
      handle: 'GET /dup',
      transport: 'http',
      file_path: filePath,
      metadata: { transport: 'http', method: 'GET', path: '/dup', providerKind },
      updated_at: 0,
    };
  }
  const declarations = [surface('routes/b.php', 'closure'), surface('routes/a.php', 'controller')];
  const unqualified = (surfaces: CapabilitySurfaceNode[]): CapabilitySurfaceDetector => ({
    name: 'unqualified',
    supports: () => true,
    detect: () => Promise.resolve({ surfaces, edges: [] }),
  });

  it.each([
    ['in one order', declarations],
    ['in the other order', [...declarations].reverse()],
  ])('names the id and its files in a warning, and counts the id once (%s)', async (_, order) => {
    const run = await detectSurfaces([APP_ROUTES], [unqualified(order)]);

    expect(run.warnings).toEqual([
      'detector "unqualified" declared surface:http:GET:/dup in 2 files (routes/a.php, routes/b.php); ' +
        'one node cannot hold both, the declaration in routes/a.php is stored.',
    ]);
    expect(run.surfaces).toHaveLength(1);
    expect(run.surfaces[0].file_path).toBe('routes/a.php');
    expect(meta(run.surfaces[0]).providerKind).toBe('controller');
    expect(run.surfacesDetected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Operational boundaries
// ---------------------------------------------------------------------------

interface OperationalRun {
  boundaries: string[];
  handlers: string[];
  edges: string[];
  contracts: Array<{ id: string; payload: Record<string, unknown> }>;
  warnings: string[];
}

async function extractOperational(
  entries: Entry[],
  extractors?: OperationalExtractor[]
): Promise<OperationalRun> {
  const db = makeDb();
  const log = new WarningLog();
  try {
    await runOperationalExtractors(db, makeContext(entries), extractors, log.reporter);
    const boundaries = db.getOperationalBoundariesByRepoRoot(ROOT);
    const run: OperationalRun = {
      boundaries: boundaries
        .map((b) => `${b.id} | ${b.file_path ?? '-'} | tier ${b.trust_tier}`)
        .sort(),
      handlers: [],
      edges: [],
      contracts: [],
      warnings: [...log.messages],
    };
    for (const boundary of boundaries) {
      for (const handler of db.getOperationalHandlersForBoundary(boundary.id)) {
        run.handlers.push(`${handler.id} | tier ${handler.trust_tier}`);
      }
      for (const edge of db.getOperationalEdgesForSource(boundary.id)) {
        run.edges.push(`${edge.id} | ${edge.transport ?? '-'} | tier ${edge.trust_tier}`);
      }
      for (const contract of db.getOperationalContractsForBoundary(boundary.id)) {
        run.contracts.push({
          id: contract.id,
          payload: JSON.parse(contract.payload_schema ?? '{}') as Record<string, unknown>,
        });
      }
    }
    run.handlers.sort();
    run.edges.sort();
    run.contracts.sort((a, b) => (a.id < b.id ? -1 : 1));
    return run;
  } finally {
    db.close();
  }
}

function provider(module: string, listener: string): Entry {
  return {
    filePath: `src/Module/${module}/ServiceProvider.php`,
    content: `<?php
namespace App\\Module\\${module};
use App\\Events\\OrderShipped;
use App\\Module\\${module}\\Listeners\\${listener};
use Illuminate\\Support\\Facades\\Event;
class ServiceProvider
{
    public function boot(): void
    {
        Event::listen(OrderShipped::class, ${listener}::class);
    }
}
`,
  };
}

describe('an event registered by two providers', () => {
  const entries = [
    provider('Webhooks', 'SendWebhook'),
    provider('Invoicing', 'RecalculateInvoice'),
  ];
  const EVENT = 'opb:event:App\\Events\\OrderShipped';
  const INVOICING = 'App\\Module\\Invoicing\\Listeners\\RecalculateInvoice';
  const WEBHOOKS = 'App\\Module\\Webhooks\\Listeners\\SendWebhook';

  it('stores one boundary whose contract lists every registering file and every listener', async () => {
    const run = await extractOperational(entries);

    expect(run.boundaries).toEqual([
      `${EVENT} | src/Module/Invoicing/ServiceProvider.php | tier 5`,
    ]);
    expect(run.contracts).toHaveLength(1);
    expect(run.contracts[0].payload).toMatchObject({
      eventClass: 'App\\Events\\OrderShipped',
      listenerCount: 2,
      listenerClasses: [INVOICING, WEBHOOKS],
      registeredIn: [
        'src/Module/Invoicing/ServiceProvider.php',
        'src/Module/Webhooks/ServiceProvider.php',
      ],
    });
    expect(run.handlers).toEqual([
      `oph:${EVENT}:symbol:php:${INVOICING} | tier 5`,
      `oph:${EVENT}:symbol:php:${WEBHOOKS} | tier 5`,
    ]);
    expect(run.warnings).toEqual([]);
  });

  it('stores the same rows whichever provider is processed first', async () => {
    const forwards = await extractOperational(entries);
    const reversed = await extractOperational([...entries].reverse());

    expect(reversed).toEqual(forwards);
  });
});

function command(module: string, signature: string): Entry {
  return {
    filePath: `src/Module/${module}/Console/SendReport.php`,
    content: `<?php
namespace App\\Module\\${module}\\Console;
use Illuminate\\Console\\Command;
class SendReport extends Command
{
    protected $signature = '${signature}';
}
`,
  };
}

const KERNEL: Entry = {
  filePath: 'app/Console/Kernel.php',
  content: `<?php
namespace App\\Console;
class Kernel
{
    protected function schedule($schedule): void
    {
        $schedule->command('report:send')->daily();
        $schedule->job(new \\App\\Jobs\\Prune())->hourly();
    }
}
`,
};

describe('an Artisan command name', () => {
  it('keeps the declaring file when the scheduler also refers to the command', async () => {
    const entries = [command('Alpha', 'report:send {--force}'), KERNEL];
    const forwards = await extractOperational(entries);
    const reversed = await extractOperational([...entries].reverse());

    expect(forwards.boundaries).toContain(
      'opb:command:report:send | src/Module/Alpha/Console/SendReport.php | tier 5'
    );
    expect(reversed).toEqual(forwards);

    // Nor does it matter which extractor runs first.
    const referenceFirst = await extractOperational(entries, [
      new LaravelSchedulerExtractor(),
      new LaravelCommandExtractor(),
    ]);
    expect(referenceFirst).toEqual(forwards);
  });

  it('file-qualifies every class when two files declare the same name', async () => {
    const entries = [
      command('Beta', 'report:send {user}'),
      command('Alpha', 'report:send'),
      KERNEL,
    ];
    const forwards = await extractOperational(entries);
    const reversed = await extractOperational([...entries].reverse());

    const alpha = 'opb:command:report:send#file:src/Module/Alpha/Console/SendReport.php';
    const beta = 'opb:command:report:send#file:src/Module/Beta/Console/SendReport.php';
    expect(forwards.boundaries.filter((row) => row.startsWith('opb:command:'))).toEqual([
      // The scheduler's reference names the command, not a class: it stays unqualified.
      'opb:command:report:send | - | tier 5',
      `${alpha} | src/Module/Alpha/Console/SendReport.php | tier 5`,
      `${beta} | src/Module/Beta/Console/SendReport.php | tier 5`,
    ]);
    expect(forwards.handlers).toEqual(
      expect.arrayContaining([
        `oph:${alpha}:symbol:php:App\\Module\\Alpha\\Console\\SendReport | tier 5`,
        `oph:${beta}:symbol:php:App\\Module\\Beta\\Console\\SendReport | tier 5`,
      ])
    );
    const signatures = Object.fromEntries(
      forwards.contracts
        .filter((contract) => contract.id.endsWith(':signature'))
        .map((contract) => [contract.id, contract.payload.signature])
    );
    expect(signatures).toEqual({
      [`opc:${alpha}:signature`]: 'report:send',
      [`opc:${beta}:signature`]: 'report:send {user}',
    });
    expect(forwards.warnings).toEqual([]);
    expect(reversed).toEqual(forwards);
  });
});

function dispatcher(name: string, call: string): Entry {
  return {
    filePath: `app/Services/${name}.php`,
    content: `<?php
namespace App\\Services;
use App\\Jobs\\Prune;
class ${name}
{
    public function run(): void
    {
        ${call};
    }
}
`,
  };
}

describe('a job reached from several places', () => {
  const JOB = 'opb:job:App\\Jobs\\Prune';
  const HANDLED = `ope:${JOB}:HANDLED_BY:symbol:php:App\\Jobs\\Prune`;

  it('settles the shared handler edge by rule when dispatch sites disagree on transport', async () => {
    const entries = [
      dispatcher('Later', 'Prune::dispatch()'),
      dispatcher('Now', 'Prune::dispatchSync()'),
    ];
    const forwards = await extractOperational(entries);
    const reversed = await extractOperational([...entries].reverse());

    expect(forwards.edges).toContain(`${HANDLED} | async | tier 4`);
    expect(reversed).toEqual(forwards);
  });

  it('keeps the scheduler declaration over a dispatch-site inference', async () => {
    const entries = [KERNEL, dispatcher('Now', 'Prune::dispatchSync()')];
    const forwards = await extractOperational(entries);
    const reversed = await extractOperational([...entries].reverse());

    expect(forwards.boundaries).toContain(`${JOB} | - | tier 5`);
    expect(forwards.edges).toContain(`${HANDLED} | queue | tier 5`);
    expect(forwards.handlers).toContain(`oph:${JOB}:symbol:php:App\\Jobs\\Prune | tier 5`);
    expect(reversed).toEqual(forwards);

    // Nor does it matter which extractor runs first.
    const schedulerFirst = await extractOperational(entries, [
      new LaravelSchedulerExtractor(),
      new LaravelJobDispatchExtractor(),
    ]);
    const schedulerLast = await extractOperational(entries, [
      new LaravelJobDispatchExtractor(),
      new LaravelSchedulerExtractor(),
    ]);
    expect(schedulerFirst).toEqual(forwards);
    expect(schedulerLast).toEqual(forwards);
  });
});

describe('an extractor that emits one id for two declarations', () => {
  const unqualified = (files: string[]): OperationalExtractor => ({
    name: 'unqualified',
    supports: () => true,
    extract: () => {
      const batch = emptyOperationalBatch();
      for (const file of files) {
        batch.boundaries.push({
          id: 'opb:command:dup',
          repo_root: ROOT,
          kind: 'command',
          name: 'dup',
          trust_tier: 5,
          file_path: file,
        });
        batch.contracts.push({
          id: 'opc:opb:command:dup:signature',
          boundary_id: 'opb:command:dup',
          payload_schema: JSON.stringify({ from: file }),
          trust_tier: 5,
        });
      }
      return Promise.resolve(batch);
    },
  });

  it.each([
    ['in one order', ['b.php', 'a.php']],
    ['in the other order', ['a.php', 'b.php']],
  ])('names each id in a warning and stores one declaration by rule (%s)', async (_, files) => {
    const run = await extractOperational([KERNEL], [unqualified(files)]);

    expect(run.warnings).toEqual([
      'operational boundary opb:command:dup is declared in 2 files (a.php, b.php); ' +
        'one row cannot hold both, the declaration in a.php is stored.',
      'operational contract opc:opb:command:dup:signature was extracted with 2 different payloads; ' +
        'one row cannot hold them all, the first by text order is stored.',
    ]);
    expect(run.boundaries).toEqual(['opb:command:dup | a.php | tier 5']);
    expect(run.contracts).toEqual([
      { id: 'opc:opb:command:dup:signature', payload: { from: 'a.php' } },
    ]);
  });
});
