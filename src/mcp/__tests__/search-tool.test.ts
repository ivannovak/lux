// MCP `lux_search` CallTool HANDLER, end-to-end over the wire against the BUILT server (as
// federation-params.test.ts / delta-tool.test.ts do). The prior suite only called
// db.searchDocumentsRanked, never the registered handler — so the shape change (array→SearchReportV1),
// the SearchRefusalError→isError:true+refusal mapping, the content_only/snippets plumbing, and the
// M2 limit coercion had NO handler-level assertion (M3). This closes that gap.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LuxDatabase } from '../../db/index.js';
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

/** A primary corpus with a couple of `settlement` hits + one term that lives ONLY in a title. */
function makeFixture(root: string): { corpus: string; dbPath: string } {
  const corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });
  const dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath);
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Client Settlement Notes',
    file_path: 'docs/settlement.md',
    content: 'settlement in the client is cleared and netted',
  });
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Settlement Ledger',
    file_path: 'docs/ledger.md',
    content: 'the settlement ledger records every settlement',
  });
  // `Zzquux` appears ONLY in the title → a content_only search must NOT find it.
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Zzquux Report',
    file_path: 'docs/zzquux.md',
    content: 'this body has no such token',
  });
  db.close();
  return { corpus, dbPath };
}

interface SearchReport {
  schemaVersion: number;
  surface: string;
  limit: number;
  results: Array<{ filePath: string; entryType: string; rank: number; snippet?: string }>;
  refusal?: { reason: string; expression: string };
}

function parse(res: unknown): SearchReport {
  const content = (res as { content: Array<{ type: string; text: string }> }).content[0];
  return JSON.parse(content.text) as SearchReport;
}

describe('MCP lux_search handler (over the wire)', () => {
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-search-tool-'));
    const fx = makeFixture(root);
    client = new Client({ name: 'search-tool-test', version: '0.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: fx.corpus, LUX_DB_PATH: fx.dbPath },
      stderr: 'ignore',
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('(a) answers with a SearchReportV1 envelope carrying filePath/entryType/rank (real bm25)', async () => {
    const res = await client.callTool({ name: 'lux_search', arguments: { query: 'settlement' } });
    expect(res.isError).toBeFalsy();
    const report = parse(res);
    expect(report.schemaVersion).toBe(1);
    expect(report.surface).toBe('search');
    expect(report.refusal).toBeUndefined();
    const hit = report.results.find((r) => r.filePath === 'docs/settlement.md');
    expect(hit).toBeDefined();
    expect(hit!.entryType).toBe('documentation');
    expect(typeof hit!.rank).toBe('number');
    expect(hit!.rank).toBeLessThan(0); // real negative bm25, never the old rank:0 lie
  });

  it('(b) refuses an invalid query with isError:true + refusal.reason (not a fabricated empty)', async () => {
    const res = await client.callTool({
      name: 'lux_search',
      arguments: { query: 'nosuchcol:settlement' },
    });
    expect(res.isError).toBe(true);
    const report = parse(res);
    expect(report.refusal?.reason).toBe('invalid-query');
    expect(report.refusal?.expression).toBe('nosuchcol:settlement');
    expect(report.results).toEqual([]);
  });

  it('(c) plumbs content_only through (a title-only term is not found when scoped to content)', async () => {
    const unscoped = parse(
      await client.callTool({ name: 'lux_search', arguments: { query: 'Zzquux' } })
    );
    expect(unscoped.results.some((r) => r.filePath === 'docs/zzquux.md')).toBe(true);

    const scoped = parse(
      await client.callTool({
        name: 'lux_search',
        arguments: { query: 'Zzquux', content_only: true },
      })
    );
    expect(scoped.results).toEqual([]); // term lives only in the title → content scope excludes it
  });

  it('(c) plumbs snippets through (a query-centered <mark> snippet per result)', async () => {
    const report = parse(
      await client.callTool({
        name: 'lux_search',
        arguments: { query: 'settlement', snippets: true },
      })
    );
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results[0].snippet).toContain('<mark>settlement</mark>');
  });

  it('(d) coerces a negative limit to the default — no whole-corpus/unbounded dump (guards M2)', async () => {
    const report = parse(
      await client.callTool({
        name: 'lux_search',
        arguments: { query: 'settlement', limit: -1 },
      })
    );
    // The envelope echoes the APPLIED limit: a raw `-1` (unbounded `LIMIT -1`) never reaches SQL —
    // it is coerced to the default 20 before searchDocumentsRanked runs.
    expect(report.limit).toBe(20);
    expect(report.refusal).toBeUndefined();
    // Only the two `settlement` bodies match — a coerced search returns the matching set, bounded.
    expect(report.results.every((r) => r.filePath.startsWith('docs/'))).toBe(true);
    expect(report.results.length).toBeLessThanOrEqual(20);
  });
});
