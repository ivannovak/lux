// PHP namespaces in the symbol graph (issue #12). A namespace is not a symbol node: it is carried
// in the id and qualified name of everything declared in it. The fixture covers three files in one
// namespace, a file with two namespace blocks, a global-namespace file, a bracketed file, and a
// Blade template, whose HTML, CSS and JavaScript the server also reports as symbols.
//
// The language server here is a stand-in that replays the `textDocument/documentSymbol` answers
// intelephense 1.16.3 gives for exactly these sources, captured from the real server:
//   - `namespace X;` is a Namespace symbol (kind 3) with no children, a sibling of the
//     declarations that follow it;
//   - `namespace X { … }` is a Namespace symbol whose children are the block's declarations;
//   - the global block `namespace { … }` has no symbol, its declarations are top-level;
//   - in a `.blade.php` template, HTML elements are Field symbols, CSS selectors Class symbols
//     and JavaScript functions Function symbols, beside the template's PHP variables.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { runLux, type CliRun } from './helpers/determinism.js';

const SOURCES: Record<string, string> = {
  'src/Shared/One.php':
    '<?php\n\nnamespace App\\Shared;\n\nclass One\n{\n    public function run(): int { return 1; }\n}\n',
  'src/Shared/Two.php':
    '<?php\n\nnamespace App\\Shared;\n\nclass Two {}\n\nfunction shared_helper(): int { return 2; }\n',
  'src/Shared/Three.php': '<?php\n\nnamespace App\\Shared;\n\nclass Three {}\n',
  'src/TwoBlocks.php':
    '<?php\n\nnamespace App\\A;\n\nclass X {}\n\nnamespace App\\B;\n\nclass Y {}\nconst LIMIT = 3;\n',
  'src/global.php':
    '<?php\n\nfunction global_helper(): int { return 1; }\n\nclass GlobalThing {}\n\n$aliases = [global_helper()];\n',
  'src/Bracketed.php':
    '<?php\n\nnamespace App\\Br {\n    class Z {}\n}\n\nnamespace {\n    function in_global(): int { return 1; }\n}\n',
  'resources/views/report.blade.php':
    '<html>\n<style>\n.page-break { page-break-after: always; }\nposition { top: 0; }\n</style>\n' +
    '<script>function toggleCollapse() {}</script>\n@php\n$total = 1;\n@endphp\n</html>\n',
};

/** documentSymbol answers by file name: [name, kind, startLine, endLine, children?]. */
const ANSWERS = {
  'One.php': [
    ['App\\Shared', 3, 2, 2],
    ['One', 5, 4, 7, [['run', 6, 6, 6]]],
  ],
  'Two.php': [
    ['App\\Shared', 3, 2, 2],
    ['Two', 5, 4, 4],
    ['shared_helper', 12, 6, 6],
  ],
  'Three.php': [
    ['App\\Shared', 3, 2, 2],
    ['Three', 5, 4, 4],
  ],
  'TwoBlocks.php': [
    ['App\\A', 3, 2, 2],
    ['X', 5, 4, 4],
    ['App\\B', 3, 6, 6],
    ['Y', 5, 8, 8],
    ['LIMIT', 14, 9, 9],
  ],
  'global.php': [
    ['global_helper', 12, 2, 2],
    ['GlobalThing', 5, 4, 4],
    ['$aliases', 13, 6, 6],
  ],
  'Bracketed.php': [
    ['App\\Br', 3, 2, 4, [['Z', 5, 3, 3]]],
    ['in_global', 12, 7, 7],
  ],
  'report.blade.php': [
    ['html', 8, 0, 9],
    ['.page-break', 5, 2, 2],
    ['position', 5, 3, 3],
    ['toggleCollapse', 12, 5, 5],
    ['$total', 13, 7, 7],
  ],
};

const FAKE_SERVER = `
const { appendFileSync } = require('node:fs');
const answers = ${JSON.stringify(ANSWERS)};
const symbol = ([name, kind, start, end, children]) => ({
  name, kind,
  range: { start: { line: start, character: 0 }, end: { line: end, character: 1 } },
  selectionRange: { start: { line: start, character: 0 }, end: { line: start, character: 1 } },
  ...(children ? { children: children.map(symbol) } : {}),
});
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
};
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
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, referencesProvider: true } } });
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', method: 'indexingEnded' });
    } else if (message.method === 'textDocument/documentSymbol') {
      const file = message.params.textDocument.uri.split('/').pop();
      send({ jsonrpc: '2.0', id: message.id, result: (answers[file] || []).map(symbol) });
    } else if (message.method === 'textDocument/references') {
      const file = message.params.textDocument.uri.split('/').pop();
      appendFileSync(process.argv[2], file + ':' + message.params.position.line + '\\n');
      send({ jsonrpc: '2.0', id: message.id, result: [] });
    } else if (message.method === 'exit') {
      process.exit(0);
    } else if (message.id !== undefined && message.method) {
      send({ jsonrpc: '2.0', id: message.id, result: null });
    }
  }
});
`;

interface SymbolRow {
  id: string;
  file_path: string;
  symbol_kind: string | null;
  qualified_name: string | null;
}

let base: string;
let rebuild: CliRun;
let symbols: SymbolRow[] = [];
let status: { symbolIdCollisions: { collidingIds: number } };
/** `file:line` of every textDocument/references request the server received. */
let referenceRequests: string[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lux-php-declarations-'));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const server = join(base, 'fake-intelephense.js');
  writeFileSync(server, FAKE_SERVER);
  const requestLog = join(base, 'references.log');
  writeFileSync(requestLog, '');
  for (const [relPath, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }
  writeFileSync(join(root, 'composer.json'), '{"name":"fixture/app"}\n');
  writeFileSync(
    join(root, 'lux.yaml'),
    [
      'lsp:',
      '  enabled: true',
      '  enrichers:',
      '    - language_id: php',
      `      server_command: ${process.execPath}`,
      `      server_args: [${JSON.stringify(server)}, ${JSON.stringify(requestLog)}]`,
      'deps:',
      '  enabled: false',
      '',
    ].join('\n')
  );

  const dbPath = join(root, '.lux', 'lux.db');
  rebuild = runLux(root, dbPath, home, ['index', 'rebuild', '--quiet']);
  if (rebuild.status !== 0) return;
  const db = new LuxSqlite(dbPath, { readonly: true });
  try {
    symbols = db
      .prepare(
        `SELECT id, file_path, symbol_kind, qualified_name FROM structural_nodes
          WHERE node_type = 'symbol' ORDER BY id`
      )
      .all() as SymbolRow[];
  } finally {
    db.close();
  }
  referenceRequests = readFileSync(requestLog, 'utf-8').split('\n').filter(Boolean).sort();
  status = JSON.parse(runLux(root, dbPath, home, ['index', 'status', '--json']).stdout) as {
    symbolIdCollisions: { collidingIds: number };
  };
}, 120_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('PHP namespaces in the symbol graph', () => {
  it('rebuilds the fixture', () => {
    expect(rebuild.status, rebuild.stderr).toBe(0);
  });

  it('stores each declaration once, qualified by the namespace it is declared in', () => {
    expect(symbols.map((row) => `${row.id} @ ${row.file_path}`).sort()).toEqual(
      [
        'symbol:php:App\\Shared\\One @ src/Shared/One.php',
        'symbol:php:App\\Shared\\One::run @ src/Shared/One.php',
        'symbol:php:App\\Shared\\Two @ src/Shared/Two.php',
        'symbol:php:App\\Shared\\shared_helper @ src/Shared/Two.php',
        'symbol:php:App\\Shared\\Three @ src/Shared/Three.php',
        // Two blocks in one file: each declaration takes the block it sits in.
        'symbol:php:App\\A\\X @ src/TwoBlocks.php',
        'symbol:php:App\\B\\Y @ src/TwoBlocks.php',
        'symbol:php:App\\B\\LIMIT @ src/TwoBlocks.php',
        // No namespace: the bare name.
        'symbol:php:global_helper @ src/global.php',
        'symbol:php:GlobalThing @ src/global.php',
        'symbol:php:$aliases @ src/global.php',
        // Bracketed: the block's declarations, and the global block's without a namespace.
        'symbol:php:App\\Br\\Z @ src/Bracketed.php',
        'symbol:php:in_global @ src/Bracketed.php',
        // A Blade template: its PHP variable, and none of its HTML, CSS or JavaScript.
        'symbol:php:$total @ resources/views/report.blade.php',
      ].sort()
    );
  });

  it('stores no node for a namespace itself', () => {
    expect(symbols.filter((row) => row.symbol_kind === 'Namespace')).toEqual([]);
    expect(symbols.filter((row) => /App\\Shared\\App\\Shared/.test(row.id))).toEqual([]);
  });

  it('carries the namespace on the qualified name of what it contains', () => {
    const qualified = Object.fromEntries(symbols.map((row) => [row.id, row.qualified_name]));
    expect(qualified['symbol:php:App\\Shared\\Three']).toBe('App\\Shared\\Three');
    expect(qualified['symbol:php:App\\B\\Y']).toBe('App\\B\\Y');
    expect(qualified['symbol:php:App\\Br\\Z']).toBe('App\\Br\\Z');
    expect(qualified['symbol:php:in_global']).toBeNull();
  });

  it('asks the server about the declarations of a block, never about a namespace or a selector', () => {
    expect(referenceRequests).toEqual([
      'Bracketed.php:3', // Z, inside `namespace App\\Br { … }`
      'Bracketed.php:7', // in_global
      'One.php:4',
      'Three.php:4',
      'Two.php:4',
      'Two.php:6',
      'TwoBlocks.php:4',
      'TwoBlocks.php:8',
      'TwoBlocks.php:9', // LIMIT
      'global.php:2',
      'global.php:4',
    ]);
  });

  it('counts no shared id: three files in one namespace collide on nothing', () => {
    expect(symbols.filter((row) => row.id.includes('#file:'))).toEqual([]);
    expect(status.symbolIdCollisions.collidingIds).toBe(0);
  });
});
