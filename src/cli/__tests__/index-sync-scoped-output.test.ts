// A scoped sync that ends with warnings never prints a success line. Two ways to get there: the
// refresh leaves reported stale edges (a symbol removed under an unchanged caller), or the
// module-dependency write fails. Either way the run ends on "⚠ … with N warning(s)", and under
// --quiet the warnings themselves go to stderr.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { commitAll, initRepo, runCli, writeTree } from './scoped-sync-harness.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// Nova off, so a TypeScript change does not pull the whole program into the refresh and the
// unchanged caller stays outside it.
const LUX_YAML =
  'lsp:\n  enabled: false\n  enrichers: []\ndeps:\n  enabled: true\n  module_boundary: "src/{name}"\n' +
  'frameworks:\n  nova:\n    enabled: false\n';

/** Index A, commit `change` as B, and run `index sync` with `args`. */
function syncAfter(
  change: Record<string, string | null>,
  args: string[],
  beforeSync?: (dbPath: string) => void
) {
  const repo = mkdtempSync(join(tmpdir(), 'lux-scoped-out-'));
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-scoped-out-db-'));
  dirs.push(repo, dbDir);
  const dbPath = join(dbDir, 'lux.db');
  initRepo(repo);
  writeTree(repo, {
    'package.json': '{"name":"out"}\n',
    'lux.yaml': LUX_YAML,
    'src/a/a.ts':
      'export function keep(): number {\n  return 1;\n}\nexport function removed(): number {\n  return 2;\n}\n',
    'src/c/c.ts':
      "import { keep, removed } from '../a/a';\nexport function uses(): number {\n  return keep() + removed();\n}\n",
  });
  commitAll(repo, 'A');
  const rebuild = runCli(repo, dbPath, ['index', 'rebuild']);
  expect(rebuild.status, rebuild.stderr).toBe(0);
  beforeSync?.(dbPath);
  writeTree(repo, change);
  commitAll(repo, 'B');
  return runCli(repo, dbPath, ['index', 'sync', ...args]);
}

const REMOVE_SYMBOL = {
  'src/a/a.ts': 'export function keep(): number {\n  return 1;\n}\n',
};
const EDIT_BODY = {
  'src/a/a.ts':
    'export function keep(): number {\n  return 1 + 0;\n}\nexport function removed(): number {\n  return 2;\n}\n',
};
const failDependencyWrite = (dbPath: string) => {
  const db = new LuxSqlite(dbPath);
  db.exec(`CREATE TRIGGER fail_dependency_write BEFORE INSERT ON module_dependencies
    BEGIN SELECT RAISE(ABORT, 'injected dependency write failure'); END;`);
  db.close();
};

describe('index sync — scoped output over warnings', () => {
  it('a clean scoped refresh ends on a success line', () => {
    const r = syncAfter(EDIT_BODY, []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✓ scoped refresh complete/u);
    expect(r.stdout).not.toContain('⚠');
  });

  it('a clean scoped refresh under --quiet prints nothing', () => {
    const r = syncAfter(EDIT_BODY, ['--quiet']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  for (const quiet of [false, true]) {
    const mode = quiet ? '--quiet' : 'non-quiet';

    it(`reported stale edges end on a warning line, never a success line (${mode})`, () => {
      const r = syncAfter(REMOVE_SYMBOL, quiet ? ['--quiet'] : []);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('✓');
      expect(r.stdout).not.toMatch(/success/iu);
      expect(r.stdout).toMatch(/⚠ scoped refresh complete .* with 1 warning\(s\)/u);
      if (quiet) expect(r.stderr).toMatch(/Warning: \d+ edge\(s\) are stale/u);
    });

    it(`a failed module-dependency write ends on a warning line (${mode})`, () => {
      const r = syncAfter(EDIT_BODY, quiet ? ['--quiet'] : [], failDependencyWrite);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('✓');
      expect(r.stdout).toMatch(/⚠ scoped refresh complete .* with 1 warning\(s\)/u);
      if (quiet) {
        expect(r.stderr).toContain(
          'Warning: Failed to write module dependencies (injected dependency write failure)'
        );
      }
    });
  }
});
