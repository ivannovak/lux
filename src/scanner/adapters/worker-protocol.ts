import type { AdapterInputV1, AdapterOutputV1 } from './types.js';

export interface AdapterWorkerRequestV1 {
  schemaVersion: 1;
  adapterId: string;
  input: AdapterInputV1;
}

export type AdapterWorkerResponseV1 =
  | { schemaVersion: 1; ok: true; output: AdapterOutputV1 }
  | {
      schemaVersion: 1;
      ok: false;
      diagnostic: {
        code: 'timeout' | 'limit' | 'parse-error' | 'path-escape' | 'worker-error';
        message: string;
      };
    };

/** workerData that starts a parser worker in persistent mode: it serves one request per message. */
export const PERSISTENT_WORKER_DATA = { schemaVersion: 1, persistent: true } as const;

export function isPersistentWorkerData(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { persistent?: unknown }).persistent === true &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  );
}
