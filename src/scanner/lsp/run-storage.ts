// A per-run storage directory for a language server, removed however the run ends.
//
// The owner removes it at shutdown. If the process exits without shutting the server down (an
// uncaught error, process.exit, a handled signal), an exit hook removes it. A process that is
// killed outright runs no hook, so the directory name carries the owning pid and the next run
// sweeps the directories of processes that no longer exist.

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

/** Remove `<prefix><pid>-*` directories whose pid is not a running process. */
export function sweepRunStorage(prefix: string, baseDir: string = tmpdir()): void {
  let names: string[];
  try {
    names = readdirSync(baseDir);
  } catch {
    // lux-intentional-swallow: a temp directory that cannot be listed has nothing this run can sweep; creating the run's own directory in it fails loudly next.
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
    if (!Number.isInteger(pid) || isRunning(pid)) continue;
    rmSync(join(baseDir, name), { recursive: true, force: true });
  }
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
