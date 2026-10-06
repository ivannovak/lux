#!/usr/bin/env node
/* global process, Buffer, setTimeout */
// A deterministic stand-in for a language server, spoken over stdio JSON-RPC, so CLI tests can run
// the real enrichment and typed-receiver code paths without intelephense or tsserver.
//
// documentSymbol: one flat symbol per `namespace|class|interface|function|const` declaration line.
// initialized: answered with intelephense's `indexingEnded` notification, so a client that waits
// for workspace indexing proceeds at once.
// references: every line in a workspace source file that calls the token under the cursor.
// definition: the token under the cursor resolved to the first `function <token>` / `class <token>`
// declaration found in any workspace source file. Everything else answers null.
// FAKE_LSP_DELAY_MS delays each documentSymbol answer and FAKE_LSP_INIT_DELAY_MS the initialize
// answer, to drive a refresh past its LSP budget during enrichment or during server start-up.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DELAY_MS = Number(process.env.FAKE_LSP_DELAY_MS ?? '0');
const INIT_DELAY_MS = Number(process.env.FAKE_LSP_INIT_DELAY_MS ?? '0');
const SOURCE_EXTENSIONS = new Set(['.php', '.ts', '.tsx', '.js', '.jsx', '.vue']);
const KINDS = { namespace: 3, class: 5, interface: 11, function: 12, const: 14 };
const DECLARATION =
  /^\s*(?:export\s+)?(?:abstract\s+|final\s+)?(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(namespace|class|interface|function|const)\s+([A-Za-z_$][\w$\\]*)/u;

let rootPath = process.cwd();
const openDocuments = new Map();

function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function textFor(uri) {
  if (openDocuments.has(uri)) return openDocuments.get(uri);
  try {
    return readFileSync(fileURLToPath(uri), 'utf8');
  } catch {
    return '';
  }
}

function documentSymbols(uri) {
  const symbols = [];
  textFor(uri)
    .split('\n')
    .forEach((line, index) => {
      const match = DECLARATION.exec(line);
      if (!match) return;
      const name = match[2].replace(/;$/u, '');
      const start = line.indexOf(match[2]);
      const range = {
        start: { line: index, character: 0 },
        end: { line: index, character: line.length },
      };
      symbols.push({
        name,
        kind: KINDS[match[1]],
        range,
        selectionRange: {
          start: { line: index, character: start },
          end: { line: index, character: start + name.length },
        },
      });
    });
  return symbols;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SOURCE_EXTENSIONS.has(extname(name))) out.push(path);
  }
  return out;
}

function tokenAt(uri, position) {
  const line = textFor(uri).split('\n')[position.line] ?? '';
  let start = position.character;
  let end = position.character;
  while (start > 0 && /[\w$]/u.test(line[start - 1])) start--;
  while (end < line.length && /[\w$]/u.test(line[end])) end++;
  return line.slice(start, end);
}

function references(uri, position) {
  const token = tokenAt(uri, position);
  if (!token) return [];
  const call = new RegExp(`\\b${token}\\s*\\(`, 'u');
  const declaration = new RegExp(`\\bfunction\\s+${token}\\b`, 'u');
  const locations = [];
  for (const file of sourceFiles(rootPath)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!call.test(line) || declaration.test(line)) return;
        locations.push({
          uri: pathToFileURL(file).href,
          range: { start: { line: index, character: 0 }, end: { line: index, character: 0 } },
        });
      });
  }
  return locations;
}

function definition(uri, position) {
  const token = tokenAt(uri, position);
  if (!token) return null;
  const declaration = new RegExp(`\\b(?:function|class)\\s+${token}\\b`, 'u');
  for (const file of sourceFiles(rootPath)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const index = lines.findIndex((l) => declaration.test(l));
    if (index >= 0) {
      return {
        uri: pathToFileURL(file).href,
        range: { start: { line: index, character: 0 }, end: { line: index, character: 0 } },
      };
    }
  }
  return null;
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    if (INIT_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, INIT_DELAY_MS));
    if (params?.rootUri) rootPath = fileURLToPath(params.rootUri);
    send({
      id,
      result: {
        capabilities: {
          documentSymbolProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          textDocumentSync: 1,
        },
      },
    });
    return;
  }
  if (method === 'initialized') {
    // intelephense's signal that workspace indexing finished; the PHP enricher waits for it.
    send({ method: 'indexingEnded', params: {} });
    return;
  }
  if (method === 'textDocument/didOpen') {
    openDocuments.set(params.textDocument.uri, params.textDocument.text);
    return;
  }
  if (method === 'textDocument/didClose') {
    openDocuments.delete(params.textDocument.uri);
    return;
  }
  if (method === 'exit') process.exit(0);
  if (id === undefined) return;
  if (method === 'textDocument/documentSymbol') {
    if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    send({ id, result: documentSymbols(params.textDocument.uri) });
    return;
  }
  if (method === 'textDocument/references') {
    send({ id, result: references(params.textDocument.uri, params.position) });
    return;
  }
  if (method === 'textDocument/definition') {
    send({ id, result: definition(params.textDocument.uri, params.position) });
    return;
  }
  send({ id, result: null });
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1] ?? '0');
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    void handle(JSON.parse(body));
  }
});
