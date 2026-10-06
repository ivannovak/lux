import { parentPort, workerData } from 'node:worker_threads';

// A parser worker driven by its input: it reports the parse started, then answers — unless the
// source is `hang`, in which case the parse never finishes. It speaks both modes: a single request
// in workerData, or one request per message when persistent.
function respond(wire) {
  parentPort.postMessage({ schemaVersion: 1, parseStarted: true });
  if (wire.source === 'hang') return;
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
  // Stay alive, as a worker stuck in a parse would, until the host terminates it.
  setInterval(() => {}, 60_000);
}
