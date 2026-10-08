import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LuxDatabase } from '../../db/index.js';
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

function makeFixture(parent: string, name: string, token: string): string {
  const corpus = join(parent, name);
  mkdirSync(corpus, { recursive: true });
  const db = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: `${name} knowledge`,
    file_path: `${name}.md`,
    content: token,
  });
  db.close();
  return corpus;
}

function parse(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ type: string; text: string }> }).content[0];
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function eventually<T>(fn: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let last!: T;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await fn();
    if (accept(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return last;
}

describe('MCP Roots workspace selection (over the wire)', () => {
  let tempRoot: string;
  let first: string;
  let second: string;
  let activeRoot: string;
  let client: Client;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'lux-roots-wire-'));
    first = makeFixture(tempRoot, 'first', 'firstrootunique');
    second = makeFixture(tempRoot, 'second', 'secondrootunique');
    activeRoot = first;

    client = new Client(
      { name: 'roots-wire-test', version: '0.0.0' },
      { capabilities: { roots: { listChanged: true } } }
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(activeRoot).href }],
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: getDefaultEnvironment(),
      stderr: 'ignore',
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses the client root instead of the MCP process cwd', async () => {
    const status = await eventually(
      () => client.callTool({ name: 'lux_index_status', arguments: {} }),
      (result) => !result.isError
    );
    expect(status.isError).toBeFalsy();
    const payload = parse(status) as { runtime?: { corpusPath?: string; dbPath?: string } };
    expect(payload.runtime?.corpusPath).toBe(first);
    expect(payload.runtime?.dbPath).toBe(join(first, '.lux', 'lux.db'));

    const search = await client.callTool({
      name: 'lux_search',
      arguments: { query: 'firstrootunique' },
    });
    expect(search.isError).toBeFalsy();
    expect(JSON.stringify(parse(search))).toContain('firstrootunique');
  });

  it('switches subsequent calls after roots/list_changed', async () => {
    activeRoot = second;
    await client.sendRootsListChanged();

    const status = await eventually(
      () => client.callTool({ name: 'lux_index_status', arguments: {} }),
      (result) => {
        if (result.isError) return false;
        const payload = parse(result) as { runtime?: { corpusPath?: string } };
        return payload.runtime?.corpusPath === second;
      }
    );
    expect(status.isError).toBeFalsy();
    const payload = parse(status) as { runtime?: { corpusPath?: string } };
    expect(payload.runtime?.corpusPath).toBe(second);

    const oldSearch = await client.callTool({
      name: 'lux_search',
      arguments: { query: 'firstrootunique' },
    });
    const oldPayload = parse(oldSearch) as { results?: unknown[] };
    expect(oldPayload.results).toEqual([]);

    const newSearch = await client.callTool({
      name: 'lux_search',
      arguments: { query: 'secondrootunique' },
    });
    expect(JSON.stringify(parse(newSearch))).toContain('secondrootunique');
  });
});
