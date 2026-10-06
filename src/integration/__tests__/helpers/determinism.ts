// Helpers for the cold-rebuild determinism test: a fixture repository built to expose every
// order-dependent stage, a normalized dump of the index tables, and the --json command battery.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LuxDatabase } from '../../../db/index.js';
import type { EdgeType, StructuralEdge, StructuralNode } from '../../../db/types.js';
import { LuxSqlite } from '../../../db/sqlite-adapter.js';
import { SCAN_ORDER_SEED_ENV } from '../../../scanner/scan-order.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

/** Columns that hold wall-clock time; they are the only values allowed to differ between runs. */
const TIMESTAMP_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'recorded_at',
  'timestamp',
  'spawned_at',
  'last_active_at',
]);

/** JSON keys that hold wall-clock time in command output and stored metadata. */
const TIMESTAMP_KEYS = new Set(['recordedAt', 'enrichedAt', 'indexedAt', 'updatedAt']);

/** Every table a rebuild writes. `events` is an append-only log and is compared by count only. */
export const DETERMINISM_TABLES = [
  'knowledge_entries',
  'index_metadata',
  'module_dependencies',
  'structural_nodes',
  'structural_edges',
  'edge_evidence',
  'operational_boundaries',
  'operational_handlers',
  'operational_edges',
  'operational_contracts',
  'structural_node_texts',
  'structural_node_embeddings',
];

/** The renderer-facing commands whose --json output must be byte-identical after normalization. */
export const DETERMINISM_COMMANDS: Record<string, string[]> = {
  'deps-graph': ['deps', 'graph', '--json'],
  'deps-clusters': ['deps', 'clusters', '--json'],
  'boundaries-show': ['overlay', 'boundaries', 'show', '--json'],
  'boundaries-regions': ['overlay', 'boundaries', 'list-regions', '--json'],
  'boundaries-families': ['overlay', 'boundaries', 'list-families', '--json'],
  'overlay-ownership': ['overlay', 'ownership', '--json'],
  'overlay-status': ['overlay', 'status', '--json'],
  'index-status': ['index', 'status', '--json'],
};

function write(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function service(module: string, name: string, body: string): string {
  return (
    `<?php\n\nnamespace App\\Module\\${module}\\Services;\n\n` +
    `class ${name}\n{\n    public function run(): float\n    {\n        return ${body};\n    }\n}\n`
  );
}

function consumer(module: string, name: string, uses: Array<[string, string]>): string {
  const imports = uses.map(([m, s]) => `use App\\Module\\${m}\\Services\\${s};`).join('\n');
  const params = uses.map(([, s]) => `${s} $${s.charAt(0).toLowerCase()}${s.slice(1)}`);
  const calls = uses.map(([, s]) => `$this->${s.charAt(0).toLowerCase()}${s.slice(1)}->run()`);
  const props = uses
    .map(([, s]) => `    private ${s} $${s.charAt(0).toLowerCase()}${s.slice(1)};`)
    .join('\n');
  const assigns = uses
    .map(([, s]) => {
      const v = `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
      return `        $this->${v} = $${v};`;
    })
    .join('\n');
  return (
    `<?php\n\nnamespace App\\Module\\${module}\\Http\\Controllers;\n\n${imports}\n` +
    `use App\\Shared\\Duplicate;\n\n` +
    `class ${name}\n{\n${props}\n\n    public function __construct(${params.join(', ')})\n    {\n` +
    `${assigns}\n    }\n\n    public function __invoke(): float\n    {\n` +
    `        (new Duplicate())->handle();\n` +
    uses.map(([, s]) => `        (new ${s}())->run();\n`).join('') +
    `        return ${calls.join(' + ')};\n    }\n}\n`
  );
}

/**
 * Write the fixture repository. It contains, on purpose:
 *  - two files that declare the same global function and two that declare the same class, so
 *    their node ids collide (`symbol:php:module_helper`, `symbol:php:App\Shared\Duplicate`);
 *  - module dependencies that all carry one reference, so every ordering of them is a tie;
 *  - cross-module edges whose boundary weights are non-terminating binary fractions, so their sum
 *    depends on summation order;
 *  - more source files per module pair than the sample size, so sample selection has a choice.
 */
export function writeDeterminismFixture(root: string): void {
  write(
    root,
    'lux.yaml',
    [
      'lsp:',
      '  enabled: false',
      `  workspace_root: ${root}`,
      'deps:',
      '  enabled: true',
      '  module_boundary: "src/Module/{name}"',
      '',
    ].join('\n')
  );
  write(
    root,
    'composer.json',
    JSON.stringify({ name: 'fixture/app', autoload: { 'psr-4': { 'App\\': 'src/' } } }, null, 2)
  );
  write(root, 'README.md', '# Determinism fixture\n');
  // lux.yaml carries the absolute workspace root, so it stays out of the commit (as a real
  // checkout's would): both copies then share one HEAD while their configs differ by path.
  write(root, '.gitignore', 'lux.yaml\n.lux/\n');

  const modules = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  for (const module of modules) {
    write(
      root,
      `src/Module/${module}/Services/${module}Service.php`,
      service(module, `${module}Service`, '0.1')
    );
    write(root, `src/Module/${module}/readme.md`, `# ${module}\n`);
  }

  // Every module consumes every other module through 6 to 10 controllers. The reference counts
  // repeat across pairs (ties), the supporting weights derived from them are distinct
  // non-terminating fractions (order-sensitive sums), and every pair has more candidate files
  // than a sample holds.
  for (let i = 0; i < modules.length; i++) {
    for (let j = 0; j < modules.length; j++) {
      if (i === j) continue;
      const consumers = 6 + ((i + j) % 3);
      for (let k = 1; k <= consumers; k++) {
        const name = `${modules[j]}Consumer${k}Controller`;
        write(
          root,
          `src/Module/${modules[i]}/Http/Controllers/${name}.php`,
          consumer(modules[i], name, [[modules[j], `${modules[j]}Service`]])
        );
      }
    }
  }

  // Same global function in two files: no namespace, so both ids are `symbol:php:module_helper`.
  for (const module of ['Alpha', 'Beta']) {
    write(
      root,
      `src/Module/${module}/config/aliases.php`,
      `<?php\n\nfunction module_helper(): string\n{\n    return '${module}';\n}\n\n$aliases = [module_helper()];\n`
    );
  }

  // Same class FQCN in two files.
  for (const module of ['Gamma', 'Delta']) {
    write(
      root,
      `src/Module/${module}/Legacy/Duplicate.php`,
      `<?php\n\nnamespace App\\Shared;\n\nclass Duplicate\n{\n    public function handle(): string\n    {\n        return '${module}';\n    }\n}\n`
    );
  }

  write(
    root,
    'routes/api.php',
    `<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n` +
      modules
        .map(
          (m) =>
            `use App\\Module\\${m}\\Http\\Controllers\\${modules[(modules.indexOf(m) + 1) % modules.length]}Consumer1Controller as ${m}Entry;`
        )
        .join('\n') +
      '\n\n' +
      modules
        .map((m) => `Route::get('/${m.toLowerCase()}', ${m}Entry::class)->name('${m}.entry');`)
        .join('\n') +
      '\n'
  );

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root, env });
}

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI from source against one corpus/db, optionally under a scan-order seed. HOME points
 * at `home` so the run sees no cached vendor pack and no cached embedding model: both are machine
 * state, and the test pins the inputs to the commit and the config.
 */
export function runLux(
  corpus: string,
  db: string,
  home: string,
  args: string[],
  seed?: string
): CliRun {
  const env: typeof process.env = {
    ...process.env,
    HOME: home,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  delete env[SCAN_ORDER_SEED_ENV];
  if (seed !== undefined) env[SCAN_ORDER_SEED_ENV] = seed;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI_ENTRY, '--db', db, '--corpus', corpus, ...args],
    { cwd: PROJECT_ROOT, encoding: 'utf-8', env }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function replaceRoot(value: string, root: string): string {
  return value.split(root).join('<ROOT>');
}

function normalizeJson(value: unknown, root: string): unknown {
  if (typeof value === 'string') return replaceRoot(value, root);
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, root));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = TIMESTAMP_KEYS.has(key)
        ? '<TIMESTAMP>'
        : normalizeJson((value as Record<string, unknown>)[key], root);
    }
    return out;
  }
  return value;
}

/** A text value that holds JSON is normalized as JSON, so embedded timestamps are masked too. */
function normalizeCell(value: unknown, root: string): unknown {
  if (typeof value !== 'string')
    return value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
  const trimmed = value.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return normalizeJson(JSON.parse(value), root);
    } catch {
      // Not JSON after all — fall through to plain text.
    }
  }
  return replaceRoot(value, root);
}

/**
 * Dump every rebuild-written table as sorted lines. Dropped: wall-clock columns and INTEGER
 * autoincrement ids (insertion-order artifacts). The clone root is replaced by `<ROOT>`.
 */
export function dumpTables(dbPath: string, root: string): Record<string, string[]> {
  const db = new LuxSqlite(dbPath, { readonly: true });
  try {
    const out: Record<string, string[]> = {};
    for (const table of DETERMINISM_TABLES) {
      const columns = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>
      )
        .filter((c) => !TIMESTAMP_COLUMNS.has(c.name))
        .filter((c) => !(c.name === 'id' && c.type.toUpperCase() === 'INTEGER'))
        .map((c) => c.name);
      const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Array<
        Record<string, unknown>
      >;
      out[table] = rows
        .map((row) =>
          JSON.stringify(Object.fromEntries(columns.map((c) => [c, normalizeCell(row[c], root)])))
        )
        .sort();
    }
    out.events = [
      String((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n),
    ];
    return out;
  } finally {
    db.close();
  }
}

/** Run the --json battery, keyed by command name. */
export function runBattery(corpus: string, db: string, home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(DETERMINISM_COMMANDS)) {
    out[name] = runCommand(corpus, db, home, name);
  }
  return out;
}

/** One battery command: its exit code plus its normalized, key-sorted output. */
export function runCommand(corpus: string, db: string, home: string, name: string): string {
  const run = runLux(corpus, db, home, DETERMINISM_COMMANDS[name]);
  let body: string;
  try {
    body = JSON.stringify(normalizeJson(JSON.parse(run.stdout), corpus), null, 1);
  } catch {
    body = `<non-json stdout>\n${replaceRoot(run.stdout, corpus)}`;
  }
  return `exit=${run.status}\n${body}`;
}

/** Line-level differences between two dumps, for a readable assertion message. */
export function diffDumps(
  left: Record<string, string[]>,
  right: Record<string, string[]>
): string[] {
  const problems: string[] = [];
  for (const table of Object.keys(left)) {
    const a = new Set(left[table]);
    const b = new Set(right[table] ?? []);
    const onlyLeft = left[table].filter((row) => !b.has(row));
    const onlyRight = (right[table] ?? []).filter((row) => !a.has(row));
    if (left[table].length !== (right[table] ?? []).length || onlyLeft.length || onlyRight.length) {
      problems.push(
        `${table}: ${left[table].length} vs ${(right[table] ?? []).length} rows, ` +
          `${onlyLeft.length} only in run 1, ${onlyRight.length} only in run 2` +
          [...onlyLeft.slice(0, 3).map((r) => `\n  - ${r.slice(0, 300)}`)].join('') +
          [...onlyRight.slice(0, 3).map((r) => `\n  + ${r.slice(0, 300)}`)].join('')
      );
    }
  }
  return problems;
}

/**
 * Write one fixed set of index rows, forward or reversed. Every ordering the read commands apply
 * meets a tie in it: equal reference counts, equal-weight boundary relationships, regions and
 * families with equal totals, ownership groups of equal size. Each cross-module pair carries edges
 * of several types with distinct weights, families and confidences, so the order paths are visited
 * in shows up in the summed weights, the family list and the chosen samples.
 */
export function writeOrderedRows(db: LuxDatabase, reverse: boolean): void {
  const modules = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const types: Array<[EdgeType, number]> = [
    ['emits_event', 0.7],
    ['binds_service', 0.9],
    ['imports_pipeline_artifact', 0.8],
    ['consumes_reporting_source', 0.6],
    ['subscribes_event', 0.75],
    ['validates_contract_family', 0.65],
  ];
  const nodes: StructuralNode[] = [];
  const edges: StructuralEdge[] = [];
  const deps: Array<{ source: string; target: string; count: number }> = [];
  for (const module of modules) {
    for (let k = 0; k < types.length; k++) {
      const filePath = `src/Module/${module}/Part${k}.php`;
      nodes.push({
        id: `file:${filePath}`,
        node_type: 'file',
        file_path: filePath,
        language_id: 'php',
        updated_at: 1,
      });
    }
  }
  for (const source of modules) {
    for (const target of modules) {
      if (source === target) continue;
      for (const [k, [edgeType, confidence]] of types.entries()) {
        const from = `file:src/Module/${source}/Part${k}.php`;
        const to = `file:src/Module/${target}/Part${(k + 1) % types.length}.php`;
        edges.push({
          id: `${from}→${to}:${edgeType}`,
          source_node_id: from,
          target_node_id: to,
          edge_type: edgeType,
          confidence,
          confidence_class: 'framework-inferred',
          freshness_status: 'fresh',
          dirty_dependency_count: 0,
          updated_at: 1,
        });
      }
      deps.push({ source, target, count: 3 });
    }
  }
  for (let i = 0; i < 4; i++) {
    const surface = `surface:http:GET:/route-${i}`;
    nodes.push({
      id: surface,
      node_type: 'capability-surface',
      file_path: 'routes/api.php',
      language_id: 'http',
      updated_at: 1,
    });
    edges.push({
      id: `${surface}→file:src/Module/Alpha/Part0.php:handled_by`,
      source_node_id: surface,
      target_node_id: 'file:src/Module/Alpha/Part0.php',
      edge_type: 'handled_by',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: 1,
    });
  }
  const order = <T>(items: T[]): T[] => (reverse ? [...items].reverse() : items);
  db.transaction(() => {
    for (const node of order(nodes)) db.upsertStructuralNode(node);
    for (const edge of order(edges)) db.upsertStructuralEdge(edge);
    for (const dep of order(deps)) {
      db.insertModuleDependency({
        source_module: dep.source,
        target_module: dep.target,
        reference_count: dep.count,
        sample_files: JSON.stringify([]),
      });
    }
  });
  const handlerEdges = edges.filter((edge) => edge.edge_type === 'handled_by');
  db.setEdgeOwnershipBatch(
    order(
      handlerEdges.map((edge, index) => ({
        id: edge.id,
        ownership: index % 2 === 0 ? 'kernel-owned' : 'client-override',
      }))
    )
  );
}
