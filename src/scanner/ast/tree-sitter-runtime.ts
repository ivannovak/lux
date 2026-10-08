// The one way Lux starts the tree-sitter runtime, in the main thread and in parser workers.
//
// web-tree-sitter loads every grammar through `WebAssembly.instantiate(bytes)`, which V8 compiles
// asynchronously. Under V8 12 (Node 22) the first parse into an asynchronously compiled grammar
// spends its tier-up budget, and the thread that parsed is then blocked for about 270 ms before it
// runs its next task; the TypeScript grammar does this on every run that parses one file of it. A
// synchronously compiled grammar parses at the same speed (a 650-file parse took 688 ms
// asynchronously compiled and 704 ms synchronously) without the block, so Lux turns asynchronous
// WebAssembly compilation off before it loads a grammar. The flag is process-wide and is read when
// a module is compiled; nothing else in Lux depends on WebAssembly compiling off the main thread.

import { setFlagsFromString } from 'node:v8';
import Parser from 'web-tree-sitter';

let flagSet = false;

/** Initialize web-tree-sitter for this thread, with synchronous WebAssembly compilation. */
export async function initTreeSitterRuntime(): Promise<void> {
  if (!flagSet) {
    setFlagsFromString('--no-wasm-async-compilation');
    flagSet = true;
  }
  await Parser.init();
}
