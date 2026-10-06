// src/cli/__tests__/index-anchor-embed.test.ts
//
// Integration proof that the anchor node-embed pass (spec 16 Part B) is WIRED LIVE into the index
// tails as a QUEUE-GATED, CACHED-ONLY tail (T3.4 hardening) — not a dead helper, and NOT a surprising
// network side effect of `lux index rebuild`/`sync`. Every case here is network-free and
// environment-independent:
//
//   1. Queue-gate: an EMPTY anchor queue reports coverage and returns WITHOUT ever constructing an
//      embedder. Proven by setting LUX_EMBEDDING_TOKEN (which makes `createEmbedder` throw the moment
//      it is reached) and asserting NEITHER the token error NOR the weights-absent skip appears — the
//      tail short-circuited before both the embedder load and the cache check.
//   2. Cached-only + QUIET default (A3): a NON-EMPTY queue with the model weights ABSENT skips the
//      embed pass, still exits 0, and does NOT fetch (no `~/.lux/embeddings` is even created). It also
//      stays SILENT on stdout — no "weights not cached" nudge and no "Anchor embeddings:" coverage line
//      — so a corpus whose owner never opted into embeddings is never nagged. Weights-absent is forced
//      deterministically by pointing the spawned CLI's HOME at a fresh empty dir — so this holds
//      regardless of whether the real machine cache is present.
//   3. Opt-in DRAIN (A1): `lux index rebuild --embeddings` loads the (cached) model and embeds the queue
//      to FULL coverage in one run (the drain loop), printing an `Embedding anchor nodes: E/A` progress
//      line. Run offline by pointing HOME at a dir whose `.lux/embeddings` is symlinked to the real
//      cache, so `ensureModelWeights` cache-hits (no network). Skipped when the real cache is absent.
//
// The happy-path embed/coverage arithmetic is unit-tested against StubEmbedder in
// scanner/embeddings/__tests__/node-embed-pass.test.ts; this file asserts the CLI wiring + the
// queue-gate + the cached-only degrade invariant, which need neither weights nor network (except case
// 3, which uses the local cache offline).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { resolveModelCacheDir } from '../../scanner/embeddings/model-cache.js';
import {
  ANCHOR_EMBED_MODEL,
  ANCHOR_EMBED_MODEL_ARTIFACTS,
} from '../../scanner/embeddings/model-pin.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

// The real per-machine weights cache (from THIS test process's HOME). Case 3 needs it present; the
// other two cases are independent of it.
const REAL_CACHE_DIR = resolveModelCacheDir();
const REAL_CACHE_PARENT = dirname(REAL_CACHE_DIR);
const REAL_WEIGHTS_PRESENT = Object.keys(ANCHOR_EMBED_MODEL_ARTIFACTS.files).every((f) =>
  existsSync(join(REAL_CACHE_DIR, f))
);

function git(repoPath: string, command: string): string {
  return execSync(command, { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

/**
 * Spawn the real CLI. `env` overrides are merged over a copy of process.env that has
 * LUX_EMBEDDING_TOKEN scrubbed first, so a token only takes effect when a case explicitly sets it
 * (cases 2/3 must run the local path, not the fail-closed path).
 */
function runCli(
  repoPath: string,
  dbPath: string,
  args: string[],
  env: Record<string, string> = {}
) {
  const baseEnv = { ...process.env };
  delete baseEnv.LUX_EMBEDDING_TOKEN;
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...baseEnv, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
  });
}

function initRepo(repoPath: string): void {
  git(repoPath, 'git init');
  git(repoPath, 'git config user.email "test@test.com"');
  git(repoPath, 'git config user.name "Test"');
  git(repoPath, 'git add -A');
  git(repoPath, 'git commit -m init');
}

/** A markdown-only corpus: zero anchor-viable symbol nodes → the anchor queue is always EMPTY. */
function writeMarkdownRepo(repoPath: string): void {
  mkdirSync(join(repoPath, 'docs'), { recursive: true });
  writeFileSync(
    join(repoPath, 'lux.yaml'),
    ['lsp:', '  enabled: false', '  enrichers: []', 'deps:', '  enabled: false', ''].join('\n')
  );
  writeFileSync(join(repoPath, 'docs', 'guide.md'), '# Guide\n\nsome docs\n');
  initRepo(repoPath);
}

/**
 * A corpus with three anchor-viable symbols (`double`, `Greeter`, `Greeter#greet`). LSP is OFF — the
 * AST symbol tier (default on) extracts them from the source tree via bundled tree-sitter WASM (no
 * network). A package.json/tsconfig are required for the source tree to be discovered as project
 * source. So a fresh rebuild leaves a NON-EMPTY anchor queue.
 */
function writeSymbolRepo(repoPath: string): void {
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'lux.yaml'),
    ['lsp:', '  enabled: false', '  enrichers: []', 'deps:', '  enabled: false', ''].join('\n')
  );
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      { name: 'anchor-embed-fixture', private: true, type: 'module', version: '1.0.0' },
      null,
      2
    ) + '\n'
  );
  writeFileSync(
    join(repoPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2
    ) + '\n'
  );
  writeFileSync(
    join(repoPath, 'src', 'app.ts'),
    'export function double(x: number) {\n  return x * 2;\n}\n' +
      'export class Greeter {\n  greet(name: string) {\n    return `hello ${name}`;\n  }\n}\n'
  );
  initRepo(repoPath);
}

describe('anchor embed-pass CLI wiring — queue-gated + cached-only (network-free)', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;
  let homeDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-anchor-embed-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-anchor-embed-db-'));
    homeDir = mkdtempSync(join(tmpdir(), 'lux-anchor-embed-home-'));
    dbPath = join(dbDir, 'lux.db');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('queue-gate: an empty anchor queue reports coverage and never loads the embedder', () => {
    writeMarkdownRepo(repoDir);

    // LUX_EMBEDDING_TOKEN is a tripwire: if the tail ever reached `getSharedEmbedder`, createEmbedder
    // would throw the token error. Its ABSENCE from the output proves the queue-gate short-circuited
    // before any embedder load. (Real HOME here so, if the gate regressed with weights present, the
    // token error WOULD surface — a crisp fail signal in both machine states.)
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild'], {
      LUX_EMBEDDING_TOKEN: 'test-token-would-fail-closed-if-reached',
    });
    const combined = `${rebuild.stdout}\n${rebuild.stderr}`;

    expect(rebuild.status).toBe(0);
    // Empty queue → the tail reports coverage from getAnchorEmbeddingCoverage without an embedder.
    expect(rebuild.stdout).toContain('Anchor embeddings: 0/0 anchor nodes');
    expect(rebuild.stdout).toContain('(100%)');
    // Never reached the embedder (no token error) and never reached the cache check (no weights skip).
    // (A generic `not.toContain('Warning:')` is NOT asserted here: a symbol-less corpus legitimately
    // emits the orthogonal "No symbol nodes were materialized" overlay warning, which has nothing to do
    // with the embed tail. The embed-specific absences below are the queue-gate proof.)
    expect(combined).not.toContain('LUX_EMBEDDING_TOKEN');
    expect(combined).not.toContain('embedder unavailable');
    expect(combined).not.toContain('model weights not cached');
    expect(combined).toContain('rebuild complete');

    // No-change resume seam: a second sync with an empty queue also short-circuits before the embedder.
    const sync = runCli(repoDir, dbPath, ['index', 'sync'], {
      LUX_EMBEDDING_TOKEN: 'test-token-would-fail-closed-if-reached',
    });
    const syncCombined = `${sync.stdout}\n${sync.stderr}`;
    expect(sync.status).toBe(0);
    expect(syncCombined).toContain('Index matches HEAD'); // took the no-change branch
    expect(sync.stdout).toContain('Anchor embeddings: 0/0 anchor nodes');
    expect(syncCombined).not.toContain('LUX_EMBEDDING_TOKEN'); // still never loaded the embedder
  });

  it('cached-only + quiet default (A3): weights absent → skip silently, exit 0, no nudge, no fetch', () => {
    writeSymbolRepo(repoDir);

    // HOME → a fresh empty dir, so resolveModelCacheDir points at an EMPTY cache (weights absent),
    // independent of the real machine cache. The tail must skip cached-only, not fetch.
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild'], { HOME: homeDir });
    const combined = `${rebuild.stdout}\n${rebuild.stderr}`;

    // Decision 5: absent weights degrade, they do not fail the index.
    expect(rebuild.status).toBe(0);
    // A3: weights-not-cached stays SILENT by default — no nudge, and no coverage line at all (the
    // capability is discoverable via --help/docs; a never-opted-in corpus is not nagged every rebuild).
    expect(rebuild.stdout).not.toContain('model weights not cached');
    expect(rebuild.stdout).not.toContain('Anchor embeddings:');
    // Still not a Warning: (an offline machine is not in error), and the index itself still succeeds.
    expect(rebuild.stderr).not.toContain('Warning:');
    expect(combined).toContain('rebuilt successfully');

    // Network-free proof: the tail never called ensureModelWeights, so it never even mkdir'd the cache
    // path under the redirected HOME.
    expect(existsSync(join(homeDir, '.lux', 'embeddings'))).toBe(false);
  });

  it('tail degrades (no crash, exit 0) when lux.yaml is malformed on the no-change resume seam (Fix 5)', () => {
    writeSymbolRepo(repoDir);

    // First index cleanly (valid lux.yaml, weights absent via empty HOME) — the anchor queue stays
    // NON-EMPTY (cached-only skip), and last_indexed_commit == HEAD.
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild'], { HOME: homeDir });
    expect(rebuild.status).toBe(0);

    // Now poison lux.yaml with an inline embedding.token — loadLspConfig THROWS on this. No new commit,
    // so `lux index sync` takes the no-change resume seam, which reaches runNodeEmbedTail as the ONLY
    // config parse on that path. Without the tail's wrap-and-degrade this crashes with a raw stacktrace;
    // with it, the tail degrades to the local model, skips cached-only (weights absent), and exits 0.
    writeFileSync(
      join(repoDir, 'lux.yaml'),
      'embedding:\n  token: sk-leaked-into-a-committed-file\n'
    );
    const sync = runCli(repoDir, dbPath, ['index', 'sync'], { HOME: homeDir });
    const combined = `${sync.stdout}\n${sync.stderr}`;

    expect(sync.status).toBe(0); // never throws — the tail is contractually crash-proof
    expect(combined).toContain('Index matches HEAD'); // took the no-change resume seam
    // The config error is not an uncaught crash: it is the run's warning, and the local model is used.
    expect(sync.stderr).toMatch(
      /^Warning: lux\.yaml could not be read for its embedding settings, so the local model was used — .*`embedding\.token` is not permitted/m
    );
    // The warning names the problem without echoing the leaked key.
    expect(combined).not.toContain('sk-leaked-into-a-committed-file');
    expect(sync.stderr).not.toContain('Error: Failed');
  });

  it.skipIf(!REAL_WEIGHTS_PRESENT)(
    '--embeddings (A1) loads the cached model and DRAINS the anchor queue to full coverage',
    () => {
      writeSymbolRepo(repoDir);

      // Point HOME at a dir whose .lux/embeddings symlinks to the REAL cache, so `ensureModelWeights`
      // (invoked by --embeddings) and the embedder create both cache-hit and verify offline — no
      // network, and the real cache is only ever read (a verified cache-hit never writes).
      mkdirSync(join(homeDir, '.lux'), { recursive: true });
      symlinkSync(REAL_CACHE_PARENT, join(homeDir, '.lux', 'embeddings'));

      const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--embeddings'], {
        HOME: homeDir,
      });

      expect(rebuild.status).toBe(0);
      expect(rebuild.stdout).toContain('Fetching embedding model'); // the one-time opt-in line
      // A1: the drain loop reaches full coverage on this single run and prints its progress line.
      expect(rebuild.stdout).toContain('Embedding anchor nodes: 3/3');
      expect(rebuild.stdout).toContain('Anchor embeddings: 3/3 anchor nodes');
      expect(rebuild.stdout).toContain('(100%)');
      expect(rebuild.stderr).not.toContain('Warning:');

      // The vectors are actually persisted under the active model.
      const db = new LuxDatabase(dbPath);
      const coverage = db.getAnchorEmbeddingCoverage(ANCHOR_EMBED_MODEL);
      db.close();
      expect(coverage.embeddedNodes).toBe(3);
      expect(coverage.anchorViableNodes).toBe(3);
    }
  );
});
