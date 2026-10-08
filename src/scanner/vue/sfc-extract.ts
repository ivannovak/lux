import { posix } from 'node:path';
import type { SFCBlock, SFCParseResult } from '@vue/compiler-sfc';
import { vueSfcCompiler } from './compilers.js';
import Parser from 'web-tree-sitter';
import {
  extractSource,
  getGrammars,
  type AstLang,
  type AstRange,
  type Extraction,
  type ModuleSyntaxFact,
} from '../ast/extract.js';
import type { ParserLimitsV1 } from '../adapters/types.js';
import { DEFAULT_PARSER_LIMITS } from '../adapters/types.js';
import type {
  DeclarationFactV1,
  ReferenceFactV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../contracts/program.js';
import { vueComponentId } from '../identity/program-identity.js';
import { mapScriptByteOffset, sourceLocationAt } from './source-map.js';
import { extractVueTemplate } from './template-extract.js';
import type {
  VueCallFactV1,
  VueEventFactV1,
  VueImportBindingV1,
  VueSfcFactsV1,
  VueStoreDeclarationV1,
} from './types.js';

export interface VueSfcExtractOptionsV1 {
  limits?: Partial<ParserLimitsV1>;
  grammars?: Map<AstLang, Parser.Language>;
  /** Accepted as a parity seam. Deterministic extraction deliberately never reads it. */
  lspEnabled?: boolean;
}

interface ScriptBlockFacts {
  declarations: DeclarationFactV1[];
  references: ReferenceFactV1[];
  diagnostics: SourceDiagnosticV1[];
  imports: VueImportBindingV1[];
  calls: VueCallFactV1[];
  stores: VueStoreDeclarationV1[];
  events: VueEventFactV1[];
  optionsComponents: Record<string, string>;
  syntaxNodes: number;
}

function emptyFacts(filePath: string, diagnostics: SourceDiagnosticV1[] = []): VueSfcFactsV1 {
  return {
    schemaVersion: 1,
    languageId: 'vue',
    filePath,
    componentId: vueComponentId(filePath),
    declarations: [],
    references: [],
    diagnostics,
    imports: [],
    optionsComponents: {},
    templateElements: [],
    templateListeners: [],
    calls: [],
    stores: [],
    events: [],
    compilerDiagnostics: [],
  };
}

function safeRepositoryPath(filePath: string): boolean {
  if (
    filePath.length === 0 ||
    filePath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(filePath) ||
    [...filePath].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return false;
  }
  const normalized = posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//u, '');
  return normalized !== '..' && !normalized.startsWith('../');
}

function rangeLocation(
  filePath: string,
  sfcSource: string,
  block: SFCBlock,
  range: AstRange
): SourceLocationV1 {
  return mapScriptByteOffset(
    filePath,
    sfcSource,
    block.loc.start.offset,
    block.content,
    range.startByte
  );
}

function diagnosticAt(
  filePath: string,
  sfcSource: string,
  code: string,
  message: string,
  offset = 0
): SourceDiagnosticV1 {
  return { code, message, location: sourceLocationAt(filePath, sfcSource, offset) };
}

function compilerDiagnostic(
  error: SyntaxError & { code?: string | number; loc?: { start: { offset: number } } },
  filePath: string,
  source: string
): SourceDiagnosticV1 {
  return {
    code: `vue-sfc-${String(error.code ?? 'parse-error')}`,
    message: error.message,
    ...(error.loc
      ? { location: sourceLocationAt(filePath, source, error.loc.start.offset) }
      : { location: sourceLocationAt(filePath, source, 0) }),
  };
}

function scriptLanguage(block: SFCBlock): AstLang | undefined {
  switch ((block.lang ?? 'js').toLowerCase()) {
    case 'js':
    case 'javascript':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'ts':
    case 'typescript':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    default:
      return undefined;
  }
}

function moduleReference(filePath: string, fact: ModuleSyntaxFact, location: SourceLocationV1) {
  const importing = fact.kind === 'esm-import' || fact.kind === 'commonjs-require';
  return {
    fromLocalId: `file:${filePath}`,
    kind: importing ? ('import' as const) : ('export' as const),
    rawTarget: fact.specifier ?? fact.exportedName ?? fact.localName ?? '',
    ...(fact.importedName ? { member: fact.importedName } : {}),
    location,
  };
}

function enclosingDeclaration(extraction: Extraction, byte: number, filePath: string): string {
  const candidates = extraction.nodes.filter(
    (node) => node.range.startByte <= byte && byte < node.range.endByte
  );
  candidates.sort(
    (left, right) =>
      left.range.endByte - left.range.startByte - (right.range.endByte - right.range.startByte)
  );
  const winner = candidates[0];
  if (!winner) return `file:${filePath}`;
  return winner.type === 'method' && winner.container
    ? `${winner.container}.${winner.name}`
    : winner.name;
}

function staticFirstString(callSource: string): string | undefined {
  const match = callSource.match(/^[^(]*\(\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/u);
  if (!match?.[2]) return undefined;
  return match[2].replace(/\\(['"\\])/gu, '$1');
}

function scriptSliceAt(block: SFCBlock, range: AstRange): string {
  const start = Buffer.from(block.content, 'utf8')
    .subarray(0, range.startByte)
    .toString('utf8').length;
  const end = Buffer.from(block.content, 'utf8').subarray(0, range.endByte).toString('utf8').length;
  return block.content.slice(start, end);
}

function staticScriptFacts(
  filePath: string,
  source: string,
  block: SFCBlock,
  imports: readonly VueImportBindingV1[]
): Pick<ScriptBlockFacts, 'stores' | 'events' | 'optionsComponents'> {
  const stores: VueStoreDeclarationV1[] = [];
  const events: VueEventFactV1[] = [];
  const optionsComponents: Record<string, string> = {};
  const location = (relativeOffset: number) =>
    sourceLocationAt(filePath, source, block.loc.start.offset + relativeOffset);

  const storePattern =
    /\bexport\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(defineStore|createStore)\s*\(/gu;
  for (const match of block.content.matchAll(storePattern)) {
    const localName = match[1];
    const callee = match[2];
    if (!localName || !callee || match.index === undefined) continue;
    stores.push({
      exportName: localName,
      localName,
      kind: callee === 'defineStore' ? 'pinia' : 'vuex',
      location: location(match.index + match[0].indexOf(localName)),
    });
  }
  const defaultVuex = /\bexport\s+default\s+(?:new\s+Vuex\.Store|createStore)\s*\(/gu;
  for (const match of block.content.matchAll(defaultVuex)) {
    if (match.index === undefined) continue;
    stores.push({
      exportName: 'default',
      localName: 'default',
      kind: 'vuex',
      location: location(match.index),
    });
  }

  const addEvents = (
    body: string,
    bodyOffset: number,
    eventSource: VueEventFactV1['source']
  ): void => {
    const quoted = /(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1\s*(?=,|\]|:|\}|\)|$)/gu;
    for (const match of body.matchAll(quoted)) {
      if (!match[2] || match.index === undefined) continue;
      events.push({
        eventName: match[2],
        source: eventSource,
        location: location(bodyOffset + match.index),
      });
    }
    const callSignature = /\bevent\s*:\s*(['"])([^'"]+)\1/gu;
    for (const match of body.matchAll(callSignature)) {
      if (!match[2] || match.index === undefined) continue;
      if (!events.some((item) => item.eventName === match[2] && item.source === eventSource)) {
        events.push({
          eventName: match[2],
          source: eventSource,
          location: location(bodyOffset + match.index),
        });
      }
    }
    const objectKey = /(?:^|[;,])\s*([A-Za-z_$][\w$-]*)\s*:/gu;
    for (const match of body.matchAll(objectKey)) {
      if (!match[1] || match.index === undefined) continue;
      events.push({
        eventName: match[1],
        source: eventSource,
        location: location(bodyOffset + match.index),
      });
    }
  };

  const emitsTypePattern = /\bdefineEmits\s*<\s*\{([\s\S]*?)\}\s*>\s*\(\s*\)/gu;
  for (const match of block.content.matchAll(emitsTypePattern)) {
    if (match.index === undefined || !match[1]) continue;
    addEvents(match[1], match.index + match[0].indexOf(match[1]), 'defineEmits');
  }
  const emitsPattern = /\bdefineEmits\s*\(\s*([[{])([\s\S]*?)([\]}])\s*\)/gu;
  for (const match of block.content.matchAll(emitsPattern)) {
    if (match.index === undefined || !match[2]) continue;
    addEvents(match[2], match.index + match[0].indexOf(match[2]), 'defineEmits');
  }
  const optionsEmits = /\bemits\s*:\s*([[{])([\s\S]*?)([\]}])/gu;
  for (const match of block.content.matchAll(optionsEmits)) {
    if (match.index === undefined || !match[2]) continue;
    addEvents(match[2], match.index + match[0].indexOf(match[2]), 'options-emits');
  }

  const components = /\bcomponents\s*:\s*\{([\s\S]*?)\}/gu.exec(block.content);
  if (components?.[1]) {
    const body = components[1];
    for (const entry of body.split(',')) {
      const clean = entry.trim();
      const shorthand = /^([A-Za-z_$][\w$]*)$/u.exec(clean);
      const mapped = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/u.exec(clean);
      const publicName = shorthand?.[1] ?? mapped?.[1];
      const localName = shorthand?.[1] ?? mapped?.[2];
      if (publicName && localName && imports.some((item) => item.localName === localName)) {
        optionsComponents[publicName] = localName;
      }
    }
  }

  for (const match of block.content.matchAll(
    /\bdefineModel(?:\s*<[^>]*>)?\s*\(\s*(?:(['"])([^'"]+)\1)?/gu
  )) {
    if (match.index === undefined) continue;
    events.push({
      eventName: `update:${match[2] ?? 'modelValue'}`,
      source: 'model',
      location: location(match.index),
    });
  }

  return { stores, events, optionsComponents };
}

function countSyntax(root: Parser.SyntaxNode, maxNodes: number, maxDepth: number) {
  let count = 0;
  const pending: Array<{ node: Parser.SyntaxNode; depth: number }> = [{ node: root, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    count += 1;
    if (count > maxNodes) return { count, error: 'Vue script syntax node count exceeds maxNodes.' };
    if (current.depth > maxDepth)
      return { count, error: 'Vue script syntax depth exceeds maxDepth.' };
    for (let index = current.node.namedChildCount - 1; index >= 0; index -= 1) {
      const child = current.node.namedChild(index);
      if (child) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return { count };
}

function extractScriptBlock(
  grammars: Map<AstLang, Parser.Language>,
  filePath: string,
  sfcSource: string,
  block: SFCBlock,
  limits: ParserLimitsV1
): ScriptBlockFacts {
  const diagnostics: SourceDiagnosticV1[] = [];
  const empty = {
    declarations: [],
    references: [],
    imports: [],
    calls: [],
    stores: [],
    events: [],
    optionsComponents: {},
    syntaxNodes: 0,
  } satisfies Omit<ScriptBlockFacts, 'diagnostics'>;
  if (block.src) {
    return {
      ...empty,
      diagnostics: [
        diagnosticAt(
          filePath,
          sfcSource,
          'vue-script-src-unsupported',
          '<script src> is not consumed by deterministic SFC extraction.',
          block.loc.start.offset
        ),
      ],
    };
  }
  const lang = scriptLanguage(block);
  if (!lang) {
    return {
      ...empty,
      diagnostics: [
        diagnosticAt(
          filePath,
          sfcSource,
          'vue-script-lang-unsupported',
          `Unsupported Vue script language: ${String(block.lang)}`,
          block.loc.start.offset
        ),
      ],
    };
  }
  const grammar = grammars.get(lang);
  if (!grammar) {
    return {
      ...empty,
      diagnostics: [
        diagnosticAt(
          filePath,
          sfcSource,
          'vue-script-grammar-unavailable',
          `No Phase 6 grammar is available for ${lang}.`,
          block.loc.start.offset
        ),
      ],
    };
  }

  const parser = new Parser();
  let syntaxNodes: number;
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(block.content);
    if (!tree) {
      return {
        ...empty,
        diagnostics: [
          diagnosticAt(
            filePath,
            sfcSource,
            'parse-error',
            'Phase 6 parser returned no Vue script syntax tree.',
            block.loc.start.offset
          ),
        ],
      };
    }
    try {
      const counted = countSyntax(tree.rootNode, limits.maxNodes, limits.maxDepth);
      syntaxNodes = counted.count;
      if (counted.error) {
        return {
          ...empty,
          syntaxNodes,
          diagnostics: [
            diagnosticAt(filePath, sfcSource, 'limit', counted.error, block.loc.start.offset),
          ],
        };
      }
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }

  const extracted = extractSource(grammars, block.content, filePath, lang).extraction;
  const declarations = extracted.nodes.map((node) => ({
    localId:
      node.type === 'method' && node.container ? `${node.container}.${node.name}` : node.name,
    kind: node.type,
    name: node.name,
    ...(node.container ? { container: node.container } : {}),
    location: rangeLocation(filePath, sfcSource, block, node.range),
  }));
  const references: ReferenceFactV1[] = (extracted.moduleFacts ?? []).map((fact) =>
    moduleReference(filePath, fact, rangeLocation(filePath, sfcSource, block, fact.range))
  );
  const calls: VueCallFactV1[] = [];
  for (const edge of extracted.edges) {
    if (edge.type === 'import') continue;
    references.push({
      fromLocalId: enclosingDeclaration(extracted, edge.range.startByte, filePath),
      kind: edge.type === 'call' ? 'call' : 'reference',
      rawTarget: edge.toRaw,
      ...(edge.member ? { member: edge.member } : {}),
      location: rangeLocation(filePath, sfcSource, block, edge.nameRange ?? edge.range),
    });
    if (edge.type === 'call') {
      const callSource = scriptSliceAt(block, edge.range);
      calls.push({
        callee: edge.toRaw,
        ...(extracted.imports?.some((binding) => binding.local === edge.toRaw)
          ? { localBinding: edge.toRaw }
          : {}),
        ...(staticFirstString(callSource)
          ? { firstStaticString: staticFirstString(callSource) }
          : {}),
        location: rangeLocation(filePath, sfcSource, block, edge.nameRange ?? edge.range),
      });
    }
  }
  const imports: VueImportBindingV1[] = (extracted.imports ?? [])
    .filter((binding) => binding.module !== undefined && binding.range !== undefined)
    .map((binding) => ({
      localName: binding.local,
      importedName: binding.imported,
      specifier: binding.module!,
      location: rangeLocation(filePath, sfcSource, block, binding.range!),
    }));
  const asyncLiteral =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*defineAsyncComponent\s*\(\s*\(?(?:[^=()]*)\)?\s*=>\s*import\s*\(\s*(['"])([^'"]+)\2\s*\)\s*\)/gu;
  for (const match of block.content.matchAll(asyncLiteral)) {
    if (!match[1] || !match[3] || match.index === undefined) continue;
    imports.push({
      localName: match[1],
      importedName: 'default',
      specifier: match[3],
      location: sourceLocationAt(
        filePath,
        sfcSource,
        block.loc.start.offset + match.index + match[0].indexOf(match[1])
      ),
    });
  }
  const dynamicAsync =
    /\bdefineAsyncComponent\s*\((?!\s*\(?(?:[^=()]*)\)?\s*=>\s*import\s*\(\s*['"])[\s\S]*?\)/gu;
  for (const match of block.content.matchAll(dynamicAsync)) {
    if (match.index === undefined) continue;
    diagnostics.push({
      code: 'vue-async-component-dynamic',
      message: 'Dynamic async-component factories cannot produce a static component relationship.',
      location: sourceLocationAt(filePath, sfcSource, block.loc.start.offset + match.index),
    });
  }

  diagnostics.push(
    ...(extracted.diagnostics ?? []).map((item) => ({
      code: item.code,
      message: item.message,
      ...(item.range
        ? { location: rangeLocation(filePath, sfcSource, block, item.range) }
        : { location: sourceLocationAt(filePath, sfcSource, block.loc.start.offset) }),
    }))
  );
  const dynamicMacros: Array<[RegExp, string]> = [
    [/\bdefineEmits\s*\(\s*(?![[{)])/gu, 'defineEmits argument is not statically reducible.'],
    [
      /\bdefineModel(?:\s*<[^>]*>)?\s*\(\s*(?!['"]|\))/gu,
      'defineModel argument is not statically reducible.',
    ],
  ];
  for (const [pattern, message] of dynamicMacros) {
    for (const match of block.content.matchAll(pattern)) {
      if (match.index === undefined) continue;
      diagnostics.push({
        code: 'vue-macro-dynamic',
        message,
        location: sourceLocationAt(filePath, sfcSource, block.loc.start.offset + match.index),
      });
    }
  }
  const staticFacts = staticScriptFacts(filePath, sfcSource, block, imports);
  const establishedEmitBindings = new Set<string>();
  for (const match of block.content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*defineEmits\b/gu
  )) {
    if (match[1]) establishedEmitBindings.add(match[1]);
  }
  if (/\bsetup\s*\([^,]*,\s*\{[^}]*\bemit\b[^}]*\}/u.test(block.content)) {
    establishedEmitBindings.add('emit');
  }
  for (const call of calls) {
    if (
      (call.callee === 'this.$emit' || establishedEmitBindings.has(call.callee)) &&
      call.firstStaticString
    ) {
      staticFacts.events.push({
        eventName: call.firstStaticString,
        source: 'emit-call',
        location: call.location,
      });
    }
  }
  return {
    declarations,
    references,
    diagnostics,
    imports,
    calls,
    stores: staticFacts.stores,
    events: staticFacts.events,
    optionsComponents: staticFacts.optionsComponents,
    syntaxNodes,
  };
}

function exactBlock(
  filePath: string,
  source: string,
  block: SFCBlock | null,
  label: string,
  diagnostics: SourceDiagnosticV1[]
): block is SFCBlock {
  if (!block) return false;
  if (source.slice(block.loc.start.offset, block.loc.end.offset) === block.content) return true;
  diagnostics.push(
    diagnosticAt(
      filePath,
      source,
      'vue-block-offset-mismatch',
      `Vue compiler ${label} offsets did not reproduce the exact source slice.`,
      Math.max(0, Math.min(source.length, block.loc.start.offset))
    )
  );
  return false;
}

/** Extract deterministic, original-source-mapped facts from one in-memory Vue SFC. */
export async function extractVueSfc(
  source: string,
  filePath: string,
  options: VueSfcExtractOptionsV1 = {}
): Promise<VueSfcFactsV1> {
  const limits = { ...DEFAULT_PARSER_LIMITS, ...options.limits };
  if (!safeRepositoryPath(filePath)) {
    return emptyFacts(filePath, [
      { code: 'path-escape', message: 'Vue SFC path is outside the repository root.' },
    ]);
  }
  if (Buffer.byteLength(source, 'utf8') > limits.maxBytes) {
    return emptyFacts(filePath, [
      diagnosticAt(filePath, source, 'limit', 'Vue SFC input exceeds maxBytes.'),
    ]);
  }
  const startedAt = Date.now();
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return emptyFacts(filePath, [
      diagnosticAt(filePath, source, 'limit', 'Vue SFC parser limits are invalid.'),
    ]);
  }
  let parsed: SFCParseResult;
  try {
    parsed = vueSfcCompiler().parse(source, { filename: filePath, sourceMap: false });
  } catch (error) {
    const item = diagnosticAt(
      filePath,
      source,
      'vue-sfc-parse-error',
      error instanceof Error ? error.message : 'Vue SFC parser failed'
    );
    const failed = emptyFacts(filePath, [item]);
    failed.compilerDiagnostics.push(item);
    return failed;
  }
  const compilerDiagnostics = parsed.errors.map((error) =>
    typeof error === 'string'
      ? diagnosticAt(filePath, source, 'vue-sfc-parse-error', error)
      : compilerDiagnostic(error, filePath, source)
  );
  const diagnostics = [...compilerDiagnostics];
  const facts = emptyFacts(filePath);
  facts.compilerDiagnostics.push(...compilerDiagnostics);
  const grammars = options.grammars ?? (await getGrammars());
  let syntaxNodes = 0;

  for (const [label, block] of [
    ['script', parsed.descriptor.script],
    ['script setup', parsed.descriptor.scriptSetup],
  ] as const) {
    if (!exactBlock(filePath, source, block, label, diagnostics)) continue;
    const script = extractScriptBlock(grammars, filePath, source, block, limits);
    syntaxNodes += script.syntaxNodes;
    facts.declarations.push(...script.declarations);
    facts.references.push(...script.references);
    facts.imports.push(...script.imports);
    facts.calls.push(...script.calls);
    facts.stores.push(...script.stores);
    facts.events.push(...script.events);
    Object.assign(facts.optionsComponents, script.optionsComponents);
    diagnostics.push(...script.diagnostics);
  }

  const template = parsed.descriptor.template;
  if (exactBlock(filePath, source, template, 'template', diagnostics)) {
    if (template.src) {
      diagnostics.push(
        diagnosticAt(
          filePath,
          source,
          'vue-template-src-unsupported',
          '<template src> is not consumed by deterministic SFC extraction.',
          template.loc.start.offset
        )
      );
    } else if (template.lang && template.lang.toLowerCase() !== 'html') {
      diagnostics.push(
        diagnosticAt(
          filePath,
          source,
          'vue-template-lang-unsupported',
          `Unsupported Vue template language: ${template.lang}`,
          template.loc.start.offset
        )
      );
    } else {
      const extracted = extractVueTemplate(
        filePath,
        source,
        template.loc.start.offset,
        template.content,
        {
          maxNodes: Math.max(0, limits.maxNodes - syntaxNodes),
          maxDepth: limits.maxDepth,
          maxReferences: limits.maxReferences,
        }
      );
      syntaxNodes += extracted.nodeCount;
      facts.templateElements.push(...extracted.elements);
      facts.templateListeners.push(...extracted.listeners);
      diagnostics.push(...extracted.diagnostics);
      facts.compilerDiagnostics.push(...extracted.compilerDiagnostics);
    }
  }

  const ambiguousLocals = new Set<string>();
  const firstImport = new Map<string, VueImportBindingV1>();
  for (const binding of facts.imports) {
    const previous = firstImport.get(binding.localName);
    if (!previous) firstImport.set(binding.localName, binding);
    else if (
      previous.specifier !== binding.specifier ||
      previous.importedName !== binding.importedName
    ) {
      ambiguousLocals.add(binding.localName);
      diagnostics.push({
        code: 'vue-import-ambiguous',
        message: `Vue import binding ${binding.localName} disagrees across script blocks.`,
        location: binding.location,
      });
    }
  }
  facts.imports = facts.imports.filter((item) => !ambiguousLocals.has(item.localName));

  const totalReferences =
    facts.references.length + facts.templateElements.length + facts.templateListeners.length;
  if (totalReferences > limits.maxReferences) {
    diagnostics.push(
      diagnosticAt(filePath, source, 'limit', 'Vue SFC facts exceed maxReferences.')
    );
    facts.references.length = 0;
    facts.templateElements.length = 0;
    facts.templateListeners.length = 0;
  }
  if (syntaxNodes > limits.maxNodes) {
    diagnostics.push(diagnosticAt(filePath, source, 'limit', 'Vue SFC syntax exceeds maxNodes.'));
  }
  if (limits.timeoutMs === 0 || Date.now() - startedAt > limits.timeoutMs) {
    diagnostics.push(diagnosticAt(filePath, source, 'timeout', 'Vue SFC extraction timed out.'));
  }
  facts.diagnostics.push(...diagnostics);
  if (Buffer.byteLength(JSON.stringify(facts), 'utf8') > limits.maxResultBytes) {
    return emptyFacts(filePath, [
      diagnosticAt(filePath, source, 'limit', 'Vue SFC result exceeds maxResultBytes.'),
    ]);
  }
  return facts;
}
