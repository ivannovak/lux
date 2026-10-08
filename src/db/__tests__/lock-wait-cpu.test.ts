// Waiting for a lock costs no CPU, and the busy timeout still means what it says. SQLite waits out
// another process's lock by sleeping between attempts, and the engine's sleep spun on a clock until
// the vendored glue made that clock block when polled (vendor/node-sqlite3-wasm/README.md, change
// 5). A process that waits one and a half seconds for a writer here must spend well under that in
// CPU: with the spin it spent all of it. Each blocked sleep ends a little late and SQLite adds its
// sleeps up, so a 1 s busy timeout fires late by the sum: 6 ms with 0.1 ms slices, 43 ms with 1 ms
// ones, which this bound tells apart.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LuxDatabase } from '../index.js';
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const ADAPTER = pathToFileURL(built('src/db/sqlite-adapter.ts')).href;
const HOLD_MS = 1500;
const BUSY_TIMEOUT_MS = 1000;
const MAX_OVERSHOOT_MS = 25;

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function node(
  script: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    env: { ...process.env, ...env },
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  return new Promise((done) => child.on('close', (code) => done({ code, stdout })));
}

describe('a process waiting for another process’s lock', () => {
  it('sleeps through the wait instead of spinning', async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-lock-wait-'));
    const db = join(root, 'lux.db');
    const ready = join(root, 'ready');
    new LuxDatabase(db).close();

    const writer = node(
      `import { writeFileSync } from 'node:fs';
       const { LuxSqlite } = await import(${JSON.stringify(ADAPTER)});
       const h = new LuxSqlite(process.argv[1]);
       h.exec('BEGIN IMMEDIATE');
       writeFileSync(process.argv[2], '');
       setTimeout(() => { h.exec('ROLLBACK'); h.close(); }, ${HOLD_MS});`,
      [db, ready]
    );
    while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 10));

    const reader = await node(
      `const { LuxSqlite } = await import(${JSON.stringify(ADAPTER)});
       const h = new LuxSqlite(process.argv[1]);
       const before = process.cpuUsage();
       const started = performance.now();
       h.get('SELECT count(*) AS n FROM sqlite_master');
       const waitedMs = performance.now() - started;
       const used = process.cpuUsage(before);
       h.close();
       console.log(JSON.stringify({ waitedMs, cpuMs: (used.user + used.system) / 1000 }));`,
      [db]
    );
    await writer;

    expect(reader.code).toBe(0);
    const { waitedMs, cpuMs } = JSON.parse(reader.stdout) as { waitedMs: number; cpuMs: number };
    // It did wait for the writer, most of the hold.
    expect(waitedMs).toBeGreaterThan(HOLD_MS / 2);
    expect(cpuMs).toBeLessThan(waitedMs / 4);
  });

  it('gives up when its busy timeout runs out, not long after', async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-lock-wait-'));
    const db = join(root, 'lux.db');
    const ready = join(root, 'ready');
    new LuxDatabase(db).close();

    const writer = node(
      `import { writeFileSync } from 'node:fs';
       const { LuxSqlite } = await import(${JSON.stringify(ADAPTER)});
       const h = new LuxSqlite(process.argv[1]);
       h.exec('BEGIN IMMEDIATE');
       writeFileSync(process.argv[2], '');
       setTimeout(() => { h.exec('ROLLBACK'); h.close(); }, ${BUSY_TIMEOUT_MS + 2000});`,
      [db, ready]
    );
    while (!existsSync(ready)) await new Promise((r) => setTimeout(r, 10));

    const reader = await node(
      `const { LuxSqlite } = await import(${JSON.stringify(ADAPTER)});
       const h = new LuxSqlite(process.argv[1]);
       const started = performance.now();
       let error = '';
       try { h.get('SELECT count(*) AS n FROM sqlite_master'); } catch (e) { error = String(e); }
       console.log(JSON.stringify({ waitedMs: performance.now() - started, error }));
       h.close();`,
      [db],
      { LUX_BUSY_TIMEOUT_MS: String(BUSY_TIMEOUT_MS) }
    );
    await writer;

    const { waitedMs, error } = JSON.parse(reader.stdout) as { waitedMs: number; error: string };
    expect(error).toMatch(/database is locked/u);
    expect(waitedMs).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS);
    expect(waitedMs - BUSY_TIMEOUT_MS).toBeLessThan(MAX_OVERSHOOT_MS);
  });
});
