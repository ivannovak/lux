// Shared harness for the scoped-sync equivalence tests: build a fixture git repository, drive the
// real CLI, and compare two index databases row by row.
//
// The comparison is the standard a scoped sync is held to: after syncing A→B, the index states the
// same facts as a cold rebuild of B. Columns that legitimately differ between any two runs are
// excluded or normalized here, and each exclusion is listed in INDEX_COMPARISON_EXCLUSIONS so a
// reader can see exactly what the comparison does not look at.

import { execSync, spawnSync, type SpawnSyncReturns } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LuxSqlite } from '../../db/sqlite-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');
export const FAKE_LSP_SERVER = join(
  PROJECT_ROOT,
  'src',
  'scanner',
  '__tests__',
  'fixtures',
  'fake-lsp-server.mjs'
);

export const INDEX_COMPARISON_EXCLUSIONS = [
  'wall-clock columns (created_at, updated_at, recorded_at, timestamp, spawned_at, last_active_at)',
  'INTEGER autoincrement id columns',
  'wall-clock keys inside JSON values (extractedAt, enrichedAt, recordedAt, builtAt)',
  'structural_edges.source_commit: a scoped refresh stamps HEAD on the tiers it re-derives (SC-8)',
  'tables that record activity, not facts: events, experts, expert_sessions',
  'structural_node_embeddings: the embed pass is budgeted and resumes on the next run',
  'index_metadata: compared through overlay_trust_state only, minus recordedAt/sourceAction',
  'module_dependencies.sample_files: compared as a set (order is scan order)',
] as const;

const DROPPED_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'recorded_at',
  'timestamp',
  'spawned_at',
  'last_active_at',
]);
const VOLATILE_JSON_KEYS = new Set(['extractedAt', 'enrichedAt', 'recordedAt', 'builtAt']);
const FACT_TABLES = [
  'knowledge_entries',
  'module_dependencies',
  'structural_nodes',
  'structural_edges',
  'edge_evidence',
  'operational_boundaries',
  'operational_handlers',
  'operational_edges',
  'operational_contracts',
  'structural_node_texts',
] as const;

export type IndexDump = Map<string, string[]>;

export interface TableDifference {
  table: string;
  onlyInExpected: string[];
  onlyInActual: string[];
}

export function git(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

export function writeTree(repo: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(repo, rel);
    if (content === null) {
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export function commitAll(repo: string, message: string): string {
  git(repo, 'git add -A');
  git(repo, `git commit -q --allow-empty -m ${JSON.stringify(message)}`);
  return git(repo, 'git rev-parse HEAD');
}

export function initRepo(repo: string): void {
  git(repo, 'git init -q');
  git(repo, 'git config user.email a@b.c');
  git(repo, 'git config user.name x');
}

export function runCli(
  repo: string,
  dbPath: string,
  args: string[],
  env: Record<string, string> = {}
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI_ENTRY, '--db', dbPath, '--corpus', repo, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    }
  );
}

function scrubJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_JSON_KEYS.has(key)) continue;
      out[key] = scrubJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function normalizeText(value: string, root: string): string {
  const rooted = value.split(root).join('<ROOT>');
  const trimmed = rooted.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(scrubJson(JSON.parse(rooted)));
    } catch {
      return rooted;
    }
  }
  return rooted;
}

/** Dump every fact table of an index as sorted, normalized row strings. */
export function dumpIndex(dbPath: string, root: string): IndexDump {
  const db = new LuxSqlite(dbPath, { readonly: true, fileMustExist: true });
  const dump: IndexDump = new Map();
  try {
    for (const table of FACT_TABLES) {
      const columns = (
        db.all(`PRAGMA table_info(${table})`) as Array<{ name: string; type: string }>
      ).filter(
        (c) =>
          !DROPPED_COLUMNS.has(c.name) &&
          !(c.name === 'id' && c.type.toUpperCase() === 'INTEGER') &&
          !(table === 'structural_edges' && c.name === 'source_commit')
      );
      const rows = db.all(`SELECT ${columns.map((c) => c.name).join(', ')} FROM ${table}`) as Array<
        Record<string, unknown>
      >;
      dump.set(
        table,
        rows
          .map((row) =>
            columns
              .map((c) => {
                let value = row[c.name];
                if (table === 'module_dependencies' && c.name === 'sample_files') {
                  value = JSON.stringify(
                    (JSON.parse(String(value ?? '[]')) as string[])
                      .map((s) => s.split(root).join('<ROOT>'))
                      .sort()
                  );
                } else if (typeof value === 'string') {
                  value = normalizeText(value, root);
                }
                return `${c.name}=${value === null || value === undefined ? '<NULL>' : String(value)}`;
              })
              .join(' | ')
          )
          .sort()
      );
    }
    const trust = db.get(`SELECT value FROM index_metadata WHERE key = 'overlay_trust_state'`) as
      { value: string } | undefined;
    const state = trust ? (JSON.parse(trust.value) as Record<string, unknown>) : {};
    delete state.recordedAt;
    delete state.sourceAction;
    dump.set('overlay_trust_state', [normalizeText(JSON.stringify(state), root)]);
  } finally {
    db.close();
  }
  return dump;
}

/** Multiset difference per table: rows the expected index has and the actual lacks, and vice versa. */
export function diffIndexes(expected: IndexDump, actual: IndexDump): TableDifference[] {
  const differences: TableDifference[] = [];
  for (const [table, expectedRows] of expected) {
    const remaining = new Map<string, number>();
    for (const row of actual.get(table) ?? []) remaining.set(row, (remaining.get(row) ?? 0) + 1);
    const onlyInExpected: string[] = [];
    for (const row of expectedRows) {
      const count = remaining.get(row) ?? 0;
      if (count > 0) remaining.set(row, count - 1);
      else onlyInExpected.push(row);
    }
    const onlyInActual: string[] = [];
    for (const [row, count] of remaining) for (let i = 0; i < count; i++) onlyInActual.push(row);
    if (onlyInExpected.length || onlyInActual.length) {
      differences.push({ table, onlyInExpected, onlyInActual });
    }
  }
  return differences;
}

/** Restrict a dump to rows matching a predicate, per table (for per-defect assertions). */
export function selectRows(dump: IndexDump, table: string, predicate: (row: string) => boolean) {
  return (dump.get(table) ?? []).filter(predicate);
}

export function formatDifferences(differences: TableDifference[], limit = 8): string {
  return differences
    .map(
      (d) =>
        `${d.table}: ${d.onlyInExpected.length} only in cold rebuild, ${d.onlyInActual.length} only in scoped sync\n` +
        d.onlyInExpected
          .slice(0, limit)
          .map((r) => `  - ${r.slice(0, 400)}`)
          .join('\n') +
        '\n' +
        d.onlyInActual
          .slice(0, limit)
          .map((r) => `  + ${r.slice(0, 400)}`)
          .join('\n')
    )
    .join('\n');
}
