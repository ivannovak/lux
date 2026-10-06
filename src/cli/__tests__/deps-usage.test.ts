// Strict-read behavior for every `lux deps` query: no repository-local usage mutation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

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

describe('lux deps strict reads', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-deps-usage-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-deps-usage-db-'));
    dbPath = join(dbDir, 'lux.db');
    mkdirSync(join(repoDir, 'packages', 'Orders'), { recursive: true });
    const db = new LuxDatabase(dbPath);
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Orders',
      reference_count: 10,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Billing',
      target_module: 'Orders',
      reference_count: 8,
      sample_files: null,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it.each([
    ['graph', ['deps', 'graph']],
    ['clusters', ['deps', 'clusters']],
    ['impact', ['deps', 'impact', 'packages/Orders/OrderService.php']],
    ['coverage', ['deps', 'coverage']],
    ['unresolved impact', ['deps', 'impact', 'src/Nowhere/Thing.php']],
  ])('%s does not append usage events', (_name, args) => {
    const before = eventCount(dbPath);
    const result = runCli(repoDir, dbPath, args);
    expect(result.status).toBe(0);
    expect(eventCount(dbPath)).toBe(before);
  });

  it('JSON object answers report omitted telemetry', () => {
    const result = runCli(repoDir, dbPath, [
      'deps',
      'impact',
      'packages/Orders/OrderService.php',
      '--json',
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).telemetry).toEqual({
      recorded: false,
      reason: 'read-only-index',
    });
  });
});
