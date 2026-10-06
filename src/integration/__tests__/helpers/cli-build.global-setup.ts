// Vitest global setup: compile `src` once for the run, so CLI tests spawn a compiled `lux` rather
// than a TypeScript loader per call (test-build.ts).

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { buildTestTree, PROJECT_ROOT, TEST_BUILD_ENV, TEST_BUILD_PREFIX } from './test-build.js';

const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

/** Remove build directories left behind by runs that were killed before their teardown. */
function removeAbandonedBuilds(): void {
  for (const name of readdirSync(PROJECT_ROOT)) {
    if (!name.startsWith(TEST_BUILD_PREFIX)) continue;
    const dir = join(PROJECT_ROOT, name);
    if (Date.now() - statSync(dir).mtimeMs > ABANDONED_AFTER_MS) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The process that made the current build: vitest runs this setup once for each of its projects. */
const BUILD_OWNER_ENV = 'LUX_TEST_BUILD_OWNER';

export default function setup(project: TestProject): () => void {
  const existing = process.env[TEST_BUILD_ENV];
  if (existing !== undefined && process.env[BUILD_OWNER_ENV] === String(process.pid)) {
    project.onTestsRerun(() => buildTestTree(existing));
    return () => {};
  }
  removeAbandonedBuilds();
  // Beside `src`, so the build resolves `node_modules` and `package.json` exactly as `dist` does.
  const buildDir = mkdtempSync(join(PROJECT_ROOT, TEST_BUILD_PREFIX));
  buildTestTree(buildDir);
  process.env[TEST_BUILD_ENV] = buildDir;
  process.env[BUILD_OWNER_ENV] = String(process.pid);
  // Watch mode re-runs tests after an edit without running this setup again: rebuild first.
  project.onTestsRerun(() => buildTestTree(buildDir));
  // Compiled-code cache for the spawned CLIs: they all load the same modules.
  process.env.NODE_COMPILE_CACHE ??= mkdtempSync(join(tmpdir(), 'lux-test-compile-cache-'));
  return () => rmSync(buildDir, { recursive: true, force: true });
}
