// Where Lux's own files are, however its code is laid out.
//
// The compiled tree (`dist`, the test build, or `src` under a TypeScript loader) keeps Lux's assets
// beside the modules that use them: the migrations in `db/migrations`, the SQLite engine in
// `db/vendor`, a grammar in `scanner/adapters/hcl`, the parser workers in `scanner/adapters`. A
// module cannot find them relative to its own URL, because the CLI is one bundled file
// (`cli/index.js`): every module in it has the bundle's URL. So assets are named from the root of
// the tree, which is the nearest directory above this code that holds `db/migrations`.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let root: string | undefined;

/** The root of the tree this code runs from: `dist`, `src`, or a test build. */
function layoutRoot(): string {
  if (root !== undefined) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'db', 'migrations'))) return (root = dir);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Lux cannot find its own files above ${fileURLToPath(import.meta.url)}.`);
    }
    dir = parent;
  }
}

/** A file of Lux's own, named by its path from the root of the tree (`db/migrations`, …). */
export function layoutPath(relative: string): string {
  return join(layoutRoot(), relative);
}
