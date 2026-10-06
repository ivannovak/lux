// Cross-repo delta — computeCrossRepoImpact + `delta --against` (spec 14 Parts B/C/D / T3.2,3.3 /
// Decisions 6,8,9 / SC-6,8,9). A primary-side diff seeds the shipped walkDownstream INSIDE a
// sibling's read-only graph: a touched Acme\Core\* handler FQCN that a sibling route delegates to
// reports that sibling's affected HTTP surface. Portable seeds only (bare-name PHP + path-relative
// excluded); a peer receives portable FQCNs, a kernel additionally receives http surfaces. Every
// resolve-time refusal class degrades in analysis mode and refuses under --check (no silent pass).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { LuxSqlite } from '../../../db/sqlite-adapter.js';
import { computeDelta } from '../run.js';
import { renderDeltaText } from '../report.js';
import { computeCrossRepoImpact } from '../cross-repo.js';
import type { DeltaOptions, DeltaTouchSet } from '../types.js';
import type { DownstreamBudget } from '../downstream.js';
import type { ConfidenceClass, EdgeType, StructuralNodeType } from '../../../db/types.js';

const FQCN = 'symbol:php:Acme\\Core\\OfferService::show';
const CTRL = 'symbol:php:App\\Http\\OfferController::show';
const ROUTE = 'surface:http:GET:/offer/{offerId}';
const HELPER = 'symbol:php:helper'; // bare-name (no namespace separator) → repo-local

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}
function budget(over: Partial<DownstreamBudget> = {}): DownstreamBudget {
  return { depth: 6, maxNodes: 2000, maxFanout: 64, minConfidence: 'framework-inferred', ...over };
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
function node(
  db: LuxDatabase,
  id: string,
  over: { nodeType?: StructuralNodeType; filePath?: string } = {}
): void {
  db.upsertStructuralNode({
    id,
    node_type: over.nodeType ?? 'symbol',
    file_path: over.filePath,
    updated_at: 1,
  });
}
function edge(
  db: LuxDatabase,
  source: string,
  target: string,
  edgeType: EdgeType,
  cc: ConfidenceClass
): void {
  db.upsertStructuralEdge({
    id: `${source}=>${target}`,
    source_node_id: source,
    target_node_id: target,
    edge_type: edgeType,
    confidence: 1,
    confidence_class: cc,
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
}

/** The kernel file: a namespaced class whose method changes, and a global helper that changes. */
function offerService(version: number): string {
  return (
    `<?php\nnamespace Acme\\Core {\n    class OfferService\n    {\n` +
    `        public function show() { return ${version}; }\n    }\n}\n` +
    `namespace {\n    function helper() { return ${version}; }\n}\n`
  );
}

/** A sibling `.lux` with route --handled_by--> controller --calls--> the shared kernel FQCN. */
function makeResSibling(path: string): void {
  const db = new LuxDatabase(path);
  node(db, ROUTE, { nodeType: 'capability-surface' });
  node(db, CTRL);
  edge(db, ROUTE, CTRL, 'handled_by', 'artifact-backed');
  edge(db, CTRL, FQCN, 'calls', 'proven'); // FQCN is an edge target (matches the intersection)
  db.close();
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-cross-repo-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('cross-repo delta — SC-6: a kernel diff reaches a sibling route surface', () => {
  it('reports the sibling HTTP surface via structural-walk with honest hops/confidence + seeds', async () => {
    // Primary (kernel) git corpus: a committed change to src/OfferService.php, whose FQCN + a
    // bare-name helper both live in the primary .lux keyed under that file.
    const kernel = join(root, 'kernel');
    initRepo(kernel);
    mkdirSync(join(kernel, 'src'), { recursive: true });
    writeFileSync(join(kernel, 'src', 'OfferService.php'), offerService(1));
    git(kernel, ['add', '-A']);
    git(kernel, ['commit', '-q', '-m', 'base']);
    const base = git(kernel, ['rev-parse', 'HEAD']);
    writeFileSync(join(kernel, 'src', 'OfferService.php'), offerService(2));
    git(kernel, ['add', '-A']);
    git(kernel, ['commit', '-q', '-m', 'change offer service']);

    const resDb = join(root, 'res', '.lux', 'lux.db');
    makeResSibling(resDb);
    writeFileSync(join(kernel, 'lux.yaml'), `siblings:\n  res:\n    db: ${resDb}\n`);

    const kdb = new LuxDatabase(join(kernel, '.lux', 'lux.db'));
    kdb.setIndexMetadata('last_indexed_commit', base);
    node(kdb, FQCN, { filePath: 'src/OfferService.php' });
    node(kdb, HELPER, { filePath: 'src/OfferService.php' }); // bare-name → excluded from seeds

    const result = await computeDelta(kdb, kernel, opts({ committedOnly: true, against: ['res'] }));
    kdb.close();

    expect('report' in result).toBe(true);
    if (!('report' in result)) return;
    const cri = result.report.crossRepoImpact;
    expect(cri).toBeDefined();
    expect(cri!.siblings).toHaveLength(1);
    const s = cri!.siblings[0];
    expect(s.name).toBe('res');
    expect(s.attached).toBe(true);
    // Only the changed method; the bare-name helper changed too but is repo-local, not a seed.
    expect(s.seedsTotal).toBe(1);
    expect(s.seedsMatched).toBe(1);
    expect(s.entrySurfaces).toEqual([
      {
        kind: 'http',
        id: ROUTE,
        resolvedVia: 'structural-walk',
        hops: 2,
        weakestConfidence: 'artifact-backed',
        via: [FQCN, CTRL],
      },
    ]);
    expect(s.budget).toEqual({ depth: 6, maxNodes: 2000, truncated: false });
    expect(s.freshness).toBeDefined();
    // the schemaVersion:1 envelope stays additive (SC-9): crossRepoImpact rides alongside, no bump
    expect(result.report.schemaVersion).toBe(1);

    // text render (analysis default) surfaces the cross-repo impact, not only --json
    const text = renderDeltaText(result.report);
    expect(text).toContain('cross-repo impact');
    expect(text).toContain('res: 1/1 seed(s) matched');
    expect(text).toContain(ROUTE);
  });
});

describe('cross-repo delta — no deadlock after a prior primary-side write (MCP long-lived server)', () => {
  it('resolves the sibling surface even when the primary handle has already written (usage-event/migration)', async () => {
    // The intersection must NOT ATTACH the sibling onto the primary: a prior cached write on the
    // primary handle leaves node-sqlite3-wasm unable to DETACH, deadlocking the sibling open on the
    // busy-timeout. This exercises that exact path directly (a fast assert — a regression would hang
    // ~30s and trip the test timeout).
    const corpus = join(root, 'primary');
    mkdirSync(corpus, { recursive: true });
    const primary = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
    primary.upsertStructuralNode({
      id: 'symbol:php:App\\Prior',
      node_type: 'symbol',
      updated_at: 1,
    });

    const resDb = join(root, 'res', '.lux', 'lux.db');
    makeResSibling(resDb);
    writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  res:\n    db: ${resDb}\n`);

    const touch: DeltaTouchSet = {
      nodes: [],
      symbolIds: [FQCN],
      surfacesDeclared: [],
      evidenceEdgeCount: 0,
      operationalBoundaries: [],
      orphanedNodeCount: 0,
      symbolChanges: [],
      precision: {
        fileLevelOnly: [],
        renamedOnly: [],
        cosmeticOnly: [],
        changedOutsideSymbols: [],
      },
      walkSeeds: [FQCN],
    };
    const { impact } = computeCrossRepoImpact(primary, corpus, touch, ['res'], budget());
    primary.close();

    const s = impact.siblings[0];
    expect(s.attached).toBe(true);
    expect(s.seedsMatched).toBe(1);
    expect(s.entrySurfaces?.[0]?.id).toBe(ROUTE);
  });
});

describe('cross-repo delta — portable-seed law (peer vs kernel; bare/path excluded)', () => {
  it('a peer receives portable FQCNs only; a kernel additionally receives http surfaces', async () => {
    // Direct computeCrossRepoImpact with a synthetic touch carrying all four id classes. Empty
    // sibling dbs → seedsMatched:0, but seedsTotal reflects exactly the filtered seed set.
    const corpus = join(root, 'primary');
    mkdirSync(corpus, { recursive: true });
    const primary = new LuxDatabase(join(corpus, '.lux', 'lux.db'));

    const resDb = join(root, 'res', '.lux', 'lux.db');
    const coreDb = join(root, 'core', '.lux', 'lux.db');
    new LuxDatabase(resDb).close();
    new LuxDatabase(coreDb).close();
    writeFileSync(
      join(corpus, 'lux.yaml'),
      `siblings:\n  res:\n    db: ${resDb}\n  core:\n    db: ${coreDb}\n    role: kernel\n`
    );

    const touch: DeltaTouchSet = {
      nodes: [],
      symbolIds: [
        FQCN, // portable (namespace-qualified) → both peer + kernel
        'surface:http:GET:/x', // portable-kernel-only → kernel only
        HELPER, // bare-name PHP → repo-local, never a seed
        'file:routes/web.php', // path-relative → repo-local, never a seed
      ],
      surfacesDeclared: [],
      evidenceEdgeCount: 0,
      operationalBoundaries: [],
      orphanedNodeCount: 0,
      symbolChanges: [],
      precision: {
        fileLevelOnly: [],
        renamedOnly: [],
        cosmeticOnly: [],
        changedOutsideSymbols: [],
      },
      walkSeeds: [FQCN, 'surface:http:GET:/x', HELPER, 'file:routes/web.php'],
    };

    const { impact } = computeCrossRepoImpact(primary, corpus, touch, ['res', 'core'], budget());
    primary.close();

    const res = impact.siblings.find((s) => s.name === 'res')!;
    const core = impact.siblings.find((s) => s.name === 'core')!;
    expect(res.attached).toBe(true);
    expect(core.attached).toBe(true);
    expect(res.seedsTotal).toBe(1); // FQCN only — http surface excluded from a peer
    expect(core.seedsTotal).toBe(2); // FQCN + the http surface (kernel bridge)
    expect(res.seedsMatched).toBe(0);
    expect(core.seedsMatched).toBe(0);
  });
});

describe('cross-repo delta — SC-8: every refusal class degrades + refuses under --check', () => {
  /** git corpus with a `.lux` at HEAD (empty diff) so computeDelta reaches the --against block. */
  function makeCorpus(): { corpus: string; db: LuxDatabase } {
    const corpus = join(root, 'corpus');
    initRepo(corpus);
    git(corpus, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const db = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
    db.setIndexMetadata('last_indexed_commit', git(corpus, ['rev-parse', 'HEAD']));
    return { corpus, db };
  }

  it('unregistered / db-absent / schema-skew / worktree-missing each degrade + fail --check', async () => {
    for (const cls of ['unregistered', 'db-absent', 'schema-skew', 'worktree-missing'] as const) {
      const { corpus, db } = makeCorpus();
      let againstName = 'phantom';

      if (cls === 'unregistered') {
        // no siblings: block at all → the name is unregistered
        writeFileSync(join(corpus, 'lux.yaml'), `siblings: {}\n`);
      } else if (cls === 'db-absent') {
        const ghost = join(root, `absent-${cls}`, '.lux', 'lux.db');
        writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  ${againstName}:\n    db: ${ghost}\n`);
      } else if (cls === 'schema-skew') {
        const skewed = join(root, `skew-${cls}`, '.lux', 'lux.db');
        new LuxDatabase(skewed).close();
        const raw = new LuxSqlite(skewed);
        raw.run(
          'DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)'
        );
        raw.close();
        writeFileSync(
          join(corpus, 'lux.yaml'),
          `siblings:\n  ${againstName}:\n    db: ${skewed}\n`
        );
      } else {
        const missing = join(root, `no-such-worktree-${cls}`);
        writeFileSync(
          join(corpus, 'lux.yaml'),
          `siblings:\n  ${againstName}:\n    path: ${missing}\n`
        );
      }

      // analysis mode: degrades to a report with the sibling attached:false + a refusal string.
      const analysis = await computeDelta(
        db,
        corpus,
        opts({ committedOnly: true, against: [againstName] })
      );
      expect('report' in analysis).toBe(true);
      if ('report' in analysis) {
        const s = analysis.report.crossRepoImpact?.siblings[0];
        expect(s?.name).toBe(againstName);
        expect(s?.attached).toBe(false);
        expect(typeof s?.refusal).toBe('string');
        // the refusal is also surfaced as a trust warning (never silently dropped)
        expect(analysis.report.trust.warnings.some((w) => w.includes(againstName))).toBe(true);
      }

      // --check: the same unresolvable sibling becomes a hard config-error refusal (nonzero exit).
      const checked = await computeDelta(
        db,
        corpus,
        opts({ committedOnly: true, against: [againstName], check: true })
      );
      expect('refusal' in checked).toBe(true);
      if ('refusal' in checked) {
        expect(checked.refusal.reason).toBe('config-error');
        expect(checked.refusal.message).toContain(againstName);
        expect(checked.refusal.message).toContain(cls);
      }
      db.close();
    }
  });

  it('a corrupt / non-lux db: sibling degrades in analysis and refuses under --check (FIX 1)', async () => {
    // The path exists but is not a readable Lux index. FIX 1b catches this at resolve time as a
    // `db-unreadable` refusal (no raw throw escapes computeDelta); analysis degrades (attached:false
    // + trust warning, exit-0-equivalent report) and --check turns it into a config-error refusal.
    const { corpus, db } = makeCorpus();
    const bogus = join(root, 'bogus', '.lux', 'lux.db');
    mkdirSync(dirname(bogus), { recursive: true });
    writeFileSync(bogus, 'not a sqlite database at all');
    writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  bad:\n    db: ${bogus}\n`);

    const analysis = await computeDelta(
      db,
      corpus,
      opts({ committedOnly: true, against: ['bad'] })
    );
    expect('report' in analysis).toBe(true);
    if ('report' in analysis) {
      const s = analysis.report.crossRepoImpact?.siblings[0];
      expect(s?.name).toBe('bad');
      expect(s?.attached).toBe(false);
      expect(typeof s?.refusal).toBe('string');
      expect(analysis.report.trust.warnings.some((w) => w.includes('bad'))).toBe(true);
    }

    const checked = await computeDelta(
      db,
      corpus,
      opts({ committedOnly: true, against: ['bad'], check: true })
    );
    expect('refusal' in checked).toBe(true);
    if ('refusal' in checked) {
      expect(checked.refusal.reason).toBe('config-error');
      expect(checked.refusal.message).toContain('bad');
    }
    db.close();
  });
});

describe('cross-repo delta — a post-resolve open fault isolates to that sibling (FIX 1)', () => {
  it('degrades the faulted sibling, still processes the healthy one, and closes its handle', async () => {
    // Both siblings RESOLVE cleanly (valid, current-schema indexes). Simulate a fault that only
    // surfaces on the post-resolve open — a cross-process busy-timeout / TOCTOU re-index — for one of
    // them. FIX 1 must degrade THAT sibling (refusal, no throw), keep processing the healthy sibling
    // (the batch is not aborted), and close every handle it opened (the finally — no leak).
    const corpus = join(root, 'primary');
    mkdirSync(corpus, { recursive: true });
    const primary = new LuxDatabase(join(corpus, '.lux', 'lux.db'));

    const okDb = join(root, 'ok', '.lux', 'lux.db');
    makeResSibling(okDb);
    const faultDb = join(root, 'fault', '.lux', 'lux.db');
    makeResSibling(faultDb);
    writeFileSync(
      join(corpus, 'lux.yaml'),
      `siblings:\n  ok:\n    db: ${okDb}\n  fault:\n    db: ${faultDb}\n`
    );

    const realOpen = LuxDatabase.openSiblingReadOnly.bind(LuxDatabase);
    const closes: Array<{ path: string; spy: ReturnType<typeof vi.spyOn> }> = [];
    const openSpy = vi
      .spyOn(LuxDatabase, 'openSiblingReadOnly')
      .mockImplementation((dbPath: string, schema: number) => {
        if (dbPath === faultDb) throw new Error('database is locked'); // busy-timeout on open
        const handle = realOpen(dbPath, schema);
        closes.push({ path: dbPath, spy: vi.spyOn(handle, 'close') });
        return handle;
      });

    const touch: DeltaTouchSet = {
      nodes: [],
      symbolIds: [FQCN],
      surfacesDeclared: [],
      evidenceEdgeCount: 0,
      operationalBoundaries: [],
      orphanedNodeCount: 0,
      symbolChanges: [],
      precision: {
        fileLevelOnly: [],
        renamedOnly: [],
        cosmeticOnly: [],
        changedOutsideSymbols: [],
      },
      walkSeeds: [FQCN],
    };
    const { impact, refusals } = computeCrossRepoImpact(
      primary,
      corpus,
      touch,
      ['ok', 'fault'],
      budget()
    );
    openSpy.mockRestore();
    primary.close();

    const ok = impact.siblings.find((s) => s.name === 'ok')!;
    const fault = impact.siblings.find((s) => s.name === 'fault')!;
    // the batch was NOT aborted by the fault — the healthy sibling still produced its impact
    expect(ok.attached).toBe(true);
    expect(ok.seedsMatched).toBe(1);
    // the faulted sibling degraded to a refusal, never thrown, and is a --check-failing refusal
    expect(fault.attached).toBe(false);
    expect(typeof fault.refusal).toBe('string');
    expect(refusals.some((r) => r.name === 'fault' && r.reason === 'db-unreadable')).toBe(true);
    // no handle leak: the one handle that opened (the healthy sibling's) was closed in its finally
    expect(closes).toHaveLength(1);
    expect(closes[0].path).toBe(okDb);
    expect(closes[0].spy).toHaveBeenCalled();
  });
});
