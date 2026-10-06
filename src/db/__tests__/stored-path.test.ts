// Paths are stored corpus-relative, and the database refuses an absolute one (issue #16).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { assertStoredPath, resolveStoredPath, toStoredPath } from '../stored-path.js';

describe('toStoredPath / resolveStoredPath', () => {
  it('makes an absolute path under the corpus relative to it', () => {
    expect(toStoredPath('/work/repo', '/work/repo/src/a.ts')).toBe('src/a.ts');
    expect(toStoredPath('/work/repo/', '/work/repo/README.md')).toBe('README.md');
  });

  it('gives two checkouts of one tree the same stored path', () => {
    expect(toStoredPath('/ci/build-17/repo', '/ci/build-17/repo/docs/x.md')).toBe(
      toStoredPath('/Users/someone/code/repo', '/Users/someone/code/repo/docs/x.md')
    );
  });

  it('leaves a relative path as it is', () => {
    expect(toStoredPath('/work/repo', 'src/a.ts')).toBe('src/a.ts');
  });

  it('does not treat a sibling directory with a longer name as inside the corpus', () => {
    expect(toStoredPath('/work/repo', '/work/repo-old/a.ts')).toBe('../repo-old/a.ts');
  });

  it('resolves a stored path against the corpus root the reader runs with', () => {
    expect(resolveStoredPath('/elsewhere/repo', 'src/a.ts')).toBe('/elsewhere/repo/src/a.ts');
    expect(resolveStoredPath('/elsewhere/repo', '/abs/a.ts')).toBe('/abs/a.ts');
  });

  it('round-trips', () => {
    const stored = toStoredPath('/work/repo', '/work/repo/src/Module/Users/readme.md');
    expect(resolveStoredPath('/work/repo', stored)).toBe('/work/repo/src/Module/Users/readme.md');
  });

  it.each(['/abs/a.ts', 'C:\\repo\\a.ts', 'C:/repo/a.ts', '\\\\server\\share\\a.ts'])(
    'assertStoredPath refuses %s',
    (path) => {
      expect(() => assertStoredPath(path, 'x')).toThrow(/corpus-relative/);
    }
  );

  it.each(['src/a.ts', 'README.md', '../outside/a.ts', './a.ts'])(
    'assertStoredPath accepts %s',
    (path) => {
      expect(() => assertStoredPath(path, 'x')).not.toThrow();
    }
  );
});

describe('the database refuses absolute paths', () => {
  let dir: string;
  let db: LuxDatabase;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-stored-path-'));
    db = new LuxDatabase(join(dir, 'lux.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (file_path: string) => ({ type: 'general', title: 'T', file_path, content: 'c' });

  it('on inserting a knowledge entry, and stores nothing', () => {
    expect(() => db.insertKnowledgeEntry(entry('/work/repo/docs/a.md'))).toThrow(
      /knowledge_entries\.file_path must be a corpus-relative path.*\/work\/repo\/docs\/a\.md/
    );
    expect(db.getAllKnowledgeEntries()).toEqual([]);
  });

  it('on deleting or looking up a knowledge entry, instead of matching nothing in silence', () => {
    db.insertKnowledgeEntry(entry('docs/a.md'));
    expect(() => db.deleteKnowledgeEntryByPath('/work/repo/docs/a.md')).toThrow(/corpus-relative/);
    expect(() => db.getKnowledgeEntryByPath('/work/repo/docs/a.md')).toThrow(/corpus-relative/);
    expect(db.getAllKnowledgeEntries()).toHaveLength(1);

    expect(db.getKnowledgeEntryByPath('docs/a.md')?.title).toBe('T');
    db.deleteKnowledgeEntryByPath('docs/a.md');
    expect(db.getAllKnowledgeEntries()).toEqual([]);
  });

  it('stores an operational boundary under the corpus root, not the directory it was indexed in', () => {
    db.upsertOperationalBoundary({
      id: 'opb:command:report:send',
      repo_root: '/ci/build-17/repo',
      kind: 'command',
      name: 'report:send',
      trust_tier: 5,
      file_path: 'src/Console/SendReport.php',
    });

    // Read back without naming a root: a reader in another checkout finds the same boundary.
    expect(db.getOperationalBoundaries().map((b) => [b.id, b.repo_root])).toEqual([
      ['opb:command:report:send', '.'],
    ]);
    expect(db.getOperationalBoundary('opb:command:report:send')?.repo_root).toBe('.');
  });

  it('on inserting a module dependency whose samples include one', () => {
    const dep = (files: string[]) => ({
      source_module: 'A',
      target_module: 'B',
      reference_count: 1,
      sample_files: JSON.stringify(files),
    });
    expect(() => db.insertModuleDependency(dep(['src/A/x.php', '/work/repo/src/A/y.php']))).toThrow(
      /module_dependencies\.sample_files must be a corpus-relative path/
    );
    expect(db.getModuleDependencies('A', 'source')).toEqual([]);

    db.insertModuleDependency(dep(['src/A/x.php']));
    expect(db.getModuleDependencies('A', 'source')).toHaveLength(1);
  });
});
