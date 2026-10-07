import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  buildIncrementalPlan,
  collectOverlayRelevantPaths,
  commitIncrementalSync,
  hasOverlayRelevantChanges,
  type IncrementalSyncWriter,
} from '../incremental.js';
import type { GitDiffResult } from '../git.js';

describe('buildIncrementalPlan', () => {
  const testDir = join(tmpdir(), 'lux-incremental-test-' + Date.now());

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should handle empty diff', () => {
    const diff: GitDiffResult = { added: [], modified: [], deleted: [] };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toDelete).toEqual([]);
    expect(plan.toIndex).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it('should include added markdown file in toIndex', () => {
    writeFileSync(join(testDir, 'doc.md'), '---\ntitle: Test Doc\n---\nHello world');
    const diff: GitDiffResult = { added: ['doc.md'], modified: [], deleted: [] };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toHaveLength(1);
    expect(plan.toIndex[0].title).toBe('Test Doc');
    expect(plan.toIndex[0].type).toBe('general');
    expect(plan.toIndex[0].filePath).toBe(join(testDir, 'doc.md'));
    expect(plan.toDelete).toHaveLength(0);
  });

  it('should include added source code file as source-code type', () => {
    writeFileSync(join(testDir, 'app.ts'), 'console.log("hello");');
    const diff: GitDiffResult = { added: ['app.ts'], modified: [], deleted: [] };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toHaveLength(1);
    expect(plan.toIndex[0].type).toBe('source-code');
    expect(plan.toIndex[0].title).toBe('app.ts');
  });

  it('should include deleted file in toDelete as absolute path', () => {
    const diff: GitDiffResult = { added: [], modified: [], deleted: ['old.md'] };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toDelete).toHaveLength(1);
    expect(plan.toDelete[0]).toBe(join(testDir, 'old.md'));
    expect(plan.toIndex).toHaveLength(0);
  });

  it('should handle modified file: appears in both toDelete and toIndex', () => {
    writeFileSync(join(testDir, 'changed.md'), '# Updated');
    const diff: GitDiffResult = { added: [], modified: ['changed.md'], deleted: [] };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toDelete).toHaveLength(1);
    expect(plan.toDelete[0]).toBe(join(testDir, 'changed.md'));
    expect(plan.toIndex).toHaveLength(1);
    expect(plan.toIndex[0].filePath).toBe(join(testDir, 'changed.md'));
  });

  it('should filter out files in node_modules', () => {
    const diff: GitDiffResult = {
      added: ['node_modules/pkg/index.ts'],
      modified: [],
      deleted: [],
    };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it('should filter out non-indexable files (.png, .lock)', () => {
    const diff: GitDiffResult = {
      added: ['image.png', 'package-lock.json.lock', 'photo.jpg'],
      modified: [],
      deleted: [],
    };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toHaveLength(0);
    expect(plan.unchanged).toBe(3);
  });

  it('keeps a credential file on the deny list out, naming it, and deletes any old row', () => {
    mkdirSync(join(testDir, 'config'), { recursive: true });
    writeFileSync(join(testDir, 'config', 'auth.json'), '{"token":"x"}');
    writeFileSync(join(testDir, 'auth.json'), '{"token":"y"}');
    const diff: GitDiffResult = {
      added: ['config/auth.json'],
      modified: ['auth.json'],
      deleted: [],
    };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toEqual([]);
    expect(plan.toDelete).toEqual([join(testDir, 'auth.json')]);
    expect(plan.denied).toEqual(['auth.json', 'config/auth.json']);
  });

  it('selects with the same include and ignore globs as a rebuild', () => {
    mkdirSync(join(testDir, 'public'), { recursive: true });
    mkdirSync(join(testDir, '.github'), { recursive: true });
    writeFileSync(join(testDir, 'public', 'app.js'), 'x');
    writeFileSync(join(testDir, '.github', 'ci.yml'), 'x');
    const diff: GitDiffResult = {
      added: ['public/app.js', '.github/ci.yml'],
      modified: [],
      deleted: [],
    };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it('should infer markdown type from path', () => {
    mkdirSync(join(testDir, 'methodology'), { recursive: true });
    writeFileSync(join(testDir, 'methodology', 'guide.md'), '# Guide');
    const diff: GitDiffResult = { added: ['methodology/guide.md'], modified: [], deleted: [] };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toHaveLength(1);
    expect(plan.toIndex[0].type).toBe('methodology');
  });

  it('should filter out vendor directory files', () => {
    const diff: GitDiffResult = {
      added: ['vendor/lib/file.php'],
      modified: [],
      deleted: [],
    };
    const plan = buildIncrementalPlan(testDir, diff);

    expect(plan.toIndex).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
  });

  it('should detect overlay-relevant source changes', () => {
    const diff: GitDiffResult = {
      added: ['src/app.ts', 'docs/readme.md'],
      modified: ['routes/api.php'],
      deleted: [],
    };

    expect(collectOverlayRelevantPaths(diff)).toEqual(['src/app.ts', 'routes/api.php']);
    expect(hasOverlayRelevantChanges(diff)).toBe(true);
  });

  it('should ignore non-structural changes for overlay relevance', () => {
    const diff: GitDiffResult = {
      added: ['docs/readme.md'],
      modified: ['notes/plan.md'],
      deleted: [],
    };

    expect(collectOverlayRelevantPaths(diff)).toEqual([]);
    expect(hasOverlayRelevantChanges(diff)).toBe(false);
  });
});

describe('commitIncrementalSync — crash-atomic ordering (MAJOR 1 / OQ4)', () => {
  /** A spy writer recording the order of the ordering-sensitive calls. `transaction` runs its fn
   *  synchronously (mirrors the WASM adapter) so the recorded order is the real commit order. */
  function spyWriter(): { db: IncrementalSyncWriter; calls: string[] } {
    const calls: string[] = [];
    const db: IncrementalSyncWriter = {
      transaction<T>(fn: () => T): T {
        calls.push('transaction:begin');
        const r = fn();
        calls.push('transaction:commit');
        return r;
      },
      markEdgesStaleForFiles(paths) {
        calls.push('markEdgesStaleForFiles');
        return paths.length;
      },
      markEdgesStaleByEvidencePaths(paths) {
        calls.push('markEdgesStaleByEvidencePaths');
        return paths.length;
      },
      setIndexMetadata(key) {
        calls.push(`setIndexMetadata:${key}`);
      },
    };
    return { db, calls };
  }

  it('writes both stale-mark dimensions BEFORE the last_indexed_commit pointer (mark-only)', () => {
    const { db, calls } = spyWriter();
    const counts = commitIncrementalSync(db, () => calls.push('writeContent'), {
      overlayRelevantPaths: ['routes/web.php', 'app/Handler.php'],
      headCommit: 'deadbeef',
      markOnly: true,
    });

    // The invariant: content writes → both marks → pointer, all inside one transaction.
    expect(calls).toEqual([
      'transaction:begin',
      'writeContent',
      'markEdgesStaleForFiles',
      'markEdgesStaleByEvidencePaths',
      'setIndexMetadata:last_indexed_commit',
      'transaction:commit',
    ]);
    // The crash-atomicity guard: neither mark may follow the pointer advance.
    const pointerIdx = calls.indexOf('setIndexMetadata:last_indexed_commit');
    expect(calls.indexOf('markEdgesStaleForFiles')).toBeLessThan(pointerIdx);
    expect(calls.indexOf('markEdgesStaleByEvidencePaths')).toBeLessThan(pointerIdx);
    expect(counts).toEqual({ edgesMarkedNodePath: 2, edgesMarkedEvidence: 2 });
  });

  it('non-mark-only sync advances the pointer but writes no marks', () => {
    const { db, calls } = spyWriter();
    const counts = commitIncrementalSync(db, () => calls.push('writeContent'), {
      overlayRelevantPaths: [],
      headCommit: 'cafe',
      markOnly: false,
    });

    expect(calls).toEqual([
      'transaction:begin',
      'writeContent',
      'setIndexMetadata:last_indexed_commit',
      'transaction:commit',
    ]);
    expect(counts).toEqual({ edgesMarkedNodePath: 0, edgesMarkedEvidence: 0 });
  });
});
