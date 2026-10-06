// Commit batching on the rebuild and sync paths (issue #15).
//
// Lux runs WASM SQLite under a rollback journal, so every write outside a transaction pays a full
// journal create/sync/delete — about 49 rows/s. The instrument here is the number of SQLite write
// transactions, counted as rollback-journal creations by a `node --import` preload in the real CLI
// subprocess. That count does not depend on how fast the machine is: a rebuild that commits per row
// produces more transactions for a larger repository, and one that batches produces the same number
// for any size. Bulk writes commit once per chunk (db/chunked-writes.ts), so the count is
// O(phases + rows / chunk); both fixture sizes fit in one chunk per phase, so the bound here is
// equality: each test indexes the same fixture shape at two sizes and requires equal counts.
// chunked-writes.test.ts covers the per-chunk term.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();
const JOURNAL_COUNTER = join(__dirname, 'fixtures', 'count-sqlite-journals.mjs');

const SMALL = 2;
const LARGE = 12;

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(repo: string, cmd: string): void {
  execSync(cmd, { cwd: repo, stdio: 'pipe' });
}

function write(repo: string, relPath: string, content: string): void {
  mkdirSync(dirname(join(repo, relPath)), { recursive: true });
  writeFileSync(join(repo, relPath), content);
}

/** A letters-only name for item `i`: the Laravel route detector does not match digits in class names. */
function letters(i: number): string {
  let name = '';
  for (let k = i + 1; k > 0; k = Math.floor((k - 1) / 26)) {
    name = String.fromCharCode(65 + ((k - 1) % 26)) + name;
  }
  return name;
}

/**
 * Write `n` copies of every kind of row a rebuild persists: markdown knowledge entries, TypeScript
 * modules that import each other across module boundaries (module dependencies, AST symbols, anchor
 * texts, structural edges), and Laravel routes, controllers, form requests and job dispatches
 * (capability surfaces, propagation, operational boundaries). `revision` changes every file's body
 * so a later sync re-derives all of them.
 */
function writeFixture(repo: string, n: number, revision: number): void {
  write(
    repo,
    'lux.yaml',
    'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: true\n  module_boundary: "src/Module/{name}"\n'
  );
  write(repo, 'package.json', JSON.stringify({ name: 'commit-batching-fixture' }));
  write(repo, 'composer.json', JSON.stringify({ name: 'fixture/app' }));

  const routes = ['<?php', '', 'use Illuminate\\Support\\Facades\\Route;'];
  for (let i = 0; i < n; i++) {
    write(repo, `docs/guide-${i}.md`, `# Guide ${i}\n\nRevision ${revision} of guide ${i}.\n`);

    const previous = i === 0 ? null : `M${i - 1}`;
    write(
      repo,
      `src/Module/M${i}/service.ts`,
      (previous ? `import { value${i - 1} } from '../${previous}/service.js';\n\n` : '') +
        `/** Service ${i}, revision ${revision}. */\n` +
        `export function value${i}(): number {\n` +
        `  return ${previous ? `value${i - 1}() + ` : ''}${revision};\n}\n\n` +
        `export class Widget${i} {\n  size(): number {\n    return value${i}();\n  }\n}\n`
    );

    write(
      repo,
      `app/Http/Controllers/Thing${letters(i)}Controller.php`,
      `<?php\n\nnamespace App\\Http\\Controllers;\n\n` +
        `use App\\Http\\Requests\\StoreThing${letters(i)}Request;\nuse App\\Jobs\\ProcessThing${letters(i)};\n\n` +
        `class Thing${letters(i)}Controller extends Controller\n{\n` +
        `    public function store(StoreThing${letters(i)}Request $request)\n    {\n` +
        `        ProcessThing${letters(i)}::dispatch($request->input('id'), ${revision});\n` +
        `        return response()->json(['ok' => true]);\n    }\n}\n`
    );
    write(
      repo,
      `app/Http/Requests/StoreThing${letters(i)}Request.php`,
      `<?php\n\nnamespace App\\Http\\Requests;\n\nuse Illuminate\\Foundation\\Http\\FormRequest;\n\n` +
        `class StoreThing${letters(i)}Request extends FormRequest\n{\n` +
        `    public function rules(): array\n    {\n        return ['id' => 'required|integer|min:${revision}'];\n    }\n}\n`
    );
    write(
      repo,
      `app/Jobs/ProcessThing${letters(i)}.php`,
      `<?php\n\nnamespace App\\Jobs;\n\nuse Illuminate\\Contracts\\Queue\\ShouldQueue;\n\n` +
        `class ProcessThing${letters(i)} implements ShouldQueue\n{\n` +
        `    public function handle(): void\n    {\n        // revision ${revision}\n    }\n}\n`
    );

    routes.push(`use App\\Http\\Controllers\\Thing${letters(i)}Controller;`);
  }
  routes.push('');
  for (let i = 0; i < n; i++) {
    routes.push(`Route::post('/things-${i}', [Thing${letters(i)}Controller::class, 'store']);`);
  }
  write(repo, 'routes/web.php', routes.join('\n') + '\n');
}

interface JournalCount {
  total: number;
  phases: Array<{ journals: number; endedBy: string }>;
}

function runCountingCli(repo: string, dbPath: string, args: string[]): JournalCount {
  const countFile = join(dirname(dbPath), `journals-${args.join('-')}.json`);
  const result = spawnSync(
    process.execPath,
    ['--import', JOURNAL_COUNTER, CLI_ENTRY, '--db', dbPath, '--corpus', repo, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        // An empty home has no cached embedding model or vendor pack, so the time-budgeted embed
        // tail and the pack merge stay out of the count.
        HOME: tempDir('lux-commit-batching-home-'),
        LUX_EMBEDDING_TOKEN: '',
        LUX_JOURNAL_COUNT_OUT: countFile,
      },
    }
  );
  expect(result.status, `${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(readFileSync(countFile, 'utf-8')) as JournalCount;
}

function describeCounts(small: JournalCount, large: JournalCount): string {
  const render = (label: string, c: JournalCount): string =>
    `${label}: ${c.total} transaction(s)\n` +
    c.phases.map((p) => `  ${String(p.journals).padStart(5)}  ${p.endedBy}`).join('\n');
  return `${render(`n=${SMALL}`, small)}\n${render(`n=${LARGE}`, large)}`;
}

/** Build a committed fixture of size `n` and return its repo + db paths. */
function fixture(n: number): { repo: string; dbPath: string } {
  const repo = tempDir('lux-commit-batching-repo-');
  const dbPath = join(tempDir('lux-commit-batching-db-'), 'lux.db');
  writeFixture(repo, n, 1);
  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name t');
  git(repo, 'git add -A');
  git(repo, 'git commit -q -m init');
  return { repo, dbPath };
}

describe('commit batching (issue #15)', () => {
  it('commits a cold rebuild in a number of transactions that does not grow with the repository', () => {
    const small = fixture(SMALL);
    const large = fixture(LARGE);

    const smallCount = runCountingCli(small.repo, small.dbPath, ['index', 'rebuild']);
    const largeCount = runCountingCli(large.repo, large.dbPath, ['index', 'rebuild']);

    expect(largeCount.total, describeCounts(smallCount, largeCount)).toBe(smallCount.total);
  }, 120_000);

  it('commits a sync that re-derives every file in a number of transactions that does not grow with the repository', () => {
    const counts = [SMALL, LARGE].map((n) => {
      const { repo, dbPath } = fixture(n);
      runCountingCli(repo, dbPath, ['index', 'rebuild']);
      writeFixture(repo, n, 2);
      git(repo, 'git add -A');
      git(repo, 'git commit -q -m revise');
      return runCountingCli(repo, dbPath, ['index', 'sync']);
    });

    expect(counts[1].total, describeCounts(counts[0], counts[1])).toBe(counts[0].total);
  }, 120_000);

  it('commits a content-only sync in a number of transactions that does not grow with the repository', () => {
    const counts = [SMALL, LARGE].map((n) => {
      const { repo, dbPath } = fixture(n);
      runCountingCli(repo, dbPath, ['index', 'rebuild']);
      for (let i = 0; i < n; i++) {
        if (i % 2 === 0) rmSync(join(repo, `docs/guide-${i}.md`));
        else write(repo, `docs/guide-${i}.md`, `# Guide ${i}\n\nRevision 2 of guide ${i}.\n`);
      }
      git(repo, 'git add -A');
      git(repo, 'git commit -q -m revise-docs');
      return runCountingCli(repo, dbPath, ['index', 'sync']);
    });

    expect(counts[1].total, describeCounts(counts[0], counts[1])).toBe(counts[0].total);
  }, 120_000);
});
