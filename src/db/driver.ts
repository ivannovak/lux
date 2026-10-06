import { createRequire } from 'node:module';
import type sqlite from './vendor/node-sqlite3-wasm/node-sqlite3-wasm.cjs';

// The SQLite engine is a vendored copy of node-sqlite3-wasm (see vendor/node-sqlite3-wasm/README.md
// for the version and the changes made to it). It is a CommonJS Emscripten bundle whose exports are
// attached at runtime, so `cjs-module-lexer` cannot see them and a native-ESM named import fails.
// Load it via createRequire (works under native ESM, tsx, and vitest alike). Every use of the engine
// goes through this module, so that nothing loads a second, unhooked copy.
const require = createRequire(import.meta.url);

export const driver = require('./vendor/node-sqlite3-wasm/node-sqlite3-wasm.cjs') as typeof sqlite;

export type WasmDatabase = sqlite.Database;
export type WasmStatement = sqlite.Statement;
export type BindValues = sqlite.BindValues;
