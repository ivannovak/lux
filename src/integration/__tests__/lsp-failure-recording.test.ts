// "lspEnrichmentFailures is empty" must mean the LSP output is complete. Each way a server can
// fail a rebuild — never starting, dying in the typed-receiver pass, timing out there — has to
// reach `lux index status --json` as an entry, through the real CLI.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLux } from './helpers/determinism.js';

// A stand-in intelephense. argv: mode.
//   no-init             never answers initialize
//   crash-on-definition answers everything, then exits on the first textDocument/definition
//   silent-definition   never answers textDocument/definition
//   goes-silent         answers five textDocument/documentSymbol requests, then nothing at all
//   reject-all          answers every textDocument/* and typeHierarchy/* request with an error
//   method-not-found    answers prepareTypeHierarchy with MethodNotFound although it declared it
//   null-symbols        answers textDocument/documentSymbol with null, as for a document not open
//   healthy             answers everything
const FAKE_SERVER = `
const mode = process.argv[2];
let symbolsAnswered = 0;
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
};
const range = (line) => ({ start: { line, character: 0 }, end: { line, character: 5 } });
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
      if (mode !== 'no-init') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true, typeHierarchyProvider: true } } });
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', method: 'indexingEnded' });
    } else if (mode === 'goes-silent' && symbolsAnswered >= 5) {
      if (message.method === 'exit') process.exit(0);
    } else if (mode === 'reject-all' && /^(textDocument|typeHierarchy)\\//.test(message.method) && message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'internal error' } });
    } else if (mode === 'method-not-found' && message.method === 'textDocument/prepareTypeHierarchy') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unhandled method' } });
    } else if (message.method === 'textDocument/definition') {
      if (mode === 'crash-on-definition') process.exit(1);
      // [] is intelephense's "no target" for an open document; null means it was not open.
      if (mode !== 'silent-definition') send({ jsonrpc: '2.0', id: message.id, result: [] });
    } else if (message.method === 'textDocument/documentSymbol' && mode === 'null-symbols') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'textDocument/documentSymbol') {
      symbolsAnswered++;
      send({ jsonrpc: '2.0', id: message.id, result: [{ name: 'A', kind: 5, range: range(4), selectionRange: range(4) }] });
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null });
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
  method?: string;
  code?: number;
  fileCount?: number;
}

let base: string;
const failuresByMode: Record<string, Failure[]> = {};
const MODES = [
  'no-init',
  'crash-on-definition',
  'silent-definition',
  'goes-silent',
  'reject-all',
  'method-not-found',
  'null-symbols',
  'healthy',
];
const outputByMode: Record<string, string> = {};
const elapsedByMode: Record<string, number> = {};
const CALLERS = Array.from({ length: 20 }, (_, i) => `Caller${String(i).padStart(2, '0')}`);

function writeRepo(root: string, server: string, mode: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'composer.json'), '{"name":"fixture/app"}\n');
  writeFileSync(
    join(root, 'lux.yaml'),
    [
      'lsp:',
      '  enabled: true',
      '  enrichers:',
      '    - language_id: php',
      `      server_command: ${process.execPath}`,
      `      server_args: [${JSON.stringify(server)}, ${mode}]`,
      '      request_timeout_ms: 300',
      '      init_timeout_ms: 800',
      'deps:',
      '  enabled: false',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(root, 'src', 'Service.php'),
    '<?php\n\nnamespace App;\n\nclass Service\n{\n    public function run(): void {}\n}\n'
  );
  // More callers than the client keeps open at once, so some files ask only after the crash.
  for (const name of CALLERS) {
    writeFileSync(
      join(root, 'src', `${name}.php`),
      `<?php\n\nnamespace App;\n\nclass ${name}\n{\n    public function go(Service $service): void\n    {\n        $service->run();\n    }\n}\n`
    );
  }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-lsp-failures-'));
  const server = join(base, 'fake-intelephense.js');
  writeFileSync(server, FAKE_SERVER);
  for (const mode of MODES) {
    const root = join(base, mode);
    const home = join(base, `home-${mode}`);
    mkdirSync(home, { recursive: true });
    writeRepo(root, server, mode);
    const db = join(root, '.lux', 'lux.db');
    const started = Date.now();
    const rebuild = runLux(root, db, home, ['index', 'rebuild', '--quiet']);
    elapsedByMode[mode] = Date.now() - started;
    if (rebuild.status !== 0) throw new Error(`rebuild (${mode}) failed: ${rebuild.stderr}`);
    outputByMode[mode] = `${rebuild.stdout}\n${rebuild.stderr}`;
    const status = runLux(root, db, home, ['index', 'status', '--json']);
    failuresByMode[mode] = (
      JSON.parse(status.stdout) as { lspEnrichmentFailures: Failure[] }
    ).lspEnrichmentFailures;
  }
}, 300_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('LSP failures reach index status --json', () => {
  it('records a server that never started, for its whole language', () => {
    expect(failuresByMode['no-init']).toContainEqual({
      filePath: '.',
      stage: 'init',
      reason: 'timeout',
      languageId: 'php',
    });
  });

  it('records every file a server crash left without call edges, not just the first', () => {
    const calls = failuresByMode['crash-on-definition'].filter((f) => f.stage === 'calls');
    expect(calls.map((f) => f.filePath).sort()).toEqual(CALLERS.map((c) => `src/${c}.php`));
    expect(calls.every((f) => f.reason === 'transport')).toBe(true);
  });

  it('records a server that stopped answering definition requests once, with the file count', () => {
    // Two requests and their retries go unanswered; the server is then given up on, and the
    // 20 callers are one entry, not 20.
    expect(failuresByMode['silent-definition']).toEqual([
      { filePath: '.', stage: 'calls', reason: 'unresponsive', languageId: 'php', fileCount: 20 },
    ]);
    expect(outputByMode['silent-definition']).toMatch(
      /Warning: LSP output incomplete — calls: the php language server stopped answering and was not asked about 20 file\(s\)/
    );
  });

  it('gives up on a server that goes silent part-way, in bounded time, and says so once per stage', () => {
    expect(failuresByMode['goes-silent']).toEqual([
      { filePath: '.', stage: 'calls', reason: 'unresponsive', languageId: 'php', fileCount: 20 },
      { filePath: '.', stage: 'symbols', reason: 'unresponsive', languageId: 'php', fileCount: 21 },
    ]);
    const output = outputByMode['goes-silent'];
    expect(
      output.match(/LSP output incomplete — symbols: the php language server stopped answering/g)
    ).toHaveLength(1);
    expect(
      output.match(/LSP output incomplete — calls: the php language server stopped answering/g)
    ).toHaveLength(1);
    expect(output).toMatch(/⚠ index rebuild complete/);
    // Giving up costs 8 timeout periods (2.4 s here). Waiting out every file would cost
    // 4 periods for each of the 16 unanswered files, and again for the 20 callers: 43 s.
    expect(elapsedByMode['goes-silent'] - elapsedByMode['healthy']).toBeLessThan(10_000);
  });

  it('records every file whose requests the server answered with an error, with method and code', () => {
    const responses = failuresByMode['reject-all'].filter((f) => f.reason === 'response');
    expect(responses).toContainEqual({
      filePath: 'src/Service.php',
      stage: 'symbols',
      reason: 'response',
      method: 'textDocument/documentSymbol',
      code: -32603,
    });
    const files = new Set(responses.filter((f) => f.stage === 'symbols').map((f) => f.filePath));
    expect([...files].sort()).toEqual(
      [...CALLERS.map((c) => `src/${c}.php`), 'src/Service.php'].sort()
    );
    expect(responses.filter((f) => f.stage === 'calls').map((f) => f.method)).toContain(
      'textDocument/definition'
    );
  });

  it('records MethodNotFound for a declared capability once for the language, not per file', () => {
    expect(failuresByMode['method-not-found']).toEqual([
      {
        filePath: '.',
        stage: 'capability',
        reason: 'response',
        languageId: 'php',
        method: 'textDocument/prepareTypeHierarchy',
        code: -32601,
      },
    ]);
  });

  it('closes the run on a warning with one summary line per stage', () => {
    const rejected = outputByMode['reject-all'];
    expect(rejected).toMatch(/Warning: LSP output incomplete — symbols: 21 file\(s\) \(response\)/);
    expect(rejected).toMatch(/Warning: LSP output incomplete — calls: 20 file\(s\) \(response\)/);
    expect(rejected.match(/LSP output incomplete — symbols/g)).toHaveLength(1);
    expect(rejected).toMatch(/⚠ index rebuild complete/);
    expect(rejected).not.toMatch(/✓ index rebuild complete/);
    expect(outputByMode['no-init']).toMatch(/Warning: LSP output incomplete — init: php/);
    expect(outputByMode['method-not-found']).toMatch(
      /Warning: LSP output incomplete — capability: php textDocument\/prepareTypeHierarchy/
    );
  });

  it('records every file whose documentSymbol answer was null, not "no symbols"', () => {
    const empty = failuresByMode['null-symbols'].filter((f) => f.stage === 'symbols');
    expect(empty.map((f) => f.filePath).sort()).toEqual(
      [...CALLERS.map((c) => `src/${c}.php`), 'src/Service.php'].sort()
    );
    expect(empty[0]).toEqual({
      filePath: 'src/Caller00.php',
      stage: 'symbols',
      reason: 'empty',
      method: 'textDocument/documentSymbol',
    });
    expect(outputByMode['null-symbols']).toMatch(
      /Warning: LSP output incomplete — symbols: 21 file\(s\) \(empty\)/
    );
    expect(outputByMode['null-symbols']).toMatch(/⚠ index rebuild complete/);
  });

  it('records nothing, and closes clean, when the server answers everything', () => {
    expect(failuresByMode['healthy']).toEqual([]);
    expect(outputByMode['healthy']).not.toMatch(/LSP output incomplete/);
    expect(outputByMode['healthy']).not.toMatch(/⚠|Warning:/);
  });
});
