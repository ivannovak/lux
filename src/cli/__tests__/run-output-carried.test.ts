// What a rebuild or sync prints (issue #6), continued: warnings an earlier run raised are labelled
// as carried until a run that re-runs their component cleanly retires them, and a clean --quiet sync
// stays silent (run-output-harness.ts has the fixtures and the CLI driver).

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { loadOverlayTrustState } from '../../scanner/overlay-trust-state.js';
import {
  LSP_LESS,
  ROUTES_A,
  ROUTES_B,
  ROUTES_C,
  TS_LSP,
  commitFile,
  dbPathIn,
  expectSilent,
  removeTempDirs,
  repoWith,
  runLux,
} from './run-output-harness.js';

afterEach(removeTempDirs);

describe('run output rules: carried warnings and quiet syncs (issue #6)', () => {
  it('labels a carried warning, and a scoped sync that re-runs its component cleanly retires it', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'composer.json': '{}',
      'routes/web.php': ROUTES_A,
      'docs/a.md': '# a\n',
    });
    const dbPath = dbPathIn();
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
    const FAULT = 'detector "laravel-http-surfaces" threw — injected detector fault';

    // A scoped sync with the detector broken raises the warning as its own.
    commitFile(repo, 'routes/web.php', ROUTES_B);
    const faulted = runLux(repo, dbPath, ['index', 'sync', '--quiet'], {
      faults: 'laravel-detector',
    });
    expect(faulted.stderr).toContain(`Warning: ${FAULT}`);

    // A docs-only sync re-runs no detector: the warning is still there, labelled as carried.
    commitFile(repo, 'docs/a.md', '# a\n\nmore\n');
    const carried = runLux(repo, dbPath, ['index', 'sync']);
    expect(carried.status, carried.stderr).toBe(0);
    expect(carried.stderr).toContain(`Warning: carried from an earlier run: ${FAULT}`);

    // A scoped sync whose detector runs cleanly retires it.
    commitFile(repo, 'routes/web.php', ROUTES_C);
    const cleared = runLux(repo, dbPath, ['index', 'sync']);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain('scoped overlay refresh');
    expect(`${cleared.stdout}${cleared.stderr}`).not.toContain(FAULT);
    const db = new LuxDatabase(dbPath);
    const trust = loadOverlayTrustState(db);
    db.close();
    expect(trust?.warnings).not.toContain(FAULT);
  });

  it('warns when the embed step cannot read lux.yaml and falls back to the local model', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'a.md': '# a\n' });
    const dbPath = dbPathIn();
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
    // Broken after indexing, so the no-change sync's embed step is the only reader.
    writeFileSync(join(repo, 'lux.yaml'), 'lsp: [unclosed\n');

    const r = runLux(repo, dbPath, ['index', 'sync']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Index matches HEAD');
    expect(r.stderr).toMatch(
      /^Warning: lux\.yaml could not be read for its embedding settings, so the local model was used — /m
    );
  });

  it('does not label warnings derived from the current index as carried', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}', 'docs/a.md': '# a\n' });
    const dbPath = dbPathIn();
    // A content-only rebuild records no trust state, so no earlier run raised any warning.
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--content-only', '--quiet']).status).toBe(0);
    commitFile(repo, 'docs/a.md', '# a\n\nmore\n');

    const r = runLux(repo, dbPath, ['index', 'sync']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/^Warning: /m);
    expect(r.stderr).not.toContain('carried from an earlier run');
  });

  it('does not label inferred warnings as carried on a scoped sync either', () => {
    const repo = repoWith({
      'lux.yaml': LSP_LESS,
      'package.json': '{}',
      'a.ts': 'export function a(): number {\n  return 1;\n}\n',
    });
    const dbPath = dbPathIn();
    expect(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']).status).toBe(0);
    // With the persisted trust state gone, the next sync infers one from the DB's shape.
    const db = new LuxDatabase(dbPath);
    db.clearRebuildTrustState();
    db.close();
    commitFile(repo, 'a.ts', 'export function a(): number {\n  return 2;\n}\n');

    const r = runLux(repo, dbPath, ['index', 'sync']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('scoped overlay refresh');
    expect(r.stderr).toMatch(/^Warning: /m);
    expect(r.stderr).not.toContain('carried from an earlier run');
  });

  it('keeps a clean --quiet sync silent when it clears a stale lock, and --verbose shows the notice', () => {
    const repo = repoWith({
      'lux.yaml': TS_LSP,
      'package.json': JSON.stringify({ name: 'lock-fx', private: true, type: 'module' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
      'a.ts': 'export function a(): number {\n  return 1;\n}\n',
    });
    const dbPath = dbPathIn();
    expectSilent(runLux(repo, dbPath, ['index', 'rebuild', '--quiet']));
    const NOTE = 'Note: cleared a stale database lock';

    // A lock left by a crashed run: its owner token names a pid that is not running, so the next
    // open reclaims it. (A lock that names no owner is never reclaimed.)
    const crashedRunLeavesLock = (): void => {
      mkdirSync(`${dbPath}.lock/4194303-0123456789ab@${encodeURIComponent(hostname())}`, {
        recursive: true,
      });
    };
    commitFile(repo, 'notes.md', '# notes\n');
    crashedRunLeavesLock();
    expectSilent(runLux(repo, dbPath, ['index', 'sync', '--quiet']));

    // Notices print by default, not only under --verbose.
    commitFile(repo, 'notes.md', '# notes\n\nmore\n');
    crashedRunLeavesLock();
    const plain = runLux(repo, dbPath, ['index', 'sync']);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stderr).toContain(NOTE);

    commitFile(repo, 'notes.md', '# notes\n\nmore\n\nagain\n');
    crashedRunLeavesLock();
    const verbose = runLux(repo, dbPath, ['index', 'sync'], { globalArgs: ['--verbose'] });
    expect(verbose.status, verbose.stderr).toBe(0);
    expect(verbose.stderr).toContain(NOTE);
  });

  it('describes --quiet as it behaves, on rebuild and on sync', () => {
    const repo = repoWith({ 'lux.yaml': LSP_LESS, 'package.json': '{}' });
    for (const command of ['rebuild', 'sync']) {
      const help = runLux(repo, dbPathIn(), ['index', command, '--help']);
      expect(help.stdout.replace(/\s+/g, ' '), command).toContain(
        '--quiet Print nothing on a clean run; otherwise only the warnings and one ⚠ line'
      );
    }
  });
});
