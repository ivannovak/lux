// Over the wire (issue #46): `lux_get_file` serves only files in the index's file universe. In a git
// repository that is a tracked file; an ignored credential file, an untracked file, a tracked file
// on the deny list and a path outside the corpus are refused.

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
import { built } from '../../integration/__tests__/helpers/built-cli.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DIST_SERVER = built('src/mcp/server.ts');

describe('lux_get_file reads only the file universe', () => {
  let root: string;
  let corpus: string;
  let client: Client;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'lux-get-file-universe-'));
    corpus = join(root, 'repo');
    mkdirSync(join(corpus, 'docs'), { recursive: true });
    mkdirSync(join(corpus, 'config'), { recursive: true });
    writeFileSync(join(corpus, '.gitignore'), '.lux/\nauth.json\n');
    writeFileSync(join(corpus, 'docs', 'tracked.md'), '# Tracked\n\ntracked body\n');
    writeFileSync(join(corpus, 'config', 'auth.json'), '{"token":"tracked-credential"}\n');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: corpus, env });
    execFileSync('git', ['add', '.gitignore', 'docs/tracked.md'], { cwd: corpus, env });
    execFileSync('git', ['add', '-f', 'config/auth.json'], { cwd: corpus, env });
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: corpus, env });
    writeFileSync(join(corpus, 'auth.json'), '{"token":"ignored-credential"}\n');
    writeFileSync(join(corpus, 'docs', 'untracked.md'), '# Untracked\n');
    writeFileSync(join(root, 'outside.md'), '# Outside\n');

    const dbPath = join(corpus, '.lux', 'lux.db');
    new LuxDatabase(dbPath).close();
    client = new Client({ name: 'get-file-universe-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_SERVER],
        cwd: REPO_ROOT,
        env: { ...getDefaultEnvironment(), LUX_CORPUS_PATH: corpus, LUX_DB_PATH: dbPath },
        stderr: 'ignore',
      })
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  });

  const read = async (filePath: string) => {
    const res = (await client.callTool({
      name: 'lux_get_file',
      arguments: { file_path: filePath },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: res.isError === true, text: res.content[0].text };
  };

  it('serves a tracked file', async () => {
    const res = await read('docs/tracked.md');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('tracked body');
  });

  it.each([
    ['an ignored credential file', 'auth.json'],
    ['a tracked file on the deny list', 'config/auth.json'],
    ['an untracked file', 'docs/untracked.md'],
    ['a file outside the corpus', '../outside.md'],
  ])('refuses %s', async (_label, filePath) => {
    const res = await read(filePath);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('not in the index');
    expect(res.text).not.toContain('credential"}');
  });
});
