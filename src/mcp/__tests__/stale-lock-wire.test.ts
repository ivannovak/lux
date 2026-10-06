// A stale VFS lock must not break the index over MCP, and a live or foreign owner's lock must survive.
//
// Every MCP read goes through openIndex(), whose read-only schema probe opens the DB before
// LuxDatabase is constructed. If the probe runs first it waits out the 30 s busy timeout on an
// orphaned `${db}.lock` and reports `db-unreadable`, so the reclaim has to happen before the probe.
// Driven end-to-end against the BUILT server, as search-tool.test.ts does.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LuxDatabase } from '../../db/index.js';
import { built } from '../../__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

/** A PID that is not running. 2^22 is above the default macOS/Linux pid_max. */
const DEAD_PID = 4194303;

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A real, current index whose lock names an owner `pid` on `host`. */
function lockedIndex(pid: number, host: string): { corpus: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'lux-stale-lock-wire-'));
  roots.push(root);
  const corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });
  const dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath);
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Settlement Notes',
    file_path: 'docs/settlement.md',
    content: 'settlement is cleared and netted',
  });
  db.close();
  mkdirSync(`${dbPath}.lock`, { recursive: true });
  mkdirSync(`${dbPath}.lock/${pid}-0123456789ab@${encodeURIComponent(host)}`, { recursive: true });
  return { corpus, dbPath };
}

async function search(fx: {
  corpus: string;
  dbPath: string;
}): Promise<{ isError: boolean; text: string; stderr: string }> {
  const client = new Client(
    { name: 'stale-lock-wire-test', version: '0.0.0' },
    { capabilities: {} }
  );
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_SERVER],
    cwd: REPO_ROOT,
    env: {
      ...getDefaultEnvironment(),
      LUX_CORPUS_PATH: fx.corpus,
      LUX_DB_PATH: fx.dbPath,
      // The refusals below come after the busy timeout; they are the same after 200 ms as after
      // the default 30 s.
      LUX_BUSY_TIMEOUT_MS: '200',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await client.connect(transport);
  const res = (await client.callTool({
    name: 'lux_search',
    arguments: { query: 'settlement' },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: res.isError === true, text: res.content[0]?.text ?? '', stderr };
}

describe('MCP open path with a leftover lock (over the wire)', () => {
  it('reclaims a lock whose owner is provably dead and answers the read', async () => {
    const fx = lockedIndex(DEAD_PID, hostname());
    const res = await search(fx);
    expect(res.text).not.toContain('db-unreadable');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('docs/settlement.md');
    expect(existsSync(`${fx.dbPath}.lock`)).toBe(false);
  }, 60000);

  it('leaves a live or foreign owner’s lock in place', async () => {
    const live = lockedIndex(process.pid, hostname()); // this test process is alive
    const foreign = lockedIndex(DEAD_PID, `not-${hostname()}`); // dead here, unknowable there
    const [liveRes, foreignRes] = await Promise.all([search(live), search(foreign)]);

    expect(liveRes.isError).toBe(true);
    expect(readdirSync(`${live.dbPath}.lock`)).toHaveLength(1);
    expect(liveRes.text).toContain(`owner pid ${process.pid} is alive`);

    expect(foreignRes.isError).toBe(true);
    expect(readdirSync(`${foreign.dbPath}.lock`)).toHaveLength(1);
    expect(foreignRes.text).toContain(`owner pid ${DEAD_PID} is on another host`);
  }, 120000);
});
