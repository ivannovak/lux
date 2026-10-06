// lux_rebuild_index persists module dependencies through the shared rebuild, and a failed write is
// reported in the tool result instead of passing as a complete rebuild (issue #6).
//
// Runs over the wire against the BUILT server, like status-tools.test.ts. A write failure is injected
// with a SQLite trigger in the database file, which the server process honours.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LuxDatabase } from '../../db/index.js';
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

const roots: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function makeCorpus(): { corpus: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'lux-mcp-rebuild-'));
  roots.push(root);
  const corpus = join(root, 'corpus');
  mkdirSync(join(corpus, 'src', 'Module', 'Users'), { recursive: true });
  mkdirSync(join(corpus, 'src', 'Module', 'Orders'), { recursive: true });
  mkdirSync(join(corpus, 'src', 'Module', 'Billing'), { recursive: true });
  writeFileSync(join(corpus, 'package.json'), '{}');
  writeFileSync(
    join(corpus, 'lux.yaml'),
    'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: true\n  module_boundary: "src/Module/{name}"\n'
  );
  writeFileSync(
    join(corpus, 'src', 'Module', 'Users', 'UserService.php'),
    '<?php\nnamespace App\\Module\\Users;\n\nuse App\\Module\\Orders\\OrderService;\nuse App\\Module\\Billing\\BillingService;\n\nclass UserService {}\n'
  );
  writeFileSync(
    join(corpus, 'src', 'Module', 'Orders', 'OrderService.php'),
    '<?php\nnamespace App\\Module\\Orders;\n\nclass OrderService {}\n'
  );
  writeFileSync(
    join(corpus, 'src', 'Module', 'Billing', 'BillingService.php'),
    '<?php\nnamespace App\\Module\\Billing;\n\nclass BillingService {}\n'
  );
  git(corpus, ['init', '-q']);
  git(corpus, ['config', 'user.email', 'test@example.com']);
  git(corpus, ['config', 'user.name', 'Test']);
  git(corpus, ['config', 'commit.gpgsign', 'false']);
  git(corpus, ['add', '-A']);
  git(corpus, ['commit', '-q', '-m', 'base']);

  const dbPath = join(root, 'lux.db');
  new LuxDatabase(dbPath).close(); // autoMigrate → current schema
  return { corpus, dbPath };
}

/** Fail every module_dependencies insert after the first, so a non-atomic write leaves one row. */
function failSecondDependencyInsert(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    raw.exec(`CREATE TRIGGER fail_second_dependency BEFORE INSERT ON module_dependencies
      WHEN (SELECT COUNT(*) FROM module_dependencies) >= 1
      BEGIN SELECT RAISE(ABORT, 'injected dependency write failure'); END;`);
  } finally {
    raw.close();
  }
}

/** Call lux_rebuild_index on a fresh server and close it, so the DB is free to read afterwards. */
async function rebuildOverMcp(
  corpus: string,
  dbPath: string
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const client = new Client({ name: 'rebuild-index-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: corpus, LUX_DB_PATH: dbPath },
      stderr: 'ignore',
    })
  );
  try {
    const res = await client.callTool({ name: 'lux_rebuild_index', arguments: {} });
    const content = (res as { content: Array<{ text: string }> }).content[0];
    return {
      isError: res.isError === true,
      payload: JSON.parse(content.text) as Record<string, unknown>,
    };
  } finally {
    await client.close();
  }
}

function dependencyCount(dbPath: string): number {
  const db = new LuxDatabase(dbPath);
  try {
    return db.getAllModuleDependencies().length;
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('MCP lux_rebuild_index — module dependencies', () => {
  it('persists the dependencies the rebuild computed', async () => {
    const { corpus, dbPath } = makeCorpus();

    const { isError, payload } = await rebuildOverMcp(corpus, dbPath);

    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(dependencyCount(dbPath)).toBe(2);
  }, 60000);

  it('reports a failed dependency write as degraded, with the warning, and leaves no rows', async () => {
    const { corpus, dbPath } = makeCorpus();
    failSecondDependencyInsert(dbPath);

    const { payload } = await rebuildOverMcp(corpus, dbPath);

    const overlay = payload.overlay as { trustLevel: string; mode: string; warnings: string[] };
    expect(overlay.mode).toBe('degraded-overlay');
    expect(overlay.trustLevel).toBe('degraded-overlay');
    expect(overlay.warnings).toContain(
      'Failed to write module dependencies (injected dependency write failure); ' +
        'the module dependency graph is empty until the next successful rebuild.'
    );
    expect(dependencyCount(dbPath)).toBe(0);
  }, 60000);
});
