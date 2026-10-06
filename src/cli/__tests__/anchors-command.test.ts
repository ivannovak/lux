import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../../db/index.js';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

// CLI text-surface behavior for the consumer-polish default (issue #77 item #3): when the test-exclusion
// default swallows every match, the human CLI must not go silent — it prints "No anchors found" AND a
// pointer at --include-tests, and exits 0 (an empty answer, not an error). Driven through the REAL
// spawned CLI so the commander wiring + renderer are exercised end-to-end.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = builtCli();
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

function runCli(dbPath: string, corpusPath: string, args: string[]) {
  const env = { ...process.env };
  delete env.LUX_EMBEDDING_TOKEN; // lexical-only fixture; keep the local posture regardless of shell
  return spawnSync(process.execPath, [CLI_ENTRY, '--db', dbPath, '--corpus', corpusPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

const split = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const toks = (s: string): string => split(s).join(' ').toLowerCase();

/** Seed a single TEST-file node whose only distinctive token ('asserts') lives in its context column. */
function seedTestOnly(dbPath: string): void {
  const db = new LuxDatabase(dbPath);
  const id = 'symbol:php:Tests\\Unit\\WidgetTest';
  const path = 'tests/Unit/WidgetTest.php';
  db.transaction(() => {
    db.upsertStructuralNode({
      id,
      node_type: 'symbol',
      file_path: path,
      language_id: 'php',
      symbol_name: 'WidgetTest',
      symbol_kind: 'Class',
      qualified_name: 'Tests\\Unit\\WidgetTest',
      updated_at: Math.floor(Date.now() / 1000),
    });
    db.upsertNodeAnchorText({
      node_id: id,
      prepared: 'Class WidgetTest',
      content_hash: 'x'.repeat(64),
      name: 'WidgetTest',
      identifiers: 'widget test',
      qualified: toks('Tests\\Unit\\WidgetTest'),
      path_segments: toks(path.replace(/\.[a-z]+$/i, '')),
      context: 'asserts widget behavior',
    });
  });
  db.close();
}

describe('lux anchors CLI — text surface', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchors-cli-'));
    dbPath = join(dir, 'lux.db');
    seedTestOnly(dbPath);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('all-matches-are-tests default: exits 0 and prints "No anchors found" plus the --include-tests hint', () => {
    const r = runCli(dbPath, dir, ['anchors', 'asserts']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No anchors found');
    expect(r.stdout).toContain('--include-tests');
  });

  it('--include-tests surfaces the test node the default suppressed', () => {
    const r = runCli(dbPath, dir, ['anchors', 'asserts', '--include-tests']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WidgetTest');
  });
});
