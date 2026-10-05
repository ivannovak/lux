import { parentPort, workerData } from 'node:worker_threads';

// A parser worker with a fixed start-up cost whose "parse" of a source `parse-ms:<n>` takes n ms.
// It speaks both modes: a single request in workerData, or one request per message when persistent.
const STARTUP_MS = 200;

function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until);
}

busyWait(STARTUP_MS);

function respond(wire) {
  parentPort.postMessage({ schemaVersion: 1, parseStarted: true });
  busyWait(Number(/parse-ms:(\d+)/.exec(wire.source)?.[1] ?? 0));
  const filePath = wire.request.input.filePath;
  const facts = {
    schemaVersion: 1,
    languageId: 'javascript',
    filePath,
    declarations: [],
    references: [],
    diagnostics: [],
  };
  parentPort.postMessage(
    JSON.stringify({
      schemaVersion: 1,
      ok: true,
      output: { facts, dependencies: [filePath], diagnostics: [] },
    })
  );
}

if (workerData && workerData.persistent === true) {
  parentPort.on('message', respond);
} else {
  respond(workerData);
}
