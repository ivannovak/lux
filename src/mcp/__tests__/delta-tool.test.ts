// Spec 16 — the `lux_delta` MCP tool. The MCP `case 'lux_delta'` delegates to the shared
// `computeDelta` orchestrator (byte-identical envelope with the CLI) and the tool's non-negotiable
// requirement is Decision 17: an injection-shaped `--base` is validated (isSafeGitRef) BEFORE any
// git call, argv-form, NO shell. These tests exercise that contract directly and — for
// ListTools/CallTool wiring (SC-8) — over the wire against a spawned server via the MCP SDK client.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LuxDatabase } from '../../db/index.js';
import { computeDelta } from '../../scanner/delta/run.js';
import type { DeltaOptions } from '../../scanner/delta/types.js';
import { built } from '../../__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
// The wire test drives the BUILT server (plain node, negligible startup) rather than compiling it
// on-spawn via tsx — the latter's CPU spike starved the parallel WASM-SQLite fixtures. The gate
// builds before testing, so dist is always present there; a bare `npm test` (no build) skips it.
const DIST_SERVER = built('src/mcp/server.ts');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** Build a git repo corpus with a current-schema `.lux` index whose last_indexed_commit = HEAD. */
function makeFixture(root: string): { corpus: string; dbPath: string; head: string } {
  const corpus = join(root, 'corpus');
  mkdirSync(corpus, { recursive: true });
  git(corpus, ['init', '-q']);
  git(corpus, ['config', 'user.email', 'test@example.com']);
  git(corpus, ['config', 'user.name', 'Test']);
  git(corpus, ['config', 'commit.gpgsign', 'false']);
  git(corpus, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const head = git(corpus, ['rev-parse', 'HEAD']);

  const dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath); // autoMigrate=true → current schema
  db.setIndexMetadata('last_indexed_commit', head);
  db.close();
  return { corpus, dbPath, head };
}

function baseOptions(overrides: Partial<DeltaOptions> = {}): DeltaOptions {
  return {
    depth: 6,
    maxNodes: 2000,
    maxFanout: 64,
    minConfidence: 'framework-inferred',
    json: true,
    ...overrides,
  };
}

describe('lux_delta MCP tool — computeDelta contract (spec 16 / Decision 17)', () => {
  let root: string;
  let corpus: string;
  let db: LuxDatabase;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lux-delta-mcp-direct-'));
    const fx = makeFixture(root);
    corpus = fx.corpus;
    db = new LuxDatabase(fx.dbPath); // shared, already-migrated handle (as the MCP server holds)
  });
  afterAll(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a schemaVersion:1 delta envelope for a benign (default) base', () => {
    const result = computeDelta(db, corpus, baseOptions());
    expect('report' in result).toBe(true);
    if ('report' in result) {
      expect(result.report.schemaVersion).toBe(1);
      expect(result.report.surface).toBe('delta');
      expect(result.report.touched).toBeDefined();
      expect(result.report.downstream).toBeDefined();
      expect(result.report.trust).toBeDefined();
    }
  });

  it('refuses an injection-shaped --base without spawning a shell (Decision 17, --check mode)', () => {
    const probe = join(root, 'INJECTION_PROBE');
    expect(existsSync(probe)).toBe(false);

    // --check turns baseline-unavailable into a hard refusal (analysis mode degrades it).
    const result = computeDelta(
      db,
      corpus,
      baseOptions({ base: `--output=${probe}`, check: true })
    );

    expect('refusal' in result).toBe(true);
    if ('refusal' in result) expect(result.refusal.reason).toBe('baseline-unavailable');
    // The injection string never reached a git call → the probe file was never written.
    expect(existsSync(probe)).toBe(false);
  });

  it('degrades an injection --base to an empty report in analysis mode (still no shell)', () => {
    const probe = join(root, 'INJECTION_PROBE_2');
    const result = computeDelta(db, corpus, baseOptions({ base: `--output=${probe}` }));
    // Analysis mode (no --check): baseline-unavailable degrades to a warned empty report.
    expect('report' in result).toBe(true);
    if ('report' in result) {
      expect(result.report.schemaVersion).toBe(1);
      expect(result.report.trust.warnings.some((w) => w.includes('not a valid ref'))).toBe(true);
    }
    expect(existsSync(probe)).toBe(false);
  });

  it('mirrors the MCP payload wrapping: report vs {error: refusal}', () => {
    const ok = computeDelta(db, corpus, baseOptions());
    const okPayload = 'refusal' in ok ? { error: ok.refusal } : ok.report;
    expect('error' in okPayload).toBe(false);

    const bad = computeDelta(db, corpus, baseOptions({ base: '$(rm -rf /)', check: true }));
    const badPayload = 'refusal' in bad ? { error: bad.refusal } : bad.report;
    expect('error' in badPayload).toBe(true);
  });
});

describe('lux_delta MCP tool — over the wire (ListTools + CallTool, SC-8)', () => {
  let root: string;
  let corpus: string;
  let dbPath: string;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-delta-mcp-wire-'));
    const fx = makeFixture(root);
    corpus = fx.corpus;
    dbPath = fx.dbPath;

    client = new Client({ name: 'delta-tool-test', version: '0.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: corpus, LUX_DB_PATH: dbPath },
      stderr: 'ignore',
    });
    await client.connect(transport);
  }, 60000);

  afterAll(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists lux_delta with the documented input schema (incl. the against cross-repo param)', async () => {
    const { tools } = await client.listTools();
    const delta = tools.find((t) => t.name === 'lux_delta');
    expect(delta).toBeDefined();
    const props = (delta!.inputSchema.properties ?? {}) as Record<string, unknown>;
    for (const key of [
      'base',
      'committed_only',
      'depth',
      'max_nodes',
      'min_confidence',
      'against',
    ]) {
      expect(props[key]).toBeDefined();
    }
  });

  it('CallTool with against:[ghost] returns crossRepoImpact with the sibling attached:false (never dropped, SC-8)', async () => {
    const res = await client.callTool({
      name: 'lux_delta',
      arguments: { against: ['ghost'] },
    });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      schemaVersion?: number;
      crossRepoImpact?: { siblings: Array<{ name: string; attached: boolean }> };
    };
    expect(payload.schemaVersion).toBe(1); // additive — no bump (SC-9)
    const ghost = payload.crossRepoImpact?.siblings.find((s) => s.name === 'ghost');
    expect(ghost).toMatchObject({ name: 'ghost', attached: false });
  });

  it('CallTool with a benign base returns a parseable schemaVersion:1 envelope', async () => {
    const res = await client.callTool({ name: 'lux_delta', arguments: {} });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload.surface).toBe('delta');
  });

  it('CallTool with an injection base never spawns a shell / writes the probe (Decision 17)', async () => {
    const probe = join(root, 'WIRE_INJECTION_PROBE');
    expect(existsSync(probe)).toBe(false);
    const res = await client.callTool({
      name: 'lux_delta',
      arguments: { base: `--output=${probe}` },
    });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    // Analysis-mode MCP surface: the unsafe base degrades to a warned empty report; the load-bearing
    // invariant is that git was never invoked with the injection → the probe file does not exist.
    const payload = JSON.parse(content.text) as {
      schemaVersion?: number;
      trust?: { warnings?: string[] };
      error?: { reason?: string };
    };
    const refusedOrWarned =
      payload.error?.reason === 'baseline-unavailable' ||
      (payload.trust?.warnings ?? []).some((w) => w.includes('not a valid ref'));
    expect(refusedOrWarned).toBe(true);
    expect(existsSync(probe)).toBe(false);
  });
});

// Fix #1: the MCP `lux_delta` handler must validate `min_confidence` against the ConfidenceClass
// enum and fall back to the CLI default on an out-of-enum value. Without the guard, "high" is cast
// straight to ConfidenceClass, the reverse-walk floor is `undefined`, every confidence comparison is
// false, and the agent receives a confidently-wrong EMPTY (non-truncated) result. This is driven
// over the wire so it exercises the real server.ts argument handling, not a re-implementation.
function makeReachableFixture(root: string): { corpus: string; dbPath: string } {
  const corpus = join(root, 'corpus');
  mkdirSync(corpus, { recursive: true });
  git(corpus, ['init', '-q']);
  git(corpus, ['config', 'user.email', 'test@example.com']);
  git(corpus, ['config', 'user.name', 'Test']);
  git(corpus, ['config', 'commit.gpgsign', 'false']);
  git(corpus, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const base = git(corpus, ['rev-parse', 'HEAD']);
  writeFileSync(join(corpus, 'Service.php'), '<?php class Service {}');
  git(corpus, ['add', '-A']);
  git(corpus, ['commit', '-q', '-m', 'add service']);

  const dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath);
  db.setIndexMetadata('last_indexed_commit', base); // diff base = the empty base commit
  // a surface reachable from the touched Service symbol ONLY via a framework-inferred handled_by
  // edge: found at the default floor, dropped at a stricter valid floor (proven), and dropped if the
  // class is treated as unknown.
  db.upsertStructuralNode({
    id: 'symbol:Service',
    node_type: 'symbol',
    file_path: 'Service.php',
    updated_at: 1,
  });
  db.upsertStructuralNode({
    id: 'surface:http:GET:/svc',
    node_type: 'capability-surface',
    updated_at: 1,
  });
  db.upsertStructuralEdge({
    id: 'edge:svc',
    source_node_id: 'surface:http:GET:/svc',
    target_node_id: 'symbol:Service',
    edge_type: 'handled_by',
    confidence: 0.8,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  });
  db.close();
  return { corpus, dbPath };
}

describe('lux_delta MCP tool — min_confidence enum guard over the wire (fix)', () => {
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-delta-mcp-minconf-'));
    const fx = makeReachableFixture(root);
    client = new Client({ name: 'delta-minconf-test', version: '0.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: fx.corpus, LUX_DB_PATH: fx.dbPath },
      stderr: 'ignore',
    });
    await client.connect(transport);
  }, 60000);

  afterAll(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function surfaceIds(min_confidence?: string): Promise<string[]> {
    const args = min_confidence === undefined ? {} : { min_confidence };
    const res = await client.callTool({ name: 'lux_delta', arguments: args });
    const content = (res.content as Array<{ type: string; text: string }>)[0];
    const payload = JSON.parse(content.text) as {
      downstream?: { entrySurfaces?: Array<{ id: string }> };
    };
    return (payload.downstream?.entrySurfaces ?? []).map((s) => s.id);
  }

  it('honors a valid stricter min_confidence: proven drops the framework-inferred surface (control)', async () => {
    // Proves min_confidence is actually applied — so finding the surface below is meaningful.
    expect(await surfaceIds('proven')).not.toContain('surface:http:GET:/svc');
  });

  it('an out-of-enum min_confidence ("high") falls back to the default — NOT a confidently-wrong empty', async () => {
    // If "high" leaked through as an unknown class, the floor would be undefined and the surface
    // would be dropped (empty). Finding it proves the guard normalized "high" to the default floor.
    expect(await surfaceIds('high')).toContain('surface:http:GET:/svc');
  });
});
