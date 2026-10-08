// What a test needs to spawn this run's compiled CLI (see test-build.ts).

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { MODULAR_CLI_ENTRY, PROJECT_ROOT, SOURCE_ROOT, testBuildDir } from './test-build.js';

export { PROJECT_ROOT };

/** The compiled `lux` entry point: spawn it as `node <builtCli()> …`. It is a bundle, as in dist. */
export function builtCli(): string {
  return join(testBuildDir(), 'cli', 'index.js');
}

/**
 * The same CLI unbundled: its entry loads Lux's modules from their own files. Only for a test that
 * changes one of those modules from a preload (fixtures/faults/inject.ts), which cannot reach the
 * copies inside a bundle.
 */
export function builtModularCli(): string {
  return join(testBuildDir(), 'cli', MODULAR_CLI_ENTRY);
}

/** The compiled counterpart of a module under `src`, or of a fixture test-build.ts compiles. */
export function built(sourcePath: string): string {
  const fromSource = relative(SOURCE_ROOT, resolve(PROJECT_ROOT, sourcePath));
  const compiled = join(testBuildDir(), fromSource.replace(/\.ts$/, '.js'));
  if (!existsSync(compiled)) throw new Error(`${sourcePath} is not part of the test build.`);
  return compiled;
}
