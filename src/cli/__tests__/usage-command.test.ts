import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

describe('usage command', () => {
  let repoDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-usage-cli-repo-'));
    dbPath = join(repoDir, '.lux', 'lux.db');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('records hook events without raw corpus paths', () => {
    const result = runCli(repoDir, [
      '--corpus',
      repoDir,
      'usage',
      'hook-event',
      '--outcome',
      'success',
      '--reason',
      'sync_success',
      '--changed-count',
      '2',
      '--exit-code',
      '0',
      '--timeout-seconds',
      '300',
    ]);

    expect(result.status).toBe(0);

    const db = new LuxDatabase(dbPath);
    try {
      const events = db.getRecentEvents(10);
      const usage = events.find((event) => event.event_type === 'lux_usage_event');
      expect(usage).toBeDefined();
      expect(usage?.payload).not.toContain(repoDir);
      const payload = JSON.parse(usage!.payload!) as {
        source: string;
        surface: string;
        action: string;
        commandOutcome: string;
        corpusPathHash?: string;
        attributes?: { reason?: string; changedCount?: number; timeoutSeconds?: number };
      };
      expect(payload).toMatchObject({
        source: 'hook',
        surface: 'hook',
        action: 'success',
        commandOutcome: 'success',
        attributes: { reason: 'sync_success', changedCount: 2, timeoutSeconds: 300 },
      });
      expect(payload.corpusPathHash).toMatch(/^sha256:/);
    } finally {
      db.close();
    }
  });
});
