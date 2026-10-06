// src/scanner/anchors/prepare-node-text.ts
//
// Prepared per-node text for the anchor plane (Decision 5). Runs INSIDE materializeAstSymbols
// (materialize.ts), where the AST def's byte range and the file content still exist — the only
// moment signature lines and leading doc-comments are cheaply available (Current State §1.1). One
// prepared unit per node feeds BOTH halves: the lexical FTS (its split fields) and, in Phase 3, the
// embed pass (its `embedText`, persisted so a resume never re-parses). NON-fenced: imports nothing
// from scanner/embeddings/.

import { createHash } from 'node:crypto';
import type { AstLang, AstNode, Extraction } from '../ast/extract.js';
import { astSymbolIdentity } from '../ast/symbols.js';
import type { SymbolIdCollisions } from '../identity/symbol-collisions.js';

/** A single node's split fields (the FTS columns) + the rendered embed/search unit + freshness hash. */
export interface PreparedNodeText {
  nodeId: string;
  fields: {
    name: string;
    identifiers: string;
    qualified: string;
    pathSegments: string;
    context: string;
  };
  embedText: string;
  contentHash: string;
}

/** Coarse char cap on the `context` field before it reaches the FTS / (Phase 3) the tokenizer. The
 *  model's ~256-token cut is the accurate boundary; node texts rarely reach it. 2,000 chars is ample
 *  headroom for a signature line + a doc-comment and stops a pathological giant method body's leading
 *  comment from bloating a row. */
const MAX_CONTEXT_CHARS = 2000;

/**
 * Split one identifier on case/separator boundaries: fooBar -> [foo, Bar]; HTTPServer -> [HTTP,
 * Server]; snake_case / kebab-case fall out of the non-alnum split. De-duplication is the caller's
 * job (it joins across name + qualified). Re-keyed from Arc-4 spec 15's `splitIdentifier`.
 */
export function splitIdentifiers(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** sha256 (hex) of the final rendered `embedText` — the freshness key stored in
 *  structural_node_texts.content_hash and copied onto the embedding row at embed time (Decision 5). */
export function nodeAnchorContentHash(embedText: string): string {
  return createHash('sha256').update(embedText, 'utf8').digest('hex');
}

/** Tokenise a qualified name (PHP `Ns\Class::method`, TS `Container.method`) into a space stream. */
function tokeniseQualified(qualified: string): string {
  return splitIdentifiers(qualified).join(' ').toLowerCase();
}

/** Tokenise a repo-relative file path into lowercased segment words, dropping the extension. */
function tokenisePathSegments(relPath: string): string {
  const noExt = relPath.replace(/\.[A-Za-z0-9]+$/, '');
  return noExt
    .split(/[\\/]+/)
    .flatMap((seg) => splitIdentifiers(seg))
    .join(' ')
    .toLowerCase();
}

/** Build the identifier stream: split name + the qualified tail, lowercased, de-duplicated, joined. */
function buildIdentifierField(name: string, qualified: string | undefined): string {
  const tokens = new Set<string>();
  for (const part of splitIdentifiers(name)) tokens.add(part.toLowerCase());
  if (qualified) for (const part of splitIdentifiers(qualified)) tokens.add(part.toLowerCase());
  return [...tokens].join(' ');
}

/**
 * The signature line = the first non-empty line of the definition's byte range. The leading
 * doc-comment = the contiguous comment block immediately above `startByte` (walking backwards over
 * comment lines). Both are best-effort text extraction — a malformed slice degrades to an empty
 * context, never throws.
 */
function extractContext(def: AstNode, fileBytes: Buffer): string {
  const { startByte, endByte } = def.range;
  // tree-sitter `range` values are BYTE offsets into the UTF-8 source; JS string indices are UTF-16
  // code units. Slicing the string directly with byte offsets corrupts the signature/context for any
  // file with multi-byte UTF-8 BEFORE the definition (accented identifiers, non-ASCII comments or
  // string literals). We slice the file's UTF-8 bytes and decode, so the offsets line up with
  // tree-sitter's. `fileBytes` is encoded ONCE per file by buildAnchorTexts and threaded in, so this
  // stays O(fileSize) per file rather than re-encoding O(nodes × fileSize).
  const body = fileBytes.subarray(startByte, endByte).toString('utf8');
  const signatureLine =
    body
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';

  // Leading doc-comment: take the text before startByte (byte-aware, same reason), split to lines, walk
  // backwards collecting contiguous comment lines (stop at the first non-comment, non-blank-inside-block).
  const before = fileBytes.subarray(0, startByte).toString('utf8');
  const priorLines = before.split(/\r?\n/);
  // Drop the (partial) line the definition starts on.
  priorLines.pop();
  const collected: string[] = [];
  for (let i = priorLines.length - 1; i >= 0; i--) {
    const line = priorLines[i].trim();
    const isComment =
      line.startsWith('//') ||
      line.startsWith('#') ||
      line.startsWith('*') ||
      line.startsWith('/*') ||
      line.endsWith('*/') ||
      line.startsWith('/**');
    if (isComment && line.length > 0) {
      collected.push(line);
      continue;
    }
    break; // first non-comment line ends the block
  }
  const docComment = collected.reverse().join(' ');
  const context = [signatureLine, docComment].filter(Boolean).join(' ');
  return context.slice(0, MAX_CONTEXT_CHARS).trim();
}

/**
 * Prepare one node's text from its AST def + the file's UTF-8 bytes. Pure — no DB, no IO.
 * `qualifiedName` is the value astSymbolIdentity returns (PHP), or undefined (TS top-level).
 * `fileBytes` is the file encoded ONCE (byte-offset slicing needs bytes, not a UTF-16 string) — the
 * caller (buildAnchorTexts) hoists the encode out of its per-node loop.
 */
export function prepareNodeText(input: {
  nodeId: string;
  symbolKind: string; // 'Class' | 'Function' | 'Method'
  name: string;
  qualifiedName?: string;
  relPath: string;
  def: AstNode;
  fileBytes: Buffer;
}): PreparedNodeText {
  const { nodeId, symbolKind, name, qualifiedName, relPath, def, fileBytes } = input;
  const qualified = qualifiedName ?? name;
  const identifiers = buildIdentifierField(name, qualifiedName);
  const pathSegments = tokenisePathSegments(relPath);
  const context = extractContext(def, fileBytes);

  // The rendered one-string form persisted as structural_node_texts.prepared and, in Phase 3,
  // embedded verbatim. Naturalised (not raw syntax): "<Kind> <name> — <qualified> (<path>)\n<ctx>".
  const embedText = [
    `${symbolKind} ${name}${qualifiedName ? ` — ${qualifiedName}` : ''} (${relPath})`,
    context,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    nodeId,
    fields: { name, identifiers, qualified: tokeniseQualified(qualified), pathSegments, context },
    embedText,
    contentHash: nodeAnchorContentHash(embedText),
  };
}

/**
 * Build prepared texts for every anchor-viable node in one extraction — the exact iteration
 * buildAstSymbolNodes (symbols.ts:60-88) performs (same astSymbolIdentity, same first-wins dedup),
 * so the texts and the nodes are produced in lockstep from the same defs. Every def
 * buildAstSymbolNodes emits is Class/Function/Method (SYMBOL_KIND_LABEL, symbols.ts:15-19), so the
 * scope (Decision 6) is enforced by construction — this function never sees a non-anchor kind.
 */
export function buildAnchorTexts(
  relPath: string,
  extraction: Extraction,
  lang: AstLang,
  fileContent: string,
  collisions?: SymbolIdCollisions
): PreparedNodeText[] {
  const SYMBOL_KIND_LABEL: Record<AstNode['type'], string> = {
    function: 'Function',
    method: 'Method',
    class: 'Class',
  };
  // Encode the file's UTF-8 bytes ONCE here (extractContext slices byte offsets, not string indices)
  // and reuse it across every node in this file, so context extraction stays O(fileSize) rather than
  // re-encoding the whole file per node (O(nodes × fileSize)).
  const fileBytes = Buffer.from(fileContent, 'utf8');
  const out: PreparedNodeText[] = [];
  const seen = new Set<string>();
  for (const def of extraction.nodes) {
    const { id, qualifiedName } = astSymbolIdentity(
      relPath,
      def,
      lang,
      extraction.namespace,
      collisions
    );
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      prepareNodeText({
        nodeId: id,
        symbolKind: SYMBOL_KIND_LABEL[def.type],
        name: def.name,
        qualifiedName,
        relPath,
        def,
        fileBytes,
      })
    );
  }
  return out;
}
