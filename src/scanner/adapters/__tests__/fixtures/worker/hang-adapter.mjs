import { parentPort } from 'node:worker_threads';

// A worker whose parse starts and never finishes.
parentPort.postMessage({ schemaVersion: 1, parseStarted: true });
setInterval(() => {}, 60_000);
