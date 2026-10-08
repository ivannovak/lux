// intelephense indexes every PHP file under the workspace root; Lux's file universe is git's. What a
// working checkout holds outside git — other worktrees of the repository, a tool's copies of it —
// must be excluded from the server's index too, or it indexes those copies (on one repository, 178k
// PHP files against 9k tracked) and answers from them. Composer's vendor directory is kept: calls
// into dependencies resolve through it.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient } from '../client.js';
import { PhpLspEnricher, intelephenseSettings } from '../php.js';

/**
 * An intelephense to check the globs against, since only the server decides what they match. Not
 * installed in CI; set `LUX_TEST_INTELEPHENSE` to its command to run that check.
 */
const INTELEPHENSE = process.env.LUX_TEST_INTELEPHENSE;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const dirs: string[] = [];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

const PINNED = [
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/.lux/**',
  '**/vendor/**/{Tests,tests}/**',
  '**/vendor/**/vendor/**',
];

/** A repository with tracked source, ignored and untracked copies of it, and a vendor directory. */
function checkout(composer: object = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lux-php-excludes-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv });
  write(root, 'composer.json', JSON.stringify(composer));
  write(root, '.gitignore', '.claude/worktrees/\nvendor/\nlib/\nnotes.php\n');
  write(root, 'src/Thing.php', '<?php\nclass Thing {}\n');
  write(root, '.claude/agents/reviewer.md', '# reviewer\n');
  execFileSync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env: gitEnv });
  // Ignored: another worktree of the repository, the vendor directory, a loose script.
  write(root, '.claude/worktrees/feature/src/Thing.php', '<?php\nclass Thing {}\n');
  write(root, 'vendor/acme/lib/src/Client.php', '<?php\nclass Client {}\n');
  write(root, 'lib/vendor/acme/Other.php', '<?php\nclass Other {}\n');
  write(root, 'notes.php', '<?php\n');
  // Untracked: a tool's copy of the repository, a scratch directory, a file that is not PHP.
  write(root, '.letta/worktrees/x/src/Thing.php', '<?php\nclass Thing {}\n');
  write(root, 'scratch dir+(1)/Copy.php', '<?php\nclass Copy {}\n');
  write(root, 'loose.txt', 'text\n');
  return root;
}

describe('intelephense workspace excludes', () => {
  it('excludes what lies outside the git universe, and keeps the vendor directory', () => {
    const root = checkout();
    expect(intelephenseSettings(root).files.exclude).toEqual([
      ...PINNED,
      '.claude/worktrees/**',
      '.letta/**',
      'lib/**',
      'notes.php',
      'scratch dir\\+\\(1\\)/**',
    ]);
  });

  it("keeps the directory that holds Composer's configured vendor directory", () => {
    const root = checkout({ config: { 'vendor-dir': './lib/vendor/' } });
    const exclude = intelephenseSettings(root).files.exclude;
    expect(exclude).toContain('vendor/**');
    expect(exclude.some((glob) => glob.startsWith('lib/'))).toBe(false);
  });

  it('adds nothing outside a git work tree, where every file is in the universe', () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-php-excludes-plain-'));
    dirs.push(root);
    write(root, 'src/Thing.php', '<?php\nclass Thing {}\n');
    write(root, 'copy/src/Thing.php', '<?php\nclass Thing {}\n');
    expect(intelephenseSettings(root).files.exclude).toEqual(PINNED);
  });

  it('answers the server settings request with those excludes', async () => {
    const root = checkout();
    const record = join(mkdtempSync(join(tmpdir(), 'lux-php-excludes-record-')), 'record.json');
    dirs.push(join(record, '..'));
    const enricher = new PhpLspEnricher({
      serverCommand: process.execPath,
      serverArgs: ['-e', SETTINGS_SERVER, record],
      initTimeoutMs: 5_000,
    });
    await enricher.initialize(root);
    cleanup.push(() => enricher.shutdown());
    const [settings] = JSON.parse(readFileSync(record, 'utf-8')) as Array<{
      files: { exclude: string[] };
    }>;
    expect(settings.files.exclude).toEqual(intelephenseSettings(root).files.exclude);
    expect(settings.files.exclude).toContain('.claude/worktrees/**');
  });
});

describe.skipIf(!INTELEPHENSE)('intelephense with those excludes', () => {
  it('indexes the tracked source and the vendor directory, and none of the copies', async () => {
    const root = checkout();
    write(root, '.claude/worktrees/feature/.github/scripts/Hidden.php', '<?php\nclass Hidden {}\n');
    const storage = mkdtempSync(join(tmpdir(), 'lux-php-excludes-storage-'));
    dirs.push(storage);
    const settings = intelephenseSettings(root);
    const client = new LspClient({
      serverCommand: INTELEPHENSE!,
      serverArgs: ['--stdio'],
      serverLabel: 'php',
      cwd: root,
      initTimeoutMs: 60_000,
      configuration: (section) => (section === 'intelephense' ? settings : undefined),
    });
    cleanup.push(() => client.shutdown());
    let indexed!: () => void;
    const indexingEnded = new Promise<void>((resolve) => (indexed = resolve));
    client.onNotification('indexingEnded', () => indexed());
    const rootUri = pathToFileURL(root).toString();
    await client.initialize({
      processId: process.pid,
      rootUri,
      capabilities: { workspace: { configuration: true } },
      initializationOptions: { storagePath: storage, clearCache: true },
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    });
    await indexingEnded;
    const declaredIn = async (name: string): Promise<string[]> => {
      const found = await client.request<Array<{ name: string; location: { uri: string } }>>(
        'workspace/symbol',
        { query: name }
      );
      return (found ?? [])
        .filter((symbol) => symbol.name === name)
        .map((symbol) => decodeURIComponent(symbol.location.uri.slice(rootUri.length + 1)))
        .sort();
    };
    expect(await declaredIn('Thing')).toEqual(['src/Thing.php']);
    expect(await declaredIn('Client')).toEqual(['vendor/acme/lib/src/Client.php']);
    expect(await declaredIn('Copy')).toEqual([]);
    expect(await declaredIn('Hidden')).toEqual([]);
  });
});

// Asks for the `intelephense` settings after `initialized`, records the answer, then reports its
// index complete.
const SETTINGS_SERVER = String.raw`
const fs = require('fs');
const out = process.argv[1];
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf-8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', id: 9001, method: 'workspace/configuration', params: { items: [{ section: 'intelephense' }] } });
    } else if (message.id === 9001 && !message.method) {
      fs.writeFileSync(out, JSON.stringify(message.result));
      send({ jsonrpc: '2.0', method: 'indexingEnded' });
    } else if (message.id !== undefined && message.method) {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;
