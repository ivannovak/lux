// The one way Lux starts the tree-sitter runtime, in the main thread and in parser workers.

import Parser from 'web-tree-sitter';
import { applyWasmEngineSettings } from '../../utils/wasm-engine.js';

/** Initialize web-tree-sitter for this thread, under Lux's WebAssembly engine settings. */
export async function initTreeSitterRuntime(): Promise<void> {
  // Before the first grammar compiles: see utils/wasm-engine.ts.
  applyWasmEngineSettings();
  await Parser.init();
}
