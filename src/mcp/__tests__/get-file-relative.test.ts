// Over the wire: Lux reports corpus-relative paths, and `lux_get_file` reads a file named that way
// whatever directory the server process runs in (issue #16).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LuxDatabase } from '../../db/index.js';
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

describe('MCP paths are corpus-relative (over the wire)', () => {
  let root: string;
  let corpus: string;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-get-file-'));
    corpus = join(root, 'client');
    mkdirSync(join(corpus, 'docs'), { recursive: true });
    writeFileSync(join(corpus, 'docs', 'settlement.md'), '# Settlement\n\nnetted and cleared\n');
    const dbPath = join(corpus, '.lux', 'lux.db');
    const db = new LuxDatabase(dbPath);
    db.insertKnowledgeEntry({
      type: 'documentation',
      title: 'Settlement',
      file_path: 'docs/settlement.md',
      content: 'settlement is netted and cleared',
    });
    db.close();

    client = new Client({ name: 'get-file-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_SERVER],
        cwd: REPO_ROOT, // not the corpus: a relative path must not be resolved against this
        env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: corpus, LUX_DB_PATH: dbPath },
        stderr: 'ignore',
      })
    );
  }, 60000);

  afterAll(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });

  const text = (res: unknown): string =>
    (res as { content: Array<{ text: string }> }).content[0].text;

  it('lux_search reports the path relative to the corpus root', async () => {
    const res = await client.callTool({ name: 'lux_search', arguments: { query: 'settlement' } });
    const report = JSON.parse(text(res)) as { results: Array<{ filePath: string }> };
    expect(report.results.map((r) => r.filePath)).toEqual(['docs/settlement.md']);
    expect(report.results.filter((r) => isAbsolute(r.filePath))).toEqual([]);
  });

  it('lux_get_file reads the file that path names', async () => {
    const res = await client.callTool({
      name: 'lux_get_file',
      arguments: { file_path: 'docs/settlement.md' },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('netted and cleared');
  });

  it('lux_get_file still accepts an absolute path', async () => {
    const res = await client.callTool({
      name: 'lux_get_file',
      arguments: { file_path: join(corpus, 'docs', 'settlement.md') },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('netted and cleared');
  });
});
