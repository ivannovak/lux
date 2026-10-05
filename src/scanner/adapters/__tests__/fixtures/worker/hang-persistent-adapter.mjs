import { parentPort } from 'node:worker_threads';

// A persistent worker that accepts requests and never answers.
parentPort.on('message', () => undefined);
