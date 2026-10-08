import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { layoutPath } from '../../utils/package-layout.js';

import type { Extraction } from '../ast/extract.js';
import type { AdapterInputV1 } from './types.js';
import {
  PERSISTENT_WORKER_DATA,
  isParseStartedMessage,
  type AdapterWorkerRequestV1,
  type AdapterWorkerResponseV1,
} from './worker-protocol.js';

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const TERMINATION_GRACE_MS = 250;
/**
 * How long a worker has to load and report that its parse started. This is separate from the
 * parse's own limit, and generous: start-up time depends on the machine's load, not on the input,
 * so charging it against the parse limit made a slow start read as a timed-out parse.
 */
const WORKER_START_LIMIT_MS = 30_000;

export const WORKER_DIAGNOSTICS = {
  invalidPath: 'Parser path rejected: invalid or unsafe path.',
  pathEscape: 'Parser path rejected: path is outside allowed roots.',
  fileLimit: 'Parser input exceeds maxBytes.',
  resultLimit: 'Parser result exceeds maxResultBytes.',
  timeout: 'Parser worker timed out.',
  /** A worker that never reported its parse started: a start-up failure, not a slow parse. */
  startTimeout: (limitMs: number): string =>
    `Parser worker did not start within ${limitMs / 1000}s.`,
  /** A file not attempted because this adapter's worker already failed to start in this run. */
  startFailedEarlier: 'Parser worker failed to start earlier in this run; not retried.',
  workerError: 'Parser worker failed.',
} as const;

interface WorkerLike {
  on(event: 'message', listener: (value: unknown) => void): this;
  off(event: 'message', listener: (value: unknown) => void): this;
  once(event: 'message', listener: (value: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (exitCode: number) => void): this;
  terminate(): Promise<number>;
}

export interface WorkerHostOptions {
  /** Test/integration seam. Production callers leave this unset. */
  workerUrl?: URL;
  /** Strict worker-construction seam; it cannot bypass host path/size checks. */
  createWorker?: (url: URL, options: WorkerOptions) => WorkerLike;
  /** Internal bounded-cache seam; keeps Extraction out of the frozen adapter contract. */
  includeExtraction?: boolean;
  /** Test seam: the entry point of the persistent worker tried before a single-use one. */
  persistentWorkerUrl?: URL;
  /** Test seam: the clock behind the start and parse limits. Defaults to unref'd real timers. */
  timers?: WorkerHostTimers;
  /** Test seam: how long a worker has to report its parse started (WORKER_START_LIMIT_MS). */
  startLimitMs?: number;
}

export interface WorkerHostTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: WorkerHostTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface ConfinedSource {
  canonicalCorpusRoot: string;
  canonicalAllowedRoots: string[];
  canonicalFilePath: string;
  source: string;
}

interface WorkerWireRequestV1 {
  schemaVersion: 1;
  request: AdapterWorkerRequestV1;
  source: string;
}

function diagnostic(
  code: 'timeout' | 'start-timeout' | 'limit' | 'parse-error' | 'path-escape' | 'worker-error',
  message: string
): AdapterWorkerResponseV1 {
  return { schemaVersion: 1, ok: false, diagnostic: { code, message } };
}

function isUnsafePath(value: string): boolean {
  if (
    value.length === 0 ||
    hasControlCharacter(value) ||
    (URI_SCHEME.test(value) && !WINDOWS_DRIVE.test(value))
  )
    return true;
  return value
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => part === '..');
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function limitsAreValid(input: AdapterInputV1): boolean {
  return (
    validLimit(input.limits.maxBytes) &&
    validLimit(input.limits.maxDepth) &&
    validLimit(input.limits.maxNodes) &&
    validLimit(input.limits.maxReferences) &&
    validLimit(input.limits.timeoutMs) &&
    validLimit(input.limits.maxResultBytes)
  );
}

async function readConfinedSource(
  input: AdapterInputV1
): Promise<ConfinedSource | AdapterWorkerResponseV1> {
  const allPaths = [input.corpusRoot, ...input.allowedRoots, input.filePath];
  if (allPaths.some(isUnsafePath)) return diagnostic('path-escape', WORKER_DIAGNOSTICS.invalidPath);
  if (input.allowedRoots.length === 0) {
    return diagnostic('path-escape', WORKER_DIAGNOSTICS.pathEscape);
  }

  try {
    const unresolvedCorpusRoot = resolve(input.corpusRoot);
    const canonicalCorpusRoot = await realpath(unresolvedCorpusRoot);
    const canonicalAllowedRoots: string[] = [];
    for (const root of input.allowedRoots) {
      const absoluteRoot = isAbsolute(root) ? root : resolve(canonicalCorpusRoot, root);
      canonicalAllowedRoots.push(await realpath(absoluteRoot));
    }

    const unresolvedFile = isAbsolute(input.filePath)
      ? input.filePath
      : resolve(canonicalCorpusRoot, input.filePath);
    const canonicalFilePath = await realpath(unresolvedFile);
    if (!canonicalAllowedRoots.some((root) => isWithin(root, canonicalFilePath))) {
      return diagnostic('path-escape', WORKER_DIAGNOSTICS.pathEscape);
    }

    // Open only the already-canonical target. O_NOFOLLOW closes the final-component race. After
    // opening, re-resolve the pathname and compare its device/inode to the retained descriptor;
    // this detects an ancestor component swapped to a symlink between realpath and open.
    const handle = await open(canonicalFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      const revalidatedPath = await realpath(canonicalFilePath);
      const pathMetadata = await stat(revalidatedPath);
      if (
        !canonicalAllowedRoots.some((root) => isWithin(root, revalidatedPath)) ||
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino
      ) {
        return diagnostic('path-escape', WORKER_DIAGNOSTICS.pathEscape);
      }
      if (!metadata.isFile()) return diagnostic('path-escape', WORKER_DIAGNOSTICS.invalidPath);
      if (metadata.size > input.limits.maxBytes) {
        return diagnostic('limit', WORKER_DIAGNOSTICS.fileLimit);
      }

      const bytes = Buffer.allocUnsafe(Math.min(input.limits.maxBytes + 1, metadata.size + 1));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset > input.limits.maxBytes) {
        return diagnostic('limit', WORKER_DIAGNOSTICS.fileLimit);
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      return { canonicalCorpusRoot, canonicalAllowedRoots, canonicalFilePath, source };
    } finally {
      await handle.close();
    }
  } catch {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return diagnostic('path-escape', WORKER_DIAGNOSTICS.invalidPath);
  }
}

function workerEntryUrl(adapterId: string): URL {
  const vue = adapterId === 'vue-compiler-sfc';
  // Vitest executes sources; released code executes compiled .js from dist.
  // Named from the root of the tree: in the bundled CLI this module's URL is the bundle's.
  const name = vue ? 'vue-sfc-worker' : 'tree-sitter-worker';
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return pathToFileURL(layoutPath(`scanner/adapters/${name}.${extension}`));
}

function tsxLoaderUrl(): string {
  return pathToFileURL(layoutPath('../node_modules/tsx/dist/loader.mjs')).href;
}

function messageBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function isWorkerResponse(value: unknown): value is AdapterWorkerResponseV1 {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== 1 || typeof response.ok !== 'boolean') return false;
  if (response.ok) return Boolean(response.output && typeof response.output === 'object');
  if (!response.diagnostic || typeof response.diagnostic !== 'object') return false;
  const item = response.diagnostic as Record<string, unknown>;
  return (
    typeof item.message === 'string' &&
    ['timeout', 'start-timeout', 'limit', 'parse-error', 'path-escape', 'worker-error'].includes(
      String(item.code)
    )
  );
}

/** Decode one worker reply, enforcing the result-size limit before any decoding. */
function decodeWorkerMessage(value: unknown, maxResultBytes: number): AdapterWorkerResponseV1 {
  const bytes = messageBytes(value);
  if (!bytes) return diagnostic('worker-error', WORKER_DIAGNOSTICS.workerError);
  // This check intentionally precedes TextDecoder and JSON.parse.
  if (bytes.byteLength > maxResultBytes) {
    return diagnostic('limit', WORKER_DIAGNOSTICS.resultLimit);
  }
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isWorkerResponse(decoded)) throw new Error('invalid worker response');
    return decoded;
  } catch {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return diagnostic('worker-error', WORKER_DIAGNOSTICS.workerError);
  }
}

function defaultCreateWorker(url: URL, options: WorkerOptions): WorkerLike {
  return new Worker(url, options);
}

/** Resolve once `worker.terminate()` settles, or after the grace period if it does not. */
function terminateWithGrace(worker: WorkerLike, timers: WorkerHostTimers): Promise<void> {
  return new Promise((resolveTerminated) => {
    const grace = timers.set(resolveTerminated, TERMINATION_GRACE_MS);
    const terminated = (): void => {
      timers.clear(grace);
      resolveTerminated();
    };
    void worker.terminate().then(terminated, terminated);
  });
}

function workerOptions(url: URL, workerData: unknown): WorkerOptions {
  const isTypeScriptEntry = url.pathname.endsWith('.ts');
  return {
    workerData,
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    ...(isTypeScriptEntry ? { execArgv: ['--import', tsxLoaderUrl()] } : {}),
  };
}

type WorkerWire = WorkerWireRequestV1 & { includeExtraction?: boolean };

function wireRequest(
  request: AdapterWorkerRequestV1,
  confined: ConfinedSource,
  options: WorkerHostOptions
): WorkerWire {
  const canonicalRequest: AdapterWorkerRequestV1 = {
    schemaVersion: 1,
    adapterId: request.adapterId,
    input: {
      ...request.input,
      corpusRoot: confined.canonicalCorpusRoot,
      allowedRoots: confined.canonicalAllowedRoots,
      filePath: confined.canonicalFilePath,
    },
  };
  return {
    schemaVersion: 1,
    request: canonicalRequest,
    source: confined.source,
    ...(options.includeExtraction ? { includeExtraction: true } : {}),
  };
}

// ── Persistent worker pool ────────────────────────────────────────────────────
// Starting a worker and loading the parser into it costs far more than most parses, and a rebuild
// asks for one parse per JavaScript and Vue file. So a parse first runs in an idle persistent worker
// of the same entry, which serves one request per message, under the same path, size, time and
// heap guards. In both kinds of worker the parse's time limit runs from the worker's parse-started
// message, and getting that far has its own limit (WORKER_START_LIMIT_MS), so a parse gets the same
// budget warm or fresh, and a timeout after it is final. Any other failure in a persistent worker
// (no parse-started message within the start limit, a crash, an unreadable reply,
// `worker-error`) discards that worker and re-runs the request in a fresh single-use worker, so it
// is decided exactly as without the pool. Idle workers are unref'd and never keep the process alive.
//
// A worker that does not start is remembered for the rest of the run (resetParserWorkerStartFailures
// marks a new one). Parsing is serial, so waiting out the start limit again for every file would
// turn one broken worker into hours. A persistent worker that never starts takes its entry out of
// the pool; a fresh one that never starts fails every later file for that entry at once, as
// `start-timeout`. One expiry is enough: the limit is hundreds of times a normal start, and with
// the pool in use it is the second worker in a row to miss it.

const idleWorkers = new Map<string, Worker[]>();
/** Entries whose persistent worker never started this run: their requests skip the pool. */
const poolStartFailures = new Set<string>();
/** Entries whose fresh worker never started this run: their requests fail without a worker. */
const startFailures = new Set<string>();

/** Forget the workers that failed to start, so a new run tries them again. */
export function resetParserWorkerStartFailures(): void {
  poolStartFailures.clear();
  startFailures.clear();
}

let persistentWorkersStarted = 0;

/** Persistent parser workers started by this process (observability for tests). */
export function persistentParserWorkersStarted(): number {
  return persistentWorkersStarted;
}

function acquirePersistentWorker(url: URL): Worker {
  const idle = idleWorkers.get(url.href)?.pop();
  if (idle) return idle;
  const worker = new Worker(url, workerOptions(url, PERSISTENT_WORKER_DATA));
  persistentWorkersStarted++;
  // Always listen, so a worker that dies while idle never raises an unhandled 'error'.
  const forget = (): void => {
    const pool = idleWorkers.get(url.href);
    const index = pool?.indexOf(worker) ?? -1;
    if (pool && index >= 0) pool.splice(index, 1);
  };
  worker.on('error', forget);
  worker.on('exit', forget);
  return worker;
}

function releasePersistentWorker(url: URL, worker: Worker): void {
  worker.unref();
  const pool = idleWorkers.get(url.href) ?? [];
  pool.push(worker);
  idleWorkers.set(url.href, pool);
}

/** Run a request in a persistent worker; `undefined` means it must be re-run in a fresh worker. */
function executePersistent(
  request: AdapterWorkerRequestV1,
  wire: WorkerWire,
  url: URL,
  timers: WorkerHostTimers,
  startLimitMs: number
): Promise<AdapterWorkerResponseV1 | undefined> {
  let worker: Worker;
  try {
    worker = acquirePersistentWorker(url);
  } catch {
    // lux-intentional-swallow: `undefined` makes the caller re-run the request in a fresh worker.
    return Promise.resolve(undefined);
  }
  worker.ref();

  return new Promise((resolveResponse) => {
    /** `undefined`: re-run in a fresh worker. A worker is kept only after a clean reply. */
    const finish = (response: AdapterWorkerResponseV1 | undefined, keepWorker = false): void => {
      timers.clear(timeout);
      worker.off('message', onMessage);
      worker.off('error', onFailure);
      worker.off('exit', onFailure);
      if (keepWorker) {
        releasePersistentWorker(url, worker);
      } else {
        void worker.terminate().catch(() => undefined);
      }
      resolveResponse(response);
    };
    const onFailure = (): void => finish(undefined);
    let parseStarted = false;
    // A timeout after parse-started is the parse overrunning its limit, which a fresh worker would
    // measure the same way, so it is final; before it, the worker never got going.
    const onTimeout = (): void => {
      if (!parseStarted) poolStartFailures.add(url.href);
      finish(parseStarted ? diagnostic('timeout', WORKER_DIAGNOSTICS.timeout) : undefined);
    };
    const onMessage = (value: unknown): void => {
      if (isParseStartedMessage(value)) {
        parseStarted = true;
        timers.clear(timeout);
        timeout = timers.set(onTimeout, request.input.limits.timeoutMs);
        return;
      }
      const response = decodeWorkerMessage(value, request.input.limits.maxResultBytes);
      const failed = !response.ok && response.diagnostic.code === 'worker-error';
      finish(failed ? undefined : response, !failed);
    };

    let timeout = timers.set(onTimeout, startLimitMs);
    worker.on('message', onMessage);
    worker.once('error', onFailure);
    worker.once('exit', onFailure);
    worker.postMessage(wire);
  });
}

async function executeWorker(
  request: AdapterWorkerRequestV1,
  confined: ConfinedSource,
  options: WorkerHostOptions
): Promise<AdapterWorkerResponseV1> {
  const wire = wireRequest(request, confined, options);
  const timers = options.timers ?? REAL_TIMERS;
  const startLimitMs = options.startLimitMs ?? WORKER_START_LIMIT_MS;
  const url = options.workerUrl ?? workerEntryUrl(request.adapterId);
  if (startFailures.has(url.href)) {
    return diagnostic('start-timeout', WORKER_DIAGNOSTICS.startFailedEarlier);
  }
  // The worker seams name a single-use entry point, so they bypass the pool unless a persistent
  // entry is named too.
  const persistentUrl =
    options.persistentWorkerUrl ??
    (options.workerUrl || options.createWorker ? undefined : workerEntryUrl(request.adapterId));
  if (persistentUrl && !poolStartFailures.has(persistentUrl.href)) {
    const pooled = await executePersistent(request, wire, persistentUrl, timers, startLimitMs);
    if (pooled) return pooled;
  }
  const createWorker = options.createWorker ?? defaultCreateWorker;

  let worker: WorkerLike;
  try {
    worker = createWorker(url, workerOptions(url, wire));
  } catch {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return diagnostic('worker-error', WORKER_DIAGNOSTICS.workerError);
  }

  return new Promise((resolveResponse) => {
    let settled = false;
    const settle = (response: AdapterWorkerResponseV1): void => {
      if (settled) return;
      settled = true;
      timers.clear(timeout);
      resolveResponse(response);
    };

    let parseStarted = false;
    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      // A worker that never reported its parse started failed to start: say so, and do not wait
      // on this entry's worker again in this run.
      if (!parseStarted) startFailures.add(url.href);
      const response = parseStarted
        ? diagnostic('timeout', WORKER_DIAGNOSTICS.timeout)
        : diagnostic('start-timeout', WORKER_DIAGNOSTICS.startTimeout(startLimitMs));
      void terminateWithGrace(worker, timers).then(() => resolveResponse(response));
    };
    // The worker has the start limit to report the parse started; the parse then has its own.
    let timeout = timers.set(onTimeout, startLimitMs);

    const onMessage = (value: unknown): void => {
      if (settled) return;
      if (isParseStartedMessage(value)) {
        parseStarted = true;
        timers.clear(timeout);
        timeout = timers.set(onTimeout, request.input.limits.timeoutMs);
        return;
      }
      worker.off('message', onMessage);
      void worker.terminate().catch(() => undefined);
      settle(decodeWorkerMessage(value, request.input.limits.maxResultBytes));
    };
    worker.on('message', onMessage);
    worker.once('error', () => settle(diagnostic('worker-error', WORKER_DIAGNOSTICS.workerError)));
    worker.once('exit', () => settle(diagnostic('worker-error', WORKER_DIAGNOSTICS.workerError)));
  });
}

/** Run one adapter parse behind root, byte, time, and response-size guards. */
export async function runAdapterWorker(
  request: AdapterWorkerRequestV1,
  options: WorkerHostOptions = {}
): Promise<AdapterWorkerResponseV1> {
  if (request.schemaVersion !== 1 || !limitsAreValid(request.input)) {
    return diagnostic('worker-error', WORKER_DIAGNOSTICS.workerError);
  }
  const confined = await readConfinedSource(request.input);
  if ('ok' in confined) return confined;
  return executeWorker(request, confined, options);
}

/** Explicit parser-oriented alias used by adapter registries. */
export const runBoundedParserWorker = runAdapterWorker;

export interface BoundedExtractionResultV1 {
  response: AdapterWorkerResponseV1;
  extraction?: Extraction;
}

/**
 * Internal overlay seam. Parsing still occurs only in the bounded worker, while
 * legacy materializers retain the exact ranges/module facts in `Extraction`.
 */
export async function runBoundedExtractionWorker(
  request: AdapterWorkerRequestV1
): Promise<BoundedExtractionResultV1> {
  const response = await runAdapterWorker(request, { includeExtraction: true });
  if (!response.ok) return { response };
  const wireOutput = response.output as typeof response.output & { extraction?: Extraction };
  const extraction = wireOutput.extraction;
  delete wireOutput.extraction;
  return { response, ...(extraction ? { extraction } : {}) };
}
