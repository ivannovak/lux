// Integration coverage for `computeDelta` glue that the per-module unit tests bypass:
//   #5  --check gate wired end-to-end (input-building in run.ts:102-126: deletedHandlerSymbols /
//       handlerFiles derivation + report.gate population) via a real client-gap-created violation.
//   #6  module-dependents rollup (SC-1): DESC ordering by reference_count, `(unscoped)` exclusion.
//   #7  baselineDb branch: a valid sibling .lux populates report.baselineDiff; a missing one takes
//       the `baseline-unavailable` warning path (never throws).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { computeDelta } from '../run.js';
import type { DeltaOptions } from '../types.js';

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q');
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name Test');
  git(dir, 'config commit.gpgsign false');
}
function headOf(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}
function opts(over: Partial<DeltaOptions> = {}): DeltaOptions {
  return {
    depth: 6,
    maxNodes: 2000,
    maxFanout: 64,
    minConfidence: 'framework-inferred',
    json: true,
    ...over,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-delta-integ-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('#5 --check gate through computeDelta (client-gap-created glue, run.ts:102-126)', () => {
  it('fires client-gap-created (exit 1) when the diff deletes a client-override handler', async () => {
    // kernel worktree: composer.json (Acme\Core) + git HEAD + a populated .lux with a route whose
    // handler is the client's App\C2 (→ classified client-override).
    const kernelDir = join(root, 'core');
    mkdirSync(kernelDir, { recursive: true });
    writeFileSync(
      join(kernelDir, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'Acme\\Core\\': 'src/' } } })
    );
    git(kernelDir, 'init -q');
    git(kernelDir, 'config user.email t@t');
    git(kernelDir, 'config user.name t');
    git(kernelDir, 'config commit.gpgsign false');
    git(kernelDir, 'commit -q --allow-empty -m i');
    const kdb = new LuxDatabase(join(kernelDir, '.lux', 'lux.db'));
    const route = 'surface:http:GET:/k2';
    const handlerId = 'symbol:php:App\\C2';
    kdb.upsertStructuralNode({ id: route, node_type: 'capability-surface', updated_at: 1 });
    kdb.upsertStructuralNode({ id: handlerId, node_type: 'symbol', updated_at: 1 });
    kdb.upsertStructuralEdge({
      id: `${route}=>App\\C2`,
      source_node_id: route,
      target_node_id: handlerId,
      edge_type: 'handled_by',
      confidence: 1,
      confidence_class: 'proven',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: 1,
    });
    kdb.close();

    // client corpus: git repo whose base commit HAS app/C2.php and whose HEAD DELETES it.
    const client = join(root, 'client');
    initRepo(client);
    mkdirSync(join(client, 'app'), { recursive: true });
    writeFileSync(
      join(client, 'composer.json'),
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } })
    );
    writeFileSync(join(client, 'lux.yaml'), 'overlay:\n  kernel:\n    package: acme/core\n');
    writeFileSync(join(client, 'app', 'C2.php'), '<?php namespace App; class C2 {}');
    git(client, 'add -A');
    git(client, 'commit -q -m base');
    const base = headOf(client);
    git(client, 'rm -q app/C2.php');
    git(client, 'commit -q -m "remove client override"');

    // vendor symlink + client index created AFTER HEAD (untracked; non-indexable → ignored).
    mkdirSync(join(client, 'vendor', 'acme'), { recursive: true });
    symlinkSync(kernelDir, join(client, 'vendor', 'acme', 'core'));
    const cdb = new LuxDatabase(join(client, '.lux', 'lux.db'));
    cdb.setIndexMetadata('last_indexed_commit', base);
    // the deleted handler's node still lives in the index, keyed under app/C2.php.
    cdb.upsertStructuralNode({
      id: handlerId,
      node_type: 'symbol',
      file_path: 'app/C2.php',
      updated_at: 1,
    });

    const result = await computeDelta(
      cdb,
      client,
      opts({ check: true, failOn: ['client-gap-created'], committedOnly: true })
    );
    cdb.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    expect(result.report.gate).toBeDefined();
    expect(result.report.gate?.exitCode).toBe(1);
    const violation = result.report.gate?.violations.find(
      (v) => v.category === 'client-gap-created'
    );
    expect(violation).toBeDefined();
    expect(violation?.subject).toBe(route);
    expect(violation?.evidence?.file).toBe('app/C2.php');
  });
});

describe('#6 module-dependents rollup through computeDelta (SC-1)', () => {
  it('rolls up dependents DESC by reference_count and excludes (unscoped) and unchanged targets', async () => {
    const repo = join(root, 'mods');
    initRepo(repo);
    // packages/{modA,modB} → detectModuleBoundaries = ['packages/{name}'].
    mkdirSync(join(repo, 'packages', 'modA'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'modB'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'modA', 'Foo.php'), '<?php // v1');
    writeFileSync(join(repo, 'root.php'), '<?php // unscoped');
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    const base = headOf(repo);
    // change modA's file + the unscoped root file base..HEAD.
    writeFileSync(join(repo, 'packages', 'modA', 'Foo.php'), '<?php // v2');
    writeFileSync(join(repo, 'root.php'), '<?php // unscoped v2');
    git(repo, 'add -A');
    git(repo, 'commit -q -m change');

    const db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
    db.setIndexMetadata('last_indexed_commit', base);
    // dependents of modA (target = modA): modB (10) and modC (3).
    db.insertModuleDependency({
      source_module: 'modB',
      target_module: 'modA',
      reference_count: 10,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'modC',
      target_module: 'modA',
      reference_count: 3,
      sample_files: null,
    });
    // unrelated target (modZ not changed) → must NOT surface.
    db.insertModuleDependency({
      source_module: 'modD',
      target_module: 'modZ',
      reference_count: 99,
      sample_files: null,
    });
    // a dependent of the (unscoped) bucket → must NOT surface (the unscoped changed module is skipped).
    db.insertModuleDependency({
      source_module: 'modE',
      target_module: '(unscoped)',
      reference_count: 50,
      sample_files: null,
    });

    const result = await computeDelta(db, repo, opts({ committedOnly: true }));
    db.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    const { modules } = result.report;
    expect(modules.changed).toContain('modA');
    expect(modules.changed).not.toContain('(unscoped)');
    // DESC by reference_count; modZ (unchanged target) and modE (unscoped dependent) excluded.
    expect(modules.dependents).toEqual([
      { module: 'modB', referenceCount: 10 },
      { module: 'modC', referenceCount: 3 },
    ]);
  });
});

describe('#7 baselineDb branch through computeDelta (Phase 4)', () => {
  /** git corpus with packages/{modA,modB} so diffBaseline resolves cross-module edges. */
  function makeCorpus(): { corpus: string; primaryDb: LuxDatabase } {
    const corpus = join(root, 'corpus');
    initRepo(corpus);
    mkdirSync(join(corpus, 'packages', 'modA'), { recursive: true });
    mkdirSync(join(corpus, 'packages', 'modB'), { recursive: true });
    writeFileSync(join(corpus, 'packages', 'modA', '.keep'), '');
    writeFileSync(join(corpus, 'packages', 'modB', '.keep'), '');
    git(corpus, 'add -A');
    git(corpus, 'commit -q -m base');
    const primaryDb = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
    primaryDb.setIndexMetadata('last_indexed_commit', headOf(corpus));
    return { corpus, primaryDb };
  }

  it('populates report.baselineDiff (surfaces ± and cross-module edges +) from a sibling baseline', async () => {
    const { corpus, primaryDb } = makeCorpus();
    // HEAD (primary) state.
    primaryDb.upsertStructuralNode({
      id: 'surface:http:GET:/new',
      node_type: 'capability-surface',
      updated_at: 1,
    });
    primaryDb.upsertStructuralNode({
      id: 'sym:A1',
      node_type: 'symbol',
      file_path: 'packages/modA/Foo.php',
      updated_at: 1,
    });
    primaryDb.upsertStructuralNode({
      id: 'sym:B1',
      node_type: 'symbol',
      file_path: 'packages/modB/Bar.php',
      updated_at: 1,
    });
    primaryDb.upsertStructuralEdge({
      id: 'edge:new1',
      source_node_id: 'sym:A1',
      target_node_id: 'sym:B1',
      edge_type: 'calls',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      updated_at: 1,
    });

    // baseline (base ref) state: a surface HEAD removes, no cross-module edge.
    const baselinePath = join(root, 'baseline', '.lux', 'lux.db');
    const bdb = new LuxDatabase(baselinePath);
    bdb.upsertStructuralNode({
      id: 'surface:http:GET:/gone',
      node_type: 'capability-surface',
      updated_at: 1,
    });
    bdb.close();

    const result = await computeDelta(
      primaryDb,
      corpus,
      opts({ baselineDb: baselinePath, committedOnly: true })
    );
    primaryDb.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    const bd = result.report.baselineDiff;
    expect(bd).toBeDefined();
    expect(bd?.surfacesRemoved).toEqual(['surface:http:GET:/gone']);
    expect(bd?.surfacesAdded).toEqual(['surface:http:GET:/new']);
    expect(bd?.crossModuleEdgesAdded).toEqual([
      { source: 'modA', target: 'modB', edgeType: 'calls' },
    ]);
  });

  it('takes the baseline-unavailable warning path (no throw, no baselineDiff) for a missing baseline', async () => {
    const { corpus, primaryDb } = makeCorpus();
    const missing = join(root, 'nope', 'lux.db');

    // Resolves rather than rejecting: a missing baseline is a warning, not an error.
    const result = await computeDelta(
      primaryDb,
      corpus,
      opts({ baselineDb: missing, committedOnly: true })
    );
    primaryDb.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    expect(result.report.baselineDiff).toBeUndefined();
    expect(result.report.trust.warnings.some((w) => w.includes('No baseline index'))).toBe(true);
  });
});
