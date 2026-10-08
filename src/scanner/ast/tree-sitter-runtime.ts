// The one way Lux starts the tree-sitter runtime, in the main thread and in parser workers.

import Parser from 'web-tree-sitter';

/** Initialize web-tree-sitter for this thread. */
export async function initTreeSitterRuntime(): Promise<void> {
  await Parser.init();
}
