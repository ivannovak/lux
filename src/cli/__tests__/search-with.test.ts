// `lux search --with` (spec 13C / T2.4 / Decisions 5,6 / SC-5,9). Opt-in federation: repo-grouped,
// independently-ranked result groups; --json carries the federation block. An unresolvable sibling
// warns + the query still answers. The single-repo path is untouched (covered by
// federation-regression.test.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(corpus: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: corpus,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

function addDoc(db: LuxDatabase, title: string, path: string, content: string): void {
  db.insertKnowledgeEntry({ type: 'documentation', title, file_path: path, content });
}

let root: string;
let corpus: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-search-with-'));
  corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });

  const primary = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
  addDoc(primary, 'Client Settlement Notes', 'docs/settlement.md', 'settlement in the client');
  primary.close();

  const kernelDir = join(root, 'core');
  const siblingDbPath = join(kernelDir, '.lux', 'lux.db');
  const kernel = new LuxDatabase(siblingDbPath);
  addDoc(kernel, 'Kernel Settlement Engine', 'docs/engine.md', 'settlement engine internals');
  kernel.close();

  writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  core:\n    db: ${siblingDbPath}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lux search --with', () => {
  it('returns repo-grouped groups with the federation block (--json, SC-5/SC-9)', () => {
    const res = runCli(corpus, [
      '--corpus',
      corpus,
      'search',
      'settlement',
      '--with',
      'core',
      '--json',
    ]);
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as {
      groups: Array<{ repo: string; results: Array<{ path: string }> }>;
      federation: { siblings: Array<{ name: string; attached: boolean }> };
    };
    expect(result.groups.map((g) => g.repo)).toEqual(['main', 'core']);
    expect(result.groups[0].results[0].path).toBe('docs/settlement.md');
    expect(result.groups[1].results[0].path).toBe('docs/engine.md');
    expect(result.federation.siblings[0]).toMatchObject({ name: 'core', attached: true });
  });

  it('renders repo-grouped text output', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'search', 'settlement', '--with', 'core']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[main]');
    expect(res.stdout).toContain('[core]');
    expect(res.stdout).toContain('docs/engine.md');
  });

  it('warns on an unresolvable sibling and still answers the main group (Decision 6)', () => {
    const res = runCli(corpus, [
      '--corpus',
      corpus,
      'search',
      'settlement',
      '--with',
      'ghost',
      '--json',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('ghost');
    const result = JSON.parse(res.stdout) as {
      groups: Array<{ repo: string }>;
      federation: { siblings: Array<{ name: string; attached: boolean }> };
    };
    expect(result.groups[0].repo).toBe('main');
    expect(result.federation.siblings.find((s) => s.name === 'ghost')).toMatchObject({
      attached: false,
    });
  });

  it('honors --json on the single-repo path (no --with) — SearchReportV1 envelope (supersedes FIX 4)', () => {
    // Retrieval-lexical L0 upgrades the single-repo `--json` from FIX-4's plain array to the frozen
    // schemaVersion:1 SearchReportV1 envelope (spec 12), in lockstep with the MCP single-repo shape.
    const hit = runCli(corpus, ['--corpus', corpus, 'search', 'settlement', '--json']);
    expect(hit.status).toBe(0);
    const report = JSON.parse(hit.stdout) as {
      schemaVersion: number;
      surface: string;
      type: string;
      contentOnly: boolean;
      limit: number;
      results: Array<{ entryType: string; title: string; filePath: string; rank: number }>;
      refusal?: unknown;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.surface).toBe('search');
    expect(report.refusal).toBeUndefined();
    const hitRow = report.results.find((r) => r.filePath === 'docs/settlement.md');
    expect(hitRow).toMatchObject({ entryType: 'documentation', title: 'Client Settlement Notes' });
    expect(hitRow!.rank).toBeLessThan(0); // real bm25, not the old rank:0 lie

    const miss = runCli(corpus, ['--corpus', corpus, 'search', 'zzznotfoundzzz', '--json']);
    expect(miss.status).toBe(0);
    const missReport = JSON.parse(miss.stdout) as { results: unknown[]; refusal?: unknown };
    expect(missReport.results).toEqual([]);
    expect(missReport.refusal).toBeUndefined(); // honest zero-result, NOT a refusal
  });

  it('refuses a federated invalid query with exit 1 + a refusal block, not a fabricated all-empty (M1)', () => {
    // `nosuchcol:settlement` is an FTS5 no-such-column QUERY error — it fails identically for main and
    // every sibling. Pre-fix this returned all-empty groups + a valid federation block + exit 0 (the
    // exact fabricated-empty the single-repo path refuses). It must now refuse like single-repo.
    const res = runCli(corpus, [
      '--corpus',
      corpus,
      'search',
      'nosuchcol:settlement',
      '--with',
      'core',
      '--json',
    ]);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as {
      results: unknown[];
      refusal?: { reason: string; expression: string };
    };
    expect(report.refusal?.reason).toBe('invalid-query');
    expect(report.refusal?.expression).toBe('nosuchcol:settlement');
    expect(report.results).toEqual([]);
  });

  it('echoes the offending expression on a federated invalid query (text mode, exit 1)', () => {
    const res = runCli(corpus, [
      '--corpus',
      corpus,
      'search',
      'nosuchcol:settlement',
      '--with',
      'core',
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('FTS5 expression: nosuchcol:settlement');
  });

  it('federated search remains read-only and reports telemetry omission', () => {
    const dbPath = join(corpus, '.lux', 'lux.db');
    const beforeDb = new LuxDatabase(dbPath);
    const before = beforeDb.getRecentEvents(10).length;
    beforeDb.close();

    const res = runCli(corpus, [
      '--corpus',
      corpus,
      'search',
      'settlement',
      '--with',
      'core',
      '--json',
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).telemetry).toEqual({
      recorded: false,
      reason: 'read-only-index',
    });

    const db = new LuxDatabase(dbPath);
    expect(db.getRecentEvents(10)).toHaveLength(before);
    db.close();
  });
});
