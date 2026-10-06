// Which entries of a PHP file's document-symbol list are declarations, and in which namespace.
//
// A namespace is not a node in the symbol graph. It is not a declaration a reference can land on
// or a trace can pass through; every file of a namespace states it again, so a per-file node for
// it collides by construction, and a shared node would have no file to own it. What consumers
// need from it is the qualification of what it contains, so the namespace lives in the id and
// qualified name of each declaration (`symbol:php:App\Shared\One`) and nowhere else.
//
// A language server reports the namespace statement as a Namespace symbol in one of two shapes
// (intelephense 1.16, the same with and without hierarchical document symbols):
//   `namespace X;`       a Namespace symbol with no children; the declarations that follow it,
//                        up to the next namespace statement, are its siblings
//   `namespace X { … }`  a Namespace symbol whose children are the block's declarations; the
//                        global block `namespace { … }` has no symbol, and its declarations are
//                        top-level
// PHP does not allow the two forms in one file.
//
// A Blade template is the other case where the server's list is not a list of PHP declarations:
// intelephense reports the template's HTML elements (as Field), CSS selectors (as Class) and
// JavaScript functions (as Function) beside its PHP variables. A selector named `position` cannot
// be told from a PHP class by name or kind, and a template declares no PHP classes or functions
// of its own, so in a `.blade.php` file only the PHP variables are declarations.

/** LSP SymbolKind.Namespace. */
const NAMESPACE_KIND = 3;
/** LSP SymbolKind.Variable. */
const VARIABLE_KIND = 13;

interface DocumentSymbolLike<T> {
  name: string;
  kind: number;
  children?: T[];
}

/** A declaration and the namespace it is declared in (absent for the global namespace). */
export interface NamespacedDeclaration<T> {
  symbol: T;
  namespace?: string;
}

/**
 * The declarations of a PHP file, each with its namespace, in document order. Namespace symbols
 * themselves are not declarations and are not returned.
 *
 * @param isBlock - Whether a childless Namespace symbol is an empty `namespace X { }` block and
 *   so claims nothing after it. A file's source settles that; without it the statement form is
 *   assumed, unless another namespace in the file is a block.
 */
export function phpDeclarations<T extends DocumentSymbolLike<T>>(
  symbols: readonly T[],
  isBlock: (namespace: T) => boolean = () => false
): Array<NamespacedDeclaration<T>> {
  const hasBlocks = symbols.some(
    (symbol) => symbol.kind === NAMESPACE_KIND && (symbol.children?.length ?? 0) > 0
  );
  const declarations: Array<NamespacedDeclaration<T>> = [];
  let current: string | undefined;

  for (const symbol of symbols) {
    if (symbol.kind !== NAMESPACE_KIND) {
      declarations.push(current ? { symbol, namespace: current } : { symbol });
      continue;
    }
    if (symbol.children?.length) {
      for (const child of symbol.children)
        declarations.push({ symbol: child, namespace: symbol.name });
    } else if (!hasBlocks && !isBlock(symbol)) {
      current = symbol.name;
    }
  }
  return declarations;
}

/** The entries of a Blade template's symbol list that are PHP declarations: its variables. */
export function bladeDeclarations<T extends { name: string; kind: number }>(
  filePath: string,
  symbols: readonly T[]
): readonly T[] {
  if (!filePath.endsWith('.blade.php')) return symbols;
  return symbols.filter((symbol) => symbol.kind === VARIABLE_KIND && symbol.name.startsWith('$'));
}

/** True when the list still holds Namespace symbols, i.e. phpDeclarations has not been applied. */
export function hasNamespaceSymbols(symbols: ReadonlyArray<{ kind: number }>): boolean {
  return symbols.some((symbol) => symbol.kind === NAMESPACE_KIND);
}

/**
 * For phpDeclarations' `isBlock`: whether the namespace statement on a zero-based source line
 * opens a block.
 */
export function namespaceOpensBlock(source: string | undefined, line: number): boolean {
  if (!source) return false;
  let offset = 0;
  for (let skipped = 0; skipped < line; skipped++) {
    offset = source.indexOf('\n', offset) + 1;
    if (offset === 0) return false;
  }
  return /^[^;{]*\bnamespace\b[^;{]*\{/.test(source.slice(offset));
}
