import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { applyInitPlan, buildInitPlan, renderPortableLuxYaml } from '../../cli/init/index.js';
import { inspectDoctorReport } from '../../cli/doctor.js';

/**
 * T14 is deliberately independent from the Phase 4 producer. This virtual
 * repository seam implements the approved init/doctor contract without a
 * production import. T15 can inject the production adapter into runBattery
 * without changing owner gold, scoring, forbidden controls, or watched-red
 * mutations.
 */
type Action = 'init' | 'doctor';
type Severity = 'info' | 'warning' | 'error';
type Status = 'applied' | 'unchanged' | 'planned' | 'refused' | 'failed' | 'diagnosed';
type Scenario =
  | 'clean'
  | 'unconfigured'
  | 'already-configured'
  | 'dirty-target'
  | 'declined-apply'
  | 'symlink-escape'
  | 'interrupted-atomic-write'
  | 'missing-lsp'
  | 'tracked-database'
  | 'partial-vue-javascript';

type Diagnostic = { id: string; severity: Severity; path?: string };
type RepositoryInput = {
  files: Record<string, string>;
  symlinks: Record<string, string>;
  trackedPaths: string[];
  dirtyPaths: string[];
  availableCommands: string[];
};
type ContractArgs = {
  action: Action;
  repo: RepositoryInput;
  confirmApply?: boolean;
  interruptAtomicWriteAt?: 'before-rename';
};
type ContractResult = {
  status: Status;
  exitCode: number;
  diagnostics: Diagnostic[];
  mutatedPaths: string[];
  generatedFiles: Record<string, string>;
  preservedPaths: string[];
};
type ScoreDimension =
  | 'status'
  | 'exit-code'
  | 'diagnostic-ids'
  | 'mutated-paths'
  | 'no-absolute-paths'
  | 'stable-doctor-ids'
  | 'portable-config'
  | 'idempotent-byte-equality'
  | 'no-mutation-on-decline';
type WatchedMutation = {
  id: 'timestamp-generated-config' | 'bypass-declined-apply';
  expectedCheckerExitCode: 1;
  expectedObservable: string;
};
type PhaseCase = {
  id: string;
  corpus: 'lux';
  capability: 'portable-init-and-doctor';
  scenario: Scenario;
  query: { tool: 'portableInitContract'; args: ContractArgs };
  expected: ContractResult;
  scoreDimensions: ScoreDimension[];
  forbiddenControls: string[];
  owner: string;
  fixtureSchemaVersion: 1;
  corpusPin: { remote: string; commit: string };
  thresholds: {
    minRecall: number;
    minPrecision: number;
    minPositiveChecks: number;
    minForbiddenControls: number;
  };
  watchedMutation?: WatchedMutation;
};
type ContractDependencies = {
  renderConfig: (invocation: number) => string;
  shouldApply: (args: ContractArgs) => boolean;
};
type PortableInitContract = (
  args: ContractArgs,
  dependencies?: Partial<ContractDependencies>
) => ContractResult;
type Observation = {
  result: ContractResult;
  filesBefore: Record<string, string>;
  filesAfter: Record<string, string>;
  repeatedResult: ContractResult;
  repeatedFilesAfter: Record<string, string>;
};
type Score = {
  expected: number;
  matched: number;
  returnedInScope: number;
  forbiddenMatched: number;
  recall: number;
  precision: number;
  passed: boolean;
  failures: string[];
};
type CheckResult = {
  exitCode: number;
  scores: Score[];
  observations: Observation[];
  failures: string[];
};

const OWNER = 'Example Maintainer';
const CORPUS_PIN = {
  remote: 'https://github.com/ivannovak/lux.git',
  commit: 'f72d056233674a8f26587a3c258c58e2037710a5',
};
const PORTABLE_CONFIG = `schema_version: 1
workspace:
  root: .
index:
  database: .lux/lux.db
lsp:
  enabled: true
  workspace_root: .
  enrichers:
    - language_id: typescript
      enabled: true
      server_command: typescript-language-server
      server_args:
        - --stdio
`;
const STABLE_DIAGNOSTIC_ID = /^(?:init|doctor)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const APPROVED_MUTATION_PATHS = new Set(['lux.yaml', '.gitignore']);

function loadCases(): PhaseCase[] {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'benchmarks',
    'relationship',
    'cases',
    'phase-04.json'
  );
  return JSON.parse(readFileSync(path, 'utf8')) as PhaseCase[];
}

function cloneFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  );
}

function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function result(
  status: Status,
  exitCode: number,
  diagnostics: Diagnostic[],
  before: Record<string, string>,
  after: Record<string, string>
): ContractResult {
  const mutatedPaths = changedPaths(before, after);
  return {
    status,
    exitCode,
    diagnostics,
    mutatedPaths,
    generatedFiles: Object.fromEntries(mutatedPaths.map((path) => [path, after[path]])),
    preservedPaths: Object.keys(before)
      .filter((path) => before[path] === after[path])
      .sort(),
  };
}

/** Independent executable reference for the frozen Phase 4 adapter seam. */
const portableInitContract: PortableInitContract = (args, overrides = {}) => {
  const dependencies: ContractDependencies = {
    renderConfig: () => PORTABLE_CONFIG,
    shouldApply: (input) => input.confirmApply === true,
    ...overrides,
  };
  const before = cloneFiles(args.repo.files);
  const after = cloneFiles(before);

  if (args.action === 'doctor') {
    const diagnostics: Diagnostic[] = [];
    if (!before['lux.yaml']) {
      diagnostics.push({ id: 'doctor.config.missing', severity: 'error' });
    } else {
      if (
        before['lux.yaml'].includes('typescript-language-server') &&
        !args.repo.availableCommands.includes('typescript-language-server')
      ) {
        diagnostics.push({
          id: 'doctor.lsp.command-missing',
          severity: 'error',
          path: 'typescript-language-server',
        });
      }
      if (args.repo.trackedPaths.includes('.lux/lux.db')) {
        diagnostics.push({
          id: 'doctor.database.tracked',
          severity: 'error',
          path: '.lux/lux.db',
        });
      }
      if (Object.hasOwn(before, 'src/client.js')) {
        diagnostics.push({
          id: 'doctor.language.javascript-partial',
          severity: 'warning',
          path: 'src/client.js',
        });
      }
      if (Object.hasOwn(before, 'src/App.vue')) {
        diagnostics.push({
          id: 'doctor.language.vue-partial',
          severity: 'warning',
          path: 'src/App.vue',
        });
      }
    }
    return result('diagnosed', diagnostics.length ? 1 : 0, diagnostics, before, after);
  }

  const symlinkTarget = args.repo.symlinks['lux.yaml'];
  if (
    symlinkTarget &&
    posix.normalize(posix.join('fixture-root', symlinkTarget)).startsWith('outside/')
  ) {
    return result(
      'refused',
      1,
      [{ id: 'init.target.symlink-escape', severity: 'error', path: 'lux.yaml' }],
      before,
      after
    );
  }
  if (args.repo.dirtyPaths.includes('lux.yaml')) {
    return result(
      'refused',
      1,
      [{ id: 'init.target.dirty', severity: 'error', path: 'lux.yaml' }],
      before,
      after
    );
  }
  if (Object.hasOwn(before, 'lux.yaml')) {
    return result(
      'unchanged',
      0,
      [{ id: 'init.already-configured', severity: 'info' }],
      before,
      after
    );
  }
  if (!dependencies.shouldApply(args)) {
    return result('planned', 0, [{ id: 'init.apply.declined', severity: 'info' }], before, after);
  }
  if (args.interruptAtomicWriteAt === 'before-rename') {
    return result(
      'failed',
      1,
      [{ id: 'init.atomic-write.interrupted', severity: 'error' }],
      before,
      after
    );
  }

  after['lux.yaml'] = dependencies.renderConfig(1);
  if (!before['.gitignore']) after['.gitignore'] = '.lux/\n';
  return result('applied', 0, [{ id: 'init.applied', severity: 'info' }], before, after);
};

function execute(
  testCase: PhaseCase,
  contract: PortableInitContract,
  dependencies?: Partial<ContractDependencies>
): Observation {
  const filesBefore = cloneFiles(testCase.query.args.repo.files);
  const resultValue = contract(testCase.query.args, dependencies);
  const filesAfter = cloneFiles({ ...filesBefore, ...resultValue.generatedFiles });
  const repeatedResult = contract(testCase.query.args, dependencies);
  const repeatedFilesAfter = cloneFiles({ ...filesBefore, ...repeatedResult.generatedFiles });
  return { result: resultValue, filesBefore, filesAfter, repeatedResult, repeatedFilesAfter };
}

function hasAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || value.startsWith('\\\\');
}

function observationStrings(observation: Observation): string[] {
  return [
    ...observation.result.mutatedPaths,
    ...observation.result.diagnostics.flatMap((diagnostic) =>
      diagnostic.path ? [diagnostic.path] : []
    ),
    ...Object.keys(observation.result.generatedFiles),
    ...Object.values(observation.result.generatedFiles),
  ].flatMap((value) => [value, ...value.split('\n').map((line) => line.trim())]);
}

function portableConfig(files: Record<string, string>): boolean {
  const config = files['lux.yaml'];
  if (!config) return true;
  const pathValues = [...config.matchAll(/^\s*(?:root|workspace_root|database):\s*(.+)\s*$/gm)].map(
    (match) => match[1].trim()
  );
  return pathValues.length > 0 && pathValues.every((value) => !hasAbsolutePath(value));
}

function stableDiagnostics(observation: Observation): boolean {
  const first = observation.result.diagnostics.map(({ id }) => id);
  const repeated = observation.repeatedResult.diagnostics.map(({ id }) => id);
  return (
    first.length > 0 &&
    first.every((id) => STABLE_DIAGNOSTIC_ID.test(id)) &&
    JSON.stringify(first) === JSON.stringify(repeated)
  );
}

function dimensionPasses(
  dimension: ScoreDimension,
  testCase: PhaseCase,
  observation: Observation
): boolean {
  switch (dimension) {
    case 'status':
      return observation.result.status === testCase.expected.status;
    case 'exit-code':
      return observation.result.exitCode === testCase.expected.exitCode;
    case 'diagnostic-ids':
      return (
        JSON.stringify(observation.result.diagnostics.map(({ id }) => id)) ===
        JSON.stringify(testCase.expected.diagnostics.map(({ id }) => id))
      );
    case 'mutated-paths':
      return (
        JSON.stringify(observation.result.mutatedPaths) ===
        JSON.stringify(testCase.expected.mutatedPaths)
      );
    case 'no-absolute-paths':
      return observationStrings(observation).every((value) => !hasAbsolutePath(value));
    case 'stable-doctor-ids':
      return stableDiagnostics(observation);
    case 'portable-config':
      return portableConfig(observation.filesAfter);
    case 'idempotent-byte-equality':
      return (
        JSON.stringify(observation.filesAfter) === JSON.stringify(observation.repeatedFilesAfter)
      );
    case 'no-mutation-on-decline':
      return (
        testCase.query.args.confirmApply === false &&
        observation.result.mutatedPaths.length === 0 &&
        JSON.stringify(observation.filesBefore) === JSON.stringify(observation.filesAfter)
      );
  }
}

function detectedForbiddenControls(testCase: PhaseCase, observation: Observation): string[] {
  const detected: string[] = [];
  const generatedText = Object.values(observation.result.generatedFiles).join('\n');
  if (observationStrings(observation).some(hasAbsolutePath)) detected.push('absolute-path-output');
  if (!stableDiagnostics(observation)) detected.push('unstable-diagnostic-id');
  if (observation.result.mutatedPaths.some((path) => !APPROVED_MUTATION_PATHS.has(path))) {
    detected.push('mutation-outside-approved-targets');
  }
  if (/generated[-_ ]?at|timestamp|20\d\d-\d\d-\d\dT/i.test(generatedText)) {
    detected.push('timestamp-in-generated-config');
  }
  if (!portableConfig(observation.filesAfter)) {
    detected.push('non-portable-workspace-root', 'non-portable-database-path');
  }
  if (
    testCase.query.args.confirmApply === false &&
    (observation.result.mutatedPaths.length > 0 ||
      JSON.stringify(observation.filesBefore) !== JSON.stringify(observation.filesAfter))
  ) {
    detected.push('mutation-on-decline', 'unexpected-write');
  }
  return [...new Set(detected)].filter((control) => testCase.forbiddenControls.includes(control));
}

function scoreObservation(testCase: PhaseCase, observation: Observation): Score {
  const failures: string[] = [];
  const failedDimensions = testCase.scoreDimensions.filter(
    (dimension) => !dimensionPasses(dimension, testCase, observation)
  );
  failures.push(
    ...failedDimensions.map((dimension) => `${testCase.id}: ${dimension.replaceAll('-', ' ')}`)
  );

  const forbidden = detectedForbiddenControls(testCase, observation);
  failures.push(...forbidden.map((control) => `${testCase.id}: forbidden ${control}`));
  const expected = testCase.scoreDimensions.length;
  const matched = expected - failedDimensions.length;
  const returnedInScope = matched + forbidden.length;
  const recall = expected ? matched / expected : 0;
  const precision = returnedInScope ? matched / returnedInScope : 0;
  if (expected === 0) failures.push(`${testCase.id}: zero expected positives`);
  if (returnedInScope === 0) failures.push(`${testCase.id}: zero returned checks`);
  if (recall < testCase.thresholds.minRecall) {
    failures.push(`${testCase.id}: recall ${recall} < ${testCase.thresholds.minRecall}`);
  }
  if (precision < testCase.thresholds.minPrecision) {
    failures.push(`${testCase.id}: precision ${precision} < ${testCase.thresholds.minPrecision}`);
  }
  return {
    expected,
    matched,
    returnedInScope,
    forbiddenMatched: forbidden.length,
    recall,
    precision,
    passed: failures.length === 0,
    failures,
  };
}

function checkBattery(cases: PhaseCase[], observations: Observation[]): CheckResult {
  const failures: string[] = [];
  if (cases.length === 0) failures.push('zero expected positives');
  if (observations.length === 0) failures.push('zero returned observations');
  if (cases.length !== observations.length) {
    failures.push(`expected ${cases.length} observation(s), received ${observations.length}`);
  }
  const scores = cases.map((testCase, index) => {
    const observation = observations[index];
    if (!observation) {
      const failure = `${testCase.id}: missing observation`;
      failures.push(failure);
      return {
        expected: testCase.scoreDimensions.length,
        matched: 0,
        returnedInScope: 0,
        forbiddenMatched: 0,
        recall: 0,
        precision: 0,
        passed: false,
        failures: [failure],
      };
    }
    const score = scoreObservation(testCase, observation);
    failures.push(...score.failures);
    if (JSON.stringify(observation.result) !== JSON.stringify(testCase.expected)) {
      failures.push(`${testCase.id}: result does not match owner gold`);
    }
    return score;
  });
  return { exitCode: failures.length ? 1 : 0, scores, observations, failures };
}

function runBattery(
  cases: PhaseCase[],
  contract: PortableInitContract,
  dependencies?: Partial<ContractDependencies>
): CheckResult {
  return checkBattery(
    cases,
    cases.map((testCase) => execute(testCase, contract, dependencies))
  );
}

describe('Phase 4 acceptance: independent portable init and doctor battery (T14)', () => {
  it('pins owner gold, corpus commit, thresholds, and non-vacuous forbidden controls', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map(({ scenario }) => scenario))).toEqual(
      new Set<Scenario>([
        'clean',
        'unconfigured',
        'already-configured',
        'dirty-target',
        'declined-apply',
        'symlink-escape',
        'interrupted-atomic-write',
        'missing-lsp',
        'tracked-database',
        'partial-vue-javascript',
      ])
    );
    for (const testCase of cases) {
      expect(testCase).toMatchObject({
        corpus: 'lux',
        capability: 'portable-init-and-doctor',
        owner: OWNER,
        fixtureSchemaVersion: 1,
        corpusPin: CORPUS_PIN,
        thresholds: { minRecall: 1, minPrecision: 1 },
      });
      expect(testCase.query.tool).toBe('portableInitContract');
      expect(testCase.expected.diagnostics.length).toBeGreaterThan(0);
      expect(testCase.scoreDimensions.length).toBeGreaterThanOrEqual(
        testCase.thresholds.minPositiveChecks
      );
      expect(testCase.forbiddenControls.length).toBeGreaterThanOrEqual(
        testCase.thresholds.minForbiddenControls
      );
      expect(testCase.thresholds.minPositiveChecks).toBeGreaterThan(0);
      expect(testCase.thresholds.minForbiddenControls).toBeGreaterThan(0);
    }
  });

  it('explicitly scores portability, absolute paths, stable IDs, byte idempotence, and decline safety', () => {
    const dimensions = new Set(loadCases().flatMap(({ scoreDimensions }) => scoreDimensions));
    expect(dimensions).toEqual(
      expect.objectContaining(
        new Set<ScoreDimension>([
          'portable-config',
          'no-absolute-paths',
          'stable-doctor-ids',
          'idempotent-byte-equality',
          'no-mutation-on-decline',
        ])
      )
    );
  });

  it('executes the independent seam at 1.0/1.0 with non-vacuous observations', () => {
    const resultValue = runBattery(loadCases(), portableInitContract);
    expect(resultValue).toMatchObject({ exitCode: 0, failures: [] });
    expect(resultValue.observations).toHaveLength(10);
    for (const score of resultValue.scores) {
      expect(score.expected).toBeGreaterThanOrEqual(6);
      expect(score).toMatchObject({
        recall: 1,
        precision: 1,
        forbiddenMatched: 0,
        passed: true,
      });
    }
  });

  it('preserves bytes on dirty, decline, symlink escape, and interrupted atomic write', () => {
    const immutable = new Set([
      'dirty-target',
      'declined-apply',
      'symlink-escape',
      'interrupted-atomic-write',
    ]);
    const cases = loadCases().filter(({ scenario }) => immutable.has(scenario));
    const checked = runBattery(cases, portableInitContract);
    expect(checked).toMatchObject({ exitCode: 0, failures: [] });
    for (const observation of checked.observations) {
      expect(observation.result.mutatedPaths).toEqual([]);
      expect(observation.filesAfter).toEqual(observation.filesBefore);
    }
  });

  it('rejects zero-positive, zero-return, and forbidden controls', () => {
    const testCase = loadCases()[0];
    const observation = execute(testCase, portableInitContract);
    expect(scoreObservation(testCase, observation)).toMatchObject({ passed: true });
    expect(checkBattery([], [])).toMatchObject({ exitCode: 1 });

    const absoluteRoot = ['', 'fixture-host', 'repo'].join('/');
    const nonportableConfig = `workspace:\n  root: ${absoluteRoot}\n`;
    const absoluteObservation: Observation = {
      ...observation,
      result: {
        ...observation.result,
        generatedFiles: { 'lux.yaml': nonportableConfig },
      },
      filesAfter: {
        ...observation.filesAfter,
        'lux.yaml': nonportableConfig,
      },
    };
    expect(scoreObservation(testCase, absoluteObservation)).toMatchObject({
      forbiddenMatched: 2,
      passed: false,
    });
  });

  it('conforms production init and absent-index doctor to the independent contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-p04-production-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
      writeFileSync(join(root, 'index.ts'), 'export const ready = true;\n');
      const plan = buildInitPlan(root);
      const config = renderPortableLuxYaml(plan.detected);
      expect(config).toContain(PORTABLE_CONFIG);
      expect(config).toContain('deps:\n  enabled: true\n');
      expect(config).not.toContain(root);
      applyInitPlan(plan, false);
      expect(
        plan.changes.every((change) => change.path === 'lux.yaml' || change.path === '.gitignore')
      ).toBe(true);

      const report = inspectDoctorReport({
        corpusPath: root,
        corpusSource: 'explicit',
        dbPath: join(root, '.lux', 'lux.db'),
        dbSource: 'explicit',
      });
      expect(report.result).toBe('fail');
      expect(report.checks.find((check) => check.id === 'doctor.config.missing')).toMatchObject({
        status: 'fail',
      });
      expect(report.checks.find((check) => check.id === 'index.presence')).toMatchObject({
        status: 'fail',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('turns the timestamp-in-generated-config watched mutation red with an observable', () => {
    const testCase = loadCases().find(
      ({ watchedMutation }) => watchedMutation?.id === 'timestamp-generated-config'
    )!;
    const watched = testCase.watchedMutation!;
    let invocation = 0;
    const mutated = runBattery([testCase], portableInitContract, {
      renderConfig: () => `${PORTABLE_CONFIG}# generated-at: 2026-09-05T10:04:0${invocation++}Z\n`,
    });

    expect(watched.expectedCheckerExitCode).toBe(1);
    expect(mutated.exitCode).toBe(watched.expectedCheckerExitCode);
    expect(mutated.failures).toContain(watched.expectedObservable);
    expect(mutated.failures).toContain(`${testCase.id}: forbidden timestamp-in-generated-config`);
    expect(mutated.observations[0].result.generatedFiles['lux.yaml']).toContain('# generated-at:');
  });

  it('turns the bypass-declined-apply watched mutation red with an observable', () => {
    const testCase = loadCases().find(
      ({ watchedMutation }) => watchedMutation?.id === 'bypass-declined-apply'
    )!;
    const watched = testCase.watchedMutation!;
    const mutated = runBattery([testCase], portableInitContract, { shouldApply: () => true });

    expect(testCase.query.args.confirmApply).toBe(false);
    expect(mutated.exitCode).toBe(watched.expectedCheckerExitCode);
    expect(mutated.failures).toContain(watched.expectedObservable);
    expect(mutated.failures).toContain(`${testCase.id}: forbidden mutation-on-decline`);
    expect(mutated.observations[0].result.mutatedPaths.length).toBeGreaterThan(0);
  });
});
