import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, realpathSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { resolveFirstPartyRoots } from '../first-party.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-first-party-test-'));

/** Build a corpus with vendor/composer/installed.json + package source dirs. */
function setup(
  packages: Array<{ name: string; 'install-path': string }>,
  pkgDirs: string[]
): string {
  const corpus = join(testDir, 'corpus');
  mkdirSync(join(corpus, 'vendor', 'composer'), { recursive: true });
  writeFileSync(join(corpus, 'vendor', 'composer', 'installed.json'), JSON.stringify({ packages }));
  for (const d of pkgDirs) mkdirSync(join(corpus, 'vendor', d), { recursive: true });
  return corpus;
}

describe('resolveFirstPartyRoots', () => {
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it('returns [] for empty globs', () => {
    const corpus = setup([{ name: 'acme/core', 'install-path': '../acme/core' }], ['acme/core']);
    expect(resolveFirstPartyRoots(corpus, [])).toEqual([]);
  });

  it('returns [] when installed.json is absent (no composer install)', () => {
    mkdirSync(testDir, { recursive: true });
    expect(resolveFirstPartyRoots(join(testDir, 'nonexistent'), ['acme/*'])).toEqual([]);
  });

  it('matches a glob and resolves install-path to a realpath source root', () => {
    const corpus = setup(
      [
        { name: 'acme/core', 'install-path': '../acme/core' },
        { name: 'laravel/framework', 'install-path': '../laravel/framework' },
      ],
      ['acme/core', 'laravel/framework']
    );
    const roots = resolveFirstPartyRoots(corpus, ['acme/*']);
    expect(roots.map((r) => r.package)).toEqual(['acme/core']);
    expect(roots[0].sourceRoot).toBe(realpathSync(join(corpus, 'vendor/acme/core')));
  });

  it('excludes packages the globs do not match', () => {
    const corpus = setup(
      [{ name: 'laravel/nova', 'install-path': '../laravel/nova' }],
      ['laravel/nova']
    );
    expect(resolveFirstPartyRoots(corpus, ['acme/*'])).toEqual([]);
  });

  it('skips a matched package whose install-path is missing on disk', () => {
    const corpus = setup([{ name: 'acme/ghost', 'install-path': '../acme/ghost' }], []);
    expect(resolveFirstPartyRoots(corpus, ['acme/*'])).toEqual([]);
  });
});
