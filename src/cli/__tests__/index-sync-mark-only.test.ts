import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import {
  persistRebuildTrustState,
  loadOverlayTrustState,
  deriveOverlayTrustLevelFromState,
} from '../../scanner/overlay-trust-state.js';
import type { RebuildResult } from '../../scanner/rebuild-orchestrator.js';
import type { StructuralEdge, StructuralNode } from '../../db/types.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

function git(repoPath: string, command: string): string {
  return execSync(command, { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' }).trim();
}
function commitAll(repoPath: string, message: string): string {
  git(repoPath, 'git add -A');
  git(repoPath, `git commit -m ${JSON.stringify(message)}`);
  return git(repoPath, 'git rev-parse HEAD');
}
function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}
function now(): number {
  return Math.floor(Date.now() / 1000);
}
function fileNode(path: string): StructuralNode {
  return { id: `file:${path}`, node_type: 'file', file_path: path, updated_at: now() };
}
function symNode(id: string, path: string): StructuralNode {
  return { id, node_type: 'symbol', file_path: path, updated_at: now() };
}
function edge(id: string, over: Partial<StructuralEdge>): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}
function overlayCompleteResult(repoPath: string): RebuildResult {
  return {
    mode: 'overlay-complete',
    repoPath,
    configSource: 'default',
    configLspEnabled: false,
    surfaceCount: 1,
    detectorEdgeCount: 2,
    propagatedEdgeCount: 0,
    fileNodeCount: 2,
    symbolNodeCount: 2,
    controllerBackedCount: 1,
    closureBackedCount: 0,
    unknownProviderKindCount: 0,
    enrichmentStatus: 'inactive',
    propagationStatus: 'empty',
    warnings: [],
  };
}
function statusOf(db: LuxDatabase, id: string): string | undefined {
  return db.getEdgeFreshnessByIds([id])[0]?.freshness_status;
}

describe('index sync --mark-only (spec 11 Part B / SC-3)', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;
  let baseCommit: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-mark-only-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-mark-only-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'routes'), { recursive: true });
    mkdirSync(join(repoDir, 'app'), { recursive: true });
    writeFileSync(
      join(repoDir, 'lux.yaml'),
      ['lsp:', '  enabled: false', '  enrichers: []', 'deps:', '  enabled: false', ''].join('\n')
    );
    writeFileSync(join(repoDir, 'routes', 'web.php'), '<?php // routes v1\n');
    writeFileSync(join(repoDir, 'app', 'Other.php'), '<?php // other\n');
    writeFileSync(join(repoDir, 'app', 'Handler.php'), '<?php // handler\n');

    git(repoDir, 'git init');
    git(repoDir, 'git config user.email "test@test.com"');
    git(repoDir, 'git config user.name "Test"');
    baseCommit = commitAll(repoDir, 'base');

    // Seed a realistic overlay-complete overlay directly (deterministic; no LSP dependency):
    //   - edge:evidence   handled_by, endpoints elsewhere, EVIDENCE cites routes/web.php
    //   - edge:nodepath   endpoint node lives in routes/web.php (node-path dimension)
    //   - edge:unrelated  endpoints + evidence in app/Other.php (must stay fresh)
    const db = new LuxDatabase(dbPath);
    db.upsertStructuralNode(fileNode('routes/web.php'));
    db.upsertStructuralNode(fileNode('app/Other.php'));
    db.upsertStructuralNode(symNode('surface:http:GET:/x', 'routes/web.php'));
    db.upsertStructuralNode(symNode('symbol:Handler', 'app/Handler.php'));
    db.upsertStructuralNode(symNode('symbol:routeLocal', 'routes/web.php'));
    db.upsertStructuralNode(symNode('symbol:Other', 'app/Other.php'));

    // evidence-only: endpoints are the surface + handler (neither keyed under routes/web.php by
    // node file_path in a way node-path would catch beyond the surface); evidence cites the route.
    db.upsertStructuralEdge(
      edge('edge:evidence', {
        source_node_id: 'surface:http:GET:/x',
        target_node_id: 'symbol:Handler',
        edge_type: 'handled_by',
      })
    );
    db.replaceEdgeEvidence('edge:evidence', [
      {
        id: 'ev:evidence',
        edge_id: 'edge:evidence',
        resolver: 'r',
        evidence_kind: 'k',
        file_path: 'routes/web.php',
        recorded_at: now(),
      },
    ]);

    // node-path: target node lives in routes/web.php.
    db.upsertStructuralEdge(
      edge('edge:nodepath', {
        source_node_id: 'symbol:Handler',
        target_node_id: 'symbol:routeLocal',
      })
    );

    // unrelated: endpoints + evidence entirely in app/Other.php.
    db.upsertStructuralEdge(
      edge('edge:unrelated', { source_node_id: 'symbol:Other', target_node_id: 'symbol:Other' })
    );
    db.replaceEdgeEvidence('edge:unrelated', [
      {
        id: 'ev:unrelated',
        edge_id: 'edge:unrelated',
        resolver: 'r',
        evidence_kind: 'k',
        file_path: 'app/Other.php',
        recorded_at: now(),
      },
    ]);

    persistRebuildTrustState(db, overlayCompleteResult(repoDir), { lastIndexedCommit: baseCommit });
    // The sync path reads the index-metadata pointer (not the trust-state JSON field); without it
    // the CLI would take the "no previous commit → full rebuild" path and clear the seeded overlay.
    db.setIndexMetadata('last_indexed_commit', baseCommit);
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('downgrades evidence + node-path edges, sets stale-overlay trust, advances the pointer (SC-3)', () => {
    // commit a structural change to the route file.
    writeFileSync(join(repoDir, 'routes', 'web.php'), '<?php // routes v2 changed\n');
    const headCommit = commitAll(repoDir, 'route change');

    // delta-style path-join probe of what SHOULD be marked, computed on the pre-sync overlay.
    const probeDb = new LuxDatabase(dbPath);
    const evidenceEdges = probeDb
      .getEvidenceEdgesForFilePaths(['routes/web.php'])
      .filter((e) => e.freshness_status === 'fresh')
      .map((e) => e.id);
    const nodePathNodeIds = new Set(
      probeDb.getStructuralNodesByFilePath('routes/web.php').map((n) => n.id)
    );
    probeDb.close();

    const result = runCli(repoDir, dbPath, ['index', 'sync', '--mark-only']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Sync path: mark-only edge downgrade');
    expect(result.stdout).not.toContain('Sync path: canonical overlay rebuild');
    expect(result.stdout).toContain('Overlay trust after sync: stale-overlay');

    const db = new LuxDatabase(dbPath);
    // evidence dimension + node-path dimension both fired.
    expect(statusOf(db, 'edge:evidence')).toBe('stale');
    expect(statusOf(db, 'edge:nodepath')).toBe('stale');
    // unrelated file's edge untouched.
    expect(statusOf(db, 'edge:unrelated')).toBe('fresh');

    // trust downgraded to stale-overlay (degraded-overlay mode, index-sync source).
    const trust = loadOverlayTrustState(db);
    expect(trust?.mode).toBe('degraded-overlay');
    expect(trust?.sourceAction).toBe('index-sync');
    expect(deriveOverlayTrustLevelFromState(trust)).toBe('stale-overlay');

    // pointer advanced to HEAD (OQ4-safe: delta reads the marks).
    expect(db.getIndexMetadata('last_indexed_commit')).toBe(headCommit);

    // the union of the two dimensions matches what the marks actually flagged.
    const stalePaths = db.getFilePathsWithStaleEdges();
    expect(stalePaths).toContain('routes/web.php');
    db.close();

    // the probe predicted exactly the evidence + node-path edges we saw marked.
    expect(evidenceEdges).toContain('edge:evidence');
    expect([...nodePathNodeIds]).toContain('symbol:routeLocal');
  });

  it('leaves an unrelated docs-only sync on the incremental path (no marks)', () => {
    // a non-structural change must NOT trigger the mark-only downgrade path even with the flag.
    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');
    commitAll(repoDir, 'docs add');

    const result = runCli(repoDir, dbPath, ['index', 'sync', '--mark-only']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Sync path: mark-only edge downgrade');

    const db = new LuxDatabase(dbPath);
    expect(statusOf(db, 'edge:evidence')).toBe('fresh');
    expect(statusOf(db, 'edge:nodepath')).toBe('fresh');
    db.close();
  });
});
