import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

describe('overlay feature-path CLI', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-overlay-feature-path-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-overlay-feature-path-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'app', 'Http', 'Controllers'), { recursive: true });
    mkdirSync(join(repoDir, 'routes'), { recursive: true });
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'overlay-feature-path-test' })
    );

    const db = new LuxDatabase(dbPath);

    persistRebuildTrustState(
      db,
      {
        mode: 'overlay-complete',
        repoPath: repoDir,
        configSource: 'lux.yaml',
        configLspEnabled: true,
        surfaceCount: 2,
        detectorEdgeCount: 1,
        propagatedEdgeCount: 0,
        fileNodeCount: 3,
        symbolNodeCount: 1,
        controllerBackedCount: 1,
        closureBackedCount: 0,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'active',
        propagationStatus: 'ran',
        warnings: [],
      },
      { sourceAction: 'index-rebuild' }
    );

    const now = Math.floor(Date.now() / 1000);

    db.upsertStructuralNode({
      id: 'surface:http:POST:/offers',
      node_type: 'capability-surface',
      symbol_name: 'POST /offers',
      language_id: 'http',
      file_path: 'routes/api.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'POST',
        path: '/offers',
        routeName: 'offers.store',
      }),
      updated_at: now,
    });

    db.upsertStructuralNode({
      id: 'surface:http:GET:/',
      node_type: 'capability-surface',
      symbol_name: 'GET /',
      language_id: 'http',
      file_path: 'routes/web.php',
      metadata: JSON.stringify({
        transport: 'http',
        method: 'GET',
        path: '/',
        routeName: 'home',
      }),
      updated_at: now,
    });

    db.upsertStructuralNode({
      id: 'symbol:php:App\\Http\\Controllers\\OfferController@store',
      node_type: 'symbol',
      symbol_name: 'OfferController@store',
      language_id: 'php',
      file_path: 'app/Http/Controllers/OfferController.php',
      metadata: '{}',
      updated_at: now,
    });

    db.upsertStructuralEdge({
      id: 'edge:handled_by:surface:http:POST:/offers',
      source_node_id: 'surface:http:POST:/offers',
      target_node_id: 'symbol:php:App\\Http\\Controllers\\OfferController@store',
      edge_type: 'handled_by',
      confidence: 0.9,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'test',
      updated_at: now,
    });

    db.close();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('answers a route-handler question with text rendering and direct evidence sections', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'feature-path',
      'ask',
      'what handles POST /offers?',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OfferController@store');
    expect(result.stdout).toContain('Overlay Trust: overlay-complete');
    // English-wrapped questions resolve via the contains tier (the question
    // string contains the route form). The post-narrow-pass resolver still
    // accepts these — but only when the matched form is specific enough.
    expect(result.stdout).toContain('Resolution Match: contains');
    expect(result.stdout).toContain('Direct evidence');
  });

  it('resolves a bare "POST /offers" target via semantic-exact when --target is used', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'feature-path',
      'ask',
      'what handles POST /offers?',
      '--target',
      'POST /offers',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Resolution Match: semantic-exact');
    expect(result.stdout).toContain('OfferController@store');
  });

  it('emits a schema-validated JSON payload with --json', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'feature-path',
      'ask',
      'what handles POST /offers?',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      schemaVersion: number;
      question: string;
      intent: string;
      target: { id: string } | null;
      primaryAnswer: { summary: string; confidence: string };
      directEvidence: Array<{ kind: string; nodeId?: string }>;
      context: unknown[];
      failures: unknown[];
    };

    expect(payload.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(payload.intent).toBe('route-handler');
    expect(payload.target?.id).toBe('surface:http:POST:/offers');
    expect(payload.primaryAnswer.confidence).toBe('high');
    const evidenceKinds = payload.directEvidence.map((item) => item.kind);
    expect(evidenceKinds).toContain('route-declaration');
    expect(evidenceKinds).toContain('handler-recovery');
  });

  it('exits 1 and refuses honestly when the question cannot resolve to a surface', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'feature-path',
      'ask',
      'what handles POST /missing-route?',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Resolution: unresolved');
  });

  // Regression: the contains-tier mis-targeting bug from the tranche-one
  // promotion-decision document must stay fixed at the CLI seam too.
  it('does not let GET / mis-target an English-wrapped question about a deeper route', () => {
    const result = runCli(repoDir, dbPath, [
      'overlay',
      'feature-path',
      'ask',
      'what handles POST /private-offers?',
    ]);

    // Either we resolve to the real /private-offers (which doesn't exist here,
    // so we expect unresolved) or we refuse — but never confidently target GET /.
    expect(result.stdout).not.toContain('Target: GET /');
    expect(result.stdout).not.toMatch(/Resolution Match: contains[\s\S]*GET \//);
  });
});
