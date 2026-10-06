import { parentPort, workerData } from 'node:worker_threads';
import { relative, sep, win32 } from 'node:path';

import Parser from 'web-tree-sitter';

import { extractSource, getGrammars, langForFile, type AstLang } from '../ast/extract.js';
import { extractionToSourceFacts } from '../ast/source-facts.js';
import type { AdapterOutputV1 } from './types.js';
import {
  PARSE_STARTED_MESSAGE,
  isPersistentWorkerData,
  type AdapterWorkerRequestV1,
  type AdapterWorkerResponseV1,
} from './worker-protocol.js';

type WorkerLanguage = AstLang;

interface WorkerWireRequestV1 {
  schemaVersion: 1;
  request: AdapterWorkerRequestV1;
  source: string;
  /** Internal bounded-cache seam; never part of the frozen adapter output. */
  includeExtraction?: boolean;
}

function responseError(
  code: 'timeout' | 'limit' | 'parse-error' | 'path-escape' | 'worker-error',
  message: string
): AdapterWorkerResponseV1 {
  return { schemaVersion: 1, ok: false, diagnostic: { code, message } };
}

function validateWire(value: unknown): value is WorkerWireRequestV1 {
  if (!value || typeof value !== 'object') return false;
  const wire = value as Partial<WorkerWireRequestV1>;
  return (
    wire.schemaVersion === 1 &&
    typeof wire.source === 'string' &&
    Boolean(wire.request && wire.request.schemaVersion === 1 && wire.request.input)
  );
}

function languageForFile(filePath: string): WorkerLanguage | null {
  return langForFile(filePath);
}

function isCanonicalRequest(request: AdapterWorkerRequestV1): boolean {
  const { corpusRoot, allowedRoots, filePath } = request.input;
  if (
    !allowedRoots.some((root) => {
      const difference = relative(root, filePath);
      return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
    })
  )
    return false;
  return (
    allowedRoots.every((root) => root.startsWith(sep) || win32.isAbsolute(root)) &&
    (corpusRoot.startsWith(sep) || win32.isAbsolute(corpusRoot)) &&
    (filePath.startsWith(sep) || win32.isAbsolute(filePath))
  );
}

function countSyntax(
  root: Parser.SyntaxNode,
  maxNodes: number,
  maxDepth: number
): string | undefined {
  let nodes = 0;
  const pending: Array<{ node: Parser.SyntaxNode; depth: number }> = [{ node: root, depth: 1 }];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    nodes += 1;
    if (nodes > maxNodes) return 'Parser syntax node count exceeds maxNodes.';
    if (item.depth > maxDepth) return 'Parser syntax depth exceeds maxDepth.';
    for (let index = item.node.namedChildCount - 1; index >= 0; index -= 1) {
      const child = item.node.namedChild(index);
      if (child) pending.push({ node: child, depth: item.depth + 1 });
    }
  }
  return undefined;
}

async function parse(wire: WorkerWireRequestV1): Promise<AdapterWorkerResponseV1> {
  const request = wire.request;
  if (!isCanonicalRequest(request)) {
    return responseError('path-escape', 'Parser worker received a non-confined path.');
  }
  const language = languageForFile(request.input.filePath);
  if (!language) return responseError('parse-error', 'Parser language is unsupported.');

  let parser: Parser | undefined;
  let tree: Parser.Tree | undefined;
  try {
    const grammars = await getGrammars();
    const grammar = grammars.get(language);
    if (!grammar) return responseError('parse-error', 'Parser grammar is unavailable.');

    parser = new Parser();
    parser.setLanguage(grammar);
    tree = parser.parse(wire.source) ?? undefined;
    if (!tree) return responseError('parse-error', 'Parser did not produce a syntax tree.');

    const limitMessage = countSyntax(
      tree.rootNode,
      request.input.limits.maxNodes,
      request.input.limits.maxDepth
    );
    if (limitMessage) return responseError('limit', limitMessage);
    const hadSyntaxError = tree.rootNode.hasError;

    // Extraction owns and frees its separate parser/tree. The direct parse above
    // exists to enforce named-node/depth limits before facts are emitted.
    const extracted = extractSource(grammars, wire.source, request.input.filePath, language);
    const facts = extractionToSourceFacts(request.input.filePath, language, extracted.extraction);
    if (facts.references.length > request.input.limits.maxReferences) {
      return responseError('limit', 'Parser emitted references exceed maxReferences.');
    }
    if (hadSyntaxError || extracted.hadError) {
      const parseDiagnostic = {
        code: 'parse-error',
        message: 'Parser reported malformed syntax; partial facts were retained.',
        location: { filePath: request.input.filePath, line: 1, column: 0 },
      };
      facts.diagnostics.push(parseDiagnostic);
    }

    const output: AdapterOutputV1 = {
      facts,
      dependencies: [request.input.filePath],
      diagnostics: facts.diagnostics,
      ...(wire.includeExtraction ? { extraction: extracted.extraction } : {}),
    };
    return { schemaVersion: 1, ok: true, output };
  } catch {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return responseError('worker-error', 'Parser worker failed.');
  } finally {
    tree?.delete();
    parser?.delete();
  }
}

function postBounded(response: AdapterWorkerResponseV1, maxResultBytes: number): void {
  let encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, 'utf8') > maxResultBytes) {
    encoded = JSON.stringify(responseError('limit', 'Parser result exceeds maxResultBytes.'));
  }
  parentPort?.postMessage(encoded);
}

async function respond(wire: unknown): Promise<void> {
  // Load the grammars before the host's parse clock starts (worker-protocol.ts).
  await getGrammars();
  parentPort?.postMessage(PARSE_STARTED_MESSAGE);
  const response = validateWire(wire)
    ? await parse(wire)
    : responseError('worker-error', 'Parser worker received an invalid request.');
  const maxResultBytes = validateWire(wire) ? wire.request.input.limits.maxResultBytes : 1024;
  postBounded(response, maxResultBytes);
}

function fail(): void {
  postBounded(responseError('worker-error', 'Parser worker failed.'), 1024);
}

// A persistent worker (worker-host.ts's pool) answers one request per message; otherwise the
// request arrives as workerData and the worker answers it once.
if (isPersistentWorkerData(workerData)) {
  parentPort?.on('message', (wire: unknown) => void respond(wire).catch(fail));
} else {
  void respond(workerData).catch(fail);
}
