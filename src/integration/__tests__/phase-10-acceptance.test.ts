import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
import { programEdgeId, vueComponentId } from '../../scanner/identity/program-identity.js';

/**
 * Independent Phase 10 contract battery (T38).
 *
 * The seam is intentionally executable without either Phase 10 production
 * resolver. T37/T39 can substitute the production seam while owner gold,
 * cohort scoring, refresh behavior, and watched-red controls remain fixed.
 */

type Capability = 'vue-composable-semantics' | 'vue-store-semantics';
type MutationId =
  | 'emit-on-import'
  | 'drop-import-binding-resolution'
  | 'classify-lowercase-user-as-composable'
  | 'globally-bind-this-store'
  | 'retain-edge-after-source-edit'
  | 'retain-alias-edge-after-config-edit'
  | 'remove-required-edge'
  | 'inject-forbidden-edge';

type GoldEdge = RelationshipBenchmarkCaseV1['expectedEdges'][number];
type ForbiddenEdge = RelationshipBenchmarkCaseV1['forbiddenEdges'][number];
type Coverage = 'active' | 'partial' | 'failed';

interface QueryArgs {
  parentPath: string;
  source: string;
  files: Record<string, string>;
  resolutions: Record<string, string>;
  configFiles?: string[];
  configMutationResolutions?: Record<string, string>;
}

interface Thresholds {
  minRecall: number;
  minPrecision: number;
  minPositiveCases: number;
  minForbiddenCases: number;
}

interface PhaseCase extends RelationshipBenchmarkCaseV1 {
  capability: Capability;
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
  realGold?: {
    approvedBy: string;
    source: string;
    portable: boolean;
    sourceSha256: Record<string, string>;
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
  type: 'uses_composable' | 'uses_store';
  target: string;
  confidence: 'framework-inferred';
  evidence: Location[];
  evidenceFiles: string[];
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
  cohorts: Record<Capability, Score>;
  duplicateEdgeIds: number;
  danglingTargets: number;
  digest: string;
}

interface ImportBinding {
  local: string;
  imported: string;
  specifier: string;
  location: Location;
}

interface ResolvedExport {
  filePath: string;
  exportName: string;
  declaration: Location;
  kind: 'composable' | 'pinia' | 'vuex' | 'key';
}

const here = dirname(fileURLToPath(import.meta.url));
const benchmarkPath = resolve(here, '../../../benchmarks/relationship/cases/phase-10.json');
const LUX_PIN = 'adbb7c141c700c13a1a54c71893fb9303cc65ba2';
const CORE_PIN = '3afee6c0a42808c905c6830e5073eb83386c8409';
const PRODUCER = 'vue-semantics';
const CAPABILITIES: Capability[] = ['vue-composable-semantics', 'vue-store-semantics'];

function loadCases(): PhaseCase[] {
  return JSON.parse(readFileSync(benchmarkPath, 'utf8')) as PhaseCase[];
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function symbolId(path: string, name: string): string {
  return `symbol:ts:${path}#${name}`;
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

function scriptSource(source: string): string {
  const blocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)];
  return blocks.length === 0 ? source : blocks.map((match) => match[1]).join('\n');
}

function importBindings(source: string, filePath: string): ImportBinding[] {
  const script = scriptSource(source);
  const result: ImportBinding[] = [];
  const pattern = /import\s+(?!type\b)([^;'"\n]+?)\s+from\s+["']([^"']+)["']/gu;
  for (const match of script.matchAll(pattern)) {
    const clause = match[1].trim();
    const specifier = match[2];
    const start = match.index ?? 0;
    const namedStart = clause.indexOf('{');
    if (namedStart >= 0) {
      const namedEnd = clause.lastIndexOf('}');
      for (const member of clause.slice(namedStart + 1, namedEnd).split(',')) {
        const [imported, alias] = member.trim().split(/\s+as\s+/u);
        if (imported) {
          result.push({
            imported,
            local: alias ?? imported,
            specifier,
            location: location(script, start, filePath),
          });
        }
      }
    }
    const defaultPart = clause.split(',')[0].trim();
    if (defaultPart && !defaultPart.startsWith('{') && !defaultPart.startsWith('*')) {
      result.push({
        imported: 'default',
        local: defaultPart,
        specifier,
        location: location(script, start, filePath),
      });
    }
  }
  return result;
}

function resolveFile(
  importer: string,
  specifier: string,
  files: Readonly<Record<string, string>>,
  resolutions: Readonly<Record<string, string>>
): string | undefined {
  if (resolutions[specifier] && files[resolutions[specifier]]) return resolutions[specifier];
  if (!specifier.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ]) {
    if (files[candidate] !== undefined) return candidate;
  }
  return undefined;
}

function declarationInModule(
  filePath: string,
  exportName: string,
  files: Readonly<Record<string, string>>,
  resolutions: Readonly<Record<string, string>>,
  visited = new Set<string>()
): ResolvedExport | undefined {
  const visitKey = `${filePath}\0${exportName}`;
  if (visited.has(visitKey)) return undefined;
  visited.add(visitKey);
  const source = files[filePath];
  if (source === undefined) return undefined;
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

  if (exportName === 'default') {
    const vuexDefault = /export\s+default\s+(?:createStore\s*\(|new\s+Vuex\.Store\s*\()/u.exec(
      source
    );
    if (vuexDefault) {
      return {
        filePath,
        exportName,
        declaration: location(source, vuexDefault.index, filePath),
        kind: 'vuex',
      };
    }
  } else {
    const functionDeclaration = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${escaped}\\s*(?:<[^>{}]+>)?\\s*\\(`,
      'u'
    ).exec(source);
    const functionBinding = new RegExp(
      `export\\s+const\\s+${escaped}(?:\\s*:[^=]+)?\\s*=\\s*(?:async\\s+)?(?:function\\b|(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`,
      'u'
    ).exec(source);
    if (functionDeclaration || functionBinding) {
      const found = functionDeclaration ?? functionBinding!;
      return {
        filePath,
        exportName,
        declaration: location(source, found.index, filePath),
        kind: 'composable',
      };
    }
    const pinia = new RegExp(
      `export\\s+const\\s+${escaped}(?:\\s*:[^=]+)?\\s*=\\s*defineStore\\s*\\(`,
      'u'
    ).exec(source);
    if (pinia) {
      return {
        filePath,
        exportName,
        declaration: location(source, pinia.index, filePath),
        kind: 'pinia',
      };
    }
    const vuex = new RegExp(
      `export\\s+const\\s+${escaped}(?:\\s*:[^=]+)?\\s*=\\s*(?:createStore\\s*\\(|new\\s+Vuex\\.Store\\s*\\()`,
      'u'
    ).exec(source);
    if (vuex) {
      return {
        filePath,
        exportName,
        declaration: location(source, vuex.index, filePath),
        kind: 'vuex',
      };
    }
    const key = new RegExp(
      `export\\s+const\\s+${escaped}(?:\\s*:[^=]+)?\\s*=\\s*(?:Symbol\\s*\\(|[^;\\n]*InjectionKey)`,
      'u'
    ).exec(source);
    if (key) {
      return {
        filePath,
        exportName,
        declaration: location(source, key.index, filePath),
        kind: 'key',
      };
    }
  }

  const reexports = /export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(reexports)) {
    for (const member of match[1].split(',')) {
      const [original, alias] = member.trim().split(/\s+as\s+/u);
      const exposed = alias ?? original;
      if (exposed !== exportName) continue;
      const targetFile = resolveFile(filePath, match[2], files, resolutions);
      if (!targetFile) return undefined;
      return declarationInModule(targetFile, original, files, resolutions, visited);
    }
  }
  return undefined;
}

function hasCall(source: string, local: string): { used: boolean; at: number } {
  const script = scriptSource(source).replace(
    /import\s+(?!\()(?:(?!;|\n)[\s\S])*?from\s+["'][^"']+["'];?/gu,
    ''
  );
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const shadows = new RegExp(
    `(?:function|const|let|var|class)\\s+${escaped}\\b|(?:function\\s*\\([^)]*\\b${escaped}\\b[^)]*\\))`,
    'u'
  );
  if (shadows.test(script)) return { used: false, at: -1 };
  const call = new RegExp(`(?<![.$\\w])${escaped}\\s*(?:<[^;()]+>)?\\s*\\(`, 'u').exec(script);
  return { used: call !== null, at: call?.index ?? -1 };
}

function hasDirectReference(source: string, local: string): { used: boolean; at: number } {
  const script = scriptSource(source).replace(
    /import\s+(?!\()(?:(?!;|\n)[\s\S])*?from\s+["'][^"']+["'];?/gu,
    ''
  );
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const shadows = new RegExp(`(?:function|const|let|var|class)\\s+${escaped}\\b`, 'u');
  if (shadows.test(script)) return { used: false, at: -1 };
  const reference = new RegExp(`(?<![.$\\w])${escaped}\\s*(?:\\.|\\[)`, 'u').exec(script);
  return { used: reference !== null, at: reference?.index ?? -1 };
}

function semanticEdge(
  capability: Capability,
  parentPath: string,
  declaration: ResolvedExport,
  evidence: Location[],
  configFiles: readonly string[] = []
): ReturnedEdge {
  const source = vueComponentId(parentPath);
  const target = symbolId(declaration.filePath, declaration.exportName);
  const type = capability === 'vue-composable-semantics' ? 'uses_composable' : 'uses_store';
  return {
    id: programEdgeId(type, source, target, PRODUCER),
    source,
    type,
    target,
    confidence: 'framework-inferred',
    evidence,
    evidenceFiles: [...new Set([declaration.filePath, ...configFiles])].sort(),
  };
}

function observe(
  testCase: PhaseCase,
  mutation?: MutationId,
  override?: Partial<QueryArgs>
): Observation {
  const args = { ...(testCase.query.args as unknown as QueryArgs), ...override };
  const imports = importBindings(args.source, args.parentPath);
  const diagnostics: string[] = [];
  const edges: ReturnedEdge[] = [];
  const declaredTargets: ResolvedExport[] = [];

  if (mutation !== 'drop-import-binding-resolution') {
    for (const binding of imports) {
      const resolvedFile = resolveFile(
        args.parentPath,
        binding.specifier,
        args.files,
        args.resolutions
      );
      if (!resolvedFile) {
        if (binding.specifier.startsWith('@missing/')) diagnostics.push('unresolved-import');
        continue;
      }
      const declaration = declarationInModule(
        resolvedFile,
        binding.imported,
        args.files,
        args.resolutions
      );
      if (!declaration) continue;
      declaredTargets.push(declaration);
      const called = hasCall(args.source, binding.local);
      const direct = hasDirectReference(args.source, binding.local);
      const composableName = declaration.exportName;
      const validComposable =
        /^use(?:[A-Z0-9])/u.test(composableName) ||
        (mutation === 'classify-lowercase-user-as-composable' && composableName === 'user');
      const importOnly = mutation === 'emit-on-import';
      const validUse =
        testCase.capability === 'vue-composable-semantics'
          ? declaration.kind === 'composable' && validComposable && (called.used || importOnly)
          : declaration.kind === 'pinia'
            ? called.used || importOnly
            : declaration.kind === 'vuex' && (direct.used || importOnly);
      if (validUse) {
        const useOffset = called.used ? called.at : direct.used ? direct.at : 0;
        edges.push(
          semanticEdge(
            testCase.capability,
            args.parentPath,
            declaration,
            [
              binding.location,
              declaration.declaration,
              location(scriptSource(args.source), Math.max(0, useOffset), args.parentPath),
            ],
            args.configFiles
          )
        );
      }
    }

    if (testCase.capability === 'vue-store-semantics') {
      const script = scriptSource(args.source);
      const useStoreCall = /(?<![.$\w])useStore\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/u.exec(script);
      if (useStoreCall) {
        const keyBinding = imports.find((item) => item.local === useStoreCall[1]);
        if (keyBinding) {
          const keyFile = resolveFile(
            args.parentPath,
            keyBinding.specifier,
            args.files,
            args.resolutions
          );
          const keyDeclaration = keyFile
            ? declarationInModule(keyFile, keyBinding.imported, args.files, args.resolutions)
            : undefined;
          if (keyDeclaration?.kind === 'key' && keyFile) {
            const stores = ['default', ...Object.keys(args.files)].flatMap((candidate) => {
              if (candidate === 'default') {
                const item = declarationInModule(keyFile, 'default', args.files, args.resolutions);
                return item?.kind === 'vuex' ? [item] : [];
              }
              if (candidate !== keyFile) return [];
              const names = [
                ...args.files[keyFile].matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/gu),
              ].map((item) => item[1]);
              return names.flatMap((name) => {
                const item = declarationInModule(keyFile, name, args.files, args.resolutions);
                return item?.kind === 'vuex' ? [item] : [];
              });
            });
            for (const store of stores) {
              edges.push(
                semanticEdge(
                  testCase.capability,
                  args.parentPath,
                  store,
                  [
                    keyBinding.location,
                    store.declaration,
                    location(script, useStoreCall.index, args.parentPath),
                  ],
                  args.configFiles
                )
              );
            }
          }
        }
      }
    }
  }

  if (mutation === 'globally-bind-this-store' && /this\.\$store/u.test(args.source)) {
    const firstModule = Object.keys(args.files)[0];
    const declaration = declarationInModule(firstModule, 'default', args.files, args.resolutions);
    if (declaration) {
      edges.push(
        semanticEdge(testCase.capability, args.parentPath, declaration, [], args.configFiles)
      );
      declaredTargets.push(declaration);
    }
  }

  const unique = [
    ...new Map(
      edges.map((edge) => [`${edge.source}\0${edge.type}\0${edge.target}`, edge])
    ).values(),
  ];
  if (mutation === 'remove-required-edge') unique.shift();
  if (mutation === 'inject-forbidden-edge') {
    const forbidden = testCase.forbiddenEdges[0];
    if (forbidden?.source && forbidden.type && forbidden.target) {
      unique.push({
        id: programEdgeId(
          forbidden.type as 'uses_composable',
          forbidden.source,
          forbidden.target,
          PRODUCER
        ),
        source: forbidden.source,
        type: forbidden.type as ReturnedEdge['type'],
        target: forbidden.target,
        confidence: 'framework-inferred',
        evidence: [],
        evidenceFiles: [],
      });
    }
  }
  const targetNodes = Object.entries(args.files).flatMap(([filePath, source]) => {
    const names = [
      ...source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu),
      ...source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/gu),
    ].map((item) => symbolId(filePath, item[1]));
    if (/export\s+default\s+(?:createStore\s*\(|new\s+Vuex\.Store\s*\()/u.test(source)) {
      names.push(symbolId(filePath, 'default'));
    }
    return names;
  });
  return {
    caseId: testCase.id,
    coverage: diagnostics.length === 0 ? 'active' : 'partial',
    diagnostics: [...new Set(diagnostics)],
    nodes: [...new Set([vueComponentId(args.parentPath), ...targetNodes])],
    edges: unique,
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

function scoreCohort(
  capability: Capability,
  cases: readonly PhaseCase[],
  observations: readonly Observation[]
): Score {
  const selected = cases.filter(
    (item) => item.corpus === 'phase-10-vue-synthetic' && item.capability === capability
  );
  const ids = new Set(selected.map((item) => item.id));
  const expected = selected.flatMap((item) => item.expectedEdges);
  const returned = observations
    .filter((item) => ids.has(item.caseId))
    .flatMap((item) => item.edges);
  const expectedKeys = new Set(expected.map(edgeKey));
  const matched = new Set(returned.filter((edge) => expectedKeys.has(edgeKey(edge))).map(edgeKey))
    .size;
  return {
    expected: expected.length,
    returned: returned.length,
    matched,
    positiveCases: selected.filter((item) => item.expectedEdges.length > 0).length,
    forbiddenCases: selected.filter((item) => item.forbiddenEdges.length > 0).length,
    recall: expected.length === 0 ? 0 : matched / expected.length,
    precision: returned.length === 0 ? 0 : matched / returned.length,
  };
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

  const cohorts = Object.fromEntries(
    CAPABILITIES.map((capability) => [capability, scoreCohort(capability, cases, observations)])
  ) as Record<Capability, Score>;
  for (const capability of CAPABILITIES) {
    const score = cohorts[capability];
    const threshold = cases.find(
      (item) => item.corpus === 'phase-10-vue-synthetic' && item.capability === capability
    )?.thresholds;
    if (!threshold || score.positiveCases < threshold.minPositiveCases) {
      failures.push(`${capability}: only ${score.positiveCases} positive cases`);
    }
    if (!threshold || score.forbiddenCases < threshold.minForbiddenCases) {
      failures.push(`${capability}: only ${score.forbiddenCases} forbidden cases`);
    }
    if (!threshold || score.expected === 0 || score.recall < threshold.minRecall) {
      failures.push(`${capability}: recall ${score.recall}`);
    }
    if (!threshold || score.returned === 0 || score.precision < threshold.minPrecision) {
      failures.push(`${capability}: precision ${score.precision}`);
    }
  }

  const returned = observations.flatMap((item) => item.edges);
  const duplicateEdgeIds = observations.reduce(
    (count, item) => count + item.edges.length - new Set(item.edges.map((edge) => edge.id)).size,
    0
  );
  const nodes = new Set(observations.flatMap((item) => item.nodes));
  const danglingTargets = returned.filter((edge) => !nodes.has(edge.target)).length;
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
    cohorts,
    duplicateEdgeIds,
    danglingTargets,
    digest: stableHash(projection),
  };
}

function refreshSource(
  cases: readonly PhaseCase[],
  caseId: string,
  mutation?: MutationId
): { removed: ReturnedEdge[]; retainedUnrelated: boolean; after: Observation } {
  const testCase = cases.find((item) => item.id === caseId)!;
  const before = observe(testCase);
  const args = testCase.query.args as unknown as QueryArgs;
  const edited = args.source.replace(/\b(?:useAlpha|useAccount)\s*\(\s*\)/u, 'undefined');
  const after =
    mutation === 'retain-edge-after-source-edit'
      ? before
      : observe(testCase, undefined, { source: edited });
  const allBefore = runBattery(cases).observations.flatMap((item) => item.edges);
  const unrelatedBefore = allBefore.filter(
    (edge) => edge.source !== vueComponentId(args.parentPath)
  );
  const unrelatedAfter = runBattery(
    cases.filter((item) => item.id !== caseId)
  ).observations.flatMap((item) => item.edges);
  return {
    removed: before.edges.filter(
      (edge) => !after.edges.some((candidate) => candidate.id === edge.id)
    ),
    retainedUnrelated:
      stableHash(unrelatedBefore.map((edge) => edge.id).sort()) ===
      stableHash(unrelatedAfter.map((edge) => edge.id).sort()),
    after,
  };
}

function refreshConfig(
  cases: readonly PhaseCase[],
  mutation?: MutationId
): { citedBefore: ReturnedEdge[]; removed: ReturnedEdge[]; observations: Observation[] } {
  const citedCases = cases.filter((item) =>
    (item.query.args as unknown as QueryArgs).configFiles?.includes('tsconfig.json')
  );
  const before = citedCases.flatMap((item) => observe(item).edges);
  const after = citedCases.map((item) => {
    const args = item.query.args as unknown as QueryArgs;
    return mutation === 'retain-alias-edge-after-config-edit'
      ? observe(item)
      : observe(item, undefined, { resolutions: args.configMutationResolutions ?? {} });
  });
  const afterIds = new Set(after.flatMap((item) => item.edges.map((edge) => edge.id)));
  return {
    citedBefore: before,
    removed: before.filter((edge) => !afterIds.has(edge.id)),
    observations: after,
  };
}

function watchedMutationResult(cases: readonly PhaseCase[], mutation: MutationId): BatteryResult {
  if (mutation === 'retain-edge-after-source-edit') {
    const result = runBattery(cases);
    const refresh = refreshSource(cases, 'p10-composable-positive-01-function-ts', mutation);
    return {
      ...result,
      exitCode: refresh.removed.length === 0 ? 1 : result.exitCode,
      failures:
        refresh.removed.length === 0
          ? [
              ...result.failures,
              'p10-composable-positive-01-function-ts: stale source edge retained',
            ]
          : result.failures,
    };
  }
  if (mutation === 'retain-alias-edge-after-config-edit') {
    const result = runBattery(cases);
    const refresh = refreshConfig(cases, mutation);
    return {
      ...result,
      exitCode: refresh.removed.length !== refresh.citedBefore.length ? 1 : result.exitCode,
      failures:
        refresh.removed.length !== refresh.citedBefore.length
          ? [
              ...result.failures,
              'p10-composable-positive-09-alias-config: stale config edge retained',
            ]
          : result.failures,
    };
  }
  return runBattery(cases, mutation);
}

describe('Phase 10 independent Vue composable/store acceptance', () => {
  it('pins portable owner gold and exact approved real source bytes', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(73);
    expect(cases.every((item) => item.fixtureSchemaVersion === 1)).toBe(true);
    expect(cases.every((item) => item.goldSchemaVersion === 1)).toBe(true);
    expect(new Set(cases.map((item) => item.owner))).toEqual(new Set(['Example Maintainer']));
    expect(cases.find((item) => item.corpus === 'phase-10-vue-synthetic')?.corpusPin).toEqual({
      remote: 'https://github.com/ivannovak/lux.git',
      commit: LUX_PIN,
    });
    expect(cases.find((item) => item.corpus === 'acme-core')?.corpusPin).toEqual({
      remote: 'https://github.com/acme-software/acme-core.git',
      commit: CORE_PIN,
    });
    expect(JSON.stringify(cases)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\\\|\/home\/)/u);
    const realCases = cases.filter((item) => item.corpus === 'acme-core');
    expect(realCases).toHaveLength(4);
    for (const testCase of realCases) {
      expect(testCase.realGold).toMatchObject({
        approvedBy: 'Example Maintainer',
        source: 'owner-reviewed exact-commit semantic slice',
        portable: true,
      });
      const args = testCase.query.args as unknown as QueryArgs;
      const sources = { [args.parentPath]: args.source, ...args.files };
      expect(
        Object.fromEntries(
          Object.entries(sources).map(([path, bytes]) => [
            path,
            createHash('sha256').update(bytes).digest('hex'),
          ])
        )
      ).toEqual(testCase.realGold?.sourceSha256);
    }
  });

  it('executes separately scored, nonvacuous composable and store cohorts above thresholds', () => {
    const result = runBattery(loadCases());
    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.cohorts['vue-composable-semantics']).toMatchObject({
      positiveCases: 22,
      forbiddenCases: 11,
      recall: 1,
      precision: 1,
    });
    expect(result.cohorts['vue-store-semantics']).toMatchObject({
      positiveCases: 25,
      forbiddenCases: 12,
      recall: 1,
      precision: 1,
    });
    for (const score of Object.values(result.cohorts)) {
      expect(score.expected).toBeGreaterThan(0);
      expect(score.returned).toBeGreaterThan(0);
      expect(score.precision).toBeGreaterThanOrEqual(0.95);
      expect(score.recall).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('covers aliases, barrels, JS/TS declarations, Pinia forms, Vuex forms, and duplicate names', () => {
    const ids = new Set(loadCases().map((item) => item.id));
    for (const required of [
      'p10-composable-positive-03-function-js',
      'p10-composable-positive-05-alias-local',
      'p10-composable-positive-07-barrel-named',
      'p10-composable-positive-08-barrel-alias',
      'p10-composable-positive-09-alias-config',
      'p10-store-positive-01-pinia-setup-ts',
      'p10-store-positive-04-pinia-options-js',
      'p10-store-positive-13-vuex-default-factory-ts',
      'p10-store-positive-16-vuex-new-default',
      'p10-store-positive-18-vuex-default-barrel',
      'p10-store-positive-20-vuex-keyed-default',
      'p10-store-positive-21-vuex-keyed-named',
      'p10-store-positive-11-pinia-duplicate-name-a',
      'p10-store-positive-12-pinia-duplicate-name-b',
      'p10-store-forbidden-11-wrong-duplicate-target',
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
  });

  it('excludes imported-unused, shadowed, uncalled, dynamic, unresolved, unkeyed, and global uses', () => {
    const result = runBattery(loadCases());
    const byId = new Map(result.observations.map((item) => [item.caseId, item]));
    for (const id of [
      'p10-composable-forbidden-01-imported-unused',
      'p10-composable-forbidden-02-shadowed-local-function',
      'p10-composable-forbidden-03-uncalled-reference',
      'p10-composable-forbidden-04-dynamic-import',
      'p10-composable-forbidden-05-unresolved-alias',
      'p10-composable-forbidden-06-lowercase-user',
      'p10-store-forbidden-01-pinia-imported-unused',
      'p10-store-forbidden-02-pinia-shadowed',
      'p10-store-forbidden-03-pinia-uncalled-reference',
      'p10-store-forbidden-04-dynamic-import',
      'p10-store-forbidden-05-unresolved-alias',
      'p10-store-forbidden-06-unkeyed-vuex',
      'p10-store-forbidden-07-this-store',
      'p10-store-forbidden-08-runtime-plugin',
    ]) {
      expect(byId.get(id)?.edges, id).toEqual([]);
    }
    expect(byId.get('p10-composable-forbidden-05-unresolved-alias')).toMatchObject({
      coverage: 'partial',
      diagnostics: ['unresolved-import'],
    });
  });

  it('updates only the affected source/reverse-import closure after a one-file edit', () => {
    const cases = loadCases();
    for (const id of [
      'p10-composable-positive-01-function-ts',
      'p10-store-positive-01-pinia-setup-ts',
    ]) {
      const refresh = refreshSource(cases, id);
      expect(refresh.removed, id).toHaveLength(1);
      expect(refresh.after.edges, id).toEqual([]);
      expect(refresh.retainedUnrelated, id).toBe(true);
    }
  });

  it('invalidates every alias-cited edge after a governing config edit', () => {
    const refresh = refreshConfig(loadCases());
    expect(refresh.citedBefore).toHaveLength(4);
    expect(refresh.removed.map((edge) => edge.id).sort()).toEqual(
      refresh.citedBefore.map((edge) => edge.id).sort()
    );
    expect(refresh.observations.every((item) => item.edges.length === 0)).toBe(true);
  });

  it('has deterministic evidence, zero duplicate edge IDs, zero dangling targets, and stable builds', () => {
    const first = runBattery(loadCases());
    const second = runBattery(loadCases());
    expect(first.duplicateEdgeIds).toBe(0);
    expect(first.danglingTargets).toBe(0);
    expect(
      first.observations
        .flatMap((item) => item.edges)
        .every((edge) => edge.evidence.length >= 3 && edge.confidence === 'framework-inferred')
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

  it('executes every prescribed semantic, stale-refresh, remove, and inject mutation red', () => {
    const cases = loadCases();
    const controls = cases.flatMap((item) => item.watchedMutations ?? []);
    expect(controls.map((item) => item.id)).toEqual([
      'emit-on-import',
      'drop-import-binding-resolution',
      'classify-lowercase-user-as-composable',
      'globally-bind-this-store',
      'retain-edge-after-source-edit',
      'retain-alias-edge-after-config-edit',
      'remove-required-edge',
      'inject-forbidden-edge',
    ]);
    for (const control of controls) {
      const result = watchedMutationResult(cases, control.id);
      expect(result.exitCode, control.id).toBe(control.expectedCheckerExitCode);
      expect(
        result.failures.some((failure) => failure.startsWith(`${control.expectedCase}:`)),
        `${control.id}: ${result.failures.join(', ')}`
      ).toBe(true);
    }
  });
});
