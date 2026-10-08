// V8 settings for the WebAssembly Lux runs: SQLite (node-sqlite3-wasm) and the tree-sitter grammars.
//
// Both settings are process-wide, apply to modules compiled after they are set, and are set before
// either engine loads: an entry point imports this module first, and the tree-sitter runtime calls
// applyWasmEngineSettings() again for code that reaches it without an entry point (tests, embedders).
//
// - Synchronous compilation. web-tree-sitter compiles a grammar with `WebAssembly.instantiate(bytes)`.
//   Compiled that way, the first parse into the TypeScript grammar blocks its thread for about
//   270 ms under Node 22 before it runs its next task; compiled synchronously it parses at the same
//   speed without the block (a 650-file parse: 688 ms asynchronously compiled, 704 ms synchronously).
// - A later tier-up. V8 recompiles a hot WebAssembly function with its optimizing compiler once the
//   function has run a set amount (the tiering budget). The grammar and SQLite functions a small run
//   calls cross the default budget early, so every run paid for optimizing them and finished before
//   the optimized code paid back: a rebuild of a ten-file repository spent 1.4 s of CPU, 0.8 s of it
//   with a budget fourteen times the default, and a 925-file rebuild took the same time either way.

import { setFlagsFromString } from 'node:v8';

/** Fourteen times V8 12's default of 13,000,000. */
const WASM_TIERING_BUDGET = 180_000_000;

let applied = false;

/** Apply the WebAssembly engine settings to this process (once). */
export function applyWasmEngineSettings(): void {
  if (applied) return;
  applied = true;
  setFlagsFromString('--no-wasm-async-compilation');
  setFlagsFromString(`--wasm-tiering-budget=${WASM_TIERING_BUDGET}`);
}

applyWasmEngineSettings();
