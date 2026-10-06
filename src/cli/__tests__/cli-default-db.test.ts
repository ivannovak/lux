import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { builtCli } from '../../integration/__tests__/helpers/built-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = builtCli();

describe('cli default db path', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-default-db-'));
    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('refuses an absent repo-local db without creating it when --db is omitted', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, '--corpus', repoDir, 'index', 'status'],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `No Lux index exists at ${join(repoDir, '.lux', 'lux.db')}. Run \`lux index rebuild\` explicitly.`
    );
    expect(existsSync(join(repoDir, '.lux'))).toBe(false);
    expect(existsSync(join(repoDir, '.lux', 'lux.db'))).toBe(false);
  });
});
