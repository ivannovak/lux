import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AliasRuleV1, SourceDiagnosticV1 } from '../contracts/program.js';
import { DEFAULT_PARSER_LIMITS } from '../adapters/types.js';
import { runBoundedExtractionWorker } from '../adapters/worker-host.js';
import { normalizeRepositoryPath } from './candidates.js';
import {
  canonicalizeConfigRoots,
  readConfinedConfigFile,
  type ConfinedRootsV1,
} from './config-discovery.js';

export interface ViteAliasResultV1 {
  rules: AliasRuleV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

type TokenKind = 'identifier' | 'string' | 'number' | 'punctuation' | 'dynamic' | 'eof';
interface Token {
  kind: TokenKind;
  text: string;
  offset: number;
}

type Expression =
  | { kind: 'string'; value: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'member'; object: Expression; property: string; computed: boolean }
  | { kind: 'call'; callee: Expression; arguments: Expression[] }
  | { kind: 'object'; entries: Array<{ key: string; value: Expression }>; unsafe: boolean }
  | { kind: 'array'; items: Expression[]; unsafe: boolean }
  | { kind: 'arrow'; body: Expression }
  | { kind: 'dynamic' };

type StaticValue = string | StaticObject | StaticValue[];
interface StaticObject {
  [key: string]: StaticValue;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
const IDENTIFIER_START = /[A-Za-z_$]/u;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/u;
const DYNAMIC_KEYWORDS = new Set([
  'function',
  'new',
  'await',
  'yield',
  'class',
  'delete',
  'typeof',
  'void',
]);

function sourceDiagnostic(
  code: string,
  message: string,
  filePath: string,
  source?: string,
  offset = 0
): SourceDiagnosticV1 {
  if (!source) return { code, message, location: { filePath, line: 1, column: 0 } };
  const preceding = source.slice(0, offset).split(/\r\n|\n|\r/u);
  return {
    code,
    message,
    location: {
      filePath,
      line: preceding.length,
      column: preceding.at(-1)?.length ?? 0,
    },
  };
}

function stripIgnoredPluginEntry(expression: Expression): Expression {
  if (expression.kind === 'arrow') {
    return { ...expression, body: stripIgnoredPluginEntry(expression.body) };
  }
  if (expression.kind === 'call') {
    return { ...expression, arguments: expression.arguments.map(stripIgnoredPluginEntry) };
  }
  if (expression.kind !== 'object') return expression;
  const entries = expression.entries.map((entry) =>
    entry.key === 'plugins'
      ? { key: entry.key, value: { kind: 'array' as const, items: [], unsafe: false } }
      : entry
  );
  return { ...expression, entries };
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}

function decodeQuoted(source: string, start: number): { value?: string; end: number } {
  const quote = source[start];
  let raw = quote;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    raw += character;
    if (character === '\\') {
      index += 1;
      if (index >= source.length) return { end: source.length };
      raw += source[index];
      continue;
    }
    if (character === quote) {
      try {
        // JSON.parse handles double quoted JavaScript strings. Single quotes need a deliberately
        // small decoder so octal, line continuation, and executable escapes are never accepted.
        if (quote === '"') return { value: JSON.parse(raw) as string, end: index + 1 };
        const body = raw.slice(1, -1);
        let value = '';
        for (let item = 0; item < body.length; item += 1) {
          if (body[item] !== '\\') {
            value += body[item];
            continue;
          }
          item += 1;
          const escaped = body[item];
          const simple: Record<string, string> = {
            "'": "'",
            '"': '"',
            '\\': '\\',
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            f: '\f',
            v: '\v',
            '0': '\0',
          };
          if (escaped in simple) value += simple[escaped];
          else if (escaped === 'u' && /^[\da-fA-F]{4}$/u.test(body.slice(item + 1, item + 5))) {
            value += String.fromCharCode(Number.parseInt(body.slice(item + 1, item + 5), 16));
            item += 4;
          } else if (escaped === 'x' && /^[\da-fA-F]{2}$/u.test(body.slice(item + 1, item + 3))) {
            value += String.fromCharCode(Number.parseInt(body.slice(item + 1, item + 3), 16));
            item += 2;
          } else return { end: index + 1 };
        }
        return { value, end: index + 1 };
      } catch {
        // lux-intentional-swallow: an escape that does not decode leaves the literal unparsed, as a miss.
        return { end: index + 1 };
      }
    }
    if (character === '\n' || character === '\r') return { end: index };
  }
  return { end: source.length };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const decoded = decodeQuoted(source, index);
      tokens.push({
        kind: decoded.value === undefined ? 'dynamic' : 'string',
        text: decoded.value ?? '',
        offset: index,
      });
      index = decoded.end;
      continue;
    }
    if (character === '`' || (character === '/' && source[index + 1] !== '=')) {
      // Templates (even without substitutions) and regular expressions are outside the whitelist.
      const delimiter = character;
      let end = index + 1;
      let escaped = false;
      while (end < source.length) {
        if (!escaped && source[end] === delimiter) {
          end += 1;
          break;
        }
        escaped = !escaped && source[end] === '\\';
        if (source[end] !== '\\') escaped = false;
        end += 1;
      }
      tokens.push({ kind: 'dynamic', text: source.slice(index, end), offset: index });
      index = end;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
      tokens.push({ kind: 'identifier', text: source.slice(index, end), offset: index });
      index = end;
      continue;
    }
    if (/\d/u.test(character)) {
      let end = index + 1;
      while (end < source.length && /[\d.eE_xobA-Fa-f]/u.test(source[end])) end += 1;
      tokens.push({ kind: 'number', text: source.slice(index, end), offset: index });
      index = end;
      continue;
    }
    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (three === '...') {
      tokens.push({ kind: 'dynamic', text: three, offset: index });
      index += 3;
      continue;
    }
    if (two === '=>') {
      tokens.push({ kind: 'punctuation', text: two, offset: index });
      index += 2;
      continue;
    }
    tokens.push({ kind: 'punctuation', text: character, offset: index });
    index += 1;
  }
  tokens.push({ kind: 'eof', text: '', offset: source.length });
  return tokens;
}

class DataParser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  take(text?: string): Token | undefined {
    const token = this.current();
    if (text !== undefined && token.text !== text) return undefined;
    this.index += 1;
    return token;
  }

  skipStatement(): void {
    let depth = 0;
    while (this.current().kind !== 'eof') {
      const text = this.take()?.text;
      if (text === '{' || text === '(' || text === '[') depth += 1;
      else if (text === '}' || text === ')' || text === ']') depth -= 1;
      else if (text === ';' && depth <= 0) return;
      if (depth < 0) return;
    }
  }

  expression(): Expression {
    if (this.current().kind === 'dynamic' || DYNAMIC_KEYWORDS.has(this.current().text)) {
      this.take();
      return { kind: 'dynamic' };
    }
    let value = this.primary();
    while (true) {
      if (this.take('.')) {
        const property = this.take();
        if (!property || property.kind !== 'identifier') return { kind: 'dynamic' };
        value = { kind: 'member', object: value, property: property.text, computed: false };
        continue;
      }
      if (this.take('[')) {
        this.expression();
        this.take(']');
        value = { kind: 'member', object: value, property: '', computed: true };
        continue;
      }
      if (this.take('(')) {
        const arguments_: Expression[] = [];
        while (this.current().kind !== 'eof' && this.current().text !== ')') {
          arguments_.push(this.expression());
          if (!this.take(',')) break;
        }
        if (!this.take(')')) return { kind: 'dynamic' };
        value = { kind: 'call', callee: value, arguments: arguments_ };
        continue;
      }
      break;
    }
    if (this.take('=>')) return { kind: 'arrow', body: this.arrowBody() };
    if (['?', '&&', '||', '??'].includes(this.current().text)) {
      this.take();
      return { kind: 'dynamic' };
    }
    return value;
  }

  private arrowBody(): Expression {
    if (!this.take('{')) return this.expression();
    let returned: Expression | undefined;
    let depth = 1;
    while (this.current().kind !== 'eof' && depth > 0) {
      if (depth === 1 && this.current().text === 'return') {
        this.take();
        returned = this.expression();
        this.take(';');
        continue;
      }
      const token = this.take();
      if (token?.text === '{') depth += 1;
      else if (token?.text === '}') depth -= 1;
    }
    return returned ?? { kind: 'dynamic' };
  }

  private primary(): Expression {
    const token = this.current();
    if (token.kind === 'string') {
      this.take();
      return { kind: 'string', value: token.text };
    }
    if (token.kind === 'identifier') {
      this.take();
      // A single arrow parameter is syntactic data, never called.
      if (this.take('=>')) return { kind: 'arrow', body: this.arrowBody() };
      return { kind: 'identifier', name: token.text };
    }
    if (this.take('(')) {
      if (this.take(')')) {
        if (!this.take('=>')) return { kind: 'dynamic' };
        return { kind: 'arrow', body: this.arrowBody() };
      }
      const nested = this.expression();
      if (!this.take(')')) return { kind: 'dynamic' };
      if (this.take('=>')) return { kind: 'arrow', body: this.arrowBody() };
      return nested;
    }
    if (this.take('{')) return this.object();
    if (this.take('[')) return this.array();
    this.take();
    return { kind: 'dynamic' };
  }

  private object(): Expression {
    const entries: Array<{ key: string; value: Expression }> = [];
    let unsafe = false;
    while (this.current().kind !== 'eof' && this.current().text !== '}') {
      if (this.current().kind === 'dynamic' || this.current().text === '[') {
        unsafe = true;
        this.skipObjectItem();
      } else {
        const key = this.take();
        if (!key || (key.kind !== 'identifier' && key.kind !== 'string')) {
          unsafe = true;
          this.skipObjectItem();
        } else if (this.take(':')) {
          entries.push({ key: key.text, value: this.expression() });
        } else {
          // Object shorthand is a static local-constant lookup.
          entries.push({ key: key.text, value: { kind: 'identifier', name: key.text } });
        }
      }
      if (!this.take(',') && this.current().text !== '}') unsafe = true;
    }
    if (!this.take('}')) unsafe = true;
    return { kind: 'object', entries, unsafe };
  }

  private skipObjectItem(): void {
    let depth = 0;
    while (this.current().kind !== 'eof') {
      const text = this.current().text;
      if (depth === 0 && (text === ',' || text === '}')) return;
      this.take();
      if (text === '{' || text === '(' || text === '[') depth += 1;
      if (text === '}' || text === ')' || text === ']') depth -= 1;
    }
  }

  private array(): Expression {
    const items: Expression[] = [];
    let unsafe = false;
    while (this.current().kind !== 'eof' && this.current().text !== ']') {
      if (this.current().kind === 'dynamic') unsafe = true;
      items.push(this.expression());
      if (!this.take(',') && this.current().text !== ']') unsafe = true;
    }
    if (!this.take(']')) unsafe = true;
    return { kind: 'array', items, unsafe };
  }
}

function staticResolveProjection(source: string): string | undefined {
  const exportStart = source.indexOf('export default');
  const resolveStart = source.indexOf('resolve:', exportStart);
  if (exportStart < 0 || resolveStart < 0) return undefined;
  const aliasStart = source.indexOf('alias:', resolveStart + 'resolve:'.length);
  if (aliasStart < 0) return undefined;
  const objectStart = source.indexOf('{', aliasStart + 'alias:'.length);
  if (objectStart < 0) return undefined;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (!quote && character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (!quote && character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (quote) {
      if (!escaped && character === quote) quote = '';
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      return `const projectRoot = process.cwd(); export default { resolve: { alias: ${source.slice(objectStart, index + 1)} } };`;
    }
  }
  return undefined;
}

function parseModule(tokens: readonly Token[]): {
  constants: Map<string, Expression>;
  exported?: Expression;
} {
  const parser = new DataParser(tokens);
  const constants = new Map<string, Expression>();
  let exported: Expression | undefined;
  while (parser.current().kind !== 'eof') {
    if (parser.current().text === 'import') {
      parser.skipStatement();
      continue;
    }
    if (parser.current().text === 'const') {
      parser.take();
      const name = parser.take();
      if (name?.kind === 'identifier' && parser.take('=')) {
        constants.set(name.text, parser.expression());
      } else parser.skipStatement();
      parser.take(';');
      continue;
    }
    if (parser.current().text === 'export') {
      parser.take();
      if (parser.take('default')) exported = parser.expression();
      else parser.skipStatement();
      parser.take(';');
      continue;
    }
    parser.skipStatement();
  }
  return { constants, ...(exported ? { exported } : {}) };
}

function memberName(expression: Expression): string | undefined {
  if (expression.kind === 'identifier') return expression.name;
  if (expression.kind !== 'member' || expression.computed) return undefined;
  const parent = memberName(expression.object);
  return parent ? `${parent}.${expression.property}` : undefined;
}

function evaluate(
  expression: Expression,
  constants: ReadonlyMap<string, Expression>,
  configDirectory: string,
  rootPath: string,
  stack = new Set<string>()
): StaticValue | undefined {
  if (expression.kind === 'string') return expression.value;
  if (expression.kind === 'identifier') {
    if (expression.name === '__dirname') return configDirectory;
    const value = constants.get(expression.name);
    if (!value || stack.has(expression.name)) return undefined;
    const nestedStack = new Set(stack).add(expression.name);
    return evaluate(value, constants, configDirectory, rootPath, nestedStack);
  }
  if (expression.kind === 'member') {
    return memberName(expression) === 'import.meta.dirname' ? configDirectory : undefined;
  }
  if (expression.kind === 'arrow') {
    // Syntactic traversal only: this does not invoke user code.
    return evaluate(expression.body, constants, configDirectory, rootPath, stack);
  }
  if (expression.kind === 'array') {
    if (expression.unsafe) return undefined;
    const result: StaticValue[] = [];
    for (const item of expression.items) {
      const value = evaluate(item, constants, configDirectory, rootPath, stack);
      if (value === undefined) return undefined;
      result.push(value);
    }
    return result;
  }
  if (expression.kind === 'object') {
    if (expression.unsafe) return undefined;
    const result: StaticObject = {};
    for (const entry of expression.entries) {
      if (Object.hasOwn(result, entry.key)) return undefined;
      const value = evaluate(entry.value, constants, configDirectory, rootPath, stack);
      if (value === undefined) return undefined;
      result[entry.key] = value;
    }
    return result;
  }
  if (expression.kind !== 'call') return undefined;
  const callee = memberName(expression.callee);
  if (callee === 'defineConfig' && expression.arguments.length === 1) {
    return evaluate(expression.arguments[0], constants, configDirectory, rootPath, stack);
  }
  if (callee === 'process.cwd' && expression.arguments.length === 0) return rootPath;
  if (!['resolve', 'path.resolve', 'join', 'path.join'].includes(callee ?? '')) return undefined;
  const arguments_: string[] = [];
  for (const argument of expression.arguments) {
    const value = evaluate(argument, constants, configDirectory, rootPath, stack);
    if (typeof value !== 'string') return undefined;
    arguments_.push(value);
  }
  if (arguments_.length === 0) return undefined;
  const base = isAbsolute(arguments_[0]) ? arguments_[0] : rootPath;
  const pieces = isAbsolute(arguments_[0]) ? arguments_.slice(1) : arguments_;
  return resolve(base, ...pieces);
}

function isObject(value: StaticValue | undefined): value is StaticObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function targetHasSources(target: string, sourceFiles: ReadonlySet<string>): boolean {
  return (
    sourceFiles.has(target) ||
    [...sourceFiles].some((file) => file.startsWith(`${target}/`) || file.startsWith(`${target}.`))
  );
}

function aliasesFromValue(
  root: StaticObject,
  configFile: string,
  roots: ConfinedRootsV1,
  sourceFiles: ReadonlySet<string>,
  diagnostics: SourceDiagnosticV1[]
): AliasRuleV1[] {
  // Plugins are intentionally not interpreted. They are outside the alias subtree, so retain a
  // diagnostic while continuing to consume only the independently static resolve.alias value.
  if (Object.hasOwn(root, 'plugins')) {
    diagnostics.push(
      sourceDiagnostic(
        'vite-alias-dynamic',
        'Vite plugins were ignored; only static resolve.alias data was consumed.',
        configFile
      )
    );
  }
  const resolveSection = root.resolve;
  if (!isObject(resolveSection) || resolveSection.alias === undefined) return [];
  const rawAliases = resolveSection.alias;
  const entries: Array<{ find: string; replacement: string }> = [];
  if (isObject(rawAliases)) {
    for (const [find, replacement] of Object.entries(rawAliases)) {
      if (typeof replacement !== 'string') {
        diagnostics.push(
          sourceDiagnostic(
            'vite-alias-dynamic',
            `Vite alias ${JSON.stringify(find)} is not a static string.`,
            configFile
          )
        );
        continue;
      }
      entries.push({ find, replacement });
    }
  } else if (Array.isArray(rawAliases)) {
    for (const entry of rawAliases) {
      if (
        !isObject(entry) ||
        typeof entry.find !== 'string' ||
        typeof entry.replacement !== 'string' ||
        Object.keys(entry).some((key) => key !== 'find' && key !== 'replacement')
      ) {
        diagnostics.push(
          sourceDiagnostic(
            'vite-alias-dynamic',
            'Vite alias array entries require only string find/replacement.',
            configFile
          )
        );
        continue;
      }
      entries.push({ find: entry.find, replacement: entry.replacement });
    }
  } else {
    diagnostics.push(
      sourceDiagnostic(
        'vite-alias-dynamic',
        'resolve.alias must be an object or ordered array.',
        configFile
      )
    );
    return [];
  }

  const rules: AliasRuleV1[] = [];
  for (const [index, entry] of entries.entries()) {
    if (
      entry.find.length === 0 ||
      entry.find.includes('*') ||
      hasControlCharacter(entry.find) ||
      hasControlCharacter(entry.replacement)
    ) {
      diagnostics.push(
        sourceDiagnostic(
          'vite-alias-dynamic',
          'Vite alias contains an unsafe or unsupported string.',
          configFile
        )
      );
      continue;
    }
    const absoluteTarget = isAbsolute(entry.replacement)
      ? resolve(entry.replacement)
      : resolve(configFile, '..', entry.replacement);
    if (
      !isWithin(roots.rootPath, absoluteTarget) ||
      !roots.allowedRoots.some((item) => isWithin(item, absoluteTarget))
    ) {
      diagnostics.push(
        sourceDiagnostic(
          'vite-alias-path-escape',
          `Vite alias ${JSON.stringify(entry.find)} escapes the allowed root.`,
          configFile
        )
      );
      continue;
    }
    const target = normalizeRepositoryPath(
      relative(roots.rootPath, absoluteTarget).replaceAll('\\', '/')
    );
    if (target === null || !targetHasSources(target, sourceFiles)) {
      diagnostics.push(
        sourceDiagnostic(
          'vite-alias-target-missing',
          `Vite alias ${JSON.stringify(entry.find)} has no scanned source target.`,
          configFile
        )
      );
      continue;
    }
    rules.push({
      pattern: entry.find,
      targets: [target],
      source: 'vite',
      configFile,
      // Preserve array order while keeping Vite behind all tsconfig ranks.
      precedence: 20_000 + index,
    });
  }
  return rules;
}

/** Parse Vite aliases as inert syntax after the bounded Phase 6 worker accepts the file. */
export async function parseViteAliases(
  viteFiles: readonly string[],
  rootPath: string,
  allowedRoots: readonly string[],
  sourceFiles: ReadonlySet<string>
): Promise<ViteAliasResultV1> {
  const roots = await canonicalizeConfigRoots(rootPath, allowedRoots);
  if (!roots) {
    return {
      rules: [],
      dependencies: [],
      diagnostics: [
        sourceDiagnostic('vite-root-invalid', 'Vite root or allowed roots are invalid.', rootPath),
      ],
    };
  }
  const dependencies = new Set<string>();
  const diagnostics: SourceDiagnosticV1[] = [];
  const rules: AliasRuleV1[] = [];

  for (const viteFile of [...new Set(viteFiles)].sort()) {
    const read = await readConfinedConfigFile(viteFile, roots);
    if (!read) {
      diagnostics.push(
        sourceDiagnostic(
          'vite-alias-path-escape',
          'Vite config is symlinked, unreadable, or outside the allowed root.',
          viteFile
        )
      );
      continue;
    }
    dependencies.add(read.filePath);
    const bounded = await runBoundedExtractionWorker({
      schemaVersion: 1,
      adapterId: 'vite-config-static-data',
      input: {
        corpusRoot: roots.rootPath,
        allowedRoots: roots.allowedRoots,
        filePath: read.filePath,
        limits: DEFAULT_PARSER_LIMITS,
      },
    });
    if (!bounded.response.ok || !bounded.extraction) {
      const failure = bounded.response.ok ? undefined : bounded.response.diagnostic;
      diagnostics.push(
        sourceDiagnostic(
          failure?.code ?? 'vite-alias-dynamic',
          failure?.message ?? 'Vite config did not produce a bounded AST.',
          read.filePath
        )
      );
      continue;
    }
    if (bounded.extraction.diagnostics?.some((item) => item.code === 'parse-error')) {
      diagnostics.push(
        sourceDiagnostic('vite-alias-dynamic', 'Malformed Vite config was refused.', read.filePath)
      );
      continue;
    }

    let module = parseModule(tokenize(read.source));
    if (!module.exported) {
      const projection = staticResolveProjection(read.source);
      if (projection) module = parseModule(tokenize(projection));
    }
    if (!module.exported) {
      diagnostics.push(
        sourceDiagnostic(
          'vite-alias-dynamic',
          'Vite config has no static default export.',
          read.filePath
        )
      );
      continue;
    }
    const evaluated = evaluate(
      stripIgnoredPluginEntry(module.exported),
      module.constants,
      resolve(read.filePath, '..'),
      roots.rootPath
    );
    if (!isObject(evaluated)) {
      const projection = staticResolveProjection(read.source);
      if (projection) {
        const projected = parseModule(tokenize(projection));
        if (projected.exported) {
          const value = evaluate(
            projected.exported,
            new Map([...module.constants, ...projected.constants]),
            resolve(read.filePath, '..'),
            roots.rootPath
          );
          if (isObject(value)) {
            rules.push(...aliasesFromValue(value, read.filePath, roots, sourceFiles, diagnostics));
            continue;
          }
        }
      }
      diagnostics.push(
        sourceDiagnostic(
          'vite-alias-dynamic',
          'Vite config default export is outside the static subset.',
          read.filePath
        )
      );
      continue;
    }
    rules.push(...aliasesFromValue(evaluated, read.filePath, roots, sourceFiles, diagnostics));
  }

  return {
    rules,
    dependencies: [...dependencies].sort(),
    diagnostics,
  };
}
