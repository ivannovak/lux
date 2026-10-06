// A changed file the closure's added-symbol check cannot parse escalates the scoped refresh.
//
// The closure pulls in the unchanged importers of a changed file that gained a symbol. If that file
// cannot be parsed, whether it gained one is unknown; a refresh that carried on would leave the
// importer un-refreshed, with nothing saying so. The refresh must stop before writing instead.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const failing = vi.hoisted(() => ({ relPath: undefined as string | undefined, noTree: false }));

vi.mock('../../ast/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ast/extract.js')>();
  return {
    ...actual,
    extractSource: ((grammars, source, relPath, lang) => {
      if (relPath === failing.relPath) {
        if (!failing.noTree) throw new Error('parser crashed');
        return {
          extraction: {
            nodes: [],
            edges: [],
            moduleFacts: [],
            diagnostics: [{ code: 'parse-error', message: actual.NO_SYNTAX_TREE }],
          },
          hadError: true,
        };
      }
      return actual.extractSource(grammars, source, relPath, lang);
    }) as typeof actual.extractSource,
  };
});

const { LuxDatabase } = await import('../../../db/index.js');
const { rebuildWithOverlay } = await import('../../rebuild-orchestrator.js');
const { loadLspConfig } = await import('../../config.js');
const { refreshOverlayScoped } = await import('../overlay-refresh.js');

const roots: string[] = [];

afterEach(() => {
  failing.relPath = undefined;
  failing.noTree = false;
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const A_V1 = 'export function existing(): number {\n  return 1;\n}\n';
const A_V2 = A_V1 + 'export function added(): number {\n  return 2;\n}\n';
const C =
  "import { existing, added } from './a';\nexport function uses(): number {\n  return existing() + added();\n}\n";

async function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'lux-closure-parse-'));
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-closure-parse-db-'));
  roots.push(repo, dbDir);
  execSync('git init -q && git config user.email a@b.c && git config user.name x', { cwd: repo });
  writeFileSync(join(repo, 'package.json'), '{"name":"closure-parse"}');
  // Nova off, so only the closure can bring the unchanged importer into the refresh.
  writeFileSync(
    join(repo, 'lux.yaml'),
    'lsp:\n  enabled: false\n  enrichers: []\nframeworks:\n  nova:\n    enabled: false\n'
  );
  writeFileSync(join(repo, 'a.ts'), A_V1);
  writeFileSync(join(repo, 'c.ts'), C);
  execSync('git add -A && git commit -q -m A', { cwd: repo });
  const db = new LuxDatabase(join(dbDir, 'lux.db'));
  await rebuildWithOverlay(db, repo);
  writeFileSync(join(repo, 'a.ts'), A_V2);
  execSync('git add -A && git commit -q -m B', { cwd: repo });
  const refresh = () =>
    refreshOverlayScoped(db, repo, [{ relPath: 'a.ts', status: 'modified' }], loadLspConfig(repo));
  return { db, refresh };
}

describe('scoped refresh — a changed file the closure check cannot parse', () => {
  it('control: a parseable change pulls the importer in and completes', async () => {
    const { db, refresh } = await setup();
    const result = await refresh();
    expect(result.escalation).toBeUndefined();
    expect(result.refreshedPaths).toContain('c.ts');
    db.close();
  });

  for (const noTree of [false, true]) {
    it(`escalates before writing when ${noTree ? 'tree-sitter returns no tree' : 'the parser throws'}`, async () => {
      const { db, refresh } = await setup();
      const before = db.countEdgesByFreshness();
      const nodesBefore = db.getStructuralNodesForFilePaths(['a.ts', 'c.ts']).map((n) => n.id);
      failing.relPath = 'a.ts';
      failing.noTree = noTree;

      const result = await refresh();

      expect(result.escalation).toBe('closure-parse-failed');
      expect(result.refreshedPaths).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('AST extraction failed for a.ts');
      expect(result.warningComponents[result.warnings[0]]).toBe('ast-file:a.ts');
      // Nothing written: same nodes, no fence marks.
      expect(db.countEdgesByFreshness()).toEqual(before);
      expect(db.getStructuralNodesForFilePaths(['a.ts', 'c.ts']).map((n) => n.id)).toEqual(
        nodesBefore
      );
      db.close();
    });
  }
});
