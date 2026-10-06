// A language server's per-run storage must not outlive the run: removed by its owner, by the exit
// hook when the process ends without a shutdown, and swept by the next run when the process was
// killed outright.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunStorage, removeRunStorage, sweepRunStorage } from '../run-storage.js';
import { built } from '../../../__tests__/helpers/built-cli.js';

const MODULE = built(join(dirname(fileURLToPath(import.meta.url)), '..', 'run-storage.ts'));
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bases: string[] = [];

function base(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lux-run-storage-test-'));
  bases.push(dir);
  return dir;
}

afterEach(() => {
  while (bases.length) rmSync(bases.pop()!, { recursive: true, force: true });
});

describe('per-run server storage', () => {
  it('is named for the owning process and removed by its owner', () => {
    const dir = createRunStorage('srv-', base());
    expect(dir).toContain(`srv-${process.pid}-`);
    expect(existsSync(dir)).toBe(true);
    removeRunStorage(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('is removed when the process exits without removing it', () => {
    const root = base();
    const script =
      `import { createRunStorage } from ${JSON.stringify(MODULE)};` +
      `createRunStorage('srv-', ${JSON.stringify(root)}); process.exit(3);`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    });
    expect(run.status, run.stderr).toBe(3);
    expect(readdirSync(root)).toEqual([]);
  });

  it('sweeps the leftovers of processes that no longer exist, and only those', async () => {
    const root = base();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf-8',
    }).stdout;
    mkdirSync(join(root, `srv-${dead}-abc123`));
    mkdirSync(join(root, `srv-${process.pid}-live01`));
    mkdirSync(join(root, 'other-1-abc123'));
    sweepRunStorage('srv-', root);
    // The removal runs in a separate process, so it lands shortly after the sweep returns.
    await vi.waitFor(
      () =>
        expect(readdirSync(root).sort()).toEqual(['other-1-abc123', `srv-${process.pid}-live01`]),
      { timeout: 30_000 }
    );
  }, 60_000);

  it('hands the leftovers to be removed without deleting them itself', () => {
    const root = base();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf-8',
    }).stdout;
    const leftovers = [join(root, `srv-${dead}-one`), join(root, `srv-${dead}-two`)];
    for (const dir of leftovers) mkdirSync(dir);
    mkdirSync(join(root, `srv-${process.pid}-live01`));
    const handed: string[][] = [];

    sweepRunStorage('srv-', root, (paths) => handed.push(paths));

    // A sweep that deleted in place would block the caller for as long as the deletes take.
    expect(handed.map((paths) => paths.sort())).toEqual([leftovers]);
    expect(leftovers.every((dir) => existsSync(dir))).toBe(true);
  });
});
