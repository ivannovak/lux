/* global process, console */
// Preload (`node --import`) for rebuild-commit-batching.test.ts. Counts SQLite write transactions
// by counting rollback-journal creations: under `journal_mode = delete` every committed write
// transaction creates `<db>-journal` and deletes it at COMMIT, so the count is the number of
// commits, whatever the machine's speed. node-sqlite3-wasm's VFS calls `fs.openSync` on the shared
// CommonJS `node:fs` object at call time, so patching that object observes every journal open.
// The count is written to LUX_JOURNAL_COUNT_OUT, keyed by the progress line that ends each phase.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const out = process.env.LUX_JOURNAL_COUNT_OUT;
const originalOpenSync = fs.openSync;
let total = 0;
let sinceLastLine = 0;
const phases = [];

fs.openSync = function (path, ...rest) {
  if (typeof path === 'string' && path.endsWith('-journal')) {
    total++;
    sinceLastLine++;
  }
  return originalOpenSync.call(this, path, ...rest);
};

const originalLog = console.log;
console.log = function (...args) {
  if (sinceLastLine > 0) {
    const line = args.map(String).join(' ').replace(/^\s*\[\+[^\]]*\]\s*/, '');
    phases.push({ journals: sinceLastLine, endedBy: line.slice(0, 120) });
    sinceLastLine = 0;
  }
  return originalLog.apply(this, args);
};

process.on('exit', () => {
  if (sinceLastLine > 0) phases.push({ journals: sinceLastLine, endedBy: '(exit)' });
  if (out) fs.writeFileSync(out, JSON.stringify({ total, phases }));
});
