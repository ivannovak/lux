import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import type { RebuildResult } from '../../scanner/rebuild-orchestrator.js';
import type { StructuralEdge, StructuralNode } from '../../db/types.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

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
function overlayComplete(repoPath: string): RebuildResult {
  return {
    mode: 'overlay-complete',
    repoPath,
    configSource: 'lux.yaml',
    configLspEnabled: true,
    surfaceCount: 1,
    detectorEdgeCount: 2,
    propagatedEdgeCount: 0,
    fileNodeCount: 3,
    symbolNodeCount: 3,
    controllerBackedCount: 1,
    closureBackedCount: 0,
    unknownProviderKindCount: 0,
    enrichmentStatus: 'active',
    propagationStatus: 'ran',
    warnings: [],
  };
}
function node(id: string, over: Partial<StructuralNode>): StructuralNode {
  return { id, node_type: 'symbol', updated_at: now(), ...over };
}
function edge(id: string, over: Partial<StructuralEdge>): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}

/** Strip the additive annotation so the resolution content can be compared byte-for-byte. */
function withoutStaleSupport(json: string): unknown {
  const obj = JSON.parse(json) as Record<string, unknown>;
  delete obj.staleSupport;
  return obj;
}

describe('stale-aware consumer annotations (spec 11 Part C / SC-4)', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-stale-annot-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-stale-annot-db-'));
    dbPath = join(dbDir, 'lux.db');
    mkdirSync(join(repoDir, 'routes'), { recursive: true });
    mkdirSync(join(repoDir, 'app'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'stale-annot-test' }));

    const db = new LuxDatabase(dbPath);
    persistRebuildTrustState(db, overlayComplete(repoDir), { sourceAction: 'index-rebuild' });

    // --- trace fixture: AlphaService --calls--> BetaService ---
    db.upsertStructuralNode(
      node('symbol:svc:A', {
        symbol_name: 'AlphaService',
        qualified_name: 'App\\Svc\\AlphaService',
        file_path: 'app/A.php',
      })
    );
    db.upsertStructuralNode(
      node('symbol:svc:B', {
        symbol_name: 'BetaService',
        qualified_name: 'App\\Svc\\BetaService',
        file_path: 'app/B.php',
      })
    );
    db.upsertStructuralEdge(
      edge('edge:calls', { source_node_id: 'symbol:svc:A', target_node_id: 'symbol:svc:B' })
    );

    // --- route fixture (feature-path + spec-evidence): POST /offers handled_by OfferController@store ---
    db.upsertStructuralNode({
      id: 'file:routes/api.php',
      node_type: 'file',
      file_path: 'routes/api.php',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: 'surface:http:POST:/offers',
      node_type: 'capability-surface',
      symbol_name: 'POST /offers',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({ method: 'POST', path: '/offers', routeName: 'offers.store' }),
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: 'symbol:php:App\\Http\\Controllers\\OfferController@store',
      node_type: 'symbol',
      symbol_name: 'OfferController@store',
      file_path: 'app/Http/Controllers/OfferController.php',
      updated_at: now(),
    });
    db.upsertStructuralEdge(
      edge('edge:declares', {
        source_node_id: 'file:routes/api.php',
        target_node_id: 'surface:http:POST:/offers',
        edge_type: 'declares_surface',
      })
    );
    db.upsertStructuralEdge(
      edge('edge:handled', {
        source_node_id: 'surface:http:POST:/offers',
        target_node_id: 'symbol:php:App\\Http\\Controllers\\OfferController@store',
        edge_type: 'handled_by',
        confidence_class: 'framework-inferred',
      })
    );
    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  function markFilesStale(filePaths: string[]): void {
    const db = new LuxDatabase(dbPath);
    db.markEdgesStaleForFiles(filePaths);
    db.close();
  }

  it('trace: staleSupport 0 when fresh, ≥1 after marking, resolution byte-identical + text warns', () => {
    const fresh = runCli(repoDir, dbPath, ['trace', 'AlphaService', '--json']);
    expect(fresh.status).toBe(0);
    const freshJson = JSON.parse(fresh.stdout) as { staleSupport: { staleCount: number } };
    expect(freshJson.staleSupport.staleCount).toBe(0);

    // mark the calls edge stale via its source file (production node-path mechanism).
    markFilesStale(['app/A.php']);

    const stale = runCli(repoDir, dbPath, ['trace', 'AlphaService', '--json']);
    expect(stale.status).toBe(0);
    const staleJson = JSON.parse(stale.stdout) as { staleSupport: { staleCount: number } };
    expect(staleJson.staleSupport.staleCount).toBeGreaterThanOrEqual(1);

    // resolution (nodes/edges/stats) unchanged — only the additive annotation differs.
    expect(withoutStaleSupport(stale.stdout)).toEqual(withoutStaleSupport(fresh.stdout));

    // text mode emits the warning after marking.
    const text = runCli(repoDir, dbPath, ['trace', 'AlphaService']);
    expect(text.stderr).toContain('supporting edge(s) are marked stale');
  });

  it('spec-evidence: staleSupport 0 when fresh, ≥1 after marking, packet byte-identical', () => {
    const args = [
      'overlay',
      'spec-evidence',
      'ask',
      '--json',
      '--target',
      'POST /offers',
      '--kind',
      'route',
      'What source evidence supports this route?',
    ];
    const fresh = runCli(repoDir, dbPath, args);
    expect(fresh.status).toBe(0);
    const freshJson = JSON.parse(fresh.stdout) as { staleSupport: { staleCount: number } };
    expect(freshJson.staleSupport.staleCount).toBe(0);

    markFilesStale(['routes/api.php']); // marks the handled_by + declares edges on the surface node.

    const stale = runCli(repoDir, dbPath, args);
    expect(stale.status).toBe(0);
    const staleJson = JSON.parse(stale.stdout) as { staleSupport: { staleCount: number } };
    expect(staleJson.staleSupport.staleCount).toBeGreaterThanOrEqual(1);

    expect(withoutStaleSupport(stale.stdout)).toEqual(withoutStaleSupport(fresh.stdout));
  });

  it('feature-path: staleSupport 0 when fresh, ≥1 after marking, answer byte-identical + text warns', () => {
    const args = ['overlay', 'feature-path', 'ask', '--target', 'POST /offers', 'what handles it?'];
    const freshJsonRun = runCli(repoDir, dbPath, [...args, '--json']);
    expect(freshJsonRun.status).toBe(0);
    const freshJson = JSON.parse(freshJsonRun.stdout) as { staleSupport: { staleCount: number } };
    expect(freshJson.staleSupport.staleCount).toBe(0);

    markFilesStale(['routes/api.php']);

    const staleJsonRun = runCli(repoDir, dbPath, [...args, '--json']);
    expect(staleJsonRun.status).toBe(0);
    const staleJson = JSON.parse(staleJsonRun.stdout) as { staleSupport: { staleCount: number } };
    expect(staleJson.staleSupport.staleCount).toBeGreaterThanOrEqual(1);

    expect(withoutStaleSupport(staleJsonRun.stdout)).toEqual(
      withoutStaleSupport(freshJsonRun.stdout)
    );

    // text mode emits the warning after marking.
    const text = runCli(repoDir, dbPath, args);
    expect(text.stderr).toContain('supporting edge(s) are marked stale');
  });
});
