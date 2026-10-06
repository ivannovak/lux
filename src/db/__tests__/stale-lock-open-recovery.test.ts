// A stale VFS lock must not wedge a NORMAL open — only `index rebuild` used to recover from one.
//
// node-sqlite3-wasm implements SQLite locking as a `${path}.lock` DIRECTORY, and the kernel does not
// drop it when a process dies. reclaimStaleLock() existed for exactly this, but was called from one
// site (cli/index.ts) out of 28 `new LuxDatabase(...)` opens — so search, trace, deps, overlay,
// anchors and the MCP server all died on a lock whose owner was provably gone, permanently.
//
// Observed 2026-09-02: a lock orphaned 22h with 94 dead-pid owner markers going back six weeks;
// `lux search` returned `Error: database is locked` on every invocation and could never recover.
//
// These cases pin the recovery to the OPEN path, and pin the safety rail that makes it safe there.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-stale-open-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A PID that is not running. 2^22 is above the default macOS/Linux pid_max. */
const deadPid = (): number => 4194303;

/** Leave behind exactly what a killed writer leaves: the VFS lock dir holding its owner token, and
 *  its marker in the owner registry. */
function orphanLock(dbPath: string, pid: number): void {
  mkdirSync(`${dbPath}.lock`, { recursive: true });
  mkdirSync(`${dbPath}.lock/${pid}-0123456789ab@${encodeURIComponent(hostname())}`, {
    recursive: true,
  });
  mkdirSync(`${dbPath}.owners`, { recursive: true });
  writeFileSync(`${dbPath}.owners/${pid}`, hostname());
}

describe('stale-lock recovery on the OPEN path', () => {
  it('opens successfully when a dead owner left a lock behind, and clears it', () => {
    const p = join(root, 'a', '.lux', 'lux.db');
    mkdirSync(join(root, 'a', '.lux'), { recursive: true });
    new LuxDatabase(p).close(); // create + migrate a real index first
    orphanLock(p, deadPid());

    // Before the fix this threw `database is locked` and no retry would ever succeed.
    expect(() => new LuxDatabase(p).close()).not.toThrow();
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('prunes the dead owner marker rather than letting the registry grow without bound', () => {
    const p = join(root, 'b', '.lux', 'lux.db');
    mkdirSync(join(root, 'b', '.lux'), { recursive: true });
    new LuxDatabase(p).close();
    orphanLock(p, deadPid());

    new LuxDatabase(p).close();
    expect(existsSync(`${p}.owners/${deadPid()}`)).toBe(false);
  });

  it('does NOT clear a lock whose owner is alive — the rail that makes open-path recovery safe', () => {
    const p = join(root, 'c', '.lux', 'lux.db');
    mkdirSync(join(root, 'c', '.lux'), { recursive: true });
    new LuxDatabase(p).close();
    orphanLock(p, process.pid); // this process is, by definition, alive

    // The lock must survive: a live writer's lock is never reclaimed, whatever the caller wants.
    expect(existsSync(`${p}.lock`)).toBe(true);
  });
});
