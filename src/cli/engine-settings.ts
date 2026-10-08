// Imported first by the CLI entry point, so the short-run WebAssembly settings are in force before
// the SQLite engine and any grammar compile (utils/wasm-engine.ts).

import { applyCliWasmEngineSettings } from '../utils/wasm-engine.js';

applyCliWasmEngineSettings();
