// Strict-read observability for `lux trace`: query paths never append repository-local events.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(corpus: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--corpus', corpus, '--db', dbPath, ...args], {
    cwd: corpus,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

function eventCount(dbPath: string): number {
  const db = new LuxDatabase(dbPath);
  try {
    return db.getRecentEvents(50).length;
  } finally {
    db.close();
  }
}

describe('lux trace strict read behavior', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-trace-usage-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-trace-usage-db-'));
    dbPath = join(dbDir, 'lux.db');

    const db = new LuxDatabase(dbPath);
    const now = Math.floor(Date.now() / 1000);
    for (const node of [
      { id: 'A', symbol_name: 'start', qualified_name: 'App\\A::start' },
      { id: 'B', symbol_name: 'save', qualified_name: 'App\\B::save' },
      { id: 'C', symbol_name: 'save', qualified_name: 'App\\C::save' },
    ]) {
      db.upsertStructuralNode({ ...node, node_type: 'symbol', origin: 'local', updated_at: now });
    }
    db.upsertStructuralEdge({
      id: 'A->B:calls',
      source_node_id: 'A',
      target_node_id: 'B',
      edge_type: 'calls',
      confidence: 0.9,
      confidence_class: 'proven',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: now,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it.each([
    ['success', ['trace', 'A'], 0],
    ['unresolved', ['trace', 'DoesNotExist::nope'], 1],
    ['ambiguous', ['trace', 'save'], 1],
  ] as const)('%s does not append a usage event', (_name, args, exitCode) => {
    const before = eventCount(dbPath);
    const result = runCli(repoDir, dbPath, [...args]);
    expect(result.status).toBe(exitCode);
    expect(eventCount(dbPath)).toBe(before);
  });

  it('JSON answers report omitted telemetry', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'A', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).telemetry).toEqual({
      recorded: false,
      reason: 'read-only-index',
    });
  });
});
