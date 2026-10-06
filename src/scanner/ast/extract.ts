// Tree-sitter AST structural extraction (WASM) for TypeScript, TSX, and PHP.
//
// Produces definition nodes (function/method/class) and candidate edges
// (imports, calls, constructions) enumerated purely from syntax. Cross-file
// call/reference targets are left unresolved (`toRaw`) for the LSP-resolve tier
// (arm D). This is the deterministic enumeration substrate described in the
// approved exploration `2026-07-12-extraction-contract-ast-and-lsp`.
//
// web-tree-sitter is pinned to 0.22.x: the prebuilt tree-sitter-wasms grammars
// are compiled with tree-sitter-cli 0.20.x, whose Emscripten dylink ABI the
// 0.25+ runtime rewrite can no longer load.

import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';
import Parser from 'web-tree-sitter';

type TsNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);

/** Directory holding the prebuilt grammar `.wasm` files (tree-sitter-wasms/out). */
const WASM_DIR = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export interface AstRange {
  /** 1-based line. */
  startLine: number;
  /** 0-based tree-sitter column. */
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
}

export interface AstNode {
  type: 'function' | 'method' | 'class';
  name: string;
  /** Path relative to the scanned root. */
  file: string;
  range: AstRange;
  /** Enclosing type name for methods (the class/trait/interface they belong to). */
  container?: string;
  /**
   * PHP: the namespace this definition is declared in, set only when it is not the file's first
   * namespace (Extraction.namespace): a later `namespace Y;` statement or block, or the global
   * block `namespace { … }`, which is the empty string.
   */
  namespace?: string;
}

export interface AstEdge {
  type: 'import' | 'call' | 'new';
  fromFile: string;
  /** Module path / namespace / callee expression, as written in source. */
  toRaw: string;
  range: AstRange;
  /** Identifier token position — the point handed to LSP `definition` in arm D. */
  nameRange?: AstRange;
  /** Set only when a call/new resolves to a definition in the SAME file. */
  toFile?: string;
  resolvedSameFile?: boolean;
  /**
   * How a call's callee is referenced (calls only):
   *   - `identifier` — a bare call `foo()`: same-file function/class or import-bound.
   *   - `this`       — `this.m()` / `$this->m()` / `self::m()` / `static::m()`: a
   *                    call on the enclosing instance, resolvable to a same-class method.
   *   - `member`     — a call on any other receiver (`obj.m()`, `$svc->m()`,
   *                    `Foo::m()`, `super.m()`): a typed receiver only LSP can settle.
   */
  callKind?: 'identifier' | 'this' | 'member';
  /** The callee's leaf name — the function/method identifier, without any receiver. */
  member?: string;
}

/** Kinds of statically-understood ECMAScript module syntax. */
export type ModuleSyntaxKind =
  | 'esm-import'
  | 'esm-export-default'
  | 'esm-export-named'
  | 'esm-reexport-named'
  | 'esm-reexport-all'
  | 'commonjs-require'
  | 'commonjs-module-exports'
  | 'commonjs-exports-member';

/** One deterministic import/export observation, before project resolution. */
export interface ModuleSyntaxFact {
  kind: ModuleSyntaxKind;
  localName?: string;
  importedName?: string;
  exportedName?: string;
  specifier?: string;
  range: AstRange;
}

/** An imported name bound in a file, for cross-file resolution. */
export interface ImportBinding {
  /** Local name the import is bound to in this file. */
  local: string;
  /** Original exported name in the source module (TS/JS), or the FQN (PHP). */
  imported: string;
  /** Module specifier for TS/JS imports; absent for PHP `use`. */
  module?: string;
  /** Present on all extractor-produced bindings; optional for legacy handcrafted callers. */
  syntax?: 'esm' | 'commonjs';
  /** Exact local binding token range; present on all extractor-produced bindings. */
  range?: AstRange;
}

export interface Extraction {
  nodes: AstNode[];
  edges: AstEdge[];
  /** Declared namespace (PHP), used to qualify symbol identities. */
  namespace?: string;
  /** Import bindings (local name -> source), for cross-file resolution. */
  imports?: ImportBinding[];
  /** Always populated by extractSource; optional only for legacy handcrafted callers. */
  moduleFacts?: ModuleSyntaxFact[];
  /** Always populated by extractSource; optional only for legacy handcrafted callers. */
  diagnostics?: Array<{ code: string; message: string; range?: AstRange }>;
}

// ---------------------------------------------------------------------------
// Grammar wiring
// ---------------------------------------------------------------------------

export type AstLang = 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'php';

const GRAMMAR_WASM: Record<AstLang, string> = {
  javascript: join(WASM_DIR, 'tree-sitter-javascript.wasm'),
  jsx: join(WASM_DIR, 'tree-sitter-javascript.wasm'),
  typescript: join(WASM_DIR, 'tree-sitter-typescript.wasm'),
  tsx: join(WASM_DIR, 'tree-sitter-tsx.wasm'),
  php: join(WASM_DIR, 'tree-sitter-php.wasm'),
};

/** Collapse grammar variants to their persisted language id. */
export function astLanguageId(lang: AstLang): 'javascript' | 'typescript' | 'php' {
  if (lang === 'javascript' || lang === 'jsx') return 'javascript';
  if (lang === 'typescript' || lang === 'tsx') return 'typescript';
  return 'php';
}

/** Map a file path to a supported AST language, or null if unsupported. */
export function langForFile(file: string): AstLang | null {
  switch (extname(file).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'jsx';
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.php':
      return 'php';
    default:
      return null;
  }
}

/** Node types representing definitions we surface, per language family. */
const DEF_TYPES = {
  ts: {
    function: ['function_declaration', 'generator_function_declaration'],
    method: ['method_definition'],
    class: ['class_declaration', 'abstract_class_declaration'],
  },
  php: {
    function: ['function_definition'],
    method: ['method_declaration'],
    class: ['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration'],
  },
} as const;

// ---------------------------------------------------------------------------
// Tree-walking helpers
// ---------------------------------------------------------------------------

function toRange(node: TsNode): AstRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

/** Depth-first walk over named nodes. */
function walk(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    if (child) walk(child, visit);
  }
}

function nameOf(node: TsNode): string | null {
  const named = node.childForFieldName('name');
  if (named) return named.text;
  for (const c of node.namedChildren) {
    if (c && /(identifier|name)/.test(c.type)) return c.text;
  }
  return null;
}

/**
 * The name of the TS class a method belongs to, or undefined if the method is
 * not a class member (e.g. an object-literal shorthand method — which must NOT
 * be surfaced as a top-level symbol, where it would collide with real defs).
 *
 * Handles both class declarations and class expressions (`const X = class {…}`),
 * deriving the expression's name from the variable it is assigned to so its
 * methods get a stable container segment rather than a colliding bare id.
 */
function enclosingTsClassName(node: TsNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration' || cur.type === 'abstract_class_declaration') {
      return nameOf(cur) ?? undefined;
    }
    if (cur.type === 'class') {
      // Class expressions are surfaced only when directly assigned to a stable
      // identifier (`const X = class {}` or `X = class {}`).
      const decl = cur.parent;
      if (decl?.type === 'variable_declarator') {
        const nm = decl.childForFieldName('name');
        if (nm?.type === 'identifier') return nm.text;
      }
      if (decl?.type === 'assignment_expression') {
        const nm = decl.childForFieldName('left');
        if (nm?.type === 'identifier') return nm.text;
      }
      return undefined;
    }
    // An object literal between the method and any class means it is an
    // object-literal method, not a class member — do not surface it.
    if (cur.type === 'object') return undefined;
    cur = cur.parent;
  }
  return undefined;
}

/**
 * The name of the PHP class a method belongs to, or undefined if the method is
 * inside an anonymous class (`new class {…}`) — whose methods have no stable
 * FQN and would otherwise collide corpus-wide on a container-less id (the same
 * defect enclosingTsClassName guards for TS). An anonymous class between the
 * method and any named class shadows the outer class, so a nested anon-class
 * method is NOT misattributed to the enclosing real class.
 */
function enclosingPhpClassName(node: TsNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'object_creation_expression') return undefined; // `new class {…}`
    if (DEF_TYPES.php.class.includes(cur.type as never)) return nameOf(cur) ?? undefined;
    cur = cur.parent;
  }
  return undefined;
}

function lastNamespaceSegment(fqn: string): string {
  const idx = fqn.lastIndexOf('\\');
  return idx >= 0 ? fqn.slice(idx + 1) : fqn;
}

/** Extract local->imported bindings from an ECMAScript `import_statement`. */
function tsImportBindings(importStmt: TsNode, module: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const clause = importStmt.namedChildren.find((c) => c && c.type === 'import_clause');
  if (!clause) return out;
  for (const child of clause.namedChildren) {
    if (!child) continue;
    if (child.type === 'identifier') {
      out.push({
        local: child.text,
        imported: 'default',
        module,
        syntax: 'esm',
        range: toRange(child),
      });
    } else if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (!spec || spec.type !== 'import_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        const imported = nameNode?.text;
        const localNode = aliasNode ?? nameNode;
        if (imported && localNode) {
          out.push({
            local: localNode.text,
            imported,
            module,
            syntax: 'esm',
            range: toRange(localNode),
          });
        }
      }
    } else if (child.type === 'namespace_import') {
      const localNode = child.namedChildren.find((c) => c?.type === 'identifier');
      if (localNode) {
        out.push({
          local: localNode.text,
          imported: '*',
          module,
          syntax: 'esm',
          range: toRange(localNode),
        });
      }
    }
  }
  return out;
}

/** Extract local->FQN bindings from a PHP `namespace_use_declaration`. */
function phpUseBindings(useDecl: TsNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  const clauses = useDecl.descendantsOfType(['namespace_use_clause', 'namespace_use_group_clause']);
  for (const clause of clauses) {
    const nameNode =
      clause.childForFieldName('name') ??
      clause.namedChildren.find((c) => c && /(qualified_name|name|namespace_name)/.test(c.type));
    if (!nameNode) continue;
    const fqn = nameNode.text;
    const aliasNode = clause.namedChildren.find((c) => c && c.type === 'namespace_aliasing_clause');
    const alias = aliasNode?.namedChildren.find((c) => c && /(name|identifier)/.test(c.type))?.text;
    out.push({
      local: alias ?? lastNamespaceSegment(fqn),
      imported: fqn,
      syntax: 'esm',
      range: toRange(clause),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function stringLiteralValue(node: TsNode | null | undefined): string | undefined {
  if (!node || node.type !== 'string') return undefined;
  return node.text.slice(1, -1);
}

function moduleCallSpecifier(call: TsNode): string | undefined {
  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildCount !== 1) return undefined;
  return stringLiteralValue(args.namedChild(0));
}

function assignedName(value: TsNode): { name: string; rangeNode: TsNode } | undefined {
  const parent = value.parent;
  if (parent?.type === 'variable_declarator') {
    const name = parent.childForFieldName('name');
    if (name?.type === 'identifier') return { name: name.text, rangeNode: parent };
  }
  if (parent?.type === 'assignment_expression') {
    const left = parent.childForFieldName('left');
    if (left?.type === 'identifier') return { name: left.text, rangeNode: parent };
  }
  return undefined;
}

function exportedDeclarationNames(declaration: TsNode): string[] {
  if (
    DEF_TYPES.ts.function.includes(declaration.type as never) ||
    DEF_TYPES.ts.class.includes(declaration.type as never)
  ) {
    const name = nameOf(declaration);
    return name ? [name] : [];
  }
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    return declaration.namedChildren.flatMap((child) => {
      if (child?.type !== 'variable_declarator') return [];
      const name = child.childForFieldName('name');
      return name?.type === 'identifier' ? [name.text] : [];
    });
  }
  return [];
}

function commonJsMember(
  left: TsNode
):
  | { kind: 'default'; exportedName: 'default' }
  | { kind: 'member'; exportedName: string }
  | { kind: 'computed' }
  | undefined {
  if (left.type === 'subscript_expression') {
    const object = left.childForFieldName('object');
    if (object?.text === 'exports' || object?.text === 'module.exports')
      return { kind: 'computed' };
    return undefined;
  }
  if (left.type !== 'member_expression') return undefined;
  const object = left.childForFieldName('object');
  const property = left.childForFieldName('property');
  if (object?.text === 'module' && property?.text === 'exports') {
    return { kind: 'default', exportedName: 'default' };
  }
  if (object?.text === 'exports' && property) {
    return { kind: 'member', exportedName: property.text };
  }
  if (object?.text === 'module.exports' && property) {
    return { kind: 'member', exportedName: property.text };
  }
  return undefined;
}

function requireBindings(call: TsNode, module: string): ImportBinding[] {
  const declarator = call.parent;
  if (
    declarator?.type !== 'variable_declarator' ||
    declarator.childForFieldName('value')?.id !== call.id
  ) {
    return [];
  }
  const name = declarator.childForFieldName('name');
  if (!name) return [];
  if (name.type === 'identifier') {
    return [
      { local: name.text, imported: 'default', module, syntax: 'commonjs', range: toRange(name) },
    ];
  }
  if (name.type !== 'object_pattern') return [];
  const bindings: ImportBinding[] = [];
  for (const child of name.namedChildren) {
    if (!child) continue;
    if (child.type === 'pair_pattern') {
      const importedNode = child.namedChildren[0];
      const localNode = child.childForFieldName('value');
      if (importedNode && localNode?.type === 'identifier') {
        bindings.push({
          local: localNode.text,
          imported: importedNode.text,
          module,
          syntax: 'commonjs',
          range: toRange(localNode),
        });
      }
    } else if (child.type === 'shorthand_property_identifier_pattern') {
      bindings.push({
        local: child.text,
        imported: child.text,
        module,
        syntax: 'commonjs',
        range: toRange(child),
      });
    }
  }
  return bindings;
}

function diagnostic(
  diagnostics: Array<{ code: string; message: string; range?: AstRange }>,
  node: TsNode,
  message: string
): void {
  diagnostics.push({ code: 'unsupported-dynamic-module', message, range: toRange(node) });
}

function extractTs(root: TsNode, file: string): Extraction {
  const nodes: AstNode[] = [];
  const edges: AstEdge[] = [];
  const imports: ImportBinding[] = [];
  const moduleFacts: ModuleSyntaxFact[] = [];
  const diagnostics: Array<{ code: string; message: string; range?: AstRange }> = [];
  const localDefs = new Set<string>();
  const moduleAliases = new Set<string>();
  const exportsAliases = new Set<string>();

  walk(root, (n) => {
    if (DEF_TYPES.ts.function.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'function', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.ts.method.includes(n.type as never)) {
      const container = enclosingTsClassName(n);
      if (container === undefined) return;
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'method', name, file, range: toRange(n), container });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.ts.class.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'class', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    } else if (/^(arrow_function|function_expression|function|class)$/.test(n.type)) {
      const assigned = assignedName(n);
      if (assigned) {
        const type = n.type === 'class' ? 'class' : 'function';
        nodes.push({ type, name: assigned.name, file, range: toRange(assigned.rangeNode) });
        localDefs.add(assigned.name);
      }
    }

    if (n.type === 'variable_declarator') {
      const name = n.childForFieldName('name');
      const value = n.childForFieldName('value');
      if (name?.type === 'identifier' && value?.text === 'module') moduleAliases.add(name.text);
      if (name?.type === 'identifier' && value?.text === 'exports') exportsAliases.add(name.text);
    }
  });

  // ESM declarations and re-exports.
  walk(root, (n) => {
    if (n.type === 'import_statement') {
      const source = n.childForFieldName('source');
      const specifier = stringLiteralValue(source);
      if (specifier === undefined) {
        diagnostic(diagnostics, n, 'Non-literal ESM import is unsupported');
        return;
      }
      edges.push({
        type: 'import',
        fromFile: file,
        toRaw: specifier,
        range: toRange(n),
        nameRange: toRange(source!),
      });
      const bindings = tsImportBindings(n, specifier);
      imports.push(...bindings);
      if (bindings.length === 0) {
        moduleFacts.push({ kind: 'esm-import', specifier, range: toRange(n) });
      } else {
        moduleFacts.push(
          ...bindings.map((binding) => ({
            kind: 'esm-import' as const,
            localName: binding.local,
            importedName: binding.imported,
            specifier,
            range: binding.range ?? toRange(n),
          }))
        );
      }
      return;
    }
    if (n.type !== 'export_statement') return;

    const source = n.childForFieldName('source');
    const specifier = source ? stringLiteralValue(source) : undefined;
    const declaration = n.childForFieldName('declaration');
    const value = n.childForFieldName('value');
    const clause = n.namedChildren.find((child) => child?.type === 'export_clause');
    const namespaceExport = n.namedChildren.find((child) => child?.type === 'namespace_export');
    const isDefault = /^export\s+default\b/.test(n.text);

    if (source && specifier === undefined) {
      diagnostic(diagnostics, n, 'Non-literal ESM re-export is unsupported');
      return;
    }
    if (specifier !== undefined) {
      edges.push({
        type: 'import',
        fromFile: file,
        toRaw: specifier,
        range: toRange(n),
        nameRange: toRange(source!),
      });
    }
    if (isDefault) {
      const localName = declaration ? (nameOf(declaration) ?? undefined) : value?.text;
      moduleFacts.push({
        kind: 'esm-export-default',
        ...(localName ? { localName } : {}),
        exportedName: 'default',
        range: toRange(n),
      });
      return;
    }
    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec?.type !== 'export_specifier') continue;
        const name = spec.childForFieldName('name');
        const alias = spec.childForFieldName('alias');
        if (!name) continue;
        moduleFacts.push({
          kind: specifier === undefined ? 'esm-export-named' : 'esm-reexport-named',
          localName: name.text,
          importedName: name.text,
          exportedName: alias?.text ?? name.text,
          ...(specifier === undefined ? {} : { specifier }),
          range: toRange(spec),
        });
      }
      return;
    }
    if (specifier !== undefined) {
      const exportedName = namespaceExport?.namedChildren[0]?.text;
      moduleFacts.push({
        kind: 'esm-reexport-all',
        ...(exportedName ? { exportedName } : {}),
        specifier,
        range: toRange(namespaceExport ?? n),
      });
      return;
    }
    if (declaration) {
      for (const name of exportedDeclarationNames(declaration)) {
        moduleFacts.push({
          kind: 'esm-export-named',
          localName: name,
          exportedName: name,
          range: toRange(declaration),
        });
      }
    }
  });

  // CommonJS imports/exports and dynamic-module diagnostics.
  walk(root, (n) => {
    if (n.type === 'call_expression') {
      const callee = n.childForFieldName('function');
      if (!callee) return;
      if (callee.text === 'require' || callee.type === 'import') {
        const specifier = moduleCallSpecifier(n);
        if (specifier === undefined) {
          diagnostic(
            diagnostics,
            n,
            callee.text === 'require'
              ? 'Non-literal require() is unsupported'
              : 'Non-literal dynamic import() is unsupported'
          );
          return;
        }
        edges.push({
          type: 'import',
          fromFile: file,
          toRaw: specifier,
          range: toRange(n),
          nameRange: toRange(n.childForFieldName('arguments')?.namedChild(0) ?? n),
        });
        if (callee.type === 'import') {
          moduleFacts.push({ kind: 'esm-import', specifier, range: toRange(n) });
          return;
        }
        const bindings = requireBindings(n, specifier);
        imports.push(...bindings);
        if (bindings.length === 0) {
          moduleFacts.push({ kind: 'commonjs-require', specifier, range: toRange(n) });
        } else {
          moduleFacts.push(
            ...bindings.map((binding) => ({
              kind: 'commonjs-require' as const,
              localName: binding.local,
              importedName: binding.imported,
              specifier,
              range: binding.range ?? toRange(n),
            }))
          );
        }
        return;
      }
      if (callee.text === 'eval') {
        diagnostic(diagnostics, n, 'eval() can mutate module state dynamically');
      } else if (callee.text === 'Object.assign') {
        const first = n.childForFieldName('arguments')?.namedChild(0)?.text;
        if (first === 'exports' || first === 'module.exports') {
          diagnostic(diagnostics, n, 'Runtime mutation of CommonJS exports is unsupported');
        }
      }
      return;
    }

    if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left');
      if (!left) return;
      const commonJs = commonJsMember(left);
      if (commonJs?.kind === 'computed') {
        diagnostic(diagnostics, n, 'Computed CommonJS export members are unsupported');
        return;
      }
      if (commonJs) {
        const right = n.childForFieldName('right');
        const localName = right?.type === 'identifier' ? right.text : undefined;
        moduleFacts.push({
          kind: commonJs.kind === 'default' ? 'commonjs-module-exports' : 'commonjs-exports-member',
          ...(localName ? { localName } : {}),
          exportedName: commonJs.exportedName,
          range: toRange(n),
        });
        return;
      }
      const object = left.childForFieldName('object');
      if (
        (object && (moduleAliases.has(object.text) || exportsAliases.has(object.text))) ||
        moduleAliases.has(left.text) ||
        exportsAliases.has(left.text)
      ) {
        diagnostic(diagnostics, n, 'Assignment through a module/exports alias is unsupported');
      }
      return;
    }

    if (n.type === 'augmented_assignment_expression' || n.type === 'update_expression') {
      if (/^(?:module\.exports|exports)(?:\.|\[)/.test(n.text)) {
        diagnostic(diagnostics, n, 'Runtime mutation of CommonJS exports is unsupported');
      }
    }
  });

  // Calls & constructions.
  walk(root, (n) => {
    if (n.type === 'call_expression') {
      const callee = n.childForFieldName('function');
      if (!callee) return;
      const calleeText = callee.text;
      // Module loaders and eval are facts/diagnostics, never direct call targets.
      if (calleeText === 'require' || callee.type === 'import' || calleeText === 'eval') return;
      if (callee.type === 'identifier') {
        const name = callee.text;
        const edge: AstEdge = {
          type: 'call',
          fromFile: file,
          toRaw: name,
          range: toRange(n),
          nameRange: toRange(callee),
          callKind: 'identifier',
          member: name,
        };
        if (localDefs.has(name)) {
          edge.resolvedSameFile = true;
          edge.toFile = file;
        }
        edges.push(edge);
      } else if (callee.type === 'member_expression') {
        const property = callee.childForFieldName('property');
        const object = callee.childForFieldName('object');
        const member = property?.text ?? callee.text;
        edges.push({
          type: 'call',
          fromFile: file,
          toRaw: callee.text,
          range: toRange(n),
          nameRange: toRange(property ?? callee),
          callKind: object?.type === 'this' ? 'this' : 'member',
          member,
        });
      } else {
        const member = callee.text.split(/[.?!]/).filter(Boolean).pop() ?? callee.text;
        edges.push({
          type: 'call',
          fromFile: file,
          toRaw: callee.text,
          range: toRange(n),
          nameRange: toRange(callee),
          callKind: 'member',
          member,
        });
      }
    } else if (n.type === 'new_expression') {
      const ctor = n.childForFieldName('constructor');
      if (ctor) {
        const raw = ctor.text;
        const edge: AstEdge = {
          type: 'new',
          fromFile: file,
          toRaw: raw,
          range: toRange(n),
          nameRange: toRange(ctor),
        };
        if (localDefs.has(raw)) {
          edge.resolvedSameFile = true;
          edge.toFile = file;
        }
        edges.push(edge);
      }
    }
  });

  return { nodes, edges, imports, moduleFacts, diagnostics };
}

function extractPhp(root: TsNode, file: string): Extraction {
  const nodes: AstNode[] = [];
  const edges: AstEdge[] = [];
  const imports: ImportBinding[] = [];
  const localDefs = new Set<string>();
  let namespace: string | undefined;
  // Every namespace statement, in source order; the global block `namespace { … }` is ''. Each
  // claims the definitions up to the next one, whether it is `namespace X;` or a block: PHP
  // allows no code between two blocks.
  const namespaces: Array<{ name: string; startByte: number }> = [];

  walk(root, (n) => {
    if (n.type === 'namespace_definition') {
      const nameNode =
        n.childForFieldName('name') ??
        n.namedChildren.find((c) => c && /namespace_name/.test(c.type));
      namespaces.push({ name: nameNode?.text ?? '', startByte: n.startIndex });
      if (!namespace && nameNode) namespace = nameNode.text;
    } else if (DEF_TYPES.php.function.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'function', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.php.method.includes(n.type as never)) {
      // Only named-class members are surfaced; anonymous-class (`new class {…}`)
      // methods have no stable FQN and would collide corpus-wide.
      const container = enclosingPhpClassName(n);
      if (container === undefined) return;
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'method', name, file, range: toRange(n), container });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.php.class.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'class', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    }
  });

  // A file with one namespace statement needs nothing more: Extraction.namespace covers every
  // definition. Otherwise each definition outside the first namespace records its own.
  if (namespaces.length > 1) {
    for (const def of nodes) {
      const owner = namespaces
        .filter((candidate) => candidate.startByte <= def.range.startByte)
        .at(-1);
      const declaredIn = owner?.name ?? '';
      if (declaredIn !== (namespace ?? '')) def.namespace = declaredIn;
    }
  }

  // `use` imports, including grouped uses.
  walk(root, (n) => {
    if (n.type === 'namespace_use_declaration') {
      imports.push(...phpUseBindings(n));
      const clauses = n.descendantsOfType(['namespace_use_clause', 'namespace_use_group_clause']);
      if (clauses.length > 0) {
        for (const clause of clauses) {
          const nameNode =
            clause.childForFieldName('name') ??
            clause.namedChildren.find(
              (c) => c && /(qualified_name|name|namespace_name)/.test(c.type)
            );
          if (nameNode) {
            edges.push({
              type: 'import',
              fromFile: file,
              toRaw: nameNode.text,
              range: toRange(clause),
            });
          }
        }
      } else {
        edges.push({
          type: 'import',
          fromFile: file,
          toRaw: n.text.replace(/^use\s+|;\s*$/g, ''),
          range: toRange(n),
        });
      }
    }
  });

  // Calls & object creation.
  walk(root, (n) => {
    if (n.type === 'function_call_expression') {
      // Bare call `foo()`: a same-file function or an import-bound name.
      const callee = n.childForFieldName('function') ?? n.namedChildren[0];
      if (!callee) return;
      const name = callee.text;
      const edge: AstEdge = {
        type: 'call',
        fromFile: file,
        toRaw: name,
        range: toRange(n),
        nameRange: toRange(callee),
        callKind: 'identifier',
        member: name,
      };
      if (localDefs.has(name)) {
        edge.resolvedSameFile = true;
        edge.toFile = file;
      }
      edges.push(edge);
    } else if (
      n.type === 'member_call_expression' ||
      n.type === 'nullsafe_member_call_expression' ||
      n.type === 'scoped_call_expression'
    ) {
      // `$this->m()` / `$this?->m()` / `self::m()` / `static::m()` resolve to a
      // same-class method; `$obj->m()` / `Foo::m()` / `parent::m()` are typed
      // receivers left for LSP.
      const nameNode = n.childForFieldName('name');
      if (!nameNode) return;
      const member = nameNode.text;
      let isThis: boolean;
      let receiverText: string;
      if (n.type === 'scoped_call_expression') {
        const scope = n.childForFieldName('scope');
        const scopeText = scope?.text ?? '';
        isThis = scopeText === 'self' || scopeText === 'static';
        receiverText = `${scopeText}::${member}`;
      } else {
        // member_call_expression / nullsafe_member_call_expression: `$recv->m()`
        const object = n.childForFieldName('object');
        isThis = object?.type === 'variable_name' && object.text === '$this';
        receiverText = `${object?.text ?? ''}->${member}`;
      }
      edges.push({
        type: 'call',
        fromFile: file,
        toRaw: receiverText,
        range: toRange(n),
        nameRange: toRange(nameNode),
        callKind: isThis ? 'this' : 'member',
        member,
      });
    } else if (n.type === 'object_creation_expression') {
      const ctor = n.namedChildren.find((c) => c && /(name|qualified_name)/.test(c.type));
      if (ctor) {
        const raw = ctor.text;
        const edge: AstEdge = { type: 'new', fromFile: file, toRaw: raw, range: toRange(n) };
        if (localDefs.has(raw)) {
          edge.resolvedSameFile = true;
          edge.toFile = file;
        }
        edges.push(edge);
      }
    }
  });

  return { nodes, edges, namespace, imports, moduleFacts: [], diagnostics: [] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the tree-sitter runtime and load all grammars once. */
export async function initGrammars(): Promise<Map<AstLang, Parser.Language>> {
  await Parser.init();
  const grammars = new Map<AstLang, Parser.Language>();
  for (const lang of Object.keys(GRAMMAR_WASM) as AstLang[]) {
    grammars.set(lang, await Parser.Language.load(GRAMMAR_WASM[lang]));
  }
  return grammars;
}

/** Load grammars once per process and reuse across calls (cached). */
let grammarsPromise: Promise<Map<AstLang, Parser.Language>> | undefined;
export function getGrammars(): Promise<Map<AstLang, Parser.Language>> {
  grammarsPromise ??= initGrammars();
  return grammarsPromise;
}

/**
 * Parse one source string and extract definition nodes + candidate edges.
 * `hadError` flags a partial parse (tree-sitter is error-tolerant, so partial
 * extractions are still returned).
 */
export function extractSource(
  grammars: Map<AstLang, Parser.Language>,
  source: string,
  relPath: string,
  lang: AstLang
): { extraction: Extraction; hadError: boolean } {
  const grammar = grammars.get(lang);
  if (!grammar) throw new Error(`No grammar loaded for language: ${lang}`);
  const parser = new Parser();
  // web-tree-sitter's Parser and Tree hold WASM heap the JS GC cannot reclaim;
  // both must be explicitly freed or a long-lived process (lux-mcp) leaks one
  // parser per parse across every rebuild.
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    if (!tree) {
      return {
        extraction: {
          nodes: [],
          edges: [],
          moduleFacts: [],
          diagnostics: [{ code: 'parse-error', message: 'tree-sitter returned no syntax tree' }],
        },
        hadError: true,
      };
    }
    try {
      const hadError = tree.rootNode.hasError;
      const extraction =
        lang === 'php' ? extractPhp(tree.rootNode, relPath) : extractTs(tree.rootNode, relPath);
      if (hadError) {
        const errorNodes: TsNode[] = [];
        walk(tree.rootNode, (node) => {
          if (node.isError || node.isMissing) errorNodes.push(node);
        });
        if (errorNodes.length === 0) errorNodes.push(tree.rootNode);
        extraction.diagnostics ??= [];
        extraction.diagnostics.push(
          ...errorNodes.map((node) => ({
            code: 'parse-error',
            message: node.isMissing
              ? `tree-sitter missing ${node.type}`
              : `tree-sitter syntax error at ${node.type}`,
            range: toRange(node),
          }))
        );
      }
      return { extraction, hadError };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
