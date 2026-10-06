// What a test needs to spawn this run's compiled CLI (see test-build.ts).

import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PROJECT_ROOT, SOURCE_ROOT, testBuildDir } from './test-build.js';

export { PROJECT_ROOT };

/** The compiled `lux` entry point: spawn it as `node <builtCli()> …`. */
export function builtCli(): string {
  return join(testBuildDir(), 'cli', 'index.js');
}

/** The compiled counterpart of a module under `src`, or of a fixture test-build.ts compiles. */
export function built(sourcePath: string): string {
  const fromSource = relative(SOURCE_ROOT, resolve(PROJECT_ROOT, sourcePath));
  const compiled = join(testBuildDir(), fromSource.replace(/\.ts$/, '.js'));
  if (!existsSync(compiled)) throw new Error(`${sourcePath} is not part of the test build.`);
  return compiled;
}
