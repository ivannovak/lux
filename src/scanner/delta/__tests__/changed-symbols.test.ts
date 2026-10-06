// `touched.changedSymbolIds` (issue #41): the symbols a change modified, as opposed to
// `touched.symbolIds`, every symbol declared in a changed file. Each case commits a base version
// and a changed version of a real file and reads the envelope computeDelta produces for the span.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { computeDelta } from '../run.js';
import type { DeltaOptions, DeltaReportV1 } from '../types.js';

const BILLING = 'app/Services/Billing.php';
const CLASS = 'symbol:php:App\\Services\\Billing';
const TOTAL = `${CLASS}::total`;
const TAX = `${CLASS}::tax`;
const FEE = `${CLASS}::fee`;

const BILLING_BASE = `<?php

namespace App\\Services;

class Billing
{
    private int $rate = 1;

    /**
     * The total.
     */
    public function total(): int
    {
        return 1;
    }

    public function tax(): int
    {
        return 2;
    }

    public function fee(): int
    {
        return 3;
    }
}
`;

let repo: string;
let db: LuxDatabase;

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
}

function write(relPath: string, content: string): void {
  mkdirSync(dirname(join(repo, relPath)), { recursive: true });
  writeFileSync(join(repo, relPath), content);
}

function commit(message: string): void {
  git('add -A');
  git(`commit -q -m ${message}`);
}

function symbol(id: string, filePath: string): void {
  db.upsertStructuralNode({ id, node_type: 'symbol', file_path: filePath, updated_at: 1 });
}

function edge(source: string, target: string, type: 'calls' | 'handled_by'): void {
  db.upsertStructuralEdge({
    id: `${source}->${target}:${type}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: type,
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

const OPTIONS: DeltaOptions = {
  base: 'HEAD~1',
  committedOnly: true,
  depth: 6,
  maxNodes: 2000,
  maxFanout: 64,
  minConfidence: 'framework-inferred',
  json: true,
};

async function delta(over: Partial<DeltaOptions> = {}): Promise<DeltaReportV1> {
  const result = await computeDelta(db, repo, { ...OPTIONS, ...over });
  if ('refusal' in result) throw new Error(result.refusal.message);
  return result.report;
}

/** Commit `BILLING_BASE`, then the edited file, and return the delta over that one commit. */
async function afterEditing(edit: (source: string) => string): Promise<DeltaReportV1> {
  write(BILLING, BILLING_BASE);
  commit('base');
  const edited = edit(BILLING_BASE);
  expect(edited).not.toBe(BILLING_BASE);
  write(BILLING, edited);
  commit('change');
  return delta();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lux-changed-symbols-'));
  git('init -q');
  git('config user.email test@example.com');
  git('config user.name Test');
  git('config commit.gpgsign false');
  db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
  write('.gitignore', '.lux/\n');
  for (const id of [CLASS, TOTAL, TAX, FEE]) symbol(id, BILLING);
});

afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('a class with three methods, one edited', () => {
  it('lists the edited method as changed and every symbol of the file as file-level', async () => {
    const report = await afterEditing((source) => source.replace('return 2;', 'return 20;'));

    expect(report.touched.changedSymbolIds).toEqual([TAX]);
    expect(report.touched.changedSymbols).toBe(1);
    expect(report.touched.symbolChanges).toEqual([{ id: TAX, change: 'modified', path: BILLING }]);
    expect([...report.touched.symbolIds].sort()).toEqual([CLASS, FEE, TAX, TOTAL].sort());
    expect(report.touched.symbols).toBe(4);
  });

  it('lists the class when a line of its own changes, and none of its methods', async () => {
    const report = await afterEditing((source) => source.replace('$rate = 1;', '$rate = 2;'));

    expect(report.touched.symbolChanges).toEqual([
      { id: CLASS, change: 'modified', path: BILLING },
    ]);
  });
});

describe('symbols a change adds, removes or moves', () => {
  it('reports an added method as added, and the class whose body gained it as unchanged', async () => {
    const report = await afterEditing((source) =>
      source.replace(
        '    public function fee(): int',
        '    public function discount(): int\n    {\n        return 4;\n    }\n\n    public function fee(): int'
      )
    );

    expect(report.touched.symbolChanges).toEqual([
      { id: `${CLASS}::discount`, change: 'added', path: BILLING },
    ]);
  });

  it('reports a removed method as removed', async () => {
    const report = await afterEditing((source) =>
      source.replace('    public function tax(): int\n    {\n        return 2;\n    }\n\n', '')
    );

    expect(report.touched.symbolChanges).toEqual([{ id: TAX, change: 'removed', path: BILLING }]);
  });

  it('reports a method that changed place, unedited, as moved, and its neighbours not at all', async () => {
    const fee = '    public function fee(): int\n    {\n        return 3;\n    }\n';
    const report = await afterEditing((source) =>
      source
        .replace(`\n${fee}`, '')
        .replace('    /**\n     * The total.', `${fee}\n    /**\n     * The total.`)
    );

    expect(report.touched.symbolChanges).toEqual([{ id: FEE, change: 'moved', path: BILLING }]);
  });
});

describe('changes that alter no code', () => {
  it('reports no changed symbol for a docblock-only change, and names the file as cosmetic', async () => {
    const report = await afterEditing((source) => source.replace('The total.', 'The grand total.'));

    expect(report.touched.changedSymbolIds).toEqual([]);
    expect(report.touched.precision.cosmeticOnly).toEqual([BILLING]);
    expect(report.touched.symbols).toBe(4);
  });

  it('reports no changed symbol for a whitespace-only change', async () => {
    const report = await afterEditing((source) =>
      source.replace('        return 2;', '            return 2;\n')
    );

    expect(report.touched.changedSymbolIds).toEqual([]);
    expect(report.touched.precision.cosmeticOnly).toEqual([BILLING]);
  });

  it('reports no changed symbol for a line comment added inside a method', async () => {
    const report = await afterEditing((source) =>
      source.replace(
        '        return 2;',
        '        // doubled later\n        # legacy note\n        return 2;'
      )
    );

    expect(report.touched.changedSymbolIds).toEqual([]);
    expect(report.touched.precision.cosmeticOnly).toEqual([BILLING]);
  });

  it('treats a PHP attribute as code, not as a `#` comment', async () => {
    const report = await afterEditing((source) =>
      source.replace(
        '    public function tax(): int',
        '    #[Deprecated]\n    public function tax(): int'
      )
    );

    expect(report.touched.symbolChanges).toEqual([{ id: TAX, change: 'modified', path: BILLING }]);
  });

  it('still reports a comment change that sits beside a code change', async () => {
    const report = await afterEditing((source) =>
      source.replace('The total.', 'The grand total.').replace('return 3;', 'return 30;')
    );

    expect(report.touched.changedSymbolIds).toEqual([FEE]);
    expect(report.touched.precision.cosmeticOnly).toEqual([]);
  });
});

describe('a change outside any symbol', () => {
  const BOOT = 'bootstrap/helpers.php';
  const HELPER = 'symbol:php:helper';
  const base = '<?php\n\nfunction helper(): int\n{\n    return 1;\n}\n\n$limit = 1;\n';

  it('names the file, reports no changed symbol, and still lists the file-level set', async () => {
    symbol(HELPER, BOOT);
    write(BOOT, base);
    commit('base');
    write(BOOT, base.replace('$limit = 1;', '$limit = 2;'));
    commit('change');
    const report = await delta();

    expect(report.touched.changedSymbolIds).toEqual([]);
    expect(report.touched.precision.changedOutsideSymbols).toEqual([BOOT]);
    expect(report.touched.precision.cosmeticOnly).toEqual([]);
    expect(report.touched.symbolIds).toEqual([HELPER]);
  });
});

describe('a renamed file', () => {
  const MOVED = 'app/Billing/Billing.php';

  it('reports no changed symbol for a pure rename and says so', async () => {
    write(BILLING, BILLING_BASE);
    commit('base');
    mkdirSync(join(repo, 'app/Billing'), { recursive: true });
    git(`mv ${BILLING} ${MOVED}`);
    commit('rename');
    const report = await delta();

    expect(report.changeSet.files).toMatchObject([{ path: MOVED, status: 'renamed' }]);
    expect(report.touched.changedSymbolIds).toEqual([]);
    expect(report.touched.precision.renamedOnly).toEqual([MOVED]);
  });

  it('reports the edited method of a rename with edits', async () => {
    write(BILLING, BILLING_BASE);
    commit('base');
    mkdirSync(join(repo, 'app/Billing'), { recursive: true });
    git(`mv ${BILLING} ${MOVED}`);
    write(MOVED, BILLING_BASE.replace('return 2;', 'return 20;'));
    commit('rename-and-edit');
    const report = await delta();

    expect(report.changeSet.files).toMatchObject([{ path: MOVED, status: 'renamed' }]);
    expect(report.touched.symbolChanges).toEqual([{ id: TAX, change: 'modified', path: MOVED }]);
    expect(report.touched.precision.renamedOnly).toEqual([]);
  });

  it('lists the file-level symbols whether the index holds the old path or the new one', async () => {
    write(BILLING, BILLING_BASE);
    commit('base');
    mkdirSync(join(repo, 'app/Billing'), { recursive: true });
    git(`mv ${BILLING} ${MOVED}`);
    commit('rename');

    // Index at the base commit: the nodes are under the old path (set up in beforeEach).
    expect((await delta()).touched.symbols).toBe(4);
    // Index at the head commit: the nodes are under the new path.
    for (const id of [CLASS, TOTAL, TAX, FEE]) symbol(id, MOVED);
    expect((await delta()).touched.symbols).toBe(4);
  });
});

describe('other languages and files', () => {
  it('attributes a TypeScript change to the one function edited', async () => {
    const file = 'resources/js/math.ts';
    const base =
      'export function one(): number {\n  return 1;\n}\n\nexport function two(): number {\n  return 2;\n}\n';
    for (const name of ['one', 'two']) symbol(`symbol:ts:${file}#${name}`, file);
    write(file, base);
    commit('base');
    write(file, base.replace('return 2;', 'return 22;'));
    commit('change');
    const report = await delta();

    expect(report.touched.symbolChanges).toEqual([
      { id: `symbol:ts:${file}#two`, change: 'modified', path: file },
    ]);
  });

  it("reports a renamed TypeScript file's edited function under its new path", async () => {
    const from = 'resources/js/math.ts';
    const to = 'resources/js/lib/math.ts';
    const base =
      'export function one(): number {\n  return 1;\n}\n\nexport function two(): number {\n  return 2;\n}\n';
    write(from, base);
    commit('base');
    mkdirSync(join(repo, 'resources/js/lib'), { recursive: true });
    git(`mv ${from} ${to}`);
    write(to, base.replace('return 2;', 'return 22;'));
    commit('rename-and-edit');
    const report = await delta();

    expect(report.touched.symbolChanges).toEqual([
      { id: `symbol:ts:${to}#two`, change: 'modified', path: to },
    ]);
  });

  it('reports a symbol under the file-qualified id the index stores it by', async () => {
    // An index in which `tax` is declared by two files, so this file's is stored file-qualified.
    const qualified = `${TAX}#file:${BILLING}`;
    db.close();
    db = new LuxDatabase(join(repo, '.lux', 'qualified.db'));
    for (const id of [CLASS, TOTAL, qualified, FEE]) symbol(id, BILLING);
    const report = await afterEditing((source) => source.replace('return 2;', 'return 20;'));

    expect(report.touched.changedSymbolIds).toEqual([qualified]);
  });

  it('falls back to the file-level set, marked as such, for a file it cannot parse', async () => {
    const file = 'resources/js/Widget.vue';
    const ids = [`symbol:vue:${file}#setup`, `symbol:vue:${file}#render`];
    for (const id of ids) symbol(id, file);
    write(file, '<script setup>\nconst a = 1;\n</script>\n');
    commit('base');
    write(file, '<script setup>\nconst a = 2;\n</script>\n');
    commit('change');
    const report = await delta();

    expect(report.touched.precision.fileLevelOnly).toEqual([file]);
    expect(report.touched.symbolChanges).toEqual(
      ids.sort().map((id) => ({ id, change: 'file-level', path: file }))
    );
  });

  it('does not name a changed file that is not source and holds no symbol', async () => {
    write('.github/workflows/ci.yml', 'on: push\n');
    write(BILLING, BILLING_BASE);
    commit('base');
    write('.github/workflows/ci.yml', 'on: pull_request\n');
    write(BILLING, BILLING_BASE.replace('return 2;', 'return 20;'));
    commit('change');
    const report = await delta();

    expect(report.touched.precision.fileLevelOnly).toEqual([]);
    expect(report.touched.changedSymbolIds).toEqual([TAX]);
  });

  it('reads an uncommitted edit and an untracked file from the working tree', async () => {
    write(BILLING, BILLING_BASE);
    commit('base');
    write(BILLING, BILLING_BASE.replace('return 3;', 'return 30;'));
    write('app/Services/Fresh.php', '<?php\n\nnamespace App\\Services;\n\nclass Fresh\n{\n}\n');
    const report = await delta({ base: 'HEAD', committedOnly: false });

    expect(report.touched.symbolChanges).toEqual([
      { id: FEE, change: 'modified', path: BILLING },
      { id: 'symbol:php:App\\Services\\Fresh', change: 'added', path: 'app/Services/Fresh.php' },
    ]);
  });
});

describe('the downstream walk', () => {
  const INVOKER = 'symbol:php:App\\Http\\FeeInvoker';
  const SURFACE = 'surface:http:GET:/fee';

  beforeEach(() => {
    // GET /fee is handled by FeeInvoker, which calls Billing::fee and nothing else in the file.
    db.upsertStructuralNode({ id: SURFACE, node_type: 'capability-surface', updated_at: 1 });
    symbol(INVOKER, 'app/Http/FeeInvoker.php');
    edge(SURFACE, INVOKER, 'handled_by');
    edge(INVOKER, FEE, 'calls');
  });

  it('starts from the changed symbol: a change to another method of the file reaches nothing', async () => {
    const report = await afterEditing((source) => source.replace('return 2;', 'return 20;'));

    expect(report.downstream.entrySurfaces).toEqual([]);
  });

  it('reaches the surface when the method it depends on is the one that changed', async () => {
    const report = await afterEditing((source) => source.replace('return 3;', 'return 30;'));

    expect(report.downstream.entrySurfaces).toMatchObject([{ id: SURFACE, hops: 2 }]);
  });

  it('still reaches a surface handled by the class of a changed method', async () => {
    const direct = 'surface:http:GET:/billing';
    db.upsertStructuralNode({ id: direct, node_type: 'capability-surface', updated_at: 1 });
    edge(direct, CLASS, 'handled_by');
    const report = await afterEditing((source) => source.replace('return 2;', 'return 20;'));

    expect(report.downstream.entrySurfaces).toMatchObject([{ id: direct, hops: 1 }]);
  });
});
