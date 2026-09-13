import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NodeTypes,
  parse as parseTemplate,
  type DirectiveNode,
  type RootNode,
  type TemplateChildNode,
} from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
import {
  programEdgeId,
  vueComponentEventId,
  vueComponentId,
} from '../../scanner/identity/program-identity.js';

/**
 * Independent Phase 11 contract battery (T42).
 *
 * The executable seam intentionally does not import either Phase 11 leaf. The
 * production implementation can replace `observe` while the owner gold,
 * fixed-denominator scoring, refresh assertions, integrity checks, and watched
 * mutants remain independent.
 */

type Coverage = 'active' | 'partial' | 'failed';
type MutationId =
  | 'remove-child-from-event-identity'
  | 'scope-event-to-parent'
  | 'permit-dynamic-name'
  | 'handler-without-child-declaration'
  | 'swap-canonical-direction'
  | 'remove-required-edge'
  | 'inject-forbidden-edge'
  | 'duplicate-row'
  | 'dangling-target';

type GoldEdge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];
type EventEdgeType = 'emits_component_event' | 'handles_component_event';

interface ChildInput {
  path: string;
  tag: string;
  source: string;
}

interface QueryArgs {
  parentPath: string;
  parentSource: string;
  children: ChildInput[];
}

interface Thresholds {
  minRecall: number;
  minPrecision: number;
  minPositiveCases: number;
  minForbiddenCases: number;
}

interface PhaseCase extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: Thresholds;
  expectedCoverage: Coverage;
  expectedDiagnostics: string[];
  fixture?: { rootPath: string; subtrees: string[] };
  performanceProtocol?: {
    warmups: number;
    measurements: number;
    maxRegressionRatio: number;
    baselineWallMs: number;
    baselineRssBytes: number;
  };
  watchedMutations?: Array<{
    id: MutationId;
    expectedCheckerExitCode: number;
    expectedCase: string;
  }>;
  query: { tool: string; args: Record<string, unknown> };
}

interface Location {
  filePath: string;
  line: number;
  column: number;
}

interface ReturnedEdge {
  id: string;
  source: string;
  type: EventEdgeType;
  target: string;
  confidence: 'framework-inferred';
  evidence: Location[];
}

interface Observation {
  caseId: string;
  coverage: Coverage;
  diagnostics: string[];
  nodes: string[];
  edges: ReturnedEdge[];
}

interface Score {
  expected: number;
  returned: number;
  matched: number;
  positiveCases: number;
  forbiddenCases: number;
  recall: number;
  precision: number;
}

interface BatteryResult {
  exitCode: 0 | 1;
  failures: string[];
  observations: Observation[];
  score: Score;
  duplicateNodeIds: number;
  duplicateEdgeIds: number;
  danglingTargets: number;
  digest: string;
}

interface ExtractedChild {
  events: Array<{ name: string; location: Location }>;
  diagnostics: string[];
}

interface Listener {
  tag: string;
  event: string;
  location: Location;
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(here, '../../../benchmarks/relationship/cases/phase-11.json');
const LUX_PIN = 'adbb7c141c700c13a1a54c71893fb9303cc65ba2';
const PRODUCER = 'vue-component-event';

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkPath, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function location(source: string, offset: number, filePath: string): Location {
  const prefix = source.slice(0, offset);
  const lastNewline = prefix.lastIndexOf('\n');
  return {
    filePath,
    line: prefix.split('\n').length,
    column: prefix.length - lastNewline - 1,
  };
}

function addEvent(
  result: ExtractedChild,
  name: string | undefined,
  source: string,
  offset: number,
  filePath: string
): void {
  if (!name) return;
  result.events.push({ name, location: location(source, offset, filePath) });
}

function exactString(value: string): string | undefined {
  const trimmed = value.trim();
  const match = /^(?:'([^']+)'|"([^"]+)")$/u.exec(trimmed);
  return match?.[1] ?? match?.[2];
}

function runtimeArrayNames(value: string): string[] {
  if (/\.\.\./u.test(value)) return [];
  const members = value
    .split(',')
    .map((item) => exactString(item))
    .filter((item): item is string => item !== undefined);
  const nonempty = value.split(',').filter((item) => item.trim().length > 0);
  return members.length === nonempty.length ? members : [];
}

function runtimeObjectNames(value: string): string[] {
  if (/\.\.\.|\[/u.test(value)) return [];
  const names: string[] = [];
  for (const member of value.split(',')) {
    if (!member.trim()) continue;
    const match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:/u.exec(member);
    if (!match) return [];
    names.push(match[1] ?? match[2] ?? match[3]);
  }
  return names;
}

function extractChildEvents(child: ChildInput, mutation?: MutationId): ExtractedChild {
  const result: ExtractedChild = { events: [], diagnostics: [] };
  const parsed = parseSfc(child.source, { filename: child.path, sourceMap: false });
  if (parsed.errors.length > 0) {
    result.diagnostics.push('vue-sfc-parse-error');
    return result;
  }
  const blocks = [parsed.descriptor.script, parsed.descriptor.scriptSetup].filter(
    (block): block is NonNullable<typeof block> => block !== null
  );
  for (const block of blocks) {
    const source = block.content;
    const sourceOffset = block.loc.start.offset;
    const defineEmitsShadowed = /(?:const|let|var|function|class)\s+defineEmits\b/u.test(source);
    const defineModelShadowed = /(?:const|let|var|function|class)\s+defineModel\b/u.test(source);

    if (!defineEmitsShadowed) {
      for (const match of source.matchAll(/defineEmits\s*\(\s*\[([\s\S]*?)\]\s*\)/gu)) {
        for (const name of runtimeArrayNames(match[1])) {
          addEvent(result, name, child.source, sourceOffset + (match.index ?? 0), child.path);
        }
      }
      for (const match of source.matchAll(/defineEmits\s*\(\s*\{([\s\S]*?)\}\s*\)/gu)) {
        for (const name of runtimeObjectNames(match[1])) {
          addEvent(result, name, child.source, sourceOffset + (match.index ?? 0), child.path);
        }
      }
      for (const match of source.matchAll(/defineEmits\s*<([\s\S]*?)>\s*\(\s*\)/gu)) {
        const body = match[1];
        for (const signature of body.matchAll(/\(\s*event\s*:\s*([^,)]+)[^)]*\)/gu)) {
          for (const literal of signature[1].matchAll(/['"]([^'"]+)['"]/gu)) {
            addEvent(
              result,
              literal[1],
              child.source,
              sourceOffset + (match.index ?? 0),
              child.path
            );
          }
        }
        for (const line of body
          .replace(/^\s*\{/u, '')
          .replace(/\}\s*$/u, '')
          .split(/[;\n]/u)) {
          const property = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*(?::|\()/u.exec(line);
          const name = property?.[1] ?? property?.[2] ?? property?.[3];
          if (name && name !== 'event') {
            addEvent(result, name, child.source, sourceOffset + (match.index ?? 0), child.path);
          }
        }
      }

      const emitBindings = new Set<string>();
      for (const binding of source.matchAll(
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*defineEmits\s*(?:<[\s\S]*?>\s*)?\(/gu
      )) {
        emitBindings.add(binding[1]);
      }
      for (const binding of emitBindings) {
        const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const calls = new RegExp(`(?<![.$\\w])${escaped}\\s*\\(\\s*(['"])([^'"]+)\\1`, 'gu');
        for (const call of source.matchAll(calls)) {
          addEvent(result, call[2], child.source, sourceOffset + (call.index ?? 0), child.path);
        }
      }
    }

    if (!defineModelShadowed && parsed.descriptor.scriptSetup === block) {
      for (const match of source.matchAll(/defineModel(?:\s*<[^>]+>)?\s*\(([^)]*)\)/gu)) {
        const argument = match[1].trim();
        const model = argument.length === 0 ? 'modelValue' : exactString(argument);
        addEvent(
          result,
          model ? `update:${model}` : undefined,
          child.source,
          sourceOffset + (match.index ?? 0),
          child.path
        );
      }
    }

    for (const match of source.matchAll(/\bemits\s*:\s*\[([\s\S]*?)\]/gu)) {
      for (const name of runtimeArrayNames(match[1])) {
        addEvent(result, name, child.source, sourceOffset + (match.index ?? 0), child.path);
      }
    }
    for (const match of source.matchAll(/\bemits\s*:\s*\{([^{}]*?)\}/gu)) {
      for (const name of runtimeObjectNames(match[1])) {
        addEvent(result, name, child.source, sourceOffset + (match.index ?? 0), child.path);
      }
    }
    for (const match of source.matchAll(/this\.\$emit\s*\(\s*(['"])([^'"]+)\1/gu)) {
      addEvent(result, match[2], child.source, sourceOffset + (match.index ?? 0), child.path);
    }
    for (const setup of source.matchAll(
      /setup\s*\([^,]*,\s*\{\s*emit(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}\s*\)\s*\{([\s\S]*?)\}/gu
    )) {
      const binding = setup[1] ?? 'emit';
      const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const calls = new RegExp(`(?<![.$\\w])${escaped}\\s*\\(\\s*(['"])([^'"]+)\\1`, 'gu');
      for (const call of setup[2].matchAll(calls)) {
        addEvent(result, call[2], child.source, sourceOffset + (setup.index ?? 0), child.path);
      }
    }
    for (const setup of source.matchAll(
      /setup\s*\([^,]*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\}/gu
    )) {
      const escaped = setup[1].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const calls = new RegExp(`${escaped}\\.emit\\s*\\(\\s*(['"])([^'"]+)\\1`, 'gu');
      for (const call of setup[2].matchAll(calls)) {
        addEvent(result, call[2], child.source, sourceOffset + (setup.index ?? 0), child.path);
      }
    }

    if (mutation === 'permit-dynamic-name') {
      const dynamic =
        /const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2[\s\S]*defineEmits\s*\(\s*\[\s*\1\s*\]/u.exec(
          source
        );
      if (dynamic) {
        addEvent(result, dynamic[3], child.source, sourceOffset + dynamic.index, child.path);
      }
    }
  }

  result.events = [...new Map(result.events.map((event) => [event.name, event])).values()].sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  return result;
}

function directiveArgument(item: DirectiveNode): string | undefined {
  return item.arg?.type === NodeTypes.SIMPLE_EXPRESSION && item.arg.isStatic
    ? item.arg.content
    : undefined;
}

function templateChildren(node: RootNode | TemplateChildNode): readonly TemplateChildNode[] {
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.filter((child): child is TemplateChildNode => typeof child !== 'string');
  }
  if (node.type === NodeTypes.IF) return node.branches.flatMap((branch) => branch.children);
  return [];
}

function extractListeners(
  parentPath: string,
  source: string
): {
  listeners: Listener[];
  diagnostics: string[];
} {
  const parsed = parseSfc(source, { filename: parentPath, sourceMap: false });
  if (parsed.errors.length > 0) return { listeners: [], diagnostics: ['vue-sfc-parse-error'] };
  const template = parsed.descriptor.template;
  if (!template || template.src || (template.lang && template.lang !== 'html')) {
    return { listeners: [], diagnostics: [] };
  }
  let malformed = false;
  let root: RootNode;
  try {
    root = parseTemplate(template.content, {
      onError() {
        malformed = true;
      },
    });
  } catch {
    return { listeners: [], diagnostics: ['vue-sfc-parse-error'] };
  }
  if (malformed) return { listeners: [], diagnostics: ['vue-sfc-parse-error'] };

  const listeners: Listener[] = [];
  const pending: Array<RootNode | TemplateChildNode> = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    pending.push(...templateChildren(node));
    if (node.type !== NodeTypes.ELEMENT) continue;
    const element = node;
    for (const prop of element.props) {
      if (prop.type !== NodeTypes.DIRECTIVE) continue;
      let event: string | undefined;
      if (prop.name === 'on') event = directiveArgument(prop);
      if (prop.name === 'model') {
        const argument = prop.arg === undefined ? 'modelValue' : directiveArgument(prop);
        if (argument) event = `update:${argument}`;
      }
      if (prop.name === 'bind' && prop.modifiers.some((modifier) => modifier.content === 'sync')) {
        const argument = directiveArgument(prop);
        if (argument) event = `update:${argument}`;
      }
      if (event) {
        listeners.push({
          tag: element.tag,
          event,
          location: location(source, template.loc.start.offset + prop.loc.start.offset, parentPath),
        });
      }
    }
  }
  return { listeners, diagnostics: [] };
}

function resolvedImports(args: QueryArgs): Map<string, ChildInput> {
  const result = new Map<string, ChildInput>();
  const imports = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of args.parentSource.matchAll(imports)) {
    const resolved = posix.normalize(
      posix.join(
        posix.dirname(args.parentPath),
        match[2].endsWith('.vue') ? match[2] : `${match[2]}.vue`
      )
    );
    const child = args.children.find((candidate) => candidate.path === resolved);
    if (child) result.set(match[1].replaceAll('-', '').toLowerCase(), child);
  }
  return result;
}

function eventArtifactId(
  childId: string,
  parentId: string,
  event: string,
  mutation?: MutationId
): string {
  if (mutation === 'remove-child-from-event-identity') return `artifact:component-event#${event}`;
  if (mutation === 'scope-event-to-parent') return vueComponentEventId(parentId, event);
  return vueComponentEventId(childId, event);
}

function eventEdge(
  source: string,
  type: EventEdgeType,
  target: string,
  evidence: Location[],
  mutation?: MutationId
): ReturnedEdge {
  const actualSource = mutation === 'swap-canonical-direction' ? target : source;
  const actualTarget = mutation === 'swap-canonical-direction' ? source : target;
  return {
    id: programEdgeId(type, actualSource, actualTarget, PRODUCER),
    source: actualSource,
    type,
    target: actualTarget,
    confidence: 'framework-inferred',
    evidence,
  };
}

function observe(
  testCase: PhaseCase,
  mutation?: MutationId,
  overrides: Partial<QueryArgs> = {}
): Observation {
  const original = testCase.query.args as unknown as QueryArgs;
  const args = { ...original, ...overrides };
  const parentId = vueComponentId(args.parentPath);
  const nodes = [parentId, ...args.children.map((child) => vueComponentId(child.path))];
  const edges: ReturnedEdge[] = [];
  const diagnostics: string[] = [];
  const artifacts = new Map<string, { child: ChildInput; location: Location }>();

  for (const child of args.children) {
    const extracted = extractChildEvents(child, mutation);
    diagnostics.push(...extracted.diagnostics);
    for (const event of extracted.events) {
      const childId = vueComponentId(child.path);
      const artifact = eventArtifactId(childId, parentId, event.name, mutation);
      nodes.push(artifact);
      artifacts.set(`${child.path}\0${event.name}`, { child, location: event.location });
      edges.push(eventEdge(childId, 'emits_component_event', artifact, [event.location], mutation));
    }
  }

  const parent = extractListeners(args.parentPath, args.parentSource);
  diagnostics.push(...parent.diagnostics);
  const imports = resolvedImports(args);
  for (const listener of parent.listeners) {
    const child = imports.get(listener.tag.replaceAll('-', '').toLowerCase());
    if (!child) continue;
    const artifact = artifacts.get(`${child.path}\0${listener.event}`);
    if (artifact) {
      const childId = vueComponentId(child.path);
      const target = eventArtifactId(childId, parentId, listener.event, mutation);
      edges.push(
        eventEdge(
          parentId,
          'handles_component_event',
          target,
          [artifact.location, listener.location],
          mutation
        )
      );
    } else if (mutation === 'handler-without-child-declaration') {
      const target = vueComponentEventId(vueComponentId(child.path), listener.event);
      nodes.push(target);
      edges.push(
        eventEdge(parentId, 'handles_component_event', target, [listener.location], mutation)
      );
    }
  }

  if (mutation === 'inject-forbidden-edge' && testCase.forbiddenEdges[0]) {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden.source && forbidden.type && forbidden.target) {
      nodes.push(forbidden.target);
      edges.push(
        eventEdge(forbidden.source, forbidden.type as EventEdgeType, forbidden.target, [], mutation)
      );
    }
  }
  if (mutation === 'remove-required-edge' && testCase.expectedEdges.length > 0) edges.shift();
  if (mutation === 'duplicate-row' && testCase.id === 'p11-positive-01-define-emits-array-single') {
    if (edges[0]) edges.push({ ...edges[0] });
  }
  if (
    mutation === 'dangling-target' &&
    testCase.id === 'p11-positive-01-define-emits-array-single'
  ) {
    const target = edges[0]?.target;
    if (target) {
      const index = nodes.indexOf(target);
      if (index >= 0) nodes.splice(index, 1);
    }
  }

  return {
    caseId: testCase.id,
    coverage: diagnostics.length > 0 ? 'partial' : 'active',
    diagnostics: [...new Set(diagnostics)],
    nodes,
    edges,
  };
}

function edgeKey(edge: GoldEdge | ReturnedEdge): string {
  return `${edge.source}\0${edge.type}\0${edge.target}`;
}

function forbiddenMatches(edge: ReturnedEdge, forbidden: ForbiddenEdge): boolean {
  return (
    (forbidden.source === undefined || forbidden.source === edge.source) &&
    (forbidden.type === undefined || forbidden.type === edge.type) &&
    (forbidden.target === undefined || forbidden.target === edge.target)
  );
}

function runBattery(cases: readonly PhaseCase[], mutation?: MutationId): BatteryResult {
  const observations = cases.map((testCase) => observe(testCase, mutation));
  const failures: string[] = [];
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  for (const testCase of cases) {
    const observation = byId.get(testCase.id)!;
    const returnedKeys = new Set(observation.edges.map(edgeKey));
    for (const expected of testCase.expectedEdges) {
      if (!returnedKeys.has(edgeKey(expected)))
        failures.push(`${testCase.id}: missing expected edge`);
    }
    if (
      observation.edges.some((edge) =>
        testCase.forbiddenEdges.some((forbidden) => forbiddenMatches(edge, forbidden))
      )
    ) {
      failures.push(`${testCase.id}: forbidden edge returned`);
    }
    if (observation.coverage !== testCase.expectedCoverage) {
      failures.push(`${testCase.id}: coverage ${observation.coverage}`);
    }
    for (const diagnostic of testCase.expectedDiagnostics) {
      if (!observation.diagnostics.includes(diagnostic)) {
        failures.push(`${testCase.id}: missing diagnostic ${diagnostic}`);
      }
    }
  }

  const expected = cases.flatMap((item) => item.expectedEdges);
  const returned = observations.flatMap((item) => item.edges);
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = returned.filter((edge) => expectedKeys.has(edgeKey(edge))).length;
  const score: Score = {
    expected: expected.length,
    returned: returned.length,
    matched,
    positiveCases: cases.filter((item) => item.forbiddenEdges.length === 0).length,
    forbiddenCases: cases.filter((item) => item.forbiddenEdges.length > 0).length,
    recall: expected.length === 0 ? 0 : matched / expected.length,
    precision: returned.length === 0 ? 0 : matched / returned.length,
  };
  const threshold = cases[0]?.thresholds;
  if (!threshold || score.positiveCases < threshold.minPositiveCases) {
    failures.push(`score: only ${score.positiveCases} positive cases`);
  }
  if (!threshold || score.forbiddenCases < threshold.minForbiddenCases) {
    failures.push(`score: only ${score.forbiddenCases} forbidden cases`);
  }
  if (!threshold || score.expected === 0 || score.recall < threshold.minRecall) {
    failures.push(`score: recall ${score.recall}`);
  }
  if (!threshold || score.returned === 0 || score.precision < threshold.minPrecision) {
    failures.push(`score: precision ${score.precision}`);
  }

  const duplicateNodeIds = observations.reduce(
    (count, item) => count + item.nodes.length - new Set(item.nodes).size,
    0
  );
  const duplicateEdgeIds = observations.reduce(
    (count, item) => count + item.edges.length - new Set(item.edges.map((edge) => edge.id)).size,
    0
  );
  const danglingTargets = observations.reduce((count, item) => {
    const nodeIds = new Set(item.nodes);
    return count + item.edges.filter((edge) => !nodeIds.has(edge.target)).length;
  }, 0);
  if (duplicateNodeIds > 0) failures.push(`integrity: ${duplicateNodeIds} duplicate nodes`);
  if (duplicateEdgeIds > 0) failures.push(`integrity: ${duplicateEdgeIds} duplicate edges`);
  if (danglingTargets > 0) failures.push(`integrity: ${danglingTargets} dangling targets`);

  const projection = observations.map((item) => ({
    caseId: item.caseId,
    nodes: [...item.nodes].sort(),
    edges: item.edges
      .map(({ id, source, type, target }) => ({ id, source, type, target }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  }));
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    observations,
    score,
    duplicateNodeIds,
    duplicateEdgeIds,
    danglingTargets,
    digest: stableHash(projection),
  };
}

function refreshChild(
  cases: readonly PhaseCase[],
  mutation?: MutationId
): {
  before: Observation;
  after: Observation;
  removedArtifactIds: string[];
  removedInboundIds: string[];
  unrelatedStable: boolean;
} {
  const selected = cases.find((item) => item.id === 'p11-positive-01-define-emits-array-single')!;
  const before = observe(selected);
  const args = selected.query.args as unknown as QueryArgs;
  const children = args.children.map((child) => ({
    ...child,
    source: child.source.replace("defineEmits(['saved'])", 'defineEmits([])'),
  }));
  const after =
    mutation === 'handler-without-child-declaration'
      ? before
      : observe(selected, undefined, { children });
  const afterNodes = new Set(after.nodes);
  const afterEdges = new Set(after.edges.map((edge) => edge.id));
  const artifactIds = before.nodes.filter((node) => node.includes(':event:'));
  const inboundIds = before.edges
    .filter((edge) => edge.type === 'handles_component_event')
    .map((edge) => edge.id);
  const unrelated = cases.filter((item) => item.id !== selected.id);
  return {
    before,
    after,
    removedArtifactIds: artifactIds.filter((id) => !afterNodes.has(id)),
    removedInboundIds: inboundIds.filter((id) => !afterEdges.has(id)),
    unrelatedStable: runBattery(unrelated).digest === runBattery(unrelated).digest,
  };
}

function watchedMutationResult(cases: readonly PhaseCase[], mutation: MutationId): BatteryResult {
  return runBattery(cases, mutation);
}

describe('Phase 11 independent Vue component event acceptance', () => {
  it('pins portable owner gold and the frozen executable seam', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(46);
    expect(cases.every((item) => item.fixtureSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.goldSchemaVersion === 1)).toBe(true);
    expect(new Set(cases.map((item) => item.owner))).toEqual(new Set(['Example Maintainer']));
    expect(new Set(cases.map((item) => item.query.tool))).toEqual(new Set(['phase11VueEventSeam']));
    expect(cases[0].corpusPin).toEqual({
      remote: 'https://github.com/ivannovak/lux.git',
      commit: LUX_PIN,
    });
    expect(JSON.stringify(cases)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\\\|\/home\/)/u);
  });

  it('executes nonvacuous positive and forbidden cohorts above 0.95/0.90 thresholds', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.score).toMatchObject({
      positiveCases: 28,
      forbiddenCases: 18,
      recall: 1,
      precision: 65 / 68,
    });
    expect(result.score.expected).toBeGreaterThan(0);
    expect(result.score.returned).toBeGreaterThan(0);
    expect(result.score.precision).toBeGreaterThanOrEqual(0.95);
    expect(result.score.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('covers every accepted declaration, call, listener, model, and static sync form', () => {
    const ids = new Set(loadCases().map((item) => item.id));
    for (const id of [
      'p11-positive-01-define-emits-array-single',
      'p11-positive-04-define-emits-object-identifier',
      'p11-positive-06-typed-call-signature',
      'p11-positive-07-typed-call-union',
      'p11-positive-08-typed-property',
      'p11-positive-10-returned-binding-call',
      'p11-positive-12-options-emits-array',
      'p11-positive-13-options-emits-object',
      'p11-positive-14-options-this-emit',
      'p11-positive-15-setup-destructured-emit',
      'p11-positive-16-setup-aliased-emit',
      'p11-positive-17-setup-context-emit',
      'p11-positive-18-define-model-default',
      'p11-positive-19-define-model-named',
      'p11-positive-20-declared-default-model-listener',
      'p11-positive-21-declared-argument-model-listener',
      'p11-positive-22-vue2-static-sync',
      'p11-positive-25-listener-without-expression',
      'p11-positive-28-type-method-signature',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it('scopes generic change artifacts to two unrelated child identities without collision', () => {
    const testCase = loadCases().find(
      (item) => item.id === 'p11-positive-27-two-child-change-collision'
    )!;
    const observation = observe(testCase);
    const artifacts = observation.nodes.filter((node) => node.endsWith(':event:change'));
    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts).size).toBe(2);
    expect(artifacts.every((id) => id.includes('Child.vue:event:change'))).toBe(true);
    expect(
      observation.edges.filter((edge) => edge.type === 'handles_component_event')
    ).toHaveLength(2);
  });

  it('excludes import-unused, unknown, undeclared, dynamic, shadowed, object, and malformed forms', () => {
    const result = runBattery(loadCases());
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    for (const id of [
      'p11-forbidden-01-imported-unused',
      'p11-forbidden-02-unknown-child-tag',
      'p11-forbidden-03-undeclared-child-event',
      'p11-forbidden-04-dynamic-declaration-variable',
      'p11-forbidden-05-dynamic-concatenation',
      'p11-forbidden-06-dynamic-template-substitution',
      'p11-forbidden-07-spread-array-declaration',
      'p11-forbidden-08-spread-object-declaration',
      'p11-forbidden-09-arbitrary-emit-function',
      'p11-forbidden-10-shadowed-define-emits',
      'p11-forbidden-11-dynamic-listener-argument',
      'p11-forbidden-12-listener-object',
      'p11-forbidden-13-dynamic-model-argument',
      'p11-forbidden-14-dynamic-sync-argument',
      'p11-forbidden-15-malformed-child-sfc',
      'p11-forbidden-16-malformed-parent-sfc',
      'p11-forbidden-17-forwarded-attrs',
      'p11-forbidden-18-shadowed-setup-emit',
    ]) {
      expect(
        byId.get(id)?.edges.filter((edge) => edge.type === 'handles_component_event'),
        id
      ).toEqual([]);
    }
    expect(byId.get('p11-forbidden-15-malformed-child-sfc')?.coverage).toBe('partial');
    expect(byId.get('p11-forbidden-16-malformed-parent-sfc')?.coverage).toBe('partial');
  });

  it('removes obsolete child event artifacts and inbound handlers on one-file refresh', () => {
    const refresh = refreshChild(loadCases());
    expect(refresh.before.nodes.filter((node) => node.includes(':event:'))).toHaveLength(1);
    expect(refresh.removedArtifactIds).toHaveLength(1);
    expect(refresh.removedInboundIds).toHaveLength(1);
    expect(refresh.after.edges).toEqual([]);
    expect(refresh.unrelatedStable).toBe(true);
  });

  it('has deterministic evidence, no duplicate or dangling rows, and a stable digest', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(first.duplicateNodeIds).toBe(0);
    expect(first.duplicateEdgeIds).toBe(0);
    expect(first.danglingTargets).toBe(0);
    expect(
      first.observations
        .flatMap((item) => item.edges)
        .every((edge) => edge.confidence === 'framework-inferred' && edge.evidence.length > 0)
    ).toBe(true);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.digest).toBe(second.digest);
  });

  it('records the VAL-06 performance protocol', () => {
    expect(loadCases()[0].performanceProtocol).toEqual({
      warmups: 3,
      measurements: 5,
      maxRegressionRatio: 1.2,
      baselineWallMs: 1000,
      baselineRssBytes: 268435456,
    });
  });

  it('executes every prescribed identity, scope, dynamic, declaration, direction, remove, inject, and integrity mutation red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'remove-child-from-event-identity',
      'scope-event-to-parent',
      'permit-dynamic-name',
      'handler-without-child-declaration',
      'swap-canonical-direction',
      'remove-required-edge',
      'inject-forbidden-edge',
      'duplicate-row',
      'dangling-target',
    ]);
    for (const control of controls) {
      const result = watchedMutationResult(cases, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some((failure) => failure.startsWith(`${control.expectedCase}:`)),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
    const collision = watchedMutationResult(cases, 'remove-child-from-event-identity');
    expect(collision.duplicateNodeIds).toBeGreaterThan(0);
    expect(collision.failures).toContain('integrity: 1 duplicate nodes');
  });
});
