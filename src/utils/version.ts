import { readFileSync } from 'fs';
import { layoutPath } from './package-layout.js';

/**
 * The lux package version, resolved once from the package manifest.
 *
 * This is the single source the CLI (`lux --version`), the MCP server metadata, and the vendor-pack
 * stamp all read — so a build always reports one honest version, never a hand-maintained literal.
 *
 * The in-tree manifest pins `version` to the `0.0.0-dev` sentinel ("source tree, not a release").
 * `@semantic-release/npm` overwrites it with the real tag version in the CI workspace at publish, so
 * released artifacts report their release version while a source checkout honestly reports
 * `0.0.0-dev`. The manifest sits beside the tree the code runs from (`src/`, `dist/`, a test build).
 */
export const LUX_VERSION: string = (() => {
  return (JSON.parse(readFileSync(layoutPath('../package.json'), 'utf-8')) as { version: string })
    .version;
})();
