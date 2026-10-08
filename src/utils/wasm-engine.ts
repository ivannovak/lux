// V8 settings for a short `lux` command's WebAssembly: SQLite (node-sqlite3-wasm) and the
// tree-sitter grammars.
//
// - Synchronous compilation. web-tree-sitter compiles a grammar with `WebAssembly.instantiate(bytes)`.
//   Compiled that way, the first parse into the TypeScript grammar blocks its thread for about 270 ms
//   under Node 22 before it runs its next task.
// - A later tier-up. V8 recompiles a hot WebAssembly function with its optimizing compiler once it
//   has run a set amount (the tiering budget). The SQLite and grammar functions a small run calls
//   cross the default budget early, and the run ends before the optimized code pays back: a rebuild
//   of a ten-file repository spent 1.4 s of CPU, 0.87 s with a budget fourteen times the default.
//
// Both cost a long workload instead. Over three interleaved runs, a 925-file rebuild spent 6.8 s of
// CPU with neither and 7.6 s with synchronous compilation, and a long MCP session (search, trace,
// impact and status calls with a rebuild in between) 33.5 s with neither and 36.0 s with both. So
// only the CLI applies them (`cli/engine-settings.ts`, imported before anything else), and a CLI run
// whose scan turns out to be large puts asynchronous compilation back before any grammar loads
// (`settleWasmEngineForScan`). The MCP server, which runs for a session, keeps V8's defaults.

import { setFlagsFromString } from 'node:v8';

/** Fourteen times V8 12's default of 13,000,000. */
const WASM_TIERING_BUDGET = 180_000_000;

/**
 * Source files above which a run counts as large. The settings pay for themselves on runs of tens
 * of files and cost on runs of hundreds.
 */
const LARGE_SCAN_SOURCE_FILES = 200;

let applied = false;
let settled = false;

/** Apply the short-run settings to this process (once). Only the CLI entry point calls this. */
export function applyCliWasmEngineSettings(): void {
  if (applied) return;
  applied = true;
  setFlagsFromString('--no-wasm-async-compilation');
  setFlagsFromString(`--wasm-tiering-budget=${WASM_TIERING_BUDGET}`);
}

/**
 * Called before the first grammar loads, with the number of source files the run will parse: a
 * large run gets asynchronous grammar compilation back. A no-op where the CLI settings were not
 * applied, and after the first call.
 */
export function settleWasmEngineForScan(sourceFiles: number): void {
  if (!applied || settled) return;
  settled = true;
  if (sourceFiles > LARGE_SCAN_SOURCE_FILES) setFlagsFromString('--wasm-async-compilation');
}
