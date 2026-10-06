import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { computeDelta } from '../../scanner/delta/run.js';
import type { DeltaOptions } from '../../scanner/delta/types.js';

const INDEX_TRUST = new Set(['index-fresh', 'index-stale', 'index-absent']);

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

function opts(over: Partial<DeltaOptions> = {}): DeltaOptions {
  return {
    depth: 6,
    maxNodes: 2000,
    maxFanout: 64,
    minConfidence: 'framework-inferred',
    committedOnly: false,
    check: false,
    json: true,
    ...over,
  };
}

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'surface',
  'changeSet',
  'touched',
  'downstream',
  'modules',
  'ownership',
  'invalidatedEvidence',
  'trust',
];

describe('delta --json envelope schema contract (spec 15)', () => {
  let repo: string;
  let db: LuxDatabase;

  beforeEach(() => {
    repo = join(tmpdir(), `lux-delta-json-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    initRepo(repo);
    writeFileSync(join(repo, 'app.php'), '<?php // original');
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
    db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
    db.setIndexMetadata('last_indexed_commit', head);
    // a working-tree change so the change-set has one file.
    writeFileSync(join(repo, 'app.php'), '<?php // edited');
  });

  afterEach(() => {
    db.close();
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it('emits a frozen schemaVersion:1 envelope with every top-level block', async () => {
    const result = await computeDelta(db, repo, opts());
    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    const r = result.report;

    expect(r.schemaVersion).toBe(1);
    expect(r.surface).toBe('delta');
    for (const k of TOP_LEVEL_KEYS) expect(r).toHaveProperty(k);

    // analysis mode, no baseline → these optional blocks are absent.
    expect(r.gate).toBeUndefined();
    expect(r.baselineDiff).toBeUndefined();

    // one changed file, indexTrust drawn from the three frozen values.
    expect(r.changeSet.files.length).toBeGreaterThanOrEqual(1);
    for (const f of r.changeSet.files) expect(INDEX_TRUST.has(f.indexTrust)).toBe(true);

    // downstream projections are empty-not-errored under the Phase-1 stub.
    expect(r.downstream.entrySurfaces).toEqual([]);
    expect(r.ownership.source).toBe('unavailable');
  });

  it('degrades a non-git corpus to an empty report + warning in analysis mode (Decision 18)', async () => {
    const plain = join(tmpdir(), `lux-delta-plain-${Date.now()}`);
    mkdirSync(plain, { recursive: true });
    try {
      const result = await computeDelta(db, plain, opts());
      expect('report' in result).toBe(true);
      if (!('report' in result)) return;
      expect(result.report.schemaVersion).toBe(1);
      expect(result.report.changeSet.files).toHaveLength(0);
      expect(result.report.trust.warnings.some((w) => /not a git repository/.test(w))).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('refuses a non-git corpus under --check (Decision 18)', async () => {
    const plain = join(tmpdir(), `lux-delta-plain2-${Date.now()}`);
    mkdirSync(plain, { recursive: true });
    try {
      const result = await computeDelta(db, plain, opts({ check: true }));
      expect('refusal' in result).toBe(true);
      if ('refusal' in result) expect(result.refusal.reason).toBe('not-a-git-repo');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
