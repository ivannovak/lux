import type { Node } from '@babel/types';
import type { SFCBlock, SFCParseResult } from '@vue/compiler-sfc';
import { vueSfcCompiler } from './compilers.js';
import type { SourceDiagnosticV1, SourceLocationV1 } from '../contracts/program.js';
import { sourceLocationAt } from './source-map.js';
import { extractVueTemplate } from './template-extract.js';
import type { VueEventFactV1, VueTemplateListenerV1 } from './types.js';

export interface VueEventExtractionV1 {
  events: VueEventFactV1[];
  listeners: VueTemplateListenerV1[];
  diagnostics: SourceDiagnosticV1[];
}

type BindingKind = 'ordinary' | 'macro-emit' | 'setup-emit' | 'setup-context';

interface Scope {
  parent?: Scope;
  bindings: Map<string, BindingKind>;
}

interface WalkContext {
  scope: Scope;
  scriptSetup: boolean;
  optionsThis: boolean;
}

interface EventCollector {
  filePath: string;
  source: string;
  block: SFCBlock;
  events: VueEventFactV1[];
  diagnostics: SourceDiagnosticV1[];
  optionFunctions: WeakSet<Node>;
  setupFunctions: WeakSet<Node>;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function nodeChildren(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc' ||
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments'
    )
      continue;
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) children.push(...value.filter(isNode));
  }
  return children;
}

function nodeStart(node: Node): number {
  return typeof node.start === 'number' ? node.start : 0;
}

function location(collector: EventCollector, node: Node): SourceLocationV1 {
  return sourceLocationAt(
    collector.filePath,
    collector.source,
    collector.block.loc.start.offset + nodeStart(node)
  );
}

function propertyName(node: Node | null | undefined, computed = false): string | undefined {
  if (!node || computed) return undefined;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return undefined;
}

function bindingNames(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'AssignmentPattern') return bindingNames(node.left);
  if (node.type === 'RestElement') return bindingNames(node.argument);
  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) => {
      if (property.type === 'RestElement') return bindingNames(property.argument);
      return bindingNames(property.value);
    });
  }
  if (node.type === 'ArrayPattern') return node.elements.flatMap((item) => bindingNames(item));
  return [];
}

function directBindings(statements: readonly Node[], parent?: Scope): Scope {
  const scope: Scope = { ...(parent ? { parent } : {}), bindings: new Map() };
  const bind = (name: string): void => {
    scope.bindings.set(name, 'ordinary');
  };
  for (const statement of statements) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) bind(specifier.local.name);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        for (const name of bindingNames(declaration.id)) bind(name);
      }
    } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      if (statement.id) bind(statement.id.name);
    }
  }
  return scope;
}

function resolveBinding(scope: Scope, name: string): BindingKind | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function isUnboundCall(node: Node | null | undefined, name: string, scope: Scope): boolean {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === name &&
    resolveBinding(scope, name) === undefined
  );
}

function staticString(node: Node | null | undefined): string | undefined {
  return node?.type === 'StringLiteral' && node.value.length > 0 ? node.value : undefined;
}

function addEvent(
  collector: EventCollector,
  eventName: string | undefined,
  source: VueEventFactV1['source'],
  node: Node
): void {
  if (!eventName) return;
  collector.events.push({ eventName, source, location: location(collector, node) });
}

function hasSpread(node: Node): boolean {
  return (
    (node.type === 'ArrayExpression' &&
      node.elements.some((item) => item?.type === 'SpreadElement')) ||
    (node.type === 'ObjectExpression' &&
      node.properties.some((item) => item.type === 'SpreadElement'))
  );
}

function runtimeDeclaration(
  collector: EventCollector,
  node: Node | null | undefined,
  source: 'defineEmits' | 'options-emits'
): void {
  if (!node || hasSpread(node)) return;
  if (node.type === 'ArrayExpression') {
    for (const element of node.elements) {
      if (element) addEvent(collector, staticString(element), source, element);
    }
    return;
  }
  if (node.type !== 'ObjectExpression') return;
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') return;
    const name = propertyName(property.key, property.computed);
    addEvent(collector, name, source, property.key);
  }
}

function literalTypeNames(node: Node | null | undefined): Array<{ name: string; node: Node }> {
  if (!node) return [];
  if (
    node.type === 'TSLiteralType' &&
    node.literal.type === 'StringLiteral' &&
    node.literal.value
  ) {
    return [{ name: node.literal.value, node: node.literal }];
  }
  if (node.type === 'TSUnionType') return node.types.flatMap((item) => literalTypeNames(item));
  return [];
}

function typeDeclaration(collector: EventCollector, call: Node): void {
  if (call.type !== 'CallExpression') return;
  const parameters =
    call.typeParameters?.type === 'TSTypeParameterInstantiation' ? call.typeParameters.params : [];
  const declaration = parameters[0];
  if (!declaration || declaration.type !== 'TSTypeLiteral') return;
  for (const member of declaration.members) {
    if (member.type === 'TSCallSignatureDeclaration') {
      const first = member.parameters[0];
      if (first?.type !== 'Identifier') continue;
      const annotation = first.typeAnnotation;
      if (!annotation || annotation.type !== 'TSTypeAnnotation') continue;
      for (const literal of literalTypeNames(annotation.typeAnnotation)) {
        addEvent(collector, literal.name, 'defineEmits', literal.node);
      }
    } else if (member.type === 'TSPropertySignature' || member.type === 'TSMethodSignature') {
      addEvent(collector, propertyName(member.key, member.computed), 'defineEmits', member.key);
    }
  }
}

type FunctionNode = Extract<
  Node,
  {
    type:
      | 'FunctionDeclaration'
      | 'FunctionExpression'
      | 'ArrowFunctionExpression'
      | 'ObjectMethod'
      | 'ClassMethod'
      | 'ClassPrivateMethod';
  }
>;

function isFunction(node: Node): node is FunctionNode {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'
  );
}

function functionParameters(node: Node): readonly Node[] {
  return isFunction(node) ? node.params : [];
}

function optionObject(node: Node, scope: Scope): Node | undefined {
  if (node.type !== 'ExportDefaultDeclaration') return undefined;
  if (node.declaration.type === 'ObjectExpression') return node.declaration;
  if (
    node.declaration.type === 'CallExpression' &&
    node.declaration.callee.type === 'Identifier' &&
    node.declaration.callee.name === 'defineComponent' &&
    resolveBinding(scope, 'defineComponent') === undefined
  ) {
    const first = node.declaration.arguments[0];
    return first?.type === 'ObjectExpression' ? first : undefined;
  }
  return undefined;
}

function prepareOptions(collector: EventCollector, object: Node): void {
  if (object.type !== 'ObjectExpression') return;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') continue;
    const name = propertyName(property.key, property.computed);
    if (name === 'emits' && property.type === 'ObjectProperty') {
      runtimeDeclaration(collector, property.value, 'options-emits');
    }
    const value =
      property.type === 'ObjectProperty' && isNode(property.value) ? property.value : property;
    if (isFunction(value)) {
      collector.optionFunctions.add(value);
      if (name === 'setup') collector.setupFunctions.add(value);
    }
    if (name === 'methods' && value.type === 'ObjectExpression') {
      for (const method of value.properties) {
        if (method.type === 'ObjectMethod') collector.optionFunctions.add(method);
        else if (method.type === 'ObjectProperty' && isFunction(method.value)) {
          collector.optionFunctions.add(method.value);
        }
      }
    }
  }
}

function establishSetupBindings(scope: Scope, node: Node): void {
  const context = functionParameters(node)[1];
  if (!context) return;
  if (context.type === 'Identifier') {
    scope.bindings.set(context.name, 'setup-context');
    return;
  }
  if (context.type !== 'ObjectPattern') return;
  for (const property of context.properties) {
    if (
      property.type !== 'ObjectProperty' ||
      property.computed ||
      propertyName(property.key) !== 'emit'
    )
      continue;
    if (property.value.type === 'Identifier') scope.bindings.set(property.value.name, 'setup-emit');
    else if (
      property.value.type === 'AssignmentPattern' &&
      property.value.left.type === 'Identifier'
    ) {
      scope.bindings.set(property.value.left.name, 'setup-emit');
    }
  }
}

function callEventName(node: Node, context: WalkContext): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const first = node.arguments[0];
  if (!first || first.type === 'SpreadElement' || first.type === 'ArgumentPlaceholder')
    return undefined;
  const eventName = staticString(first);
  if (!eventName) return undefined;
  if (node.callee.type === 'Identifier') {
    const kind = resolveBinding(context.scope, node.callee.name);
    if (kind === 'macro-emit' || kind === 'setup-emit') return eventName;
  }
  if (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'emit' &&
    node.callee.object.type === 'Identifier' &&
    resolveBinding(context.scope, node.callee.object.name) === 'setup-context'
  ) {
    return eventName;
  }
  if (
    context.optionsThis &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'ThisExpression' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === '$emit'
  ) {
    return eventName;
  }
  return undefined;
}

function walk(collector: EventCollector, node: Node, context: WalkContext): void {
  let current = context;
  if (node.type === 'Program') {
    current = { ...context, scope: directBindings(node.body) };
  } else if (node.type === 'BlockStatement') {
    current = { ...context, scope: directBindings(node.body, context.scope) };
  } else if (isFunction(node)) {
    const functionScope: Scope = { parent: context.scope, bindings: new Map() };
    for (const parameter of functionParameters(node)) {
      for (const name of bindingNames(parameter)) functionScope.bindings.set(name, 'ordinary');
    }
    if (collector.setupFunctions.has(node)) establishSetupBindings(functionScope, node);
    const isOptionFunction = collector.optionFunctions.has(node);
    current = {
      ...context,
      scope: functionScope,
      optionsThis:
        isOptionFunction || (node.type === 'ArrowFunctionExpression' && context.optionsThis),
    };
  }

  const options = optionObject(node, current.scope);
  if (options) prepareOptions(collector, options);

  if (
    current.scriptSetup &&
    node.type === 'VariableDeclarator' &&
    isUnboundCall(node.init, 'defineEmits', current.scope)
  ) {
    for (const name of bindingNames(node.id)) current.scope.bindings.set(name, 'macro-emit');
  }

  if (node.type === 'CallExpression') {
    if (isUnboundCall(node, 'defineEmits', current.scope) && current.scriptSetup) {
      const first = node.arguments[0];
      if (first && first.type !== 'SpreadElement' && first.type !== 'ArgumentPlaceholder') {
        runtimeDeclaration(collector, first, 'defineEmits');
      }
      typeDeclaration(collector, node);
    }
    if (isUnboundCall(node, 'defineModel', current.scope) && current.scriptSetup) {
      const first = node.arguments[0];
      if (!first) addEvent(collector, 'update:modelValue', 'model', node);
      else if (first.type !== 'SpreadElement' && first.type !== 'ArgumentPlaceholder') {
        const name = staticString(first);
        if (name) addEvent(collector, `update:${name}`, 'model', first);
      }
    }
    addEvent(collector, callEventName(node, current), 'emit-call', node);
  }

  for (const child of nodeChildren(node)) walk(collector, child, current);
}

function parseScript(collector: EventCollector, scriptSetup: boolean): void {
  const language = (collector.block.lang ?? 'js').toLowerCase();
  const plugins: Array<'typescript' | 'jsx' | 'decorators-legacy'> = ['decorators-legacy'];
  if (language === 'ts' || language === 'typescript' || language === 'tsx')
    plugins.push('typescript');
  if (language === 'jsx' || language === 'tsx') plugins.push('jsx');
  try {
    const ast = vueSfcCompiler().babelParse(collector.block.content, {
      sourceType: 'module',
      errorRecovery: false,
      plugins,
    });
    walk(collector, ast.program, {
      scope: { bindings: new Map() },
      scriptSetup,
      optionsThis: false,
    });
  } catch (error) {
    collector.diagnostics.push({
      code: 'vue-event-script-parse-error',
      message: error instanceof Error ? error.message : 'Vue event script parsing failed.',
      location: sourceLocationAt(
        collector.filePath,
        collector.source,
        collector.block.loc.start.offset
      ),
    });
  }
}

function sortedEvents(events: readonly VueEventFactV1[]): VueEventFactV1[] {
  return [...events].sort((left, right) =>
    [left.location.filePath, left.location.line, left.location.column, left.eventName, left.source]
      .join('\0')
      .localeCompare(
        [
          right.location.filePath,
          right.location.line,
          right.location.column,
          right.eventName,
          right.source,
        ].join('\0')
      )
  );
}

/** Extract only statically proven Vue component event declarations, emissions, and listeners. */
export function extractVueEvents(source: string, filePath: string): VueEventExtractionV1 {
  const events: VueEventFactV1[] = [];
  const listeners: VueTemplateListenerV1[] = [];
  const diagnostics: SourceDiagnosticV1[] = [];
  let parsed: SFCParseResult;
  try {
    parsed = vueSfcCompiler().parse(source, { filename: filePath, sourceMap: false });
  } catch (error) {
    // lux-intentional-swallow: returned as a diagnostic, which the caller reports.
    return {
      events,
      listeners,
      diagnostics: [
        {
          code: 'vue-event-sfc-parse-error',
          message: error instanceof Error ? error.message : 'Vue SFC event parsing failed.',
          location: sourceLocationAt(filePath, source, 0),
        },
      ],
    };
  }
  if (parsed.errors.length > 0) {
    return {
      events,
      listeners,
      diagnostics: parsed.errors.map((error) => ({
        code: 'vue-event-sfc-parse-error',
        message: typeof error === 'string' ? error : error.message,
        location: sourceLocationAt(filePath, source, 0),
      })),
    };
  }

  for (const [block, scriptSetup] of [
    [parsed.descriptor.script, false],
    [parsed.descriptor.scriptSetup, true],
  ] as const) {
    if (!block || block.src) continue;
    const collector: EventCollector = {
      filePath,
      source,
      block,
      events,
      diagnostics,
      optionFunctions: new WeakSet(),
      setupFunctions: new WeakSet(),
    };
    parseScript(collector, scriptSetup);
  }

  const template = parsed.descriptor.template;
  if (template && !template.src && (!template.lang || template.lang.toLowerCase() === 'html')) {
    const extracted = extractVueTemplate(
      filePath,
      source,
      template.loc.start.offset,
      template.content,
      {
        maxNodes: 100_000,
        maxDepth: 128,
        maxReferences: 10_000,
      }
    );
    listeners.push(...extracted.listeners);
    diagnostics.push(...extracted.diagnostics);
  }

  return {
    events: sortedEvents(events),
    listeners: [...listeners].sort((left, right) =>
      [
        left.location.filePath,
        left.location.line,
        left.location.column,
        left.childTag,
        left.eventName,
      ]
        .join('\0')
        .localeCompare(
          [
            right.location.filePath,
            right.location.line,
            right.location.column,
            right.childTag,
            right.eventName,
          ].join('\0')
        )
    ),
    diagnostics,
  };
}
