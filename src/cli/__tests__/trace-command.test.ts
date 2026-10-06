import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import type { TraceResult } from '../../scanner/associations/trace.js';
import type { TraversalResultV1 } from '../../scanner/associations/traversal/index.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}

/** Seed a small C(local) → A(local) → B(vendor) graph the CLI can trace. */
function seedGraph(dbPath: string): void {
  const db = new LuxDatabase(dbPath);
  const now = Math.floor(Date.now() / 1000);
  db.upsertStructuralNode({
    id: 'A',
    node_type: 'symbol',
    symbol_name: 'App\\Http\\Controllers\\InvoiceController::store',
    qualified_name: 'App\\Http\\Controllers\\InvoiceController::store',
    origin: 'local',
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'B',
    node_type: 'symbol',
    symbol_name: 'Illuminate\\Database\\Eloquent\\Model::save',
    qualified_name: 'Illuminate\\Database\\Eloquent\\Model::save',
    origin: 'vendor-pack',
    updated_at: now,
  });
  db.upsertStructuralNode({
    id: 'C',
    node_type: 'symbol',
    symbol_name: 'App\\Routes::invoice',
    qualified_name: 'App\\Routes::invoice',
    origin: 'local',
    updated_at: now,
  });
  db.upsertStructuralEdge({
    id: 'C->A:calls',
    source_node_id: 'C',
    target_node_id: 'A',
    edge_type: 'calls',
    confidence: 0.8,
    confidence_class: 'artifact-backed',
    freshness_status: 'stale',
    dirty_dependency_count: 0,
    updated_at: now,
  });
  db.upsertStructuralEdge({
    id: 'A->B:calls',
    source_node_id: 'A',
    target_node_id: 'B',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now,
  });
  db.close();
}

describe('lux trace CLI', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-trace-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-cli-trace-db-'));
    dbPath = join(dbDir, 'lux.db');
    seedGraph(dbPath);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('emits the TraceResult as JSON, honouring parsed --depth', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'A', '--json', '--depth', '5']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as TraceResult;
    expect(payload.startId).toBe('A');
    expect(payload.options.maxDepth).toBe(5);
    const b = payload.nodes.find((n) => n.id === 'B');
    expect(b?.external).toBe(true);
    expect(payload.stats.externalCount).toBe(1);
    expect(payload.edges.map((e) => e.id)).toContain('A->B:calls');
  });

  it('pretty-prints the DAG with a vendor tag and a stats footer', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'A']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Trace from App\\Http\\Controllers\\InvoiceController::store');
    expect(result.stdout).toContain('[vendor]');
    expect(result.stdout).toContain('1 vendor');
  });

  it('keeps explicit outgoing text and JSON byte-identical to the existing default', () => {
    const implicitText = runCli(repoDir, dbPath, ['trace', 'A']);
    const outgoingText = runCli(repoDir, dbPath, ['trace', 'A', '--direction', 'outgoing']);
    const implicitJson = runCli(repoDir, dbPath, ['trace', 'A', '--json']);
    const outgoingJson = runCli(repoDir, dbPath, [
      'trace',
      'A',
      '--json',
      '--direction',
      'outgoing',
    ]);

    expect(outgoingText.status).toBe(0);
    expect(outgoingText.stdout).toBe(implicitText.stdout);
    expect(outgoingText.stderr).toBe(implicitText.stderr);
    expect(outgoingJson.status).toBe(0);
    expect(outgoingJson.stdout).toBe(implicitJson.stdout);
    expect(outgoingJson.stderr).toBe(implicitJson.stderr);
  });

  it('emits incoming JSON with telemetry, canonical endpoints, and traversed direction', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'A', '--direction', 'incoming', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as TraversalResultV1 & {
      telemetry: { recorded: boolean; reason: string };
    };
    expect(payload.options.direction).toBe('incoming');
    expect(payload.telemetry).toEqual({ recorded: false, reason: 'read-only-index' });
    expect(payload.nodes.map((node) => node.id)).toEqual(['A', 'C']);
    expect(payload.edges).toHaveLength(1);
    expect(payload.edges[0]).toMatchObject({
      id: 'C->A:calls',
      source_node_id: 'C',
      target_node_id: 'A',
      traversed: 'reverse',
      freshness_status: 'stale',
    });
    expect(payload.stats.freshness).toEqual({
      fresh: 0,
      stale: 1,
      dirtyDependent: 0,
      unknown: 0,
    });
  });

  it('renders both directions with canonical endpoints, traversal annotations, and freshness', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'A', '--direction', 'both']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Trace both from App\\Http\\Controllers\\InvoiceController::store'
    );
    expect(result.stdout).toContain('A → B  [calls, forward]');
    expect(result.stdout).toContain('C → A  [calls, reverse]');
    expect(result.stdout).toContain('Freshness: 2 fresh, 2 stale');
  });

  it('applies max-fanout once across both directions', () => {
    const result = runCli(repoDir, dbPath, [
      'trace',
      'A',
      '--direction',
      'both',
      '--max-fanout',
      '1',
      '--depth',
      '1',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as TraversalResultV1;
    expect(payload.options.maxFanout).toBe(1);
    const firstHopEdges = payload.edges.filter(
      (edge) => edge.source_node_id === 'A' || edge.target_node_id === 'A'
    );
    expect(firstHopEdges).toHaveLength(1);
    expect(payload.nodes[0].terminus).toBe('fanout-cap');
    expect(payload.stats.truncated).toBe(true);
  });

  it('rejects an unsupported direction before opening or resolving the index', () => {
    const result = runCli(repoDir, join(dbDir, 'absent.db'), [
      'trace',
      'A',
      '--direction',
      'sideways',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--direction must be one of: outgoing, incoming, both');
  });

  it('produces an app-only trace under --no-external', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'A', '--json', '--no-external']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as TraceResult;
    expect(payload.stats.externalCount).toBe(0);
    expect(payload.nodes.map((n) => n.id)).toEqual(['A']);
  });

  it('exits non-zero with guidance when the symbol is not found', () => {
    const result = runCli(repoDir, dbPath, ['trace', 'DoesNotExist::nope']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No structural symbol found for: DoesNotExist::nope');
  });
});
