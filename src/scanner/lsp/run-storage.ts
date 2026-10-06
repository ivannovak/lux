// A per-run storage directory for a language server, removed however the run ends.
//
// The owner removes it at shutdown. If the process exits without shutting the server down (an
// uncaught error, process.exit, a handled signal), an exit hook removes it. A process that is
// killed outright runs no hook, so the directory name carries the owning pid and the next run
// sweeps the directories of processes that no longer exist.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const live = new Set<string>();
let exitHookInstalled = false;

/** Create `<tmp>/<prefix><pid>-XXXXXX`, after removing the leftovers of dead processes. */
export function createRunStorage(prefix: string, baseDir: string = tmpdir()): string {
  sweepRunStorage(prefix, baseDir);
  const dir = mkdtempSync(join(baseDir, `${prefix}${process.pid}-`));
  live.add(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const path of live) rmSync(path, { recursive: true, force: true });
    });
  }
  return dir;
}

export function removeRunStorage(dir: string): void {
  live.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Remove `<prefix><pid>-*` directories whose pid is not a running process.
 *
 * The removal is handed to `remove`, which by default does it in a separate process and does not
 * wait. A server's storage can hold tens of thousands of files, and a recursive synchronous delete
 * of a few such leftovers held the main thread for minutes before the next server was even
 * started.
 */
export function sweepRunStorage(
  prefix: string,
  baseDir: string = tmpdir(),
  remove: (paths: string[]) => void = removeInBackground
): void {
  let names: string[];
  try {
    names = readdirSync(baseDir);
  } catch {
    // lux-intentional-swallow: a temp directory that cannot be listed has nothing this run can sweep; creating the run's own directory in it fails loudly next.
    return;
  }
  const leftovers: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
    if (!Number.isInteger(pid) || isRunning(pid)) continue;
    leftovers.push(join(baseDir, name));
  }
  if (leftovers.length > 0) remove(leftovers);
}

const REMOVE_SCRIPT =
  "const fs = require('node:fs');" +
  'for (const path of process.argv.slice(1)) fs.rmSync(path, { recursive: true, force: true });';

/**
 * Delete directories in a detached process that outlives this one. A leftover this fails to remove
 * is still there, under its dead owner's pid, for the next run's sweep.
 */
function removeInBackground(paths: string[]): void {
  const child = spawn(process.execPath, ['-e', REMOVE_SCRIPT, ...paths], {
    detached: true,
    stdio: 'ignore',
  });
  // Without a listener a failed spawn would be an unhandled 'error'; the leftovers simply stay.
  child.on('error', () => undefined);
  child.unref();
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // lux-intentional-swallow: signal 0 only probes; ESRCH is the answer "no such process", and EPERM means it exists under another user.
    return (error as { code?: string }).code === 'EPERM';
  }
}
