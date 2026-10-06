// A request that times out must fail the file's enrichment rather than enrich it with no symbols:
// "no symbols" is a claim about the file, and a timeout is not. A timeout is retried once first.
// Failures that do not depend on load (an error answer, a result in an unexpected shape) still
// enrich the file with nothing for the failed item, as before.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptLspEnricher } from '../typescript.js';
import { classifyLspEnrichmentError } from '../enrichment-failures.js';

// Answers `initialize`; then answers documentSymbol per mode: never ('silent'), with an error
// ('error'), only on the second request ('slow-once'), or with flat SymbolInformation that has no
// selectionRange ('flat').
const FAKE_SERVER = String.raw`
const mode = process.argv[1];
let symbolRequests = 0;
const symbols = [{ name: 'answer', kind: 13, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }, selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } }];
let buffer = Buffer.alloc(0);
const reply = (message) => {
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
      reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true, typeHierarchyProvider: true } } });
    } else if (message.method === 'textDocument/documentSymbol') {
      symbolRequests += 1;
      if (mode === 'error') {
        reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'no symbols here' } });
      } else if (mode === 'slow-once' && symbolRequests > 1) {
        reply({ jsonrpc: '2.0', id: message.id, result: symbols });
      } else if (mode === 'flat') {
        reply({ jsonrpc: '2.0', id: message.id, result: [{ name: 'answer', kind: 13, location: { uri: 'file:///x', range: symbols[0].range } }] });
      }
    } else if (message.method === 'textDocument/definition' && mode !== 'silent') {
      // Echo where it was asked, so a test can see which position a symbol was resolved at.
      reply({ jsonrpc: '2.0', id: message.id, result: mode === 'flat' ? { uri: 'file:///x', range: { start: message.params.position, end: message.params.position } } : null });
    } else if (message.method === 'shutdown') {
      reply({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

let dir: string | undefined;
let enricher: TypeScriptLspEnricher | undefined;

afterEach(async () => {
  await enricher?.shutdown();
  enricher = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function enrichOne(mode: 'silent' | 'error' | 'slow-once' | 'flat') {
  dir = mkdtempSync(join(tmpdir(), 'lux-enrich-failure-'));
  const file = join(dir, 'example.ts');
  writeFileSync(file, 'export const answer = 42;\n');
  enricher = new TypeScriptLspEnricher({
    serverCommand: process.execPath,
    serverArgs: ['-e', FAKE_SERVER, mode],
    requestTimeoutMs: 300,
    initTimeoutMs: 300,
  });
  await enricher.initialize(dir);
  return enricher.enrich(file);
}

describe('enrichment failures are not silent', () => {
  it('rejects when documentSymbol times out, and the reason classifies as a timeout', async () => {
    const error = await enrichOne('silent').then(
      () => null,
      (rejection: Error) => rejection
    );
    expect(error?.message).toMatch(/timed out/);
    expect(classifyLspEnrichmentError(error?.message ?? '')).toBe('timeout');
  });

  it('rejects a definition lookup that times out instead of answering "no target"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lux-enrich-failure-'));
    const file = join(dir, 'example.ts');
    writeFileSync(file, 'export const answer = 42;\n');
    enricher = new TypeScriptLspEnricher({
      serverCommand: process.execPath,
      serverArgs: ['-e', FAKE_SERVER, 'silent'],
      requestTimeoutMs: 200,
      initTimeoutMs: 200,
    });
    await enricher.initialize(dir);
    await expect(
      enricher.resolveDefinitionsInFile(file, [{ line: 0, character: 13 }])
    ).rejects.toThrow(/timed out/);
  });

  it('retries a timed-out request once and keeps the answer', async () => {
    const result = await enrichOne('slow-once');
    expect(result?.symbols.map((symbol) => symbol.name)).toEqual(['answer']);
  });

  it('records an error answer for the file instead of passing it off as "no symbols"', async () => {
    const result = await enrichOne('error');
    expect(result?.symbols).toEqual([]);
    expect(enricher?.drainRequestIssues()).toEqual([
      {
        filePath: result?.filePath,
        stage: 'symbols',
        kind: 'response',
        method: 'textDocument/documentSymbol',
        code: -32603,
      },
    ]);
  });

  it('asks about a symbol reported as SymbolInformation at its location', async () => {
    const result = await enrichOne('flat');
    expect(result?.symbols).toMatchObject([{ name: 'answer', startLine: 0 }]);
    expect(result?.definitions).toEqual([
      { symbolName: 'answer', targetUri: 'external:/x', targetStartLine: 0 },
    ]);
    expect(enricher?.drainRequestIssues()).toEqual([]);
  });
});
