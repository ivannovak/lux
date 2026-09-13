import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseTemplate, NodeTypes, type TemplateChildNode } from '@vue/compiler-dom';
import {
  parse as parseSfc,
  type SFCBlock,
  type SFCScriptBlock,
  type SFCTemplateBlock,
} from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
import { programEdgeId, vueComponentId } from '../../scanner/identity/program-identity.js';

/**
 * Independent Phase 9 contract battery (T34).
 *
 * This file deliberately does not import a Phase 9 production leaf. The
 * executable seam below is a black-box reference implementation of the frozen
 * SFC/component contract. T33/T35 can replace `referenceSeam` without changing
 * owner gold, fixed-denominator scoring, integrity checks, or watched mutants.
 */

type Coverage = 'active' | 'partial' | 'failed';
type Outcome = 'answered' | 'refused' | 'unsupported';
type MutationId =
  | 'offset-plus-one'
  | 'treat-compiler-errors-clean'
  | 'map-utf8-bytes-as-utf16-units'
  | 'emit-imported-unused'
  | 'emit-native-tag'
  | 'emit-dynamic-tag'
  | 'salt-vue-component-id'
  | 'salt-identity'
  | 'remove-required-edge'
  | 'insert-forbidden-edge'
  | 'drop-output-without-volar'
  | 'duplicate-edge'
  | 'dangle-target'
  | 'reverse-edge'
  | 'lower-max-bytes'
  | 'lower-max-depth'
  | 'lower-max-nodes'
  | 'lower-max-references'
  | 'lower-timeout'
  | 'lower-max-result-bytes';

type GoldEdge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];
type ParserLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxReferences: number;
  timeoutMs: number;
  maxResultBytes: number;
};
type ParserMetrics = {
  bytes: number;
  depth: number;
  nodes: number;
  references: number;
  durationMs: number;
  resultBytes: number;
};

interface PhaseCase extends Omit<RelationshipBenchmarkCaseV1, 'expectedEdges'> {
  expectedEdges: GoldEdge[];
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: {
    minRecall: number;
    minPrecision: number;
    minPositiveCases: number;
    minForbiddenCases: number;
  };
  expectedCoverage: Coverage;
  expectedDiagnostics: string[];
  expectedScriptImportLocation?: SourceLocation;
  expectedTemplateElementLocation?: SourceLocation;
  fixture?: { rootPath: string; layout: string[]; subtrees: string[] };
  parserLimits?: ParserLimits;
  mappingSpike?: MappingSpike;
  watchedMutations?: Array<{
    id: MutationId;
    expectedCheckerExitCode: number;
    expectedCase: string;
  }>;
  performanceProtocol?: {
    warmups: number;
    measurements: number;
    maxRegressionRatio: number;
    baselineWallMs: number;
    baselineRssBytes: number;
  };
}

interface SourceLocation {
  line: number;
  column: number;
}

interface QueryArgs {
  parentPath: string;
  source: string;
  existingFiles: string[];
  resolutions: Record<string, string>;
  metrics?: ParserMetrics;
  limits?: ParserLimits;
}

interface ReturnedEdge {
  id: string;
  source: string;
  type: 'renders_component';
  target: string;
  confidence: 'framework-inferred' | 'proven';
  evidence: SourceLocation[];
}

interface Observation {
  caseId: string;
  outcome: Outcome;
  refusalReason?: string;
  coverage: Coverage;
  diagnostics: string[];
  nodes: string[];
  edges: ReturnedEdge[];
  scriptImportLocations: SourceLocation[];
  templateElementLocations: SourceLocation[];
}

interface SeamOptions {
  mutation?: MutationId;
  lspAvailable: boolean;
}

interface VueComponentSeam {
  observe(testCase: PhaseCase, options: SeamOptions): Observation;
}

interface BatteryResult {
  exitCode: 0 | 1;
  positiveCases: number;
  forbiddenCases: number;
  recall: number;
  precision: number;
  duplicateNodeIds: number;
  duplicateEdgeIds: number;
  danglingTargets: number;
  failures: string[];
  observations: Observation[];
  digest: string;
}

interface MappingSpike {
  verdict: 'HOLDS';
  malformedCorrection: string;
  corpus: 'acme-core';
  remote: string;
  commit: string;
  owner: string;
  sourcePath: string;
  sourceSha256: string;
  scriptSetupStartOffset: number;
  templateStartOffset: number;
  positive: { shift: 0; expectedExitCode: 0; expectedMatches: [true, true] };
  oneByteShift: { shift: 1; expectedExitCode: 1; expectedMatches: [false, false] };
  malformed: {
    source: string;
    expectedExitCode: 0;
    minimumCompilerErrors: number;
    expectedCoverage: 'partial';
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(here, '../../../benchmarks/relationship/cases/phase-09.json');
const LUX_PIN = '9796d27b43b67e1b2f1c4d7adb35ef44c48c60db';
const CORE_PIN = '3afee6c0a42808c905c6830e5073eb83386c8409';
const USER_DETAILS_SHA256 = '3b8c42faed5835f28cd6dc7c534a93435417619c806bdb4eb3ef29f344b4deb5';
const PRODUCER = 'vue-component';

const NATIVE_TAGS = new Set(['a', 'button', 'div', 'i', 'p', 'path', 'section', 'span', 'svg']);
const BUILTIN_TAGS = new Set([
  'component',
  'slot',
  'template',
  'teleport',
  'suspense',
  'keepalive',
  'transition',
  'transitiongroup',
]);
const LIMIT_FIELDS: Array<[keyof ParserMetrics, keyof ParserLimits, 'limit' | 'timeout']> = [
  ['bytes', 'maxBytes', 'limit'],
  ['depth', 'maxDepth', 'limit'],
  ['nodes', 'maxNodes', 'limit'],
  ['references', 'maxReferences', 'limit'],
  ['durationMs', 'timeoutMs', 'timeout'],
  ['resultBytes', 'maxResultBytes', 'limit'],
];

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkPath, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function codeUnitLocation(source: string, offset: number): SourceLocation {
  const prefix = source.slice(0, offset);
  const lastNewline = prefix.lastIndexOf('\n');
  return { line: prefix.split('\n').length, column: prefix.length - lastNewline - 1 };
}

function utf8ByteOffsetToCodeUnits(source: string, byteOffset: number): number {
  const bytes = Buffer.from(source, 'utf8');
  if (byteOffset < 0 || byteOffset > bytes.length) throw new RangeError('byte offset out of range');
  return bytes.subarray(0, byteOffset).toString('utf8').length;
}

function blockLocation(
  sfc: string,
  block: SFCBlock,
  relativeCodeUnitOffset: number,
  mutation?: MutationId
): SourceLocation {
  const relativeBytes = Buffer.byteLength(block.content.slice(0, relativeCodeUnitOffset), 'utf8');
  const mapped =
    mutation === 'map-utf8-bytes-as-utf16-units'
      ? relativeBytes
      : utf8ByteOffsetToCodeUnits(block.content, relativeBytes);
  return codeUnitLocation(sfc, block.loc.start.offset + mapped);
}

function normalizedTag(value: string): string {
  return value.replaceAll('-', '').toLowerCase();
}

function componentEdge(source: string, target: string, evidence: SourceLocation[]): ReturnedEdge {
  const sourceId = vueComponentId(source);
  const targetId = vueComponentId(target);
  return {
    id: programEdgeId('renders_component', sourceId, targetId, PRODUCER),
    source: sourceId,
    type: 'renders_component',
    target: targetId,
    confidence: 'framework-inferred',
    evidence,
  };
}

function resolveImport(
  parentPath: string,
  specifier: string,
  existingFiles: ReadonlySet<string>,
  resolutions: Readonly<Record<string, string>>
): string | undefined {
  const configured = resolutions[specifier];
  if (configured && existingFiles.has(configured)) return configured;
  if (!specifier.startsWith('.')) return undefined;
  const candidate = posix.normalize(posix.join(posix.dirname(parentPath), specifier));
  return existingFiles.has(candidate) && candidate.endsWith('.vue') ? candidate : undefined;
}

function importsFromBlock(
  sfc: string,
  block: SFCBlock,
  mutation?: MutationId
): Array<{
  local: string;
  specifier: string;
  location: SourceLocation;
}> {
  const imports: Array<{ local: string; specifier: string; location: SourceLocation }> = [];
  const source = block.content;
  const pattern = /import\s+([^;'"\n]+?)\s+from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1].trim();
    const specifier = match[2];
    const locals: string[] = [];
    if (clause.startsWith('{')) {
      for (const item of clause.slice(1, -1).split(',')) {
        const parts = item.trim().split(/\s+as\s+/u);
        if (parts[0] === 'default' || specifier.endsWith('.vue')) locals.push(parts.at(-1) ?? '');
      }
    } else {
      locals.push(clause.split(',')[0].trim());
    }
    const offset = (match.index ?? 0) + match[0].indexOf('import');
    for (const local of locals.filter(Boolean)) {
      imports.push({ local, specifier, location: blockLocation(sfc, block, offset, mutation) });
    }
  }
  return imports;
}

function asyncImportsFromBlock(
  sfc: string,
  block: SFCBlock,
  mutation?: MutationId
): Array<{
  local: string;
  specifier: string;
  location: SourceLocation;
}> {
  const results: Array<{ local: string; specifier: string; location: SourceLocation }> = [];
  const pattern =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:defineAsyncComponent|asyncComponent)\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']([^"']+)["']\s*\)\s*\)/gu;
  for (const match of block.content.matchAll(pattern)) {
    results.push({
      local: match[1],
      specifier: match[2],
      location: blockLocation(sfc, block, match.index ?? 0, mutation),
    });
  }
  return results;
}

function optionsRegistrations(block: SFCBlock): Map<string, string> {
  const registrations = new Map<string, string>();
  const object = /components\s*:\s*\{([^}]*)\}/su.exec(block.content)?.[1];
  if (!object) return registrations;
  for (const member of object.split(',')) {
    const item = member.trim();
    if (!item) continue;
    const [publicName, binding = publicName] = item.split(':').map((part) => part.trim());
    if (/^[A-Za-z_$][\w$]*$/u.test(publicName) && /^[A-Za-z_$][\w$]*$/u.test(binding)) {
      registrations.set(normalizedTag(publicName), binding);
    }
  }
  return registrations;
}

function templateElements(
  sfc: string,
  block: SFCBlock,
  mutation?: MutationId
): Array<{
  tag: string;
  staticIs?: string;
  dynamic: boolean;
  location: SourceLocation;
}> {
  const results: Array<{
    tag: string;
    staticIs?: string;
    dynamic: boolean;
    location: SourceLocation;
  }> = [];
  const compilerErrors: unknown[] = [];
  const ast = parseTemplate(block.content, {
    comments: false,
    onError: (error) => compilerErrors.push(error),
  });
  const visit = (node: TemplateChildNode): void => {
    if (node.type === NodeTypes.ELEMENT) {
      const staticIs = node.props.find(
        (prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'is'
      );
      const dynamic = node.props.some(
        (prop) =>
          prop.type === NodeTypes.DIRECTIVE &&
          prop.name === 'bind' &&
          prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
          prop.arg.content === 'is'
      );
      results.push({
        tag: node.tag,
        staticIs: staticIs?.type === NodeTypes.ATTRIBUTE ? staticIs.value?.content : undefined,
        dynamic,
        location: blockLocation(sfc, block, node.loc.start.offset, mutation),
      });
      for (const child of node.children) visit(child);
    } else if (node.type === NodeTypes.IF) {
      for (const branch of node.branches) visit(branch);
    } else if (node.type === NodeTypes.IF_BRANCH || node.type === NodeTypes.FOR) {
      for (const child of node.children) visit(child);
    }
  };
  for (const child of ast.children) visit(child);
  return results;
}

function parseErrorMessages(errors: readonly (string | Error)[]): string[] {
  return errors.length > 0 ? ['compiler-error'] : [];
}

const referenceSeam: VueComponentSeam = {
  observe(testCase, options) {
    const args = testCase.query?.args as unknown as QueryArgs;
    let limits = args.limits;
    const mutation = options.mutation;
    if (limits && mutation?.startsWith('lower-')) {
      limits = { ...limits };
      const map: Partial<Record<MutationId, keyof ParserLimits>> = {
        'lower-max-bytes': 'maxBytes',
        'lower-max-depth': 'maxDepth',
        'lower-max-nodes': 'maxNodes',
        'lower-max-references': 'maxReferences',
        'lower-timeout': 'timeoutMs',
        'lower-max-result-bytes': 'maxResultBytes',
      };
      const field = map[mutation];
      if (field) limits[field] -= 1;
    }
    if (limits && args.metrics) {
      for (const [metric, field, code] of LIMIT_FIELDS) {
        if (args.metrics[metric] > limits[field]) {
          const reason = `${code}:${field}`;
          return {
            caseId: testCase.id,
            outcome: 'refused',
            refusalReason: reason,
            coverage: 'failed',
            diagnostics: [reason],
            nodes: [],
            edges: [],
            scriptImportLocations: [],
            templateElementLocations: [],
          };
        }
      }
    }

    const parsed = parseSfc(args.source, {
      filename: args.parentPath,
      sourceMap: false,
    });
    const blocks = [
      parsed.descriptor.script,
      parsed.descriptor.scriptSetup,
      parsed.descriptor.template,
    ]
      .filter((block): block is SFCScriptBlock | SFCTemplateBlock => block !== null)
      .map((block) => ({
        block,
        matches:
          args.source.slice(
            block.loc.start.offset + (mutation === 'offset-plus-one' ? 1 : 0),
            block.loc.end.offset
          ) === block.content,
      }));
    const diagnostics = parseErrorMessages(parsed.errors);
    if (blocks.some(({ matches }) => !matches)) diagnostics.push('source-offset-mismatch');
    if (/<script\b[^>]*\bsrc\s*=/u.test(args.source)) diagnostics.push('script-src-unsupported');
    if (/<template\b[^>]*\blang\s*=\s*["'](?!html["'])/u.test(args.source)) {
      diagnostics.push('template-preprocessor-unsupported');
    }
    if (/:is\s*=|v-bind:is\s*=/u.test(args.source)) diagnostics.push('dynamic-component');
    if (
      /defineAsyncComponent\s*\(|asyncComponent\s*\(/u.test(args.source) &&
      !/=>\s*import\s*\(\s*["'][^"']+["']\s*\)/u.test(args.source)
    ) {
      diagnostics.push('dynamic-component');
    }

    const scriptBlocks: SFCScriptBlock[] = [];
    if (parsed.descriptor.script) scriptBlocks.push(parsed.descriptor.script);
    if (parsed.descriptor.scriptSetup) scriptBlocks.push(parsed.descriptor.scriptSetup);
    const imports = scriptBlocks.flatMap((block) => [
      ...importsFromBlock(args.source, block, mutation),
      ...asyncImportsFromBlock(args.source, block, mutation),
    ]);
    const existingFiles = new Set(args.existingFiles);
    const bindings = new Map<string, { target: string; evidence: SourceLocation }>();
    const ambiguous = new Set<string>();
    for (const item of imports) {
      const target = resolveImport(
        args.parentPath,
        item.specifier,
        existingFiles,
        args.resolutions
      );
      if (!target) continue;
      const key = normalizedTag(item.local);
      const current = bindings.get(key);
      if (current && current.target !== target) ambiguous.add(key);
      else bindings.set(key, { target, evidence: item.location });
    }
    if (ambiguous.size > 0) diagnostics.push('ambiguous-import-binding');

    const registrations = new Map<string, string>();
    if (parsed.descriptor.script) {
      for (const [tag, binding] of optionsRegistrations(parsed.descriptor.script)) {
        registrations.set(tag, normalizedTag(binding));
      }
    }
    const isSetup = parsed.descriptor.scriptSetup !== null;
    const elements = parsed.descriptor.template
      ? templateElements(args.source, parsed.descriptor.template, mutation)
      : [];
    const edges: ReturnedEdge[] = [];
    const unresolved: string[] = [];
    for (const element of elements) {
      const effectiveTag = element.tag === 'component' ? element.staticIs : element.tag;
      const normalized = effectiveTag ? normalizedTag(effectiveTag) : '';
      const native =
        element.tag === element.tag.toLowerCase() && NATIVE_TAGS.has(normalizedTag(element.tag));
      const builtin = BUILTIN_TAGS.has(normalizedTag(element.tag));
      const dynamic = element.dynamic;
      if (dynamic && mutation !== 'emit-dynamic-tag') continue;
      if ((native || builtin) && element.tag !== 'component' && mutation !== 'emit-native-tag')
        continue;
      if ((native || builtin) && mutation === 'emit-native-tag' && args.existingFiles[0]) {
        edges.push(componentEdge(args.parentPath, args.existingFiles[0], [element.location]));
        continue;
      }
      const bindingKey = isSetup ? normalized : registrations.get(normalized);
      const resolved = bindingKey ? bindings.get(bindingKey) : undefined;
      if (resolved && !ambiguous.has(bindingKey ?? '')) {
        edges.push(
          componentEdge(args.parentPath, resolved.target, [resolved.evidence, element.location])
        );
      } else if (effectiveTag && !native && !builtin) {
        unresolved.push(effectiveTag);
      }
    }

    if (mutation === 'emit-imported-unused') {
      for (const binding of bindings.values()) {
        edges.push(componentEdge(args.parentPath, binding.target, [binding.evidence]));
      }
    }
    if (
      elements.some((element) => element.dynamic) &&
      mutation === 'emit-dynamic-tag' &&
      edges.length === 0
    ) {
      const first = bindings.values().next().value;
      if (first) edges.push(componentEdge(args.parentPath, first.target, [first.evidence]));
    }
    const uniqueEdges = [
      ...new Map(
        edges.map((edge) => [`${edge.source}\0${edge.type}\0${edge.target}`, edge])
      ).values(),
    ];
    if (unresolved.length > 0 && uniqueEdges.length === 0) diagnostics.push('unresolved-component');
    if (mutation === 'remove-required-edge') uniqueEdges.shift();
    if (mutation === 'insert-forbidden-edge') {
      const forbidden = testCase.forbiddenEdges[0];
      if (forbidden?.source && forbidden.target) {
        uniqueEdges.push(
          componentEdge(args.parentPath, forbidden.target.replace('component:vue:', ''), [])
        );
      }
    }
    if (mutation === 'duplicate-edge' && uniqueEdges[0]) uniqueEdges.push({ ...uniqueEdges[0] });
    if (mutation === 'dangle-target' && uniqueEdges[0]) {
      uniqueEdges[0] = componentEdge(
        args.parentPath,
        'fixtures/components/missing/Dangling.vue',
        []
      );
    }
    if (mutation === 'reverse-edge' && uniqueEdges[0]) {
      const edge = uniqueEdges[0];
      uniqueEdges[0] = {
        ...edge,
        id: programEdgeId('renders_component', edge.target, edge.source, PRODUCER),
        source: edge.target,
        target: edge.source,
      };
    }

    let parentId = vueComponentId(args.parentPath);
    if (mutation === 'salt-vue-component-id' || mutation === 'salt-identity') {
      parentId += ':salt';
      for (const edge of uniqueEdges) {
        edge.source = parentId;
        edge.id = programEdgeId(edge.type, edge.source, edge.target, PRODUCER);
      }
    }
    let nodes = [parentId, ...args.existingFiles.map(vueComponentId)];
    let outputEdges = uniqueEdges;
    if (mutation === 'drop-output-without-volar' && !options.lspAvailable) {
      nodes = [];
      outputEdges = [];
    }
    const cleanErrors = mutation === 'treat-compiler-errors-clean';
    const unsupported = diagnostics.some((item) => item.endsWith('-unsupported'));
    const refused = diagnostics.some((item) =>
      ['dynamic-component', 'ambiguous-import-binding', 'unresolved-component'].includes(item)
    );
    return {
      caseId: testCase.id,
      outcome: unsupported
        ? 'unsupported'
        : refused && outputEdges.length === 0
          ? 'refused'
          : 'answered',
      refusalReason: diagnostics.includes('dynamic-component')
        ? 'vue-component-dynamic'
        : diagnostics.includes('ambiguous-import-binding')
          ? 'vue-component-ambiguous'
          : diagnostics.includes('unresolved-component')
            ? 'vue-component-missing'
            : undefined,
      coverage: diagnostics.length === 0 || cleanErrors ? 'active' : 'partial',
      diagnostics,
      nodes,
      edges: outputEdges.map((edge) => ({
        ...edge,
        confidence: options.lspAvailable ? 'proven' : 'framework-inferred',
      })),
      scriptImportLocations: imports.map((item) => item.location),
      templateElementLocations: elements
        .filter((item) => !NATIVE_TAGS.has(normalizedTag(item.tag)))
        .map((item) => item.location),
    };
  },
};

function edgeKey(edge: GoldEdge | ReturnedEdge | ForbiddenEdge): string {
  return `${edge.source ?? '*'}\0${edge.type ?? '*'}\0${edge.target ?? '*'}`;
}

function locationKey(location: SourceLocation): string {
  return `${location.line}:${location.column}`;
}

function forbiddenMatches(edge: ReturnedEdge, forbidden: ForbiddenEdge): boolean {
  return (
    (forbidden.source === undefined || forbidden.source === edge.source) &&
    (forbidden.type === undefined || forbidden.type === edge.type) &&
    (forbidden.target === undefined || forbidden.target === edge.target)
  );
}

function graphProjection(observation: Observation) {
  return {
    nodes: [...observation.nodes].sort(),
    edges: observation.edges
      .map(({ id, source, type, target }) => ({ id, source, type, target }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function runBattery(
  cases: readonly PhaseCase[],
  options: SeamOptions = { lspAvailable: false }
): BatteryResult {
  const observations = cases.map((testCase) => referenceSeam.observe(testCase, options));
  const failures: string[] = [];
  const expected = cases.flatMap((testCase) => testCase.expectedEdges);
  const returned = observations.flatMap((item) => item.edges);
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = returned.filter((edge) => expectedKeys.has(edgeKey(edge))).length;

  cases.forEach((testCase, index) => {
    const observation = observations[index];
    const returnedKeys = observation.edges.map(edgeKey);
    for (const wanted of testCase.expectedEdges) {
      if (!returnedKeys.includes(edgeKey(wanted)))
        failures.push(`${testCase.id}: missing expected edge`);
    }
    if (
      observation.edges.some((edge) =>
        testCase.forbiddenEdges.some((f) => forbiddenMatches(edge, f))
      )
    ) {
      failures.push(`${testCase.id}: forbidden edge returned`);
    }
    if (observation.outcome !== testCase.expectedOutcome) {
      failures.push(`${testCase.id}: outcome ${observation.outcome}`);
    }
    if (
      testCase.expectedRefusalReason !== undefined &&
      observation.refusalReason !== testCase.expectedRefusalReason
    ) {
      failures.push(`${testCase.id}: refusal ${observation.refusalReason ?? 'absent'}`);
    }
    if (observation.coverage !== testCase.expectedCoverage) {
      failures.push(`${testCase.id}: coverage ${observation.coverage}`);
    }
    for (const diagnostic of testCase.expectedDiagnostics) {
      if (!observation.diagnostics.includes(diagnostic)) {
        failures.push(`${testCase.id}: missing diagnostic ${diagnostic}`);
      }
    }
    if (testCase.expectedScriptImportLocation) {
      if (
        !observation.scriptImportLocations.some(
          (item) => locationKey(item) === locationKey(testCase.expectedScriptImportLocation!)
        )
      ) {
        failures.push(`${testCase.id}: wrong script source location`);
      }
    }
    if (testCase.expectedTemplateElementLocation) {
      if (
        !observation.templateElementLocations.some(
          (item) => locationKey(item) === locationKey(testCase.expectedTemplateElementLocation!)
        )
      ) {
        failures.push(`${testCase.id}: wrong template source location`);
      }
    }
  });

  const nodes = observations.flatMap((item) => item.nodes);
  const edgeIds = returned.map((item) => item.id);
  // Repeated canonical nodes across independent fixtures materialize once in a
  // merged graph. A duplicate inside one materialization result is corruption.
  const duplicateNodeIds = observations.reduce(
    (count, item) => count + item.nodes.length - new Set(item.nodes).size,
    0
  );
  const duplicateEdgeIds = edgeIds.length - new Set(edgeIds).size;
  const materialized = new Set(nodes);
  const danglingTargets = returned.filter((edge) => !materialized.has(edge.target)).length;
  if (duplicateNodeIds > 0) failures.push(`integrity: ${duplicateNodeIds} duplicate nodes`);
  if (duplicateEdgeIds > 0) failures.push(`integrity: ${duplicateEdgeIds} duplicate edges`);
  if (danglingTargets > 0) failures.push(`integrity: ${danglingTargets} dangling targets`);

  const positiveCases = cases.filter(
    (testCase) =>
      testCase.corpus === 'phase-09-vue-synthetic' &&
      testCase.capability === 'deterministic-vue-component-graph' &&
      testCase.expectedEdges.length > 0
  ).length;
  const forbiddenCases = cases.filter(
    (testCase) => testCase.corpus === 'phase-09-vue-synthetic' && testCase.forbiddenEdges.length > 0
  ).length;
  const recall = expected.length === 0 ? 0 : matched / expected.length;
  const precision = returned.length === 0 ? 0 : matched / returned.length;
  const threshold = cases[0]?.thresholds;
  if (!threshold || positiveCases < threshold.minPositiveCases) {
    failures.push(`battery: only ${positiveCases} positive cases`);
  }
  if (!threshold || forbiddenCases < threshold.minForbiddenCases) {
    failures.push(`battery: only ${forbiddenCases} forbidden cases`);
  }
  if (!threshold || recall < threshold.minRecall) failures.push(`battery: recall ${recall}`);
  if (!threshold || precision < threshold.minPrecision)
    failures.push(`battery: precision ${precision}`);

  return {
    exitCode: failures.length === 0 ? 0 : 1,
    positiveCases,
    forbiddenCases,
    recall,
    precision,
    duplicateNodeIds,
    duplicateEdgeIds,
    danglingTargets,
    failures,
    observations,
    digest: stableHash(observations.map(graphProjection)),
  };
}

function cohortScore(cases: readonly PhaseCase[], result: BatteryResult, corpus: string) {
  const ids = new Set(cases.filter((item) => item.corpus === corpus).map((item) => item.id));
  const selectedCases = cases.filter((item) => ids.has(item.id));
  const selectedObservations = result.observations.filter((item) => ids.has(item.caseId));
  const expected = selectedCases.flatMap((item) => item.expectedEdges);
  const returned = selectedObservations.flatMap((item) => item.edges);
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = returned.filter((item) => expectedKeys.has(edgeKey(item))).length;
  return {
    expected: expected.length,
    returned: returned.length,
    recall: expected.length === 0 ? 0 : matched / expected.length,
    precision: returned.length === 0 ? 0 : matched / returned.length,
  };
}

function repeatMappingSpike(spike: MappingSpike, shift: number) {
  const sourceCase = loadCases().find(
    (item) => item.id === 'p09-acme-user-details-renders-children'
  );
  if (!sourceCase) throw new Error('missing pinned UserDetails owner gold');
  const source = (sourceCase.query?.args as unknown as QueryArgs).source;
  const parsed = parseSfc(source, { filename: spike.sourcePath, sourceMap: false });
  const blocks: Array<SFCScriptBlock | SFCTemplateBlock> = [];
  if (parsed.descriptor.scriptSetup) blocks.push(parsed.descriptor.scriptSetup);
  if (parsed.descriptor.template) blocks.push(parsed.descriptor.template);
  const matches = blocks.map(
    (block) => source.slice(block.loc.start.offset + shift, block.loc.end.offset) === block.content
  );
  return {
    exitCode: parsed.errors.length === 0 && matches.length === 2 && matches.every(Boolean) ? 0 : 1,
    errors: parsed.errors.map(String),
    matches,
    starts: blocks.map((block) => block.loc.start.offset),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  };
}

function mutationResult(cases: readonly PhaseCase[], mutation: MutationId): BatteryResult {
  return runBattery(cases, { mutation, lspAvailable: false });
}

describe('Phase 9 independent Vue component acceptance', () => {
  it('pins portable schema-v1 synthetic and exact-commit Acme owner gold', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(67);
    expect(cases.every((item) => item.fixtureSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.goldSchemaVersion === 1)).toBe(true);
    expect(new Set(cases.map((item) => item.owner))).toEqual(new Set(['Example Maintainer']));
    expect(cases.find((item) => item.corpus === 'phase-09-vue-synthetic')?.corpusPin).toEqual({
      remote: 'https://github.com/ivannovak/lux.git',
      commit: LUX_PIN,
    });
    expect(cases.find((item) => item.corpus === 'acme-core')?.corpusPin).toEqual({
      remote: 'https://github.com/acme-software/acme-core.git',
      commit: CORE_PIN,
    });
    expect(JSON.stringify(cases)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\/home\/)/u);
  });

  it('executes 35 positive and 18 forbidden synthetic cases at precision/recall 1.0', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.positiveCases).toBeGreaterThanOrEqual(30);
    expect(result.forbiddenCases).toBeGreaterThanOrEqual(15);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
  });

  it('covers every required fixture subtree and SFC script/setup/template mapping shape', () => {
    const first = loadCases()[0];
    expect(first.fixture?.rootPath).toBe('.');
    expect(first.fixture?.subtrees).toEqual([
      'script-setup',
      'composition',
      'options',
      'async',
      'unicode',
      'malformed',
      'dynamic',
      'ambiguous',
      'cycles',
      'limits',
    ]);
    const ids = new Set(loadCases().map((item) => item.id));
    for (const id of [
      'p09-positive-03-default-alias',
      'p09-positive-05-named-alias',
      'p09-positive-15-script-and-setup',
      'p09-positive-18-options-alias',
      'p09-positive-19-options-alias-kebab',
      'p09-positive-27-async-aliased',
      'p09-positive-31-agreeing-duplicate-binding',
      'p09-positive-32-cycle-a-to-b',
      'p09-positive-33-cycle-b-to-a',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('maps non-ASCII script and template evidence in original SFC UTF-16 coordinates', () => {
    const cases = loadCases();
    const result = runBattery(cases);
    for (const id of [
      'p09-positive-13-unicode-script-prefix',
      'p09-positive-14-unicode-template-prefix',
      'p09-positive-34-unicode-nonbmp-column',
    ]) {
      expect(
        result.failures.some((failure) => failure.startsWith(id)),
        id
      ).toBe(false);
    }
    expect(mutationResult(cases, 'map-utf8-bytes-as-utf16-units').failures).toContain(
      'p09-positive-34-unicode-nonbmp-column: wrong script source location'
    );
  });

  it('resolves parent imports plus rendered children for setup and Options API, not import-only use', () => {
    const cases = loadCases();
    const result = runBattery(cases);
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    expect(byId.get('p09-positive-01-setup-pascal')?.edges).toHaveLength(1);
    expect(byId.get('p09-positive-18-options-alias')?.edges).toHaveLength(1);
    expect(byId.get('p09-positive-26-two-children')?.edges).toHaveLength(2);
    expect(byId.get('p09-forbidden-imported-unused')?.edges).toEqual([]);
  });

  it('equates kebab/Pascal names and refuses dynamic, ambiguous, unregistered, and missing targets', () => {
    const result = runBattery(loadCases());
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    expect(byId.get('p09-positive-02-setup-kebab')?.edges).toHaveLength(1);
    expect(byId.get('p09-positive-19-options-alias-kebab')?.edges).toHaveLength(1);
    expect(byId.get('p09-forbidden-dynamic-is')).toMatchObject({
      outcome: 'refused',
      refusalReason: 'vue-component-dynamic',
      edges: [],
    });
    expect(byId.get('p09-forbidden-ambiguous-binding')).toMatchObject({
      outcome: 'refused',
      refusalReason: 'vue-component-ambiguous',
      edges: [],
    });
    expect(byId.get('p09-forbidden-options-unregistered')?.edges).toEqual([]);
    expect(byId.get('p09-forbidden-unknown-tag')?.edges).toEqual([]);
  });

  it('excludes native HTML/SVG and every frozen Vue built-in from component targets', () => {
    const result = runBattery(loadCases());
    const forbidden = result.observations.filter((item) => /native-|builtin-/u.test(item.caseId));
    expect(forbidden).toHaveLength(7);
    expect(forbidden.every((item) => item.edges.length === 0)).toBe(true);
  });

  it('accepts only literal async imports and literal component is values', () => {
    const result = runBattery(loadCases());
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    expect(byId.get('p09-positive-10-component-static-is')?.edges).toHaveLength(1);
    expect(byId.get('p09-positive-12-async-literal')?.edges).toHaveLength(1);
    expect(byId.get('p09-forbidden-async-arbitrary-factory')?.edges).toEqual([]);
    expect(byId.get('p09-forbidden-async-dynamic-import')?.edges).toEqual([]);
    expect(byId.get('p09-forbidden-dynamic-v-bind-is')?.edges).toEqual([]);
  });

  it('retains recoverable malformed facts and compiler diagnostics but never reports active', () => {
    const result = runBattery(loadCases());
    const malformed = result.observations.find(
      (item) => item.caseId === 'p09-positive-35-malformed-recoverable'
    );
    expect(malformed).toMatchObject({
      outcome: 'answered',
      coverage: 'partial',
      diagnostics: expect.arrayContaining(['compiler-error']),
    });
    expect(malformed?.edges).toHaveLength(1);
  });

  it('enforces exact-boundary and hostile maxBytes/depth/nodes/references/time/result controls', () => {
    const cases = loadCases();
    expect(cases[0].parserLimits).toEqual({
      maxBytes: 2 * 1024 * 1024,
      maxDepth: 128,
      maxNodes: 100_000,
      maxReferences: 10_000,
      timeoutMs: 5_000,
      maxResultBytes: 8 * 1024 * 1024,
    });
    const result = runBattery(cases);
    const limits = result.observations.filter((item) => item.caseId.startsWith('p09-limit-'));
    expect(limits).toHaveLength(12);
    expect(
      limits
        .filter((item) => item.caseId.includes('-boundary-'))
        .every((item) => item.outcome === 'answered')
    ).toBe(true);
    expect(
      limits
        .filter((item) => item.caseId.includes('-hostile-'))
        .every((item) => item.outcome === 'refused' && item.coverage === 'failed')
    ).toBe(true);
  });

  it('pins Acme UserDetails owner gold and the MainPanel parent-to-child path', () => {
    const cases = loadCases();
    const result = runBattery(cases);
    const score = cohortScore(cases, result, 'acme-core');
    expect(score).toEqual({ expected: 8, returned: 8, recall: 1, precision: 1 });
    const parent = result.observations.find(
      (item) => item.caseId === 'p09-acme-main-panel-renders-user-details'
    );
    expect(
      parent?.edges.some(
        (item) =>
          item.target ===
          vueComponentId(
            'resources/js/admin-ui/views/users/views/ViewUser/components/MainPanel/components/UserDetails.vue'
          )
      )
    ).toBe(true);
    const details = result.observations.find(
      (item) => item.caseId === 'p09-acme-user-details-renders-children'
    );
    expect(details?.edges.map((item) => item.target).sort()).toEqual(
      [
        'component:vue:resources%2Fjs%2Fadmin-ui%2Fviews%2Fusers%2Fviews%2FViewUser%2Fcomponents%2FMainPanel%2Fcomponents%2FUserRolesEditor.vue',
        'component:vue:resources%2Fjs%2Fadmin-ui%2Fviews%2Fusers%2Fviews%2FViewUser%2Fcomponents%2FMainPanel%2Fcomponents%2FUserSalespeopleEditor.vue',
        'component:vue:resources%2Fjs%2Fadmin-ui%2Fviews%2Fusers%2Fviews%2FViewUser%2Fcomponents%2FMainPanel%2Fcomponents%2FUserTagsEditor.vue',
        'component:vue:resources%2Fjs%2Fcommon-ui%2Ffeatures%2Fpayments%2FCardBrandIcon.vue',
      ].sort()
    );
  });

  it('independently repeats exact-pin UserDetails mapping, one-byte shift, and malformed correction', () => {
    const spike = loadCases()[0].mappingSpike;
    expect(spike).toBeDefined();
    const positive = repeatMappingSpike(spike!, spike!.positive.shift);
    expect(positive).toEqual({
      exitCode: spike!.positive.expectedExitCode,
      errors: [],
      matches: spike!.positive.expectedMatches,
      starts: [spike!.scriptSetupStartOffset, spike!.templateStartOffset],
      sourceSha256: USER_DETAILS_SHA256,
    });
    const shifted = repeatMappingSpike(spike!, spike!.oneByteShift.shift);
    expect(shifted.exitCode).toBe(spike!.oneByteShift.expectedExitCode);
    expect(shifted.matches).toEqual(spike!.oneByteShift.expectedMatches);

    const malformed = parseSfc(spike!.malformed.source, {
      filename: 'Malformed.vue',
      sourceMap: false,
    });
    expect(malformed.errors.length).toBeGreaterThanOrEqual(spike!.malformed.minimumCompilerErrors);
    expect(spike!.verdict).toBe('HOLDS');
    expect(spike!.malformedCorrection).toContain(
      'compiler errors force partial or failed coverage'
    );
  });

  it('preserves identical deterministic graph output with LSP off/on', () => {
    const cases = loadCases();
    const off = runBattery(cases, { lspAvailable: false });
    const on = runBattery(cases, { lspAvailable: true });
    expect(off.observations.map(graphProjection)).toEqual(on.observations.map(graphProjection));
    expect(
      off.observations
        .flatMap((item) => item.edges)
        .every((edge) => edge.confidence === 'framework-inferred')
    ).toBe(true);
    expect(
      on.observations.flatMap((item) => item.edges).every((edge) => edge.confidence === 'proven')
    ).toBe(true);
  });

  it('has zero canonical duplicate identities/edges and zero dangling targets', () => {
    const result = runBattery(loadCases());
    expect(result.duplicateEdgeIds).toBe(0);
    expect(result.danglingTargets).toBe(0);
    const canonicalNodes = result.observations.flatMap((item) => item.nodes);
    expect(new Set(canonicalNodes).size).toBeGreaterThan(0);
  });

  it('produces identical graph digests across two clean builds', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
  });

  it('defines the VAL-06 three-warmup/five-measurement and 20% regression contract', () => {
    expect(loadCases()[0].performanceProtocol).toEqual({
      warmups: 3,
      measurements: 5,
      maxRegressionRatio: 1.2,
      baselineWallMs: 1000,
      baselineRssBytes: 268435456,
    });
  });

  it('executes every prescribed mapping, semantic, parity, limit, and integrity mutant red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'offset-plus-one',
      'treat-compiler-errors-clean',
      'map-utf8-bytes-as-utf16-units',
      'emit-imported-unused',
      'emit-native-tag',
      'emit-dynamic-tag',
      'salt-vue-component-id',
      'salt-identity',
      'remove-required-edge',
      'insert-forbidden-edge',
      'drop-output-without-volar',
      'duplicate-edge',
      'dangle-target',
      'reverse-edge',
      'lower-max-bytes',
      'lower-max-depth',
      'lower-max-nodes',
      'lower-max-references',
      'lower-timeout',
      'lower-max-result-bytes',
    ]);
    for (const control of controls) {
      const result = mutationResult(cases, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some(
          (failure) =>
            failure.startsWith(`${control.expectedCase}:`) || failure.startsWith('integrity:')
        ),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
