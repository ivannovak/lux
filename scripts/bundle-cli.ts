// Bundle the CLI and the parser workers into dist (config/cli-bundle.json says which and how).
//
// A `lux` command loads about 500 modules unbundled; resolving and reading them was a third of a
// read command's time. Each bundle replaces the file tsc wrote at the same path, so nothing that
// starts the CLI or a worker changes. Lux's own assets are found from the root of the tree, not from
// a module's URL (src/utils/package-layout.ts), which is what lets the code move into one file.

import { buildSync, type BuildOptions } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface BundleConfig {
  entryPoints: Array<{ in: string; out: string }>;
  options: BuildOptions;
}

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(
  readFileSync(join(root, 'config', 'cli-bundle.json'), 'utf8')
) as BundleConfig;

buildSync({
  ...config.options,
  entryPoints: config.entryPoints.map((entry) => ({
    in: join(root, 'src', entry.in),
    out: entry.out,
  })),
  outdir: join(root, 'dist'),
  sourcemap: true,
});
