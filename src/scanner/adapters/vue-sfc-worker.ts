import { parentPort, workerData } from 'node:worker_threads';
import { relative, sep, win32 } from 'node:path';

import { getGrammars } from '../ast/extract.js';
import { extractVueSfc } from '../vue/sfc-extract.js';
import type { AdapterOutputV1 } from './types.js';
import {
  PARSE_STARTED_MESSAGE,
  isPersistentWorkerData,
  type AdapterWorkerRequestV1,
  type AdapterWorkerResponseV1,
} from './worker-protocol.js';

interface WorkerWireRequestV1 {
  schemaVersion: 1;
  request: AdapterWorkerRequestV1;
  source: string;
}

function refusal(
  code: 'timeout' | 'limit' | 'parse-error' | 'path-escape' | 'worker-error',
  message: string
): AdapterWorkerResponseV1 {
  return { schemaVersion: 1, ok: false, diagnostic: { code, message } };
}

function validWire(value: unknown): value is WorkerWireRequestV1 {
  if (!value || typeof value !== 'object') return false;
  const wire = value as Partial<WorkerWireRequestV1>;
  return (
    wire.schemaVersion === 1 &&
    typeof wire.source === 'string' &&
    Boolean(wire.request && wire.request.schemaVersion === 1 && wire.request.input)
  );
}

function repositoryRelative(request: AdapterWorkerRequestV1): string | undefined {
  const { corpusRoot, filePath, allowedRoots } = request.input;
  const absolute = (value: string): boolean => value.startsWith(sep) || win32.isAbsolute(value);
  if (!absolute(corpusRoot) || !absolute(filePath) || !allowedRoots.every(absolute))
    return undefined;
  const path = relative(corpusRoot, filePath);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`)) return undefined;
  return path.split(sep).join('/');
}

async function execute(wire: WorkerWireRequestV1): Promise<AdapterWorkerResponseV1> {
  const filePath = repositoryRelative(wire.request);
  if (!filePath) return refusal('path-escape', 'Vue worker received a non-confined path.');
  try {
    const facts = await extractVueSfc(wire.source, filePath, {
      limits: wire.request.input.limits,
    });
    const boundary = facts.diagnostics.find((diagnostic) =>
      ['timeout', 'limit', 'path-escape'].includes(diagnostic.code)
    );
    if (boundary) {
      return refusal(
        boundary.code === 'timeout'
          ? 'timeout'
          : boundary.code === 'limit'
            ? 'limit'
            : 'path-escape',
        boundary.message
      );
    }
    const output: AdapterOutputV1 = {
      facts,
      dependencies: [filePath],
      diagnostics: facts.diagnostics,
    };
    return { schemaVersion: 1, ok: true, output };
  } catch (error) {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return refusal(
      'parse-error',
      error instanceof Error ? error.message : 'Vue compiler-SFC worker failed.'
    );
  }
}

async function respond(wire: unknown): Promise<void> {
  // Load the grammars before the host's parse clock starts (worker-protocol.ts).
  await getGrammars();
  parentPort?.postMessage(PARSE_STARTED_MESSAGE);
  const response = validWire(wire)
    ? await execute(wire)
    : refusal('worker-error', 'Vue worker received an invalid request.');
  parentPort?.postMessage(JSON.stringify(response));
}

function fail(): void {
  parentPort?.postMessage(JSON.stringify(refusal('worker-error', 'Vue worker failed.')));
}

// A persistent worker (worker-host.ts's pool) answers one request per message; otherwise the
// request arrives as workerData and the worker answers it once.
if (isPersistentWorkerData(workerData)) {
  parentPort?.on('message', (wire: unknown) => void respond(wire).catch(fail));
} else {
  void respond(workerData).catch(fail);
}
