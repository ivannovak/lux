// MCP `with` on lux_trace / lux_search (spec 15 Part B / T2.5 / Decisions 5,6 / SC-9,10). Driven over
// the wire against the BUILT server (as delta-tool.test.ts does): ListTools exposes the `with` param;
// CallTool with `with: ['core']` returns the federated result shape (repo attribution + federation
// block) and closes every opened sibling handle (observable: the sibling `.lux` is never mutated).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
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

const SHOW = 'symbol:php:App\\Http\\Ctrl::show';
const ENGINE = 'symbol:php:Acme\\Core\\Engine::run';
const LEDGER = 'symbol:php:Acme\\Core\\Ledger::post';
const CALLER = 'symbol:php:Acme\\Core\\Caller::invoke';

function node(db: LuxDatabase, id: string, qualified_name: string): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: id,
    qualified_name,
    origin: 'local',
    updated_at: 1,
  });
}
function edge(db: LuxDatabase, source: string, target: string): void {
  db.upsertStructuralEdge({
    id: `${source}->${target}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

/** primary corpus + `core` sibling registered in db: mode. */
function makeFixture(root: string): { corpus: string; dbPath: string; siblingDbPath: string } {
  const corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });
  const dbPath = join(corpus, '.lux', 'lux.db');
  const primary = new LuxDatabase(dbPath);
  node(primary, SHOW, 'App\\Http\\Ctrl::show');
  node(primary, ENGINE, 'Acme\\Core\\Engine::run');
  edge(primary, SHOW, ENGINE);
  primary.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Client Settlement Notes',
    file_path: 'docs/settlement.md',
    content: 'settlement in the client',
  });
  primary.close();

  const siblingDbPath = join(root, 'core', '.lux', 'lux.db');
  const sibling = new LuxDatabase(siblingDbPath);
  node(sibling, ENGINE, 'Acme\\Core\\Engine::run');
  node(sibling, LEDGER, 'Acme\\Core\\Ledger::post');
  node(sibling, CALLER, 'Acme\\Core\\Caller::invoke');
  edge(sibling, ENGINE, LEDGER);
  edge(sibling, CALLER, ENGINE);
  sibling.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Kernel Settlement Engine',
    file_path: 'docs/engine.md',
    content: 'settlement engine internals',
  });
  sibling.close();

  writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  core:\n    db: ${siblingDbPath}\n`);
  return { corpus, dbPath, siblingDbPath };
}

describe('MCP federation params — lux_trace / lux_search `with` (over the wire)', () => {
  let root: string;
  let siblingDbPath: string;
  let siblingStatBefore: Stats;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-fed-params-'));
    const fx = makeFixture(root);
    siblingDbPath = fx.siblingDbPath;
    // Baseline the sibling `.lux` BEFORE any federated CallTool runs, so the read-only assertion
    // below can prove mtime AND size are both unchanged (size-only would miss a same-size mutation).
    siblingStatBefore = statSync(siblingDbPath);
    client = new Client({ name: 'fed-params-test', version: '0.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: fx.corpus, LUX_DB_PATH: fx.dbPath },
      stderr: 'ignore',
    });
    await client.connect(transport);
  }, 60000);

  afterAll(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('ListTools exposes `direction` on lux_trace and retains federation params', async () => {
    const { tools } = await client.listTools();
    for (const name of ['lux_trace', 'lux_search']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const props = (tool!.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(props.with).toBeDefined();
      if (name === 'lux_trace') {
        expect(props.direction).toMatchObject({
          enum: ['outgoing', 'incoming', 'both'],
          default: 'outgoing',
        });
        expect(props.max_fanout).toMatchObject({ type: 'number', default: 64 });
      }
    }
  });

  it('lux_trace with `with: [core]` returns the federated shape + federation block', async () => {
    const res = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW, with: ['core'] },
    });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      nodes: Array<{ id: string; repo: string; bridged?: boolean }>;
      stats: { reposReached: string[] };
      federation: { siblings: Array<{ name: string; attached: boolean }> };
    };
    const ledger = payload.nodes.find((n) => n.id === LEDGER);
    expect(ledger).toBeDefined();
    expect(ledger!.repo).toBe('core');
    expect(ledger!.bridged).toBe(true);
    expect(payload.stats.reposReached.sort()).toEqual(['core', 'main']);
    expect(payload.federation.siblings[0]).toMatchObject({ name: 'core', attached: true });
  });

  it('lux_trace supports non-federated incoming without changing canonical endpoints', async () => {
    const implicitOutgoing = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW },
    });
    const explicitOutgoing = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW, direction: 'outgoing' },
    });
    expect((explicitOutgoing.content as Array<{ text: string }>)[0].text).toBe(
      (implicitOutgoing.content as Array<{ text: string }>)[0].text
    );

    const response = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: ENGINE, direction: 'incoming' },
    });
    const content = (response.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      options: { direction: string };
      edges: Array<{
        source_node_id: string;
        target_node_id: string;
        traversed: string;
      }>;
    };
    expect(payload.options.direction).toBe('incoming');
    expect(payload.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_node_id: SHOW,
          target_node_id: ENGINE,
          traversed: 'reverse',
        }),
      ])
    );
  });

  it('lux_trace supports federated incoming with canonical endpoints and provenance', async () => {
    const implicit = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW, with: ['core'] },
    });
    const explicitOutgoing = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW, with: ['core'], direction: 'outgoing' },
    });
    expect((explicitOutgoing.content as Array<{ text: string }>)[0].text).toBe(
      (implicit.content as Array<{ text: string }>)[0].text
    );

    const response = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: ENGINE, with: ['core'], direction: 'incoming' },
    });
    const content = (response.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      options: { direction: string };
      edges: Array<{
        source_node_id: string;
        target_node_id: string;
        traversed: string;
        repo: string;
        provenance: Array<{ repo: string; freshnessStatus: string }>;
      }>;
      stats: { freshness: { fresh: number } };
    };
    expect(payload.options.direction).toBe('incoming');
    expect(payload.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_node_id: CALLER,
          target_node_id: ENGINE,
          traversed: 'reverse',
          repo: 'core',
          provenance: [expect.objectContaining({ repo: 'core', freshnessStatus: 'fresh' })],
        }),
      ])
    );
    expect(payload.stats.freshness.fresh).toBeGreaterThan(0);
  });

  it('rejects an explicitly invalid lux_trace direction', async () => {
    const response = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW, direction: 'sideways' },
    });
    expect(response.isError).toBe(true);
    expect((response.content as Array<{ text: string }>)[0].text).toContain(
      'direction must be one of: outgoing, incoming, both'
    );
  });

  it('lux_search with `with: [core]` returns repo-grouped groups + federation block', async () => {
    const res = await client.callTool({
      name: 'lux_search',
      arguments: { query: 'settlement', with: ['core'] },
    });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      groups: Array<{ repo: string; results: Array<{ path: string }> }>;
      federation: { siblings: Array<{ name: string; attached: boolean }> };
    };
    expect(payload.groups.map((g) => g.repo)).toEqual(['main', 'core']);
    expect(payload.groups[1].results[0].path).toBe('docs/engine.md');
    expect(payload.federation.siblings[0]).toMatchObject({ name: 'core', attached: true });
  });

  it('an unresolvable `with` name appears attached:false, never dropped (Decision 6)', async () => {
    const res = await client.callTool({
      name: 'lux_trace',
      arguments: { symbol: SHOW, with: ['ghost'] },
    });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      federation: { siblings: Array<{ name: string; attached: boolean }> };
    };
    expect(payload.federation.siblings.find((s) => s.name === 'ghost')).toMatchObject({
      attached: false,
    });
  });

  it('leaves the sibling `.lux` unmodified across the federated calls (SC-7 read-only)', () => {
    // After all the CallTool invocations above, the sibling db is byte-for-byte unchanged — same
    // mtime AND size as the pre-pass baseline (a same-size mutation would still bump mtime) — and
    // no rollback -journal / -wal sidecar was left behind. The handles were opened read-only and
    // closed. Mirrors db/__tests__/open-sibling-readonly.test.ts's read-only invariant.
    const after = statSync(siblingDbPath);
    expect(after.size).toBeGreaterThan(0);
    expect(after.mtimeMs).toBe(siblingStatBefore.mtimeMs);
    expect(after.size).toBe(siblingStatBefore.size);
    expect(existsSync(siblingDbPath + '-journal')).toBe(false);
    expect(existsSync(siblingDbPath + '-wal')).toBe(false);
  });
});
