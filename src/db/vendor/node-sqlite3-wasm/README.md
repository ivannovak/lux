# Vendored: node-sqlite3-wasm

Lux's SQLite engine. A copy of the published build of
[node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm), with five small edits to its
JavaScript glue.

|                 |                                                                    |
| --------------- | ------------------------------------------------------------------ |
| Upstream        | https://github.com/tndrle/node-sqlite3-wasm                        |
| Version         | 0.8.59 (npm)                                                       |
| Upstream commit | `cb2ee85dc2321791e7f091a0fc97c83e0571b268` (the tarball's gitHead) |
| Licence         | MIT, © 2022-2024 Tobias Enderle. See `LICENSE` in this directory.  |

## Why it is vendored

The engine's VFS locks a database by creating the directory `<db>.lock` and unlocks by removing it,
calling Node's `fs` directly. Lux needs every lock to name its owner and every release to check
ownership (`src/db/lock-ownership.ts`). Upstream offers no way to intercept those two calls, and
replacing functions on Node's `fs` is not acceptable, so the two call sites are changed here.

## Files

| File                      | Upstream file                 | State             |
| ------------------------- | ----------------------------- | ----------------- |
| `node-sqlite3-wasm.cjs`   | `dist/node-sqlite3-wasm.js`   | edited, see below |
| `node-sqlite3-wasm.wasm`  | `dist/node-sqlite3-wasm.wasm` | byte-identical    |
| `node-sqlite3-wasm.d.cts` | `node-sqlite3-wasm.d.ts`      | edited, see below |
| `LICENSE`                 | `LICENSE`                     | byte-identical    |

The glue is renamed to `.cjs` because Lux's `package.json` has `"type": "module"` and the file is
CommonJS. It finds the `.wasm` beside itself through `__dirname`, so the two must stay together.

SHA-256 of the upstream files this copy was made from:

```
b25396e066dbcb9661e26062b3a80f2570d4181a4873302c4c55dbca2c8799b2  dist/node-sqlite3-wasm.js
50382672f2e254b9807b227ba5c390a822ddd48bb920f6ff710d13f14b33ee7f  dist/node-sqlite3-wasm.wasm
```

## Changes to `node-sqlite3-wasm.cjs`

1. After `Module.SQLite3Error=SQLite3Error;`, a default hook object that does what upstream did:
   `Module.lockHooks={lock:lockDir=>fs.mkdirSync(lockDir),unlock:lockDir=>fs.rmdirSync(lockDir)};`
2. In `_nodejsLock`: `fs.mkdirSync(...)` becomes `Module.lockHooks.lock(...)`, same argument.
3. In `_nodejsUnlock`: `fs.rmdirSync(...)` becomes `Module.lockHooks.unlock(...)`, same argument.
4. In `class Statement`, before `_reset()`, a public method:
   `reset(){this._assertReady();this._reset()}`
5. After `var _emscripten_get_now=()=>performance.now();`, a clock that sleeps when it is polled:
   `var _sleepCell=new Int32Array(new SharedArrayBuffer(4)),_lastPoll=-Infinity;var _emscripten_get_now_polled=()=>{var now=performance.now();if(now-_lastPoll<1){Atomics.wait(_sleepCell,0,0,0.1);now=performance.now()}_lastPoll=now;return now};`
   and in the import table `a:_emscripten_get_now,` becomes `a:_emscripten_get_now_polled,`.

   SQLite waits for a lock another process holds by sleeping between attempts (the busy timeout),
   and the engine's sleep is Emscripten's `usleep`, which spins on this clock until the time has
   passed: a reader that waited 2 s for a writer spent 2 s of CPU doing it. The clock the WebAssembly
   reads now blocks the thread for 0.1 ms when it is read again within a millisecond, which is what
   that loop does and nothing else in SQLite does. A search that waited 2 s for a writer then spent
   0.3 s of CPU, what it spends without waiting, instead of 2.2 s.

   Each sleep ends up to a slice (plus the time the thread takes to wake) after it was due, and
   SQLite adds its sleeps up without reading the clock, so a busy timeout fires late by the sum.
   Measured: 6 ms late for a 1 s timeout and 18 ms for 5 s (about 0.4%), at about 26 ms of CPU per
   second of waiting. A 1 ms slice overshot by 43 ms and 131 ms (about 4%); a 0.05 ms slice gained
   little (5 ms and 13 ms) for twice the CPU. `src/db/__tests__/lock-wait-cpu.test.ts` holds both
   the CPU and the overshoot. The clock the glue's own timers read is unchanged.

The hooks keep upstream's error contract: `lock` throwing an error whose `code` is `EEXIST` means
busy, any other error is an I/O error; `unlock` throwing `ENOENT` means already unlocked.

## Changes to `node-sqlite3-wasm.d.cts`

1. `declare module "node-sqlite3-wasm" {` becomes `declare namespace sqlite {`, with
   `export = sqlite;` at the end, so the types attach to the relative `.cjs` import.
2. `reset(): void;` added to `class Statement`.
3. `interface LockHooks` and `let lockHooks: LockHooks;` added.

## Re-syncing with upstream

1. `npm pack node-sqlite3-wasm@<version>` in a scratch directory and unpack it.
2. Copy the four files over the ones here, with the renames in the table above.
3. Reapply the edits listed above. They are plain string replacements; each target string occurs
   exactly once in 0.8.59. If one no longer matches, read the new upstream code before adapting it.
4. Update the version, commit and checksums in this file, and the SHA-256 pins in
   `src/db/__tests__/vendored-driver.test.ts`, which fails on any file here that changed or was added.
5. Run `src/db/__tests__/vendored-driver.test.ts` and `src/db/__tests__/lock-ownership.test.ts`.
   They fail if the hooks are not called or `reset()` is missing.

This directory is skipped by ESLint and by `validate:dead-code`, so it must hold these five files
and nothing else; the same test enforces that.

Nothing in `src/` may import the npm package; `src/db/driver.ts` is the only loader of this copy.
`vendored-driver.test.ts` enforces both.
