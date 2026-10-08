// What a rebuild or sync prints (issue #6): each warning once; malformed frontmatter warned about
// and still indexed; a failed `--embeddings` model fetch warned about; nothing at all from a clean
// `--quiet` run on any path; migrations only under `--verbose`; and warnings an earlier run raised
// labelled as carried, until a run that re-runs their component cleanly retires them.

import { describe, it, expect, afterEach } from 'vitest';
import { LuxDatabase } from '../../db/index.js';
import {
  BAD_FRONTMATTER,
  LSP_LESS,
  MISSING_TS_SERVER,
  TS_LSP,
  commitFile,
  dbPathIn,
  expectSilent,
  linesMatching,
  removeTempDirs,
  repoWith,
  runLux,
  tempDir,
} from './run-output-harness.js';

afterEach(removeTempDirs);

describe('run output rules (issue #6)', () => {
  it('prints a warning raised both now and by an earlier run once, as this run’s', () => {
    const repo = repoWith({
      'lux.yaml': MISSING_TS_SERVER,
      'package.json': '{}',
      'a.ts': 'export const a = 1;\n',
    });
    const dbPath = dbPathIn();
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
    commitFile(repo, 'a.ts', 'export const a = 2;\n');

    const r = runLux(repo, dbPath, ['index', 'sync', '--mark-only']);
    expect(r.status, r.stderr).toBe(0);
    const lines = linesMatching(r.stderr, 'Failed to initialize typescript enricher');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Warning: Failed to initialize typescript enricher/);
  });

  it('warns about malformed frontmatter and still indexes the file, on rebuild and on sync', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'package.json': '{}',
      'bad.md': BAD_FRONTMATTER,
    });
    const dbPath = dbPathIn();
    const contentOf = (): string | undefined => {
      const db = new LuxDatabase(dbPath);
      try {
        return db.getKnowledgeEntryByPath('bad.md')?.content;
      } finally {
        db.close();
      }
    };

    const rebuild = runLux(repo, dbPath, ['index', 'rebuild']);
    expect(rebuild.status, rebuild.stderr).toBe(0);
    expect(rebuild.stderr).toMatch(/^Warning: malformed frontmatter in bad\.md; /m);
    expect(rebuild.stdout).toMatch(/^⚠ Index rebuilt with \d+ warning\(s\)$/m);
    expect(contentOf()).toContain('body text that must stay indexed');

    commitFile(repo, 'bad.md', BAD_FRONTMATTER + 'and a second line\n');
    const sync = runLux(repo, dbPath, ['index', 'sync']);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stdout).toContain('Sync path: incremental content sync');
    expect(sync.stderr).toMatch(/^Warning: malformed frontmatter in bad\.md; /m);
    expect(sync.stdout).toMatch(/^⚠ Synced with \d+ warning\(s\): /m);
    expect(contentOf()).toContain('and a second line');
  });

  it('warns when `index rebuild --embeddings` cannot fetch the model', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'a.md': '# a\n' });

    const r = runLux(repo, dbPathIn(), ['index', 'rebuild', '--embeddings'], {
      faults: 'model-fetch',
      env: { HOME: tempDir('lux-output-home-') },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(
      /^Warning: could not fetch the embedding model \(.*injected fetch failure.*\); continued without anchor embeddings$/m
    );
    expect(r.stdout).toMatch(/^⚠ Index rebuilt with \d+ warning\(s\)$/m);
    expect(`${r.stdout}${r.stderr}`).not.toContain('✓');
  });

  it('prints nothing from a clean `--quiet` run on every rebuild and sync path', () => {
    const repo = repoWith({
      'lux.yaml': TS_LSP,
      'package.json': JSON.stringify({ name: 'quiet-fx', private: true, type: 'module' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
      'a.ts': 'export function a(): number {\n  return 1;\n}\n',
    });
    const dbPath = dbPathIn();

    expectSilent(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']));

    commitFile(repo, 'a.ts', 'export function a(): number {\n  return 2;\n}\n');
    const scoped = runLux(repo, dbPath, ['index', 'sync', '--quiet']);
    expectSilent(scoped);

    commitFile(repo, 'notes.md', '# notes\n');
    expectSilent(runLux(repo, dbPath, ['index', 'sync', '--quiet']));

    commitFile(repo, 'lux.yaml', TS_LSP + '# config edit\n');
    expectSilent(runLux(repo, dbPath, ['index', 'sync', '--quiet']));

    expectSilent(runLux(repo, dbPath, ['index', 'sync', '--force', '--quiet']));
  });

  it('prints migrations only under --verbose, and never under --quiet', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'a.md': '# a\n' });

    const plain = runLux(repo, dbPathIn(), ['index', 'rebuild', '--content-only']);
    expect(plain.status, plain.stderr).toBe(0);
    expect(`${plain.stdout}${plain.stderr}`).not.toContain('migration');

    const verbose = runLux(repo, dbPathIn(), ['index', 'rebuild', '--content-only'], {
      globalArgs: ['--verbose'],
    });
    expect(verbose.status, verbose.stderr).toBe(0);
    expect(verbose.stderr).toContain('Applying migration 1: initial_schema');

    const both = runLux(repo, dbPathIn(), ['index', 'rebuild', '--content-only', '--quiet'], {
      globalArgs: ['--verbose'],
    });
    expectSilent(both);
  });
});
