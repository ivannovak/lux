// MCP status parity — deps impact, overlay/index status, and doctor. Each MCP handler
// delegates to the SAME library the CLI uses (computeImpact from src/cli/deps-impact.ts;
// buildOverlayStatusPayload / buildIndexStatusPayload from src/cli/status-payload.ts) — the tools do
// not fork the query logic. These tests exercise the shared functions directly and — for
// ListTools/CallTool wiring — over the wire against the BUILT server via the MCP SDK client, exactly
// as delta-tool.test.ts / search-tool.test.ts do.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { LuxDatabase } from '../../db/index.js';
import { computeImpact } from '../../cli/deps-impact.js';
import { buildIndexStatusPayload, buildOverlayStatusPayload } from '../../cli/status-payload.js';
import { buildDoctorPayload } from '../../cli/doctor.js';
import { resolveRuntimePaths } from '../../utils/runtime-paths.js';
import { built } from '../../__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * A git-repo corpus with a `packages/{name}` module layout on disk, a current-schema `.lux` index
 * whose last_indexed_commit = HEAD, and one module dependency (beta → alpha) so a blast-radius query
 * for an alpha file finds beta as a dependent.
 */
function makeFixture(root: string): { corpus: string; dbPath: string; head: string } {
  const corpus = join(root, 'corpus');
  mkdirSync(join(corpus, 'packages', 'alpha'), { recursive: true });
  mkdirSync(join(corpus, 'packages', 'beta'), { recursive: true });
  writeFileSync(join(corpus, 'packages', 'alpha', 'index.ts'), 'export const alpha = 1;\n');
  writeFileSync(join(corpus, 'packages', 'beta', 'uses-alpha.ts'), "import '../alpha';\n");

  git(corpus, ['init', '-q']);
  git(corpus, ['config', 'user.email', 'test@example.com']);
  git(corpus, ['config', 'user.name', 'Test']);
  git(corpus, ['config', 'commit.gpgsign', 'false']);
  git(corpus, ['add', '-A']);
  git(corpus, ['commit', '-q', '-m', 'base']);
  const head = git(corpus, ['rev-parse', 'HEAD']);

  const dbPath = join(corpus, '.lux', 'lux.db');
  const db = new LuxDatabase(dbPath); // autoMigrate → current schema
  db.setIndexMetadata('last_indexed_commit', head);
  db.insertModuleDependency({
    source_module: 'beta',
    target_module: 'alpha',
    reference_count: 3,
    sample_files: JSON.stringify(['packages/beta/uses-alpha.ts']),
  });
  db.close();
  return { corpus, dbPath, head };
}

describe('MCP parity trio — shared library contracts (direct call)', () => {
  let root: string;
  let corpus: string;
  let dbPath: string;
  let db: LuxDatabase;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lux-status-tools-direct-'));
    const fx = makeFixture(root);
    corpus = fx.corpus;
    dbPath = fx.dbPath;
    db = new LuxDatabase(dbPath); // shared, already-migrated handle (as the MCP server holds)
  });
  afterAll(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('computeImpact resolves a module file and reports its dependents / blast radius', () => {
    const result = computeImpact(db, corpus, join(corpus, 'packages', 'alpha', 'index.ts'));
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.impact.module).toBe('alpha');
      expect(result.impact.blastRadius.modules).toBe(1);
      expect(result.impact.blastRadius.totalReferences).toBe(3);
      const beta = result.impact.dependentModules.find((d) => d.module === 'beta');
      expect(beta).toBeDefined();
      expect(beta!.referenceCount).toBe(3);
      expect(beta!.sampleFiles).toContain('packages/beta/uses-alpha.ts');
    }
  });

  it('computeImpact reports resolved:false for a file outside any module boundary', () => {
    const result = computeImpact(db, corpus, join(corpus, 'README.md'));
    expect(result.resolved).toBe(false);
    if (!result.resolved) expect(result.file).toContain('README.md');
  });

  it('buildOverlayStatusPayload (with runtime) carries overlay trust + runtime + freshness', () => {
    const runtime = resolveRuntimePaths({ corpus, db: dbPath });
    const payload = buildOverlayStatusPayload(db, runtime);
    expect('overlay' in payload).toBe(true);
    if ('overlay' in payload) {
      expect(payload.overlay.trustLevel).toBeDefined();
      expect(payload.runtime.corpusPath).toBe(corpus);
      expect(payload.freshness?.headMatchesIndex).toBe(true);
    }
  });

  it('buildIndexStatusPayload and doctor carry identical coverage without mutating trust', () => {
    const runtime = resolveRuntimePaths({ corpus, db: dbPath });
    const beforeTrust = db.getIndexMetadata('overlay_trust_state');
    const payload = buildIndexStatusPayload(db, runtime);
    const doctor = buildDoctorPayload(db, runtime);
    expect(payload.stats).toBeDefined();
    expect(payload.overlay.trustLevel).toBeDefined();
    expect(payload.coverage.languages).toBeInstanceOf(Array);
    expect(doctor).toEqual(payload);
    expect(payload.runtime?.corpusPath).toBe(corpus);
    expect(payload.freshness?.indexedCommit).not.toBeNull();
    expect(payload.freshness?.headMatchesIndex).toBe(true);
    expect(db.getIndexMetadata('overlay_trust_state')).toBe(beforeTrust);
  });
});

describe('MCP parity trio — over the wire (ListTools + CallTool)', () => {
  let root: string;
  let corpus: string;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-status-tools-wire-'));
    const fx = makeFixture(root);
    corpus = fx.corpus;

    client = new Client({ name: 'status-tools-test', version: '0.0.0' }, { capabilities: {} });
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

  function parse(res: unknown): Record<string, unknown> {
    const content = (res as { content: Array<{ type: string; text: string }> }).content[0];
    return JSON.parse(content.text) as Record<string, unknown>;
  }

  it('lists the three new tools with their documented input schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['lux_deps_impact', 'lux_overlay_status', 'lux_index_status', 'lux_doctor']) {
      expect(names).toContain(n);
    }
    const depsImpact = tools.find((t) => t.name === 'lux_deps_impact');
    const props = (depsImpact!.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(props.file_path).toBeDefined();
    expect(depsImpact!.inputSchema.required).toContain('file_path');
  });

  it('lux_deps_impact returns the blast-radius envelope for a resolvable module file', async () => {
    const res = await client.callTool({
      name: 'lux_deps_impact',
      arguments: { file_path: join(corpus, 'packages', 'alpha', 'index.ts') },
    });
    expect(res.isError).toBeFalsy();
    const payload = parse(res) as {
      module?: string;
      blastRadius?: { modules: number; totalReferences: number };
      dependentModules?: Array<{ module: string; referenceCount: number }>;
    };
    expect(payload.module).toBe('alpha');
    expect(payload.blastRadius?.modules).toBe(1);
    expect(payload.blastRadius?.totalReferences).toBe(3);
    expect(payload.dependentModules?.some((d) => d.module === 'beta')).toBe(true);
  });

  it('lux_deps_impact returns isError + module-unresolved for a non-module file', async () => {
    const res = await client.callTool({
      name: 'lux_deps_impact',
      arguments: { file_path: join(corpus, 'README.md') },
    });
    expect(res.isError).toBe(true);
    const payload = parse(res) as { error?: string };
    expect(payload.error).toBe('module-unresolved');
  });

  it('lux_overlay_status returns overlay trust + runtime + freshness', async () => {
    const res = await client.callTool({ name: 'lux_overlay_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    const payload = parse(res) as {
      overlay?: { trustLevel?: string };
      runtime?: { corpusPath?: string };
      freshness?: { headMatchesIndex?: boolean };
    };
    expect(payload.overlay?.trustLevel).toBeDefined();
    expect(payload.runtime?.corpusPath).toBe(corpus);
    expect(payload.freshness?.headMatchesIndex).toBe(true);
  });

  it('lux_doctor wraps the canonical coverage-bearing status with stable checks', async () => {
    const status = await client.callTool({ name: 'lux_index_status', arguments: {} });
    const doctor = await client.callTool({ name: 'lux_doctor', arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(doctor.isError).toBeFalsy();
    const payload = parse(status) as {
      telemetry?: unknown;
      stats?: Record<string, unknown>;
      overlay?: { trustLevel?: string };
      coverage?: { languages?: unknown[] };
      runtime?: { corpusPath?: string };
      freshness?: { indexedCommit?: string | null };
    };
    const report = parse(doctor) as {
      schemaVersion?: number;
      status?: typeof payload;
      result?: string;
      checks?: Array<{ id: string; status: string }>;
      telemetry?: unknown;
    };
    expect(report.schemaVersion).toBe(1);
    const statusWithoutTelemetry = { ...payload };
    delete statusWithoutTelemetry.telemetry;
    expect(report.status).toEqual(statusWithoutTelemetry);
    expect(report.checks?.length).toBeGreaterThan(0);
    expect(new Set(report.checks?.map((check) => check.id)).size).toBe(report.checks?.length);
    expect(payload.stats).toBeDefined();
    expect(payload.overlay?.trustLevel).toBeDefined();
    expect(payload.coverage?.languages).toBeInstanceOf(Array);
    expect(payload.runtime?.corpusPath).toBe(corpus);
    expect(payload.freshness?.indexedCommit).toBeTruthy();
  });
});
