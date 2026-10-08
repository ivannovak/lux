// Live processes contending for one index, driven against the BUILT CLI and adapter.
//
// The WASM VFS takes `${db}.lock` for reads too, so "there is a lock and nobody is recorded as its
// owner" describes an ordinary live reader. An open that clears such a lock lets a writer in beside
// the reader, and the reader's own unlock then removes that writer's lock, letting a second writer in.
// Nothing here leaves a stale lock behind: every "cleared a stale database lock" line is a live
// process losing its lock.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LuxDatabase } from '../../db/index.js';
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_CLI = built('src/cli/index.ts');
const DIST_ADAPTER = built('src/db/sqlite-adapter.ts');
const DIST_NOTICES = built('src/db/notices.ts');
const DIST_RUN_STORAGE = built('src/scanner/lsp/run-storage.ts');

const CLEARED = 'cleared a stale database lock';

let root: string;
let corpus: string;
let dbPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-lock-contention-'));
  corpus = join(root, 'client');
  mkdirSync(corpus, { recursive: true });
  dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath);
  db.insertKnowledgeEntry({
    type: 'documentation',
    title: 'Settlement Notes',
    file_path: 'docs/settlement.md',
    content: 'settlement is cleared and netted',
  });
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function search(): Promise<Finished> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [DIST_CLI, '--corpus', corpus, '--db', dbPath, 'search', 'settlement'],
      { cwd: REPO_ROOT },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      }
    );
  });
}

interface Holder {
  /** Resolves once the holder has the lock. */
  holding: Promise<void>;
  /** `acquiredAt` / `releasingAt` are epoch ms taken inside the holder. */
  finished: Promise<Finished & { acquiredAt: number; releasingAt: number; lockAtRelease: boolean }>;
}

/** A separate process that takes the lock as a reader or a writer and keeps it for `holdMs`. */
function holder(mode: 'read' | 'write', holdMs: number, name: string): Holder {
  const ready = join(root, `${name}.ready`);
  const report = join(root, `${name}.json`);
  const script = `
    import { existsSync, writeFileSync } from 'node:fs';
    const { LuxSqlite } = await import(${JSON.stringify(pathToFileURL(DIST_ADAPTER).href)});
    const { setDbNoticeHandler } = await import(${JSON.stringify(pathToFileURL(DIST_NOTICES).href)});
    setDbNoticeHandler((kind, message) => console.error(kind + ': ' + message));
    const [db, mode, holdMs, ready, report] = process.argv.slice(1);
    const h = new LuxSqlite(db, mode === 'read' ? { readonly: true, fileMustExist: true } : {});
    if (mode === 'read') { h.exec('BEGIN'); h.get('SELECT count(*) AS n FROM sqlite_master'); }
    else h.exec('BEGIN IMMEDIATE');
    const acquiredAt = Date.now();
    writeFileSync(ready, '');
    setTimeout(() => {
      const lockAtRelease = existsSync(db + '.lock');
      const releasingAt = Date.now();
      h.exec(mode === 'read' ? 'COMMIT' : 'ROLLBACK');
      h.close();
      writeFileSync(report, JSON.stringify({ acquiredAt, releasingAt, lockAtRelease }));
    }, Number(holdMs));
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, dbPath, mode, String(holdMs), ready, report],
    { cwd: REPO_ROOT }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((done) => child.on('close', done));

  const holding = (async () => {
    while (!existsSync(ready)) {
      if (child.exitCode !== null) throw new Error(`holder ${name} exited early: ${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const finished = exited.then((code) => {
    const times = existsSync(report)
      ? (JSON.parse(readFileSync(report, 'utf8')) as {
          acquiredAt: number;
          releasingAt: number;
          lockAtRelease: boolean;
        })
      : { acquiredAt: NaN, releasingAt: NaN, lockAtRelease: false };
    return { code, stdout, stderr, ...times };
  });
  return { holding, finished };
}

describe('live processes contending for one index', () => {
  it('a search does not clear a live reader’s lock, so writers stay one at a time', async () => {
    const reader = holder('read', 1500, 'reader');
    await reader.holding;

    // If this open clears the reader's lock it returns at once, and the first writer walks in beside
    // the reader. The reader's unlock then removes that writer's lock, and the second writer walks in
    // beside the first.
    const found = await search();
    const first = holder('write', 1500, 'first-writer');
    const read = await reader.finished;
    await first.holding;
    const second = holder('write', 50, 'second-writer');
    const [wrote, wroteAgain] = await Promise.all([first.finished, second.finished]);

    expect(found.stderr).not.toContain(CLEARED);
    expect(found.code).toBe(0);
    expect(read.stderr).toBe('');
    expect(read.lockAtRelease).toBe(true);
    expect(wrote.acquiredAt).toBeGreaterThanOrEqual(read.releasingAt);
    expect(wrote.lockAtRelease).toBe(true);
    expect(wroteAgain.acquiredAt).toBeGreaterThanOrEqual(wrote.releasingAt);
    expect([read.code, wrote.code, wroteAgain.code]).toEqual([0, 0, 0]);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  // The adapter's signal handler closes every database and exits; the per-run language-server
  // storage is removed by an exit hook. A signalled run must leave neither a lock nor that directory.
  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)(
    'on %s a writer releases its lock and the run storage is removed',
    async (signal, exitCode) => {
      const ready = join(root, `${signal}.ready`);
      const script = `
      import { writeFileSync } from 'node:fs';
      const { LuxSqlite } = await import(${JSON.stringify(pathToFileURL(DIST_ADAPTER).href)});
      const { createRunStorage } = await import(${JSON.stringify(pathToFileURL(DIST_RUN_STORAGE).href)});
      const [db, base, ready] = process.argv.slice(1);
      const storage = createRunStorage('lux-signal-test-', base);
      const h = new LuxSqlite(db);
      h.exec('BEGIN IMMEDIATE');
      writeFileSync(ready, storage);
      setInterval(() => {}, 1000);
    `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, dbPath, root, ready],
        {
          cwd: REPO_ROOT,
        }
      );
      const exited = new Promise<number | null>((done) => child.on('close', done));
      while (!existsSync(ready)) {
        if (child.exitCode !== null) throw new Error('signal holder exited early');
        await new Promise((r) => setTimeout(r, 20));
      }
      const storage = readFileSync(ready, 'utf8');
      expect(readdirSync(`${dbPath}.lock`)).toHaveLength(1);
      expect(existsSync(storage)).toBe(true);

      child.kill(signal);

      expect(await exited).toBe(exitCode);
      expect(existsSync(`${dbPath}.lock`)).toBe(false);
      expect(existsSync(storage)).toBe(false);
    },
    30000
  );

  it('parallel readers of a clean index never report clearing a stale lock, and none fails', async () => {
    const results = await Promise.all(Array.from({ length: 48 }, () => search()));

    expect(results.filter((r) => r.stderr.includes(CLEARED))).toEqual([]);
    expect(results.filter((r) => r.code !== 0)).toEqual([]);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });
});
