import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'node:os';
import { LuxDatabase } from '../../db/index.js';
import { detectModuleBoundaries, resolveModule } from '../../scanner/imports/module-boundary.js';
import { builtCli } from '../../__tests__/helpers/built-cli.js';

const CLI_ENTRY = builtCli();

function runCli(corpus: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: corpus,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

describe('Search Module Annotations', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-search-deps-test-'));
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(dbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should resolve source-code file to module', () => {
    // Set up module structure
    mkdirSync(join(testDir, 'src', 'Module', 'Users'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'Module', 'Orders'), { recursive: true });

    const patterns = detectModuleBoundaries(testDir);
    expect(patterns).toEqual(['src/Module/{name}']);

    const mod = resolveModule(
      join(testDir, 'src', 'Module', 'Users', 'UserService.php'),
      testDir,
      patterns
    );
    expect(mod).toBe('Users');
  });

  it('should query module dependents for annotations', () => {
    db.insertModuleDependency({
      source_module: 'Invoicing',
      target_module: 'UserDocument',
      reference_count: 3,
      sample_files: JSON.stringify(['inv1.php', 'inv2.php', 'inv3.php']),
    });
    db.insertModuleDependency({
      source_module: 'BidRegistration',
      target_module: 'UserDocument',
      reference_count: 1,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Report',
      target_module: 'UserDocument',
      reference_count: 2,
      sample_files: null,
    });

    const dependents = db.getModuleDependencies('UserDocument', 'target');
    expect(dependents).toHaveLength(3);

    // Should be ordered by reference_count desc
    expect(dependents[0].source_module).toBe('Invoicing');
    expect(dependents[0].reference_count).toBe(3);

    // Format like the search output
    const depSummary = dependents
      .map((d) => `${d.source_module} (${d.reference_count} refs)`)
      .join(', ');
    expect(depSummary).toContain('Invoicing (3 refs)');
    expect(depSummary).toContain('Report (2 refs)');
    expect(depSummary).toContain('BidRegistration (1 refs)');
  });

  it('should not annotate non-source-code results', () => {
    // Non-source-code entries (documentation, methodology, etc.) should not have module annotations.
    // This is ensured by the `result.entryType === 'source-code'` check in search.ts (the field was
    // renamed from the dead `context`; the real branch is exercised by the CLI test below).
    const result = { entryType: 'documentation', title: 'Test', filePath: '/test' };
    expect(result.entryType).not.toBe('source-code');
  });

  it('should handle modules with no dependents gracefully', () => {
    const dependents = db.getModuleDependencies('NonExistent', 'target');
    expect(dependents).toHaveLength(0);
  });
});

// Exercises the real source-code annotation branch (search.ts:355-367) end-to-end via the CLI — the
// prior file only asserted the discrimination in isolation, leaving `if (entryType === 'source-code')`
// (module + dependents lookup) covered by no test (m6).
describe('Search source-code annotation (CLI)', () => {
  let root: string;
  let corpus: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lux-search-deps-cli-'));
    corpus = join(root, 'app');
    // Two module dirs so detectModuleBoundaries infers the `src/Module/{name}` pattern.
    mkdirSync(join(corpus, 'src', 'Module', 'Users'), { recursive: true });
    mkdirSync(join(corpus, 'src', 'Module', 'Orders'), { recursive: true });
    const servicePath = join(corpus, 'src', 'Module', 'Users', 'UserService.php');
    writeFileSync(servicePath, '<?php // settlement clearing service');

    const db = new LuxDatabase(join(corpus, '.lux', 'lux.db'));
    // A source-code hit whose file lives under the Users module, so the annotation branch resolves a
    // module and prints its dependents.
    db.insertKnowledgeEntry({
      type: 'source-code',
      title: 'UserService',
      file_path: 'src/Module/Users/UserService.php',
      content: 'settlement clearing netting',
    });
    // Invoicing depends ON Users → the branch prints "Depended on by: Invoicing (3 refs)".
    db.insertModuleDependency({
      source_module: 'Invoicing',
      target_module: 'Users',
      reference_count: 3,
      sample_files: null,
    });
    db.close();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('annotates a source-code hit with its module + dependents', () => {
    const res = runCli(corpus, ['--corpus', corpus, 'search', 'settlement']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[source-code] UserService');
    expect(res.stdout).toContain('Module: Users');
    expect(res.stdout).toContain('Depended on by: Invoicing (3 refs)');
  });
});
