// `lux search` structured refusals + usage errors end-to-end (spec 11, D3/D5, SC-3/SC-4). Exercises
// the CLI exit-code contract and the SearchReportV1 refusal envelope over the real built action:
//   invalid FTS5 syntax → exit 1 invalid-query · missing/dropped FTS table → exit 1 fts-unavailable
//   (the B.0 prepare-time open guard) · unknown --type / bad --limit → exit 2 · genuine zero → exit 0.
// A refusal never prints "No results found"; a zero-result never carries a refusal.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(corpus: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: corpus,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

let root: string;
let corpus: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-search-refusals-'));
  corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });
  dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath);
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Settlement Notes',
    file_path: 'docs/settlement.md',
    content: 'settlement clearing and netting',
  });
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lux search refusals + usage errors (SC-3)', () => {
  it('invalid FTS5 query → exit 1, invalid-query refusal, expression echoed, no crash', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'search', '"unterminated phrase', '--json']);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe(''); // clean: no node-sqlite3-wasm dump at close
    const report = JSON.parse(res.stdout) as {
      results: unknown[];
      refusal?: { reason: string; expression: string };
    };
    expect(report.results).toEqual([]);
    expect(report.refusal?.reason).toBe('invalid-query');
    expect(report.refusal?.expression).toBe('"unterminated phrase');
  });

  it('invalid FTS5 query (text) → exit 1 and never prints "No results found"', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'search', '"unterminated phrase']);
    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain('No results found');
    expect(res.stderr).toContain('Invalid FTS5 query');
  });

  it('missing/dropped FTS table → exit 1 db-unreadable before the query runs', () => {
    const raw = new LuxSqlite(dbPath);
    raw.exec('DROP TABLE IF EXISTS knowledge_entries_fts;');
    raw.close();
    const res = runCli(corpus, ['--corpus', corpus, 'search', 'settlement', '--json']);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout) as {
      refusal?: string;
      telemetry?: { recorded: boolean };
    };
    expect(report.refusal).toBe('db-unreadable');
    expect(report.telemetry?.recorded).toBe(false);
  });

  it('unknown --type → exit 2 usage error (not a fabricated empty answer)', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'search', 'settlement', '--type', 'bogus']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--type must be 'all' or 'knowledge'");
  });

  it('NaN --limit → exit 2 usage error', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'search', 'settlement', '--limit', 'abc']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--limit must be a positive integer');
  });

  it('genuine zero-result → exit 0 without mutating usage events', () => {
    const beforeDb = new LuxDatabase(dbPath);
    const before = beforeDb.getRecentEvents(20).length;
    beforeDb.close();
    const res = runCli(corpus, ['--corpus', corpus, 'search', 'zzznomatchzzz']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No results found');
    const db = new LuxDatabase(dbPath);
    try {
      expect(db.getRecentEvents(20)).toHaveLength(before);
    } finally {
      db.close();
    }
  });

  it('a refusal is returned without recording a usage event', () => {
    const beforeDb = new LuxDatabase(dbPath);
    const before = beforeDb.getRecentEvents(20).length;
    beforeDb.close();
    const result = runCli(corpus, ['--corpus', corpus, 'search', '"unterminated phrase', '--json']);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      refusal?: { reason: string };
      telemetry?: { recorded: boolean; reason: string };
    };
    expect(report.refusal?.reason).toBe('invalid-query');
    expect(report.telemetry).toEqual({ recorded: false, reason: 'read-only-index' });
    const db = new LuxDatabase(dbPath);
    try {
      expect(db.getRecentEvents(20)).toHaveLength(before);
    } finally {
      db.close();
    }
  });
});
