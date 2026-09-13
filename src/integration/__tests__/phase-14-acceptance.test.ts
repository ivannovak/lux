import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
import {
  novaArtifactId,
  programEdgeId,
  vueComponentId,
} from '../../scanner/identity/program-identity.js';

/**
 * Independent Phase 14 contract battery (T54).
 *
 * This is an executable seam, not a production-leaf test double: it extracts the
 * frozen supported Nova subset from source strings and resolves only exact
 * first-party targets supplied by each portable fixture. T53/T55 can replace the
 * seam while this owner gold, scoring, safety, and mutation contract stays fixed.
 */

type Coverage = 'active' | 'partial' | 'failed';
type NovaEdgeType = 'provides_capability' | 'transforms_model' | 'hydrates_component';
type MutationId =
  | 'include-vendor-resources'
  | 'accept-dynamic-registration'
  | 'reverse-registration-edge'
  | 'reverse-model-edge'
  | 'bind-resource-by-basename'
  | 'emit-duplicate-edges'
  | 'wrong-acme-model'
  | 'remove-required-edge'
  | 'inject-forbidden-edge';

type GoldEdge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];

interface SourceLocation {
  filePath: string;
  line: number;
  column: number;
}

interface QueryArgs {
  [key: string]: unknown;
  registrationFile: string;
  source: string;
  files: Record<string, string>;
  firstPartyRoots: string[];
}

interface Thresholds {
  registrationRecall: number;
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
  sourceFamily?: string;
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
  query: { tool: string; args: QueryArgs };
}

interface ReturnedEdge {
  id: string;
  source: string;
  type: NovaEdgeType;
  target: string;
  confidence: 'framework-inferred';
  evidence: SourceLocation[];
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
  recall: number;
  precision: number;
}

interface BatteryResult {
  exitCode: 0 | 1;
  failures: string[];
  observations: Observation[];
  overall: Score;
  registration: Score;
  positiveCases: number;
  forbiddenCases: number;
  vendorFalseEdges: number;
  dynamicFalseEdges: number;
  duplicateEdgeIds: number;
  danglingTargets: number;
  digest: string;
}

interface PhpClass {
  fqcn: string;
  filePath: string;
  source: string;
}

interface SeamOptions {
  mutation?: MutationId;
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(here, '../../../benchmarks/relationship/cases/phase-14.json');
const LUX_PIN = 'adbb7c141c700c13a1a54c71893fb9303cc65ba2';
const CORE_PIN = '3afee6c0a42808c905c6830e5073eb83386c8409';
const PRODUCER = 'laravel-nova';

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkPath, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sourceLocation(source: string, offset: number, filePath: string): SourceLocation {
  const lines = source.slice(0, offset).split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function namespaceOf(source: string): string {
  return /\bnamespace\s+([^;]+);/u.exec(source)?.[1]?.trim() ?? '';
}

function classNameOf(source: string): string | undefined {
  return /\bclass\s+([A-Za-z_][\w]*)/u.exec(source)?.[1];
}

function importsOf(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/\buse\s+([^;]+);/gu)) {
    const declaration = match[1].trim();
    const aliasMatch = /^(.*?)\s+as\s+([A-Za-z_][\w]*)$/iu.exec(declaration);
    const fqcn = (aliasMatch?.[1] ?? declaration).replace(/^\\/u, '');
    const alias = aliasMatch?.[2] ?? fqcn.split('\\').at(-1)!;
    imports.set(alias, fqcn);
  }
  return imports;
}

function resolveClassName(raw: string, source: string): string {
  const value = raw.trim().replace(/^\\/u, '');
  if (raw.trim().startsWith('\\')) return value;
  const [head, ...tail] = value.split('\\');
  const imported = importsOf(source).get(head);
  if (imported) return [imported, ...tail].join('\\');
  return [namespaceOf(source), value].filter(Boolean).join('\\');
}

function phpClasses(args: QueryArgs): PhpClass[] {
  return Object.entries({ ...args.files, [args.registrationFile]: args.source }).flatMap(
    ([filePath, source]) => {
      const className = classNameOf(source);
      return className
        ? [{ fqcn: [namespaceOf(source), className].filter(Boolean).join('\\'), filePath, source }]
        : [];
    }
  );
}

function safeLiteralPath(path: string, roots: readonly string[]): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const normalized = posix.normalize(path).replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../')) return false;
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isVendor(path: string): boolean {
  return path === 'vendor' || path.startsWith('vendor/');
}

function edge(
  type: NovaEdgeType,
  source: string,
  target: string,
  evidence: SourceLocation
): ReturnedEdge {
  return {
    id: programEdgeId(type, source, target, PRODUCER),
    source,
    type,
    target,
    confidence: 'framework-inferred',
    evidence: [evidence],
  };
}

function artifactTarget(path: string): string {
  return path.endsWith('.vue') ? vueComponentId(path) : `file:${path}`;
}

function observe(testCase: PhaseCase, options: SeamOptions = {}): Observation {
  const args = testCase.query.args;
  const diagnostics: string[] = [];
  const nodes = new Set<string>();
  const edges: ReturnedEdge[] = [];
  const classes = phpClasses(args);
  const exactClasses = new Map(classes.map((item) => [item.fqcn, item]));
  const sourceClass = classes.find((item) => item.filePath === args.registrationFile);
  const sourceId = sourceClass ? `symbol:php:${sourceClass.fqcn}` : `file:${args.registrationFile}`;
  nodes.add(sourceId);
  for (const item of classes) nodes.add(`symbol:php:${item.fqcn}`);
  for (const path of Object.keys(args.files)) {
    if (path.endsWith('.vue')) nodes.add(vueComponentId(path));
    else if (/\.[cm]?[jt]sx?$/u.test(path)) nodes.add(`file:${path}`);
  }

  const emitRegistration = (raw: string, offset: number): void => {
    const fqcn = resolveClassName(raw, args.source);
    let target = exactClasses.get(fqcn);
    if (!target && options.mutation === 'bind-resource-by-basename') {
      const basename = fqcn.split('\\').at(-1);
      target = classes.find((item) => item.fqcn.split('\\').at(-1) === basename);
    }
    if (!target) {
      diagnostics.push('nova-target-missing');
      return;
    }
    if (isVendor(target.filePath) && options.mutation !== 'include-vendor-resources') {
      diagnostics.push('nova-vendor-excluded');
      return;
    }
    let candidate = edge(
      'provides_capability',
      sourceId,
      `symbol:php:${target.fqcn}`,
      sourceLocation(args.source, offset, args.registrationFile)
    );
    if (options.mutation === 'reverse-registration-edge') {
      candidate = edge(candidate.type, candidate.target, candidate.source, candidate.evidence[0]);
    }
    edges.push(candidate);
  };

  const literalRegistrations: Array<{ raw: string; offset: number }> = [];
  const registrationCalls =
    /(?:\\Laravel\\Nova\\Nova|[A-Za-z_][\w]*)\s*::\s*(resources|tools)\s*\(\s*\[([\s\S]*?)\]\s*\)/gu;
  for (const call of args.source.matchAll(registrationCalls)) {
    const body = call[2];
    for (const item of body.matchAll(
      /(?:new\s+)?(\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*)\s*(?:\([^)]*\))?\s*(?:::class)?/gu
    )) {
      if (['new', 'class'].includes(item[1])) continue;
      literalRegistrations.push({ raw: item[1], offset: call.index + item.index });
    }
  }
  const providerMethod =
    /\bfunction\s+(resources|tools)\s*\([^)]*\)[^{]*\{[\s\S]*?\breturn\s*\[([\s\S]*?)\]\s*;/gu;
  for (const method of args.source.matchAll(providerMethod)) {
    for (const item of method[2].matchAll(
      /(?:new\s+)?(\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*)\s*(?:\([^)]*\))?\s*(?:::class)?/gu
    )) {
      if (['new', 'class'].includes(item[1])) continue;
      literalRegistrations.push({ raw: item[1], offset: method.index + item.index });
    }
  }
  for (const registration of literalRegistrations)
    emitRegistration(registration.raw, registration.offset);

  const dynamicRegistration =
    /::\s*(?:resources|tools)\s*\(\s*(?!\[)([^)]+)\)|\bfunction\s+(?:resources|tools)\s*\([^)]*\)[^{]*\{[\s\S]*?\breturn\s+(?!\[)([^;]+);/u.exec(
      args.source
    );
  if (dynamicRegistration) {
    diagnostics.push('nova-dynamic-registration');
    if (options.mutation === 'accept-dynamic-registration') {
      const target = classes.find((item) => item.filePath !== args.registrationFile);
      if (target) emitRegistration(`\\${target.fqcn}`, dynamicRegistration.index);
    }
  }

  const resourcesInLiteral = /::\s*resourcesIn\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/gu;
  let sawResourcesIn = false;
  for (const registration of args.source.matchAll(resourcesInLiteral)) {
    sawResourcesIn = true;
    const directory = registration[2].replace(/\/$/u, '');
    if (
      !safeLiteralPath(directory, args.firstPartyRoots) &&
      !(isVendor(directory) && options.mutation === 'include-vendor-resources')
    ) {
      diagnostics.push(directory.includes('..') ? 'nova-path-traversal' : 'nova-vendor-excluded');
      continue;
    }
    if (isVendor(directory) && options.mutation !== 'include-vendor-resources') {
      diagnostics.push('nova-vendor-excluded');
      continue;
    }
    for (const candidate of classes) {
      if (
        candidate.filePath.startsWith(`${directory}/`) &&
        /extends\s+(?:\\Laravel\\Nova\\)?Resource\b/u.test(candidate.source)
      ) {
        emitRegistration(`\\${candidate.fqcn}`, registration.index);
      }
    }
  }
  if (!sawResourcesIn && /::\s*resourcesIn\s*\(/u.test(args.source)) {
    diagnostics.push('nova-dynamic-path');
  }

  const model =
    /\bpublic\s+static\s+(?:[?A-Za-z_\\][\w\\|]*\s+)?\$model\s*=\s*(\\?[A-Za-z_][\w]*(?:\\[A-Za-z_][\w]*)*)::class\s*;/u.exec(
      args.source
    );
  if (model && sourceClass) {
    const modelFqcn = resolveClassName(model[1], args.source);
    const target = exactClasses.get(modelFqcn);
    if (!target) diagnostics.push('nova-target-missing');
    else {
      let modelTarget = `symbol:php:${modelFqcn}`;
      if (options.mutation === 'wrong-acme-model' && testCase.corpus === 'acme-core') {
        modelTarget = modelTarget.replace(/\\Offer$/u, '\\OfferChain');
      }
      let candidate = edge(
        'transforms_model',
        sourceId,
        modelTarget,
        sourceLocation(args.source, model.index, args.registrationFile)
      );
      if (options.mutation === 'reverse-model-edge') {
        candidate = edge(candidate.type, candidate.target, candidate.source, candidate.evidence[0]);
      }
      edges.push(candidate);
    }
  } else if (/extends\s+(?:\\Laravel\\Nova\\)?Resource\b/u.test(args.source)) {
    diagnostics.push('nova-model-missing');
  }

  const staticArtifact =
    /::\s*(script|style)\s*\(\s*(['"])([^'"\r\n]+)\2\s*,\s*(['"])([^'"\r\n]+)\4\s*\)/gu;
  let staticArtifactCount = 0;
  for (const artifact of args.source.matchAll(staticArtifact)) {
    staticArtifactCount += 1;
    const [, kind, , name, , path] = artifact;
    const artifactId = novaArtifactId(args.registrationFile, name);
    nodes.add(artifactId);
    if (!safeLiteralPath(path, args.firstPartyRoots) || isVendor(path)) {
      diagnostics.push(isVendor(path) ? 'nova-vendor-excluded' : 'nova-path-traversal');
      continue;
    }
    if (!(path in args.files)) {
      diagnostics.push('nova-target-missing');
      continue;
    }
    if (kind === 'script') {
      edges.push(
        edge(
          'hydrates_component',
          artifactId,
          artifactTarget(path),
          sourceLocation(args.source, artifact.index, args.registrationFile)
        )
      );
    }
  }
  if (staticArtifactCount === 0 && /::\s*(?:script|style)\s*\(/u.test(args.source)) {
    diagnostics.push('nova-dynamic-path');
  }

  const component = /\$(?:component)\s*=\s*(['"])([^'"\r\n]+)\1/u.exec(args.source);
  if (component) {
    const path = component[2];
    const artifactId = novaArtifactId(args.registrationFile, 'component');
    nodes.add(artifactId);
    if (!safeLiteralPath(path, args.firstPartyRoots) || isVendor(path)) {
      diagnostics.push('nova-vendor-excluded');
    } else if (!(path in args.files)) {
      diagnostics.push('nova-target-missing');
    } else {
      edges.push(
        edge(
          'hydrates_component',
          artifactId,
          artifactTarget(path),
          sourceLocation(args.source, component.index, args.registrationFile)
        )
      );
    }
  }

  if (
    options.mutation === 'inject-forbidden-edge' &&
    testCase.id === 'p14-forbidden-07-missing-resource'
  ) {
    edges.push(
      edge(
        'provides_capability',
        sourceId,
        'symbol:php:App\\Nova\\Ghost',
        sourceLocation(args.source, 0, args.registrationFile)
      )
    );
  }
  if (
    options.mutation === 'remove-required-edge' &&
    testCase.id === 'p14-positive-01-resource-array'
  ) {
    edges.splice(0, 1);
  }

  const deduped =
    options.mutation === 'emit-duplicate-edges'
      ? edges
      : [...new Map(edges.map((item) => [item.id, item])).values()];
  return {
    caseId: testCase.id,
    coverage: 'active',
    diagnostics: [...new Set(diagnostics)].sort(),
    nodes: [...nodes].sort(),
    edges: deduped,
  };
}

function edgeKey(edgeValue: GoldEdge | ForbiddenEdge | ReturnedEdge): string {
  return `${edgeValue.source ?? '*'}|${edgeValue.type ?? '*'}|${edgeValue.target ?? '*'}`;
}

function forbiddenMatches(edgeValue: ReturnedEdge, forbidden: ForbiddenEdge): boolean {
  return (
    (!forbidden.source || forbidden.source === edgeValue.source) &&
    (!forbidden.type || forbidden.type === edgeValue.type) &&
    (!forbidden.target || forbidden.target === edgeValue.target)
  );
}

function score(
  cases: readonly PhaseCase[],
  observations: readonly Observation[],
  predicate: (edgeValue: GoldEdge | ReturnedEdge) => boolean = () => true
): Score {
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  let expected = 0;
  let returned = 0;
  let matched = 0;
  for (const testCase of cases) {
    const expectedKeys = new Set(testCase.expectedEdges.filter(predicate).map(edgeKey));
    const returnedKeys = new Set(
      (byId.get(testCase.id)?.edges ?? []).filter(predicate).map(edgeKey)
    );
    expected += expectedKeys.size;
    returned += returnedKeys.size;
    matched += [...expectedKeys].filter((key) => returnedKeys.has(key)).length;
  }
  return {
    expected,
    returned,
    matched,
    recall: expected === 0 ? 1 : matched / expected,
    precision: returned === 0 ? (expected === 0 ? 1 : 0) : matched / returned,
  };
}

function runBattery(cases: readonly PhaseCase[], options: SeamOptions = {}): BatteryResult {
  const observations = cases.map((item) => observe(item, options));
  const byId = new Map(observations.map((item) => [item.caseId, item]));
  const failures: string[] = [];
  for (const testCase of cases) {
    const observation = byId.get(testCase.id)!;
    const actual = new Set(observation.edges.map(edgeKey));
    for (const expected of testCase.expectedEdges) {
      if (!actual.has(edgeKey(expected)))
        failures.push(`${testCase.id}: missing ${edgeKey(expected)}`);
    }
    for (const forbidden of testCase.forbiddenEdges) {
      if (observation.edges.some((item) => forbiddenMatches(item, forbidden))) {
        failures.push(`${testCase.id}: forbidden ${edgeKey(forbidden)}`);
      }
    }
    if (
      JSON.stringify(observation.diagnostics) !==
      JSON.stringify([...testCase.expectedDiagnostics].sort())
    ) {
      failures.push(`${testCase.id}: diagnostics mismatch`);
    }
  }

  const allEdges = observations.flatMap((item) => item.edges);
  const duplicateEdgeIds = observations.reduce(
    (count, item) =>
      count + item.edges.length - new Set(item.edges.map((candidate) => candidate.id)).size,
    0
  );
  const allNodes = new Set(observations.flatMap((item) => item.nodes));
  const danglingTargets = allEdges.filter((item) => !allNodes.has(item.target)).length;
  if (duplicateEdgeIds > 0) failures.push(`integrity: ${duplicateEdgeIds} duplicate edge ids`);
  if (danglingTargets > 0) failures.push(`integrity: ${danglingTargets} dangling targets`);

  const overall = score(cases, observations);
  const registration = score(cases, observations, (item) => item.type === 'provides_capability');
  const thresholds = cases[0].thresholds;
  if (overall.recall < thresholds.minRecall) failures.push('score: overall recall below threshold');
  if (overall.precision < thresholds.minPrecision)
    failures.push('score: overall precision below threshold');
  if (registration.recall < thresholds.registrationRecall) {
    failures.push('score: registration recall below threshold');
  }

  const synthetic = cases.filter((item) => item.corpus === 'phase-14-nova-synthetic');
  const positiveCases = synthetic.filter((item) => item.expectedEdges.length > 0).length;
  const forbiddenCases = synthetic.filter((item) => item.forbiddenEdges.length > 0).length;
  if (positiveCases < thresholds.minPositiveCases)
    failures.push('score: insufficient positive cases');
  if (forbiddenCases < thresholds.minForbiddenCases)
    failures.push('score: insufficient forbidden cases');

  const vendorFalseEdges = observations
    .filter((item) => item.caseId.includes('vendor-'))
    .reduce((sum, item) => sum + item.edges.length, 0);
  const dynamicFalseEdges = observations
    .filter((item) => item.caseId.includes('dynamic-'))
    .reduce((sum, item) => sum + item.edges.length, 0);
  if (vendorFalseEdges > 0) failures.push('integrity: vendor false edge');
  if (dynamicFalseEdges > 0) failures.push('integrity: dynamic false edge');

  const projection = observations.map((item) => ({
    caseId: item.caseId,
    nodes: item.nodes,
    edges: item.edges.map(({ id, source, type, target }) => ({ id, source, type, target })),
  }));
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    observations,
    overall,
    registration,
    positiveCases,
    forbiddenCases,
    vendorFalseEdges,
    dynamicFalseEdges,
    duplicateEdgeIds,
    danglingTargets,
    digest: stableHash(projection),
  };
}

function cohortScore(cases: readonly PhaseCase[], result: BatteryResult, corpus: string): Score {
  const ids = new Set(cases.filter((item) => item.corpus === corpus).map((item) => item.id));
  return score(
    cases.filter((item) => ids.has(item.id)),
    result.observations.filter((item) => ids.has(item.caseId))
  );
}

describe('Phase 14 independent Nova acceptance', () => {
  it('pins portable schema-v1 synthetic and exact-commit Acme owner gold', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(42);
    expect(cases.every((item) => item.goldSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.fixtureSchemaVersion === 1)).toBe(true);
    expect(new Set(cases.map((item) => item.owner))).toEqual(new Set(['Example Maintainer']));
    expect(cases.find((item) => item.corpus === 'phase-14-nova-synthetic')?.corpusPin).toEqual({
      remote: 'https://github.com/ivannovak/lux.git',
      commit: LUX_PIN,
    });
    expect(cases.find((item) => item.corpus === 'acme-core')?.corpusPin).toEqual({
      remote: 'https://github.com/acme-software/acme-core.git',
      commit: CORE_PIN,
    });
    expect(JSON.stringify(cases)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\/home\/)/u);
  });

  it('executes at least 20 positive and 10 forbidden synthetic cases at precision/recall 1', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.positiveCases).toBeGreaterThanOrEqual(20);
    expect(result.forbiddenCases).toBeGreaterThanOrEqual(10);
    expect(result.overall.recall).toBe(1);
    expect(result.overall.precision).toBe(1);
  });

  it('covers resource arrays, provider resources/tools, resourcesIn, models, scripts, styles, and components', () => {
    expect(loadCases()[0].fixture).toEqual({
      rootPath: '.',
      subtrees: [
        'resource-arrays',
        'provider-methods',
        'tools',
        'resources-in',
        'models',
        'scripts',
        'styles',
        'components',
        'duplicates',
        'dynamic',
        'missing',
        'vendor',
        'traversal',
        'acme',
      ],
    });
    const byId = new Map(runBattery(loadCases()).observations.map((item) => [item.caseId, item]));
    expect(byId.get('p14-positive-03-provider-resources-method')?.edges).toHaveLength(1);
    expect(byId.get('p14-positive-06-provider-tools-method')?.edges).toHaveLength(1);
    expect(byId.get('p14-positive-08-resources-in')?.edges).toHaveLength(1);
    expect(byId.get('p14-positive-11-typed-model-invoice')?.edges).toHaveLength(1);
    expect(byId.get('p14-positive-17-script-and-style')?.nodes).toContain(
      novaArtifactId('app/Providers/NovaServiceProvider.php', 'reports')
    );
    expect(byId.get('p14-positive-18-card-component')?.edges).toHaveLength(1);
  });

  it('meets 100% registration recall and the overall Nova precision/recall thresholds', () => {
    const result = runBattery(loadCases());
    expect(result.registration.recall).toBe(1);
    expect(result.overall.precision).toBeGreaterThanOrEqual(0.95);
    expect(result.overall.recall).toBeGreaterThanOrEqual(0.9);
  });

  it('rejects dynamic, vendor, traversal, missing, unrelated, and basename-only targets', () => {
    const result = runBattery(loadCases());
    expect(result.vendorFalseEdges).toBe(0);
    expect(result.dynamicFalseEdges).toBe(0);
    const forbidden = result.observations.filter((item) =>
      item.caseId.startsWith('p14-forbidden-')
    );
    expect(forbidden).toHaveLength(12);
    expect(forbidden.every((item) => item.edges.length === 0)).toBe(true);
  });

  it('deduplicates repeated registration and has no duplicate identities or dangling targets', () => {
    const result = runBattery(loadCases());
    expect(
      result.observations.find(
        (item) => item.caseId === 'p14-positive-19-duplicate-registration-deduplicated'
      )?.edges
    ).toHaveLength(1);
    expect(result.duplicateEdgeIds).toBe(0);
    expect(result.danglingTargets).toBe(0);
  });

  it('pins all eight required exact-pin Acme source families with a perfect cohort score', () => {
    const cases = loadCases();
    expect(
      cases.filter((item) => item.corpus === 'acme-core').map((item) => item.sourceFamily)
    ).toEqual([
      'src/Module/Offers/ServiceProvider.php',
      'src/Module/Offers/Nova/Offer.php',
      'src/Module/Offers/Nova/OfferChain.php',
      'src/Module/Contact/ServiceProvider.php',
      'src/Module/Contact/Nova/Contact.php',
      'src/Module/BusinessEntity/ServiceProvider.php',
      'src/Module/BusinessEntity/Nova/BusinessEntity.php',
      'src/Module/BusinessEntity/Nova/BusinessEntityAddress.php',
    ]);
    const scoreResult = cohortScore(cases, runBattery(cases), 'acme-core');
    expect(scoreResult.recall).toBe(1);
    expect(scoreResult.precision).toBe(1);
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

  it('executes every prescribed vendor/dynamic/direction/basename/duplicate/Acme/remove/inject mutant red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'include-vendor-resources',
      'accept-dynamic-registration',
      'reverse-registration-edge',
      'reverse-model-edge',
      'bind-resource-by-basename',
      'emit-duplicate-edges',
      'wrong-acme-model',
      'remove-required-edge',
      'inject-forbidden-edge',
    ]);
    for (const control of controls) {
      const result = runBattery(cases, { mutation: control.id });
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some(
          (failure) =>
            failure.startsWith(`${control.expectedCase}:`) ||
            failure.startsWith('integrity:') ||
            failure.startsWith('score:')
        ),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
