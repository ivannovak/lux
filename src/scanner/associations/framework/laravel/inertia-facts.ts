import type { SourceDiagnosticV1, SourceLocationV1 } from '../../../contracts/program.js';
import { astSymbolIdentity } from '../../../ast/symbols.js';
import type { SymbolIdCollisions } from '../../../identity/symbol-collisions.js';
import type { AstEdge, AstNode, Extraction } from '../../../ast/extract.js';

export interface InertiaPageFactV1 {
  filePath: string;
  pageName: string;
  sourceNodeId: string;
  ownerName: string;
  ownerKind: 'method' | 'function';
  form: 'facade' | 'helper';
  location: SourceLocationV1;
}

export interface InertiaFactExtractionV1 {
  pages: InertiaPageFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

export interface InertiaFactInputV1 {
  filePath: string;
  content: string;
  extraction: Extraction;
  /** Symbol ids more than one file declares; the owning method's id is file-qualified then. */
  collisions?: SymbolIdCollisions;
}

/**
 * Extract static Inertia page responses from PHP tree-sitter output.
 *
 * The call candidates and enclosing declarations come exclusively from the PHP
 * grammar. Source text is consulted only inside a grammar-delimited argument
 * list to distinguish a plain PHP string literal from a dynamic expression.
 */
export function extractInertiaFacts(input: InertiaFactInputV1): InertiaFactExtractionV1 {
  const pages: InertiaPageFactV1[] = [];
  const diagnostics: SourceDiagnosticV1[] = [];

  for (const edge of input.extraction.edges) {
    if (edge.type !== 'call') continue;
    const form = inertiaCallForm(edge, input.extraction);
    if (!form.recognized) continue;

    const location = edgeLocation(input.filePath, edge);
    const owner = innermostCallable(input.extraction.nodes, edge.range.startByte);
    const pageName = firstLiteralArgument(input.content, edge.range.startByte, edge.range.endByte);
    if (!owner || pageName === undefined || form.dynamicAlias) {
      diagnostics.push({
        code: 'inertia-page-dynamic',
        message: form.dynamicAlias
          ? 'An aliased Inertia helper cannot be resolved statically.'
          : !owner
            ? 'An Inertia page response has no enclosing named PHP method or function.'
            : 'The Inertia page name is dynamic and cannot form a hydration edge.',
        location,
      });
      continue;
    }

    const sourceNodeId = astSymbolIdentity(
      input.filePath,
      owner,
      'php',
      input.extraction.namespace,
      input.collisions
    ).id;
    pages.push({
      filePath: input.filePath,
      pageName,
      sourceNodeId,
      ownerName: owner.name,
      ownerKind: owner.type as 'method' | 'function',
      form: form.form,
      location,
    });
  }

  return { pages, diagnostics };
}

function inertiaCallForm(
  edge: AstEdge,
  extraction: Extraction
): { recognized: boolean; dynamicAlias: boolean; form: 'facade' | 'helper' } {
  if (edge.callKind === 'identifier') {
    if (edge.toRaw === 'inertia') {
      return { recognized: true, dynamicAlias: false, form: 'helper' };
    }
    const helperImport = extraction.imports?.find(
      (binding) =>
        binding.local === edge.toRaw &&
        binding.local !== 'inertia' &&
        binding.imported.replace(/^\\/u, '').toLowerCase() === 'inertia'
    );
    return helperImport
      ? { recognized: true, dynamicAlias: true, form: 'helper' }
      : { recognized: false, dynamicAlias: false, form: 'helper' };
  }

  if (edge.callKind !== 'member' || edge.member !== 'render') {
    return { recognized: false, dynamicAlias: false, form: 'facade' };
  }
  const separator = edge.toRaw.lastIndexOf('::');
  if (separator < 0) return { recognized: false, dynamicAlias: false, form: 'facade' };
  const receiver = edge.toRaw.slice(0, separator).replace(/^\\/u, '');
  if (receiver.toLowerCase() === 'inertia\\inertia') {
    return { recognized: true, dynamicAlias: false, form: 'facade' };
  }
  const imported = extraction.imports?.find((binding) => binding.local === receiver)?.imported;
  return imported?.replace(/^\\/u, '').toLowerCase() === 'inertia\\inertia'
    ? { recognized: true, dynamicAlias: false, form: 'facade' }
    : { recognized: false, dynamicAlias: false, form: 'facade' };
}

function innermostCallable(nodes: readonly AstNode[], byte: number): AstNode | undefined {
  return nodes
    .filter(
      (node) =>
        (node.type === 'method' || node.type === 'function') &&
        node.range.startByte <= byte &&
        byte < node.range.endByte
    )
    .sort(
      (left, right) =>
        left.range.endByte - left.range.startByte - (right.range.endByte - right.range.startByte)
    )[0];
}

function edgeLocation(filePath: string, edge: AstEdge): SourceLocationV1 {
  return {
    filePath,
    line: edge.range.startLine,
    column: edge.range.startColumn,
  };
}

/** Return only a complete, non-interpolated PHP string used as argument one. */
function firstLiteralArgument(content: string, start: number, end: number): string | undefined {
  const call = content.slice(start, end);
  const open = call.indexOf('(');
  if (open < 0) return undefined;
  let index = skipTrivia(call, open + 1);
  const quote = call[index];
  if (quote !== "'" && quote !== '"') return undefined;

  const value: string[] = [];
  index += 1;
  while (index < call.length) {
    const character = call[index];
    if (character === quote) {
      index = skipTrivia(call, index + 1);
      if (call[index] !== ',' && call[index] !== ')') return undefined;
      return value.join('');
    }
    if (quote === '"' && character === '$') return undefined;
    if (quote === '"' && character === '{') return undefined;
    if (character !== '\\') {
      value.push(character);
      index += 1;
      continue;
    }
    const escaped = call[index + 1];
    if (escaped === undefined) return undefined;
    if (quote === "'") {
      if (escaped === "'" || escaped === '\\') value.push(escaped);
      else value.push('\\', escaped);
    } else {
      const replacements: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        e: '\u001b',
        f: '\f',
        '\\': '\\',
        '"': '"',
        $: '$',
      };
      value.push(replacements[escaped] ?? `\\${escaped}`);
    }
    index += 2;
  }
  return undefined;
}

function skipTrivia(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index) || source[index] === '#') {
      const newline = source.indexOf('\n', index + 1);
      return newline < 0 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      return close < 0 ? source.length : skipTrivia(source, close + 2);
    }
    return index;
  }
  return index;
}
