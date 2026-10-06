// Read-only behavior for the overlay CLI surfaces that live in overlay.ts:
//   overlay-status / overlay-check / overlay-ownership / overlay-boundaries.
// Reads never persist usage events, JSON reads report the explicit telemetry omission marker, and
// strict read opens refuse a missing index instead of creating one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

interface JsonReadPayload {
  telemetry?: { recorded: boolean; reason: string };
}

const READ_TELEMETRY = { recorded: false, reason: 'read-only-index' };

describe('lux overlay read telemetry', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-overlay-usage-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-overlay-usage-db-'));
    dbPath = join(dbDir, 'lux.db');

    // A committed git tree keeps the status freshness assessment on its normal path.
    execSync('git init -q && git config user.email t@t.co && git config user.name T', {
      cwd: repoDir,
    });
    execSync('git commit -q --allow-empty -m init', { cwd: repoDir });

    new LuxDatabase(dbPath).close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it.each([
    ['status', ['overlay', 'status', '--json']],
    ['ownership', ['overlay', 'ownership', '--json']],
    ['boundaries', ['overlay', 'boundaries', 'show', '--json']],
  ])('overlay %s reports omitted telemetry without recording usage', (_surface, args) => {
    const before = eventCount(dbPath);
    const res = runCli(repoDir, dbPath, args);

    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout) as JsonReadPayload;
    expect(payload.telemetry).toEqual(READ_TELEMETRY);
    expect(eventCount(dbPath)).toBe(before);
  });

  it('overlay check preserves its no-overlay failure without recording usage', () => {
    const before = eventCount(dbPath);
    const res = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Error: No structural overlay trust state found in database.');
    expect(eventCount(dbPath)).toBe(before);
  });

  it('an invalid boundary option is refused without opening or mutating the index', () => {
    const before = eventCount(dbPath);
    const res = runCli(repoDir, dbPath, ['overlay', 'boundaries', 'show', '--top', '0']);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Error: --top must be a positive integer.');
    expect(eventCount(dbPath)).toBe(before);
  });

  it('a missing-index JSON read returns a structured refusal and does not create the index', () => {
    rmSync(dbPath, { force: true });
    const res = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({
      error: 'index-open-refused',
      refusal: 'index-absent',
      telemetry: READ_TELEMETRY,
    });
    expect(existsSync(dbPath)).toBe(false);
  });
});
