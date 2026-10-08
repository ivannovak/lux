// The compiled copy of `src` that CLI tests spawn.
//
// A CLI test used to start every `lux` call as `node --import tsx src/cli/index.ts`, paying the
// TypeScript loader each time. Vitest's global setup (cli-build.global-setup.ts) now compiles `src`
// once per run into a directory of its own, and tests spawn `cli/index.js` from it.
//
// The build can never be stale without a test saying so: every run builds afresh, the build records
// a fingerprint of the sources it was made from, and `builtCli()` refuses to hand out a build whose
// fingerprint no longer matches the sources on disk (a watch-mode rerun after an edit).

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync, type BuildOptions } from 'esbuild';

export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);
export const SOURCE_ROOT = join(PROJECT_ROOT, 'src');

/** Set by the global setup to the directory holding this run's build. */
export const TEST_BUILD_ENV = 'LUX_TEST_BUILD_DIR';
/** Prefix of a build directory; each run makes one beside `src` and removes it afterwards. */
export const TEST_BUILD_PREFIX = '.test-build-';
const STAMP_FILE = 'test-build-stamp.json';
/** The unbundled CLI entry the build keeps beside the bundle (built-cli.ts builtModularCli). */
export const MODULAR_CLI_ENTRY = 'index.modules.js';

interface SourceFile {
  /** Path relative to `src`, with forward slashes. */
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Test fixtures that are loaded into a spawned CLI, and so are compiled with it. Nothing else under
 * a `__tests__` directory is part of the build: tests create and remove scratch files there.
 */
const COMPILED_TEST_FIXTURES = ['cli/__tests__/fixtures/faults/inject.ts'];

/** Where a build comes from. Tests of the build itself point this at a scratch tree. */
export interface BuildSource {
  root: string;
  fixtures: readonly string[];
}

const PROJECT_SOURCE: BuildSource = { root: SOURCE_ROOT, fixtures: COMPILED_TEST_FIXTURES };

/** Every file that goes into the build: `src` without its `__tests__` directories, plus the above. */
function sourceFiles(source: BuildSource): SourceFile[] {
  const found: SourceFile[] = [];
  const add = (full: string): void => {
    const stat = statSync(full);
    found.push({
      path: relative(source.root, full).split(sep).join('/'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(join(dir, entry.name));
      } else {
        add(join(dir, entry.name));
      }
    }
  };
  walk(source.root);
  for (const fixture of source.fixtures) add(join(source.root, fixture));
  return found;
}

/** A digest of the build's inputs: any edit, addition or removal under `src` changes it. */
export function sourceFingerprint(source: BuildSource = PROJECT_SOURCE): string {
  const hash = createHash('sha256');
  for (const file of sourceFiles(source).sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\n`);
  }
  return hash.digest('hex');
}

/**
 * Compile `src` into `outDir`, laid out as `tsc` lays out `dist`: each `.ts` file transpiled on its
 * own to a `.js` beside the others (the sources already run per-file under tsx), every other file
 * copied. The fingerprint is taken before compiling, so an edit made during the build shows as stale.
 */
export function buildTestTree(outDir: string, source: BuildSource = PROJECT_SOURCE): void {
  const fingerprint = sourceFingerprint(source);
  for (const file of sourceFiles(source)) {
    const from = join(source.root, file.path);
    const to = join(outDir, file.path);
    mkdirSync(dirname(to), { recursive: true });
    if (!file.path.endsWith('.ts') || file.path.endsWith('.d.ts')) {
      cpSync(from, to);
      continue;
    }
    const output = transformSync(readFileSync(from, 'utf8'), {
      loader: 'ts',
      format: 'esm',
      target: 'es2022',
      sourcemap: 'inline',
      sourcefile: from,
    });
    writeFileSync(to.replace(/\.ts$/, '.js'), output.code);
  }
  if (source.root === SOURCE_ROOT) bundleLikeDist(outDir);
  writeFileSync(join(outDir, STAMP_FILE), JSON.stringify({ fingerprint }));
}

/**
 * Replace the CLI and the parser workers with bundles, as `npm run build` does in dist
 * (config/cli-bundle.json, scripts/bundle-cli.ts), so the CLI the tests spawn is the one that ships.
 */
function bundleLikeDist(outDir: string): void {
  // Keep the unbundled entry for tests that inject faults into Lux's modules (builtModularCli).
  renameSync(join(outDir, 'cli', 'index.js'), join(outDir, 'cli', MODULAR_CLI_ENTRY));
  const config = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'config', 'cli-bundle.json'), 'utf8')
  ) as { entryPoints: Array<{ in: string; out: string }>; options: BuildOptions };
  buildSync({
    ...config.options,
    entryPoints: config.entryPoints.map((entry) => ({
      in: join(SOURCE_ROOT, entry.in),
      out: entry.out,
    })),
    outdir: outDir,
    sourcemap: 'inline',
  });
}

/** The fingerprint a build directory was made from, or undefined when it holds no finished build. */
export function builtFingerprint(buildDir: string): string | undefined {
  const stamp = join(buildDir, STAMP_FILE);
  if (!existsSync(stamp)) return undefined;
  return (JSON.parse(readFileSync(stamp, 'utf8')) as { fingerprint?: string }).fingerprint;
}

/**
 * The directory of this run's build, after checking it was made from the sources now on disk.
 * Throws rather than return a missing or stale build.
 */
export function testBuildDir(
  buildDir = process.env[TEST_BUILD_ENV],
  source: BuildSource = PROJECT_SOURCE
): string {
  if (!buildDir) {
    throw new Error(
      `${TEST_BUILD_ENV} is not set: CLI tests need the build vitest's global setup makes. ` +
        'Run them through vitest with the project config.'
    );
  }
  const built = builtFingerprint(buildDir);
  if (built === undefined) throw new Error(`No finished test build in ${buildDir}.`);
  if (built !== sourceFingerprint(source)) {
    throw new Error(
      `The test build in ${buildDir} is stale: src has changed since it was made. Re-run vitest.`
    );
  }
  return buildDir;
}
