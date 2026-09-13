import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CorpusPreflightError,
  isPathSafeCorpusOrCaseId,
  loadCorpusManifest,
  normalizeGitHubRemote,
  preflightCorpora,
  preflightCorpus,
  withPreflightCorpora,
  withPreflightCorpus,
  type CorpusManifestV1,
  type CorpusPreflightCode,
} from '../preflight.js';

const temporaryRoots: string[] = [];

function temporaryRoot(prefix = 'lux-corpus-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
}

function createRepository(
  parent = temporaryRoot(),
  name = 'checkout',
  remote = 'git@github.com:nwshq/example.git'
): { root: string; firstCommit: string } {
  const root = join(parent, name);
  execFileSync('git', ['init', '-q', root]);
  git(root, 'config', 'user.email', 'corpus-test@example.com');
  git(root, 'config', 'user.name', 'Corpus Test');
  git(root, 'remote', 'add', 'origin', remote);
  writeFileSync(join(root, 'fixture.txt'), 'first\n');
  git(root, 'add', 'fixture.txt');
  git(root, 'commit', '-q', '-m', 'first');
  return { root, firstCommit: git(root, 'rev-parse', 'HEAD') };
}

function entry(checkout: string, commit: string, id = 'example') {
  return {
    id,
    remote: `https://github.com/nwshq/${id}.git`,
    checkoutHints: [checkout],
    commit,
    fixtureSchemaVersion: 1,
    goldSchemaVersion: 1,
    minimumCases: 1,
  };
}

function manifestFor(
  checkout: string,
  commit: string,
  overrides: Partial<CorpusManifestV1> = {}
): CorpusManifestV1 {
  return {
    schemaVersion: 1,
    owner: 'Example Maintainer',
    corpora: [entry(checkout, commit)],
    ...overrides,
  };
}

function writeManifest(root: string, manifest: unknown): string {
  const path = join(root, 'manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function expectCode(run: () => unknown, code: CorpusPreflightCode): CorpusPreflightError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusPreflightError);
    expect((error as CorpusPreflightError).code).toBe(code);
    return error as CorpusPreflightError;
  }
  throw new Error(`Expected ${code}`);
}

function commitSecond(repository: { root: string }): string {
  writeFileSync(join(repository.root, 'fixture.txt'), 'second\n');
  git(repository.root, 'commit', '-qam', 'second');
  return git(repository.root, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('corpus manifest schema v1', () => {
  it('loads all canonical owner-approved, exact-pinned, non-vacuous contracts', () => {
    const path = join(dirname(new URL(import.meta.url).pathname), '..', 'manifest.json');
    const manifest = loadCorpusManifest(path);

    expect(manifest).toMatchObject({ schemaVersion: 1, owner: 'Example Maintainer' });
    expect(manifest.corpora).toHaveLength(11);
    expect(new Set(manifest.corpora.map(({ id }) => id))).toHaveLength(11);
    for (const corpus of manifest.corpora) {
      expect(corpus.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(corpus.fixtureSchemaVersion).toBeGreaterThan(0);
      expect(corpus.goldSchemaVersion).toBeGreaterThan(0);
      expect(corpus.minimumCases).toBeGreaterThan(0);
    }
  });

  it('accepts only exact HTTPS, ssh://git@, and SCP git@github.com forms', () => {
    expect(normalizeGitHubRemote('git@github.com:NWSHQ/Lux.git')).toBe('ivannovak/lux');
    expect(normalizeGitHubRemote('ssh://git@github.com/ivannovak/lux.git')).toBe('ivannovak/lux');
    expect(normalizeGitHubRemote('https://github.com/ivannovak/lux.git')).toBe('ivannovak/lux');

    const hostile = [
      'github.com/ivannovak/lux',
      'http://github.com/ivannovak/lux.git',
      'file:///tmp/lux',
      '/tmp/lux',
      'https://github.com:443/ivannovak/lux.git',
      'https://github.com/ivannovak/lux.git?q=1',
      'https://github.com/ivannovak/lux.git#x',
      'https://user@github.com/ivannovak/lux.git',
      'ssh://other@github.com/ivannovak/lux.git',
      'https://github.com/nwshq%2flux.git',
      'https://github.com/nwshq/%2e%2e.git',
      'https://github.com/ivannovak/lux/extra',
      'https://github.com.evil/ivannovak/lux.git',
      'https://github.com/ivannovak/lux.git\n',
      'https://githuЬ.com/ivannovak/lux.git',
    ];
    for (const value of hostile) expect(normalizeGitHubRemote(value), value).toBeUndefined();
  });

  it('rejects owner absence, schema drift, duplicate IDs, unsafe IDs, and weak pins', () => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    const manifest = manifestFor(repository.root, repository.firstCommit);
    const path = writeManifest(root, { ...manifest, owner: ' ' });
    expectCode(() => loadCorpusManifest(path), 'corpus.owner-missing');

    for (const mutation of [
      { ...manifest, x: 1 },
      { ...manifest, corpora: [...manifest.corpora, { ...manifest.corpora[0] }] },
      { ...manifest, corpora: [{ ...manifest.corpora[0], id: '../case' }] },
      {
        ...manifest,
        corpora: [{ ...manifest.corpora[0], commit: repository.firstCommit.slice(0, 7) }],
      },
      {
        ...manifest,
        corpora: [{ ...manifest.corpora[0], commit: repository.firstCommit.toUpperCase() }],
      },
      { ...manifest, corpora: [{ ...manifest.corpora[0], commit: 'HEAD^{commit}' }] },
      { ...manifest, corpora: [{ ...manifest.corpora[0], fixtureSchemaVersion: 0 }] },
      { ...manifest, corpora: [{ ...manifest.corpora[0], goldSchemaVersion: 0 }] },
      { ...manifest, corpora: [{ ...manifest.corpora[0], minimumCases: 0 }] },
    ]) {
      writeManifest(root, mutation);
      expectCode(() => loadCorpusManifest(path), 'corpus.schema-unsupported');
    }
    expect(isPathSafeCorpusOrCaseId('safe-case-1')).toBe(true);
    expect(isPathSafeCorpusOrCaseId('../unsafe')).toBe(false);
  });
});

describe('corpus preflight', () => {
  it.each([undefined, 'always', 'when-needed'] as const)(
    'returns an owned exact snapshot for isolation %s without modifying the source',
    (isolation) => {
      const root = temporaryRoot();
      const repository = createRepository(root);
      const manifestPath = writeManifest(
        root,
        manifestFor(repository.root, repository.firstCommit)
      );
      const before = git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all');

      const prepared = preflightCorpus({
        corpusId: 'example',
        manifestPath,
        isolation,
        allowedCheckoutRoots: [root],
      });

      expect(prepared.resolution).toEqual({
        id: 'example',
        rootPath: expect.any(String),
        remote: 'nwshq/example',
        commit: repository.firstCommit,
        owner: 'Example Maintainer',
        isolated: true,
      });
      expect(prepared.resolution.rootPath).not.toBe(realpathSync(repository.root));
      const isolatedRoot = prepared.resolution.rootPath;
      prepared.cleanup();
      prepared.cleanup();
      expect(existsSync(isolatedRoot)).toBe(false);
      expect(git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
        before
      );
    }
  );

  it('expands a portable home hint and accepts path-only known overrides', () => {
    const home = temporaryRoot();
    const hinted = createRepository(home, 'hinted');
    const overrideRoot = join(home, 'override');
    execFileSync('git', ['clone', '-q', hinted.root, overrideRoot]);
    git(overrideRoot, 'remote', 'set-url', 'origin', 'https://github.com/nwshq/example.git');
    const manifestPath = writeManifest(home, manifestFor('~/hinted', hinted.firstCommit));
    const hintedBefore = git(hinted.root, 'status', '--porcelain=v1', '--untracked-files=all');
    const overrideBefore = git(overrideRoot, 'status', '--porcelain=v1', '--untracked-files=all');

    const fromHome = preflightCorpus({
      corpusId: 'example',
      manifestPath,
      homeDirectory: home,
      allowedCheckoutRoots: [home],
    });
    expect(fromHome.resolution.rootPath).not.toBe(realpathSync(hinted.root));
    expect(fromHome.resolution.isolated).toBe(true);
    fromHome.cleanup();

    const fromOverride = preflightCorpus({
      corpusId: 'example',
      manifestPath,
      checkoutOverrides: { example: overrideRoot },
      allowedCheckoutRoots: [home],
    });
    expect(fromOverride.resolution.rootPath).not.toBe(realpathSync(overrideRoot));
    expect(fromOverride.resolution.isolated).toBe(true);
    fromOverride.cleanup();
    expect(git(hinted.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      hintedBefore
    );
    expect(git(overrideRoot, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      overrideBefore
    );

    expectCode(
      () =>
        preflightCorpus({
          corpusId: 'example',
          manifestPath,
          checkoutOverrides: { unknown: overrideRoot },
        }),
      'corpus.id-missing'
    );
    expectCode(
      () =>
        preflightCorpus({
          corpusId: 'example',
          manifestPath,
          checkoutOverrides: { example: { path: overrideRoot } } as unknown as Record<
            string,
            string
          >,
        }),
      'corpus.path-unsafe'
    );
  });

  it('creates a clean detached isolation and cleans only its owned random container', () => {
    const root = temporaryRoot();
    const isolationRoot = temporaryRoot('lux-corpus-isolation-');
    const repository = createRepository(root);
    const sourceHead = commitSecond(repository);
    const manifestPath = writeManifest(root, manifestFor(repository.root, repository.firstCommit));

    const prepared = preflightCorpus({
      corpusId: 'example',
      manifestPath,
      isolationRoot,
      allowedCheckoutRoots: [root],
    });

    expect(prepared.resolution.isolated).toBe(true);
    expect(git(prepared.resolution.rootPath, 'rev-parse', 'HEAD')).toBe(repository.firstCommit);
    expect(() => git(prepared.resolution.rootPath, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(
      git(
        prepared.resolution.rootPath,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none'
      )
    ).toBe('');
    expect(git(repository.root, 'rev-parse', 'HEAD')).toBe(sourceHead);
    const isolatedRoot = prepared.resolution.rootPath;
    prepared.cleanup();
    prepared.cleanup();
    expect(existsSync(isolatedRoot)).toBe(false);
    expect(existsSync(repository.root)).toBe(true);
    expect(existsSync(isolationRoot)).toBe(true);
  });

  it.each(['staged', 'unstaged', 'untracked'] as const)(
    'snapshots committed content without modifying a %s dirty source',
    (kind) => {
      const root = temporaryRoot();
      const repository = createRepository(root);
      const manifestPath = writeManifest(
        root,
        manifestFor(repository.root, repository.firstCommit)
      );
      if (kind === 'staged') {
        writeFileSync(join(repository.root, 'fixture.txt'), 'staged\n');
        git(repository.root, 'add', 'fixture.txt');
      } else if (kind === 'unstaged') {
        writeFileSync(join(repository.root, 'fixture.txt'), 'unstaged\n');
      } else {
        writeFileSync(join(repository.root, 'owner-work.txt'), 'untracked\n');
      }
      const before = git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all');

      const prepared = preflightCorpus({ corpusId: 'example', manifestPath });
      expect(prepared.resolution.isolated).toBe(true);
      expect(prepared.resolution.rootPath).not.toBe(realpathSync(repository.root));
      expect(readFileSync(join(prepared.resolution.rootPath, 'fixture.txt'), 'utf8')).toBe(
        'first\n'
      );
      expect(existsSync(join(prepared.resolution.rootPath, 'owner-work.txt'))).toBe(false);
      prepared.cleanup();
      expect(git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
        before
      );
    }
  );

  it('refuses legacy direct mode before inspecting the source checkout', () => {
    const root = temporaryRoot();
    const marker = join(root, 'source-inspected');
    const manifestPath = join(root, 'missing-manifest.json');
    expectCode(
      () =>
        preflightCorpus({
          corpusId: 'example',
          manifestPath,
          checkoutOverrides: { example: marker },
          isolation: 'never',
        }),
      'corpus.isolation-required'
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects missing checkout and mismatched remotes, then snapshots a non-HEAD pin', () => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    const manifestPath = writeManifest(
      root,
      manifestFor(join(root, 'missing'), repository.firstCommit)
    );
    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath }),
      'corpus.checkout-missing'
    );

    writeManifest(root, manifestFor(repository.root, repository.firstCommit));
    git(repository.root, 'remote', 'set-url', 'origin', 'https://github.com/other/example.git');
    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath }),
      'corpus.remote-mismatch'
    );

    git(repository.root, 'remote', 'set-url', 'origin', 'https://github.com/nwshq/example.git');
    git(
      repository.root,
      'config',
      '--add',
      'remote.origin.url',
      'git@github.com:nwshq/example.git'
    );
    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath }),
      'corpus.remote-mismatch'
    );
    git(repository.root, 'config', '--unset-all', 'remote.origin.url');
    git(repository.root, 'remote', 'set-url', 'origin', 'https://github.com/nwshq/example.git');

    const sourceHead = commitSecond(repository);
    const sourceBefore = git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all');
    const prepared = preflightCorpus({ corpusId: 'example', manifestPath });
    expect(prepared.resolution.isolated).toBe(true);
    expect(prepared.resolution.rootPath).not.toBe(realpathSync(repository.root));
    expect(git(prepared.resolution.rootPath, 'rev-parse', 'HEAD')).toBe(repository.firstCommit);
    prepared.cleanup();
    expect(git(repository.root, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      sourceBefore
    );
  });

  it('requires an exact commit object reachable from HEAD or a branch', () => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    const manifestPath = writeManifest(root, manifestFor(repository.root, repository.firstCommit));

    const blob = git(repository.root, 'hash-object', '-w', '--stdin');
    writeManifest(root, manifestFor(repository.root, blob));
    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath }),
      'corpus.commit-unreachable'
    );

    git(repository.root, 'tag', '-a', 'annotated', '-m', 'tag');
    const tag = git(repository.root, 'rev-parse', 'annotated^{tag}');
    writeManifest(root, manifestFor(repository.root, tag));
    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath }),
      'corpus.commit-unreachable'
    );

    git(repository.root, 'checkout', '--orphan', 'replacement');
    git(repository.root, 'rm', '-q', '-rf', '.');
    writeFileSync(join(repository.root, 'replacement.txt'), 'replacement\n');
    git(repository.root, 'add', 'replacement.txt');
    git(repository.root, 'commit', '-q', '-m', 'replacement');
    const dangling = git(repository.root, 'commit-tree', 'HEAD^{tree}', '-m', 'dangling');
    writeManifest(root, manifestFor(repository.root, dangling));
    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath }),
      'corpus.commit-unreachable'
    );

    git(repository.root, 'branch', 'reachable-pin', dangling);
    writeManifest(root, manifestFor(repository.root, dangling));
    const prepared = preflightCorpus({ corpusId: 'example', manifestPath });
    expect(prepared.resolution.commit).toBe(dangling);
    prepared.cleanup();
  });

  it('disables replacement objects so pinned content cannot be substituted', () => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    const original = repository.firstCommit;
    writeFileSync(join(repository.root, 'fixture.txt'), 'replacement\n');
    git(repository.root, 'commit', '-qam', 'replacement');
    const replacement = git(repository.root, 'rev-parse', 'HEAD');
    git(repository.root, 'replace', original, replacement);
    const manifestPath = writeManifest(root, manifestFor(repository.root, original));

    const prepared = preflightCorpus({ corpusId: 'example', manifestPath });
    expect(readFileSync(join(prepared.resolution.rootPath, 'fixture.txt'), 'utf8')).toBe('first\n');
    expect(git(prepared.resolution.rootPath, 'rev-parse', 'HEAD')).toBe(original);
    prepared.cleanup();
  });

  it('rejects gitlinks before checkout or scanning', () => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    const submodule = createRepository(root, 'nested');
    git(
      repository.root,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${submodule.firstCommit},vendor`
    );
    git(repository.root, 'commit', '-q', '-m', 'gitlink');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    const manifestPath = writeManifest(root, manifestFor(repository.root, head));

    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath, isolation: 'always' }),
      'corpus.submodule-unsupported'
    );
    expect(existsSync(join(repository.root, 'vendor'))).toBe(false);
  });

  it('rejects checkout traversal and symlink path escapes', () => {
    const allowed = temporaryRoot();
    const outside = temporaryRoot();
    const repository = createRepository(outside);
    const manifestPath = writeManifest(
      allowed,
      manifestFor(repository.root, repository.firstCommit)
    );
    expectCode(
      () =>
        preflightCorpus({
          corpusId: 'example',
          manifestPath,
          allowedCheckoutRoots: [allowed],
        }),
      'corpus.path-unsafe'
    );

    const link = join(allowed, 'linked-checkout');
    symlinkSync(repository.root, link);
    expectCode(
      () =>
        preflightCorpus({
          corpusId: 'example',
          manifestPath,
          checkoutOverrides: { example: link },
          allowedCheckoutRoots: [allowed],
        }),
      'corpus.path-unsafe'
    );
    expectCode(
      () =>
        preflightCorpus({
          corpusId: 'example',
          manifestPath,
          checkoutOverrides: { example: '../escape' },
        }),
      'corpus.path-unsafe'
    );
  });

  it('accepts a tracked in-root symlink only in an owned isolated snapshot', () => {
    const root = temporaryRoot();
    const isolationRoot = temporaryRoot('lux-corpus-isolation-');
    const repository = createRepository(root);
    writeFileSync(join(repository.root, 'AGENTS.md'), 'safe instructions\n');
    symlinkSync('AGENTS.md', join(repository.root, 'CLAUDE.md'));
    git(repository.root, 'add', 'AGENTS.md', 'CLAUDE.md');
    git(repository.root, 'commit', '-q', '-m', 'safe tracked symlink');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    const manifestPath = writeManifest(root, manifestFor(repository.root, head));

    const sourceBefore = git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all');
    const isolated = preflightCorpus({ corpusId: 'example', manifestPath, isolationRoot });
    expect(isolated.resolution.isolated).toBe(true);
    expect(isolated.resolution.rootPath).not.toBe(realpathSync(repository.root));
    expect(readFileSync(join(isolated.resolution.rootPath, 'CLAUDE.md'), 'utf8')).toBe(
      'safe instructions\n'
    );
    isolated.cleanup();
    expect(git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      sourceBefore
    );
  });

  it.each([
    { name: 'absolute', target: '/etc/passwd' },
    { name: 'parent traversal', target: '../../outside' },
  ])('rejects a tracked $name symlink target before checkout', ({ target }) => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    symlinkSync(target, join(repository.root, 'escape'));
    git(repository.root, 'add', 'escape');
    git(repository.root, 'commit', '-q', '-m', 'unsafe tracked symlink');
    const head = git(repository.root, 'rev-parse', 'HEAD');
    const manifestPath = writeManifest(root, manifestFor(repository.root, head));

    expectCode(
      () => preflightCorpus({ corpusId: 'example', manifestPath, isolation: 'always' }),
      'corpus.symlink-unsafe'
    );
  });

  it('passes hostile IDs/paths/pins as argv and never invokes text as a command', () => {
    const root = temporaryRoot();
    const marker = join(root, 'pwned');
    const repository = createRepository(root, 'checkout;touch pwned');
    const manifestPath = writeManifest(root, manifestFor(repository.root, repository.firstCommit));
    const sourceBefore = git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all');
    const prepared = preflightCorpus({ corpusId: 'example', manifestPath });
    expect(prepared.resolution.isolated).toBe(true);
    expect(prepared.resolution.rootPath).not.toBe(realpathSync(repository.root));
    expect(existsSync(marker)).toBe(false);
    prepared.cleanup();
    expect(git(repository.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      sourceBefore
    );

    const hostile = `${repository.firstCommit};touch${marker}`;
    writeManifest(root, manifestFor(repository.root, hostile));
    expectCode(() => loadCorpusManifest(manifestPath), 'corpus.schema-unsupported');
    expect(existsSync(marker)).toBe(false);
  });

  it.each([undefined, 'always', 'when-needed'] as const)(
    'does not execute source hooks or filters while producing isolation %s',
    (isolation) => {
      const root = temporaryRoot();
      const isolationRoot = temporaryRoot('lux-corpus-isolation-');
      const repository = createRepository(root);
      const hookMarker = join(root, 'hook-ran');
      const filterMarker = join(root, 'filter-ran');
      const hook = join(repository.root, '.git', 'hooks', 'post-checkout');
      writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`);
      chmodSync(hook, 0o755);
      git(repository.root, 'config', 'filter.sentinel.clean', `touch '${filterMarker}'; cat`);
      git(repository.root, 'config', 'filter.sentinel.smudge', `touch '${filterMarker}'; cat`);
      writeFileSync(join(repository.root, '.gitattributes'), 'filtered.txt filter=sentinel\n');
      writeFileSync(join(repository.root, 'filtered.txt'), 'safe\n');
      git(repository.root, 'add', '.gitattributes', 'filtered.txt');
      git(repository.root, 'commit', '-q', '-m', 'filter fixture');
      writeFileSync(join(repository.root, 'filtered.txt'), 'dirty source sentinel\n');
      rmSync(hookMarker, { force: true });
      rmSync(filterMarker, { force: true });
      const head = git(repository.root, 'rev-parse', 'HEAD');
      const manifestPath = writeManifest(root, manifestFor(repository.root, head));

      const prepared = preflightCorpus({
        corpusId: 'example',
        manifestPath,
        isolation,
        isolationRoot,
      });
      expect(readFileSync(join(prepared.resolution.rootPath, 'filtered.txt'), 'utf8')).toBe(
        'safe\n'
      );
      expect(existsSync(hookMarker)).toBe(false);
      expect(existsSync(filterMarker)).toBe(false);
      prepared.cleanup();
    }
  );

  it('opens no DB and invokes no operation after one-corpus preflight failure', async () => {
    const root = temporaryRoot();
    const repository = createRepository(root);
    const manifestPath = writeManifest(root, manifestFor(repository.root, repository.firstCommit));
    git(repository.root, 'remote', 'set-url', 'origin', 'git@github.com:other/example.git');
    const dbMarker = join(root, 'db-opened');

    await expect(
      withPreflightCorpus({ corpusId: 'example', manifestPath }, () => {
        writeFileSync(dbMarker, 'opened');
      })
    ).rejects.toMatchObject({ code: 'corpus.remote-mismatch' });
    expect(existsSync(dbMarker)).toBe(false);
  });

  it('enforces a global all-corpora barrier and rolls back earlier resources', async () => {
    const root = temporaryRoot();
    const isolationRoot = temporaryRoot('lux-corpus-isolation-');
    const first = createRepository(root, 'first');
    const second = createRepository(root, 'second');
    git(first.root, 'remote', 'set-url', 'origin', 'https://github.com/nwshq/first.git');
    git(second.root, 'remote', 'set-url', 'origin', 'https://github.com/other/second.git');
    const manifest: CorpusManifestV1 = {
      schemaVersion: 1,
      owner: 'Example Maintainer',
      corpora: [
        entry(first.root, first.firstCommit, 'first'),
        entry(second.root, second.firstCommit, 'second'),
      ],
    };
    const manifestPath = writeManifest(root, manifest);
    const dbMarker = join(root, 'db-opened');

    await expect(
      withPreflightCorpora(
        {
          corpusIds: ['first', 'second'],
          manifestPath,
          isolation: 'always',
          isolationRoot,
        },
        () => writeFileSync(dbMarker, 'opened')
      )
    ).rejects.toMatchObject({ code: 'corpus.remote-mismatch' });
    expect(existsSync(dbMarker)).toBe(false);
    expect(existsSync(first.root)).toBe(true);
    expect(existsSync(second.root)).toBe(true);
    expect(
      execFileSync('find', [isolationRoot, '-mindepth', '1', '-maxdepth', '1'], {
        encoding: 'utf8',
      }).trim()
    ).toBe('');
  });

  it('returns no resolutions for duplicate selections and cleans successful batches', () => {
    const root = temporaryRoot();
    const isolationRoot = temporaryRoot('lux-corpus-isolation-');
    const repository = createRepository(root);
    const manifestPath = writeManifest(root, manifestFor(repository.root, repository.firstCommit));
    expectCode(
      () =>
        preflightCorpora({
          corpusIds: ['example', 'example'],
          manifestPath,
        }),
      'corpus.id-missing'
    );
    const prepared = preflightCorpora({
      corpusIds: ['example'],
      manifestPath,
      isolationRoot,
    });
    expect(prepared.resolutions[0].isolated).toBe(true);
    expect(prepared.resolutions[0].rootPath).not.toBe(realpathSync(repository.root));
    const isolated = prepared.resolutions[0].rootPath;
    expect(relative(realpathSync(isolationRoot), isolated)).not.toMatch(/^\.\./u);
    prepared.cleanup();
    prepared.cleanup();
    expect(existsSync(isolated)).toBe(false);
  });
});
