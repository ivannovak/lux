// A server that starts and then dies before its language's files come up for enrichment leaves
// the whole language without LSP data. Each of the three enrichment paths — full rebuild, the
// incremental sync's own loop (`--mark-only`), and the scoped refresh — must record it and close on
// a warning, instead of skipping the files and reading as complete.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLux } from './helpers/determinism.js';

// argv: mode file, role. The mode is read at start, so one lux.yaml serves a healthy rebuild and a
// later run with a dying server (editing lux.yaml would change the config fingerprint).
//   php role, mode "php-dies": exits 100 ms after it has started and finished indexing
//   ts  role, mode "php-dies": answers initialize after 700 ms, so php is dead when its turn comes
const FAKE_SERVER = `
const fs = require('fs');
const [modeFile, role] = [process.argv[2], process.argv[3]];
const dying = fs.readFileSync(modeFile, 'utf-8').trim() === 'php-dies';
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
};
const capabilities = { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true };
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf-8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize') {
      const answer = () => send({ jsonrpc: '2.0', id: message.id, result: { capabilities } });
      if (dying && role === 'ts') setTimeout(answer, 700); else answer();
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', method: 'indexingEnded' });
      if (dying && role === 'php') setTimeout(() => process.exit(1), 100);
    } else if (message.method === 'textDocument/documentSymbol') {
      // The fixture's PHP file declares class A, and an empty answer for it would be a failure.
      const range = { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } };
      const php = message.params.textDocument.uri.endsWith('.php');
      send({ jsonrpc: '2.0', id: message.id, result: php ? [{ name: 'A', kind: 5, range, selectionRange: range }] : [] });
    } else if (message.id !== undefined && message.method) {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

interface Failure {
  filePath: string;
  stage: string;
  reason: string;
  languageId?: string;
}

const PHP_LOST = { filePath: '.', stage: 'init', reason: 'transport', languageId: 'php' };
const WARNING = /Warning: LSP output incomplete — init: php \(transport\)/;

let base: string;
let server: string;
let modeFile: string;

function git(root: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
}

function makeRepo(name: string): { root: string; db: string; home: string } {
  const root = join(base, name);
  const home = join(base, `home-${name}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const enricher = (languageId: string, role: string) => [
    `    - language_id: ${languageId}`,
    `      server_command: ${process.execPath}`,
    `      server_args: [${JSON.stringify(server)}, ${JSON.stringify(modeFile)}, ${role}]`,
    '      request_timeout_ms: 2000',
    '      init_timeout_ms: 5000',
  ];
  writeFileSync(
    join(root, 'lux.yaml'),
    [
      'lsp:',
      '  enabled: true',
      '  enrichers:',
      ...enricher('php', 'php'),
      ...enricher('typescript', 'ts'),
      'deps:',
      '  enabled: false',
      '',
    ].join('\n')
  );
  writeFileSync(join(root, '.gitignore'), 'lux.yaml\n.lux/\n');
  writeFileSync(join(root, 'composer.json'), '{"name":"fixture/app"}\n');
  writeFileSync(join(root, 'src', 'A.php'), '<?php\n\nnamespace App;\n\nclass A {}\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  return { root, db: join(root, '.lux', 'lux.db'), home };
}

function status(repo: { root: string; db: string; home: string }): Failure[] {
  const run = runLux(repo.root, repo.db, repo.home, ['index', 'status', '--json']);
  return (JSON.parse(run.stdout) as { lspEnrichmentFailures: Failure[] }).lspEnrichmentFailures;
}

function lux(repo: { root: string; db: string; home: string }, args: string[]): string {
  const run = runLux(repo.root, repo.db, repo.home, args);
  if (run.status !== 0) throw new Error(`lux ${args.join(' ')} failed: ${run.stderr}`);
  return `${run.stdout}\n${run.stderr}`;
}

/** A clean rebuild with healthy servers, then a committed PHP change and a dying PHP server. */
function rebuiltThenChanged(name: string) {
  writeFileSync(modeFile, 'healthy');
  const repo = makeRepo(name);
  lux(repo, ['index', 'rebuild', '--quiet']);
  expect(status(repo)).toEqual([]);
  writeFileSync(
    join(repo.root, 'src', 'A.php'),
    '<?php\n\nnamespace App;\n\nclass A { public $x; }\n'
  );
  git(repo.root, ['commit', '-q', '-am', 'change']);
  writeFileSync(modeFile, 'php-dies');
  return repo;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-lost-server-'));
  server = join(base, 'fake-server.js');
  modeFile = join(base, 'mode');
  writeFileSync(server, FAKE_SERVER);
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('a server that dies before its files are enriched', () => {
  it('is recorded by a full rebuild, which closes on a warning', () => {
    writeFileSync(modeFile, 'php-dies');
    const repo = makeRepo('rebuild');
    const output = lux(repo, ['index', 'rebuild', '--quiet']);
    expect(status(repo)).toContainEqual(PHP_LOST);
    expect(output).toMatch(WARNING);
    expect(output).toMatch(/⚠/);
  }, 120_000);

  it("is recorded by the incremental sync's own enrichment loop, which warns", () => {
    const repo = rebuiltThenChanged('mark-only');
    const output = lux(repo, ['index', 'sync', '--mark-only', '--quiet']);
    expect(status(repo)).toContainEqual(PHP_LOST);
    expect(output).toMatch(WARNING);
  }, 120_000);

  it('is recorded by a scoped refresh, which warns', () => {
    const repo = rebuiltThenChanged('scoped');
    const output = lux(repo, ['index', 'sync', '--quiet']);
    expect(output).toMatch(/scoped/i);
    expect(status(repo)).toContainEqual(PHP_LOST);
    expect(output).toMatch(WARNING);
  }, 120_000);
});
