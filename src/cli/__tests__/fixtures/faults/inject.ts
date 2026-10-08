// Test-only preload that breaks the parts of the pipeline named in LUX_TEST_FAULTS (comma-separated),
// so a CLI subprocess can be driven through failures no fixture repository produces. Load its
// compiled copy (`built()` in src/integration/__tests__/helpers/built-cli.ts) with `node --import <file> …`, or
// through NODE_OPTIONS for a process the test does not start itself (the post-commit hook's `lux`).
//
//   laravel-detector — the Laravel HTTP surface detector throws on every run.
//   embedder         — the API embedder cannot be constructed (pair with LUX_EMBEDDING_TOKEN).
//   embed-pass       — the API embedder is built, but every embed request fails (same pairing).
//   model-fetch      — every network fetch fails (the `--embeddings` model download).
//   die-mid-rebuild  — the process is killed (SIGKILL) as soon as a rebuild has cleared the overlay,
//                      the state a rebuild killed part-way leaves.

const faults = new Set((process.env.LUX_TEST_FAULTS ?? '').split(',').filter(Boolean));

if (faults.has('laravel-detector')) {
  const { LaravelHttpSurfaceDetector } =
    await import('../../../../scanner/associations/detectors/laravel-http.js');
  (LaravelHttpSurfaceDetector.prototype as unknown as { detectSync: () => never }).detectSync =
    () => {
      throw new Error('injected detector fault');
    };
}

if (faults.has('embedder')) {
  const { ApiEmbedder } = await import('../../../../scanner/embeddings/api-embedder.js');
  ApiEmbedder.fromConfig = () => {
    throw new Error('injected embedder fault');
  };
}

if (faults.has('embed-pass')) {
  const { ApiEmbedder } = await import('../../../../scanner/embeddings/api-embedder.js');
  ApiEmbedder.prototype.embed = () => Promise.reject(new Error('injected embed request failure'));
}

if (faults.has('model-fetch')) {
  globalThis.fetch = () => Promise.reject(new Error('injected fetch failure'));
}

if (faults.has('die-mid-rebuild')) {
  const { LuxDatabase } = await import('../../../../db/index.js');
  const clearOverlay = LuxDatabase.prototype.clearOverlay;
  LuxDatabase.prototype.clearOverlay = function (this: InstanceType<typeof LuxDatabase>) {
    clearOverlay.call(this);
    process.kill(process.pid, 'SIGKILL');
  };
}

export {};
