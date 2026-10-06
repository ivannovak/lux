// CLI tests spawn a copy of `src` compiled once per run (helpers/test-build.ts). These cases pin the
// property that makes that safe: a build that does not match the sources on disk is never handed out.

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { builtCli } from './helpers/built-cli.js';
import {
  buildTestTree,
  builtFingerprint,
  sourceFingerprint,
  TEST_BUILD_ENV,
  testBuildDir,
  type BuildSource,
} from './helpers/test-build.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A scratch source tree with one module, and an empty directory to build it into. */
function scratch(): { source: BuildSource; buildDir: string; write: (content: string) => void } {
  const base = mkdtempSync(join(tmpdir(), 'lux-test-build-'));
  dirs.push(base);
  const root = join(base, 'src');
  const buildDir = join(base, 'build');
  mkdirSync(join(root, 'cli'), { recursive: true });
  mkdirSync(buildDir);
  let tick = 0;
  const write = (content: string): void => {
    const file = join(root, 'cli', 'index.ts');
    writeFileSync(file, content);
    // A distinct modification time for each write, whatever the file system's resolution.
    tick += 10;
    utimesSync(file, 1_700_000_000 + tick, 1_700_000_000 + tick);
  };
  return { source: { root, fixtures: [] }, buildDir, write };
}

function run(file: string): string {
  return spawnSync(process.execPath, [file], { cwd: dirname(file), encoding: 'utf-8' }).stdout;
}

describe('the compiled CLI that tests spawn', () => {
  it('is this run’s build, made from the sources on disk now', () => {
    const buildDir = process.env[TEST_BUILD_ENV];

    expect(buildDir).toBeDefined();
    expect(builtCli()).toBe(join(buildDir!, 'cli', 'index.js'));
    expect(builtFingerprint(buildDir!)).toBe(sourceFingerprint());
    expect(spawnSync(process.execPath, [builtCli(), '--version']).status).toBe(0);
  });

  it('compiles TypeScript and copies everything else, skipping __tests__ directories', () => {
    const { source, buildDir, write } = scratch();
    write('const answer: number = 42;\nconsole.log(answer);\n');
    writeFileSync(join(source.root, 'cli', 'schema.sql'), 'SELECT 1;');
    mkdirSync(join(source.root, 'cli', '__tests__'));
    writeFileSync(join(source.root, 'cli', '__tests__', 'scratch.ts'), 'export {};');
    writeFileSync(join(buildDir, 'package.json'), '{"type":"module"}');

    buildTestTree(buildDir, source);

    expect(run(join(testBuildDir(buildDir, source), 'cli', 'index.js'))).toBe('42\n');
    expect(spawnSync('ls', ['-R', buildDir], { encoding: 'utf-8' }).stdout).toContain('schema.sql');
    expect(spawnSync('ls', ['-R', buildDir], { encoding: 'utf-8' }).stdout).not.toContain(
      'scratch'
    );
  });

  it.each([
    ['a source file is edited', (s: ReturnType<typeof scratch>) => s.write('console.log(2);\n')],
    [
      'a source file is added',
      (s: ReturnType<typeof scratch>) => writeFileSync(join(s.source.root, 'cli', 'new.ts'), ''),
    ],
    [
      'a source file is removed',
      (s: ReturnType<typeof scratch>) => rmSync(join(s.source.root, 'cli', 'extra.ts')),
    ],
  ])('is refused once %s', (_change, change) => {
    const s = scratch();
    s.write('console.log(1);\n');
    writeFileSync(join(s.source.root, 'cli', 'extra.ts'), 'export {};');
    buildTestTree(s.buildDir, s.source);
    expect(testBuildDir(s.buildDir, s.source)).toBe(s.buildDir);

    change(s);

    expect(() => testBuildDir(s.buildDir, s.source)).toThrow(/is stale: src has changed/);
  });

  it('is refused when there is no build, or the build never finished', () => {
    const { source, buildDir } = scratch();

    expect(() => testBuildDir('', source)).toThrow(`${TEST_BUILD_ENV} is not set`);
    expect(() => testBuildDir(buildDir, source)).toThrow('No finished test build');
  });
});
