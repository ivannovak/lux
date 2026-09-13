import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveCapability } from '../../scanner/coverage/index.js';

/**
 * T10 is deliberately independent from T9. The battery targets the frozen
 * Phase 3 deriveCapability contract through this injectable seam. A later
 * integration owner can pass the production function to runBattery without
 * changing the owner gold, oracle, scorer, or watched-red control.
 */
type CapabilityState = 'active' | 'partial' | 'unsupported' | 'failed' | 'not_applicable';
type CapabilityName = 'syntax' | 'symbols' | 'imports' | 'calls' | 'references' | 'framework';

type DeriveInput = {
  producer: string;
  candidates: number;
  configured: boolean;
  ran: boolean;
  failures: number;
  nodes: number;
  edges: number;
  documentedSubset: boolean;
};

type CapabilityEvidence = {
  state: CapabilityState;
  producer: string;
  nodes: number;
  edges: number;
  failures: number;
  reason?: string;
};

type PhaseCase = {
  id: string;
  corpus: string;
  capability: string;
  query: {
    tool: string;
    args: {
      languageId: string;
      capability: CapabilityName;
      input: DeriveInput;
    };
  };
  expectedCoverage: CapabilityEvidence;
  forbiddenStates: CapabilityState[];
  expectedOutcome: 'reported';
  owner: string;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: {
    minRecall: number;
    minPrecision: number;
    minPositiveChecks: number;
    minForbiddenControls: number;
  };
  watchedMutation?: {
    id: 'force-producer-failure-while-active';
    forceFailures: number;
    keepState: 'active';
    expectedProducerExitCode: number;
    expectedCheckerExitCode: number;
    expectedObservable: string;
  };
};

type DeriveCapability = (input: DeriveInput) => CapabilityEvidence;

type CoverageObservation = {
  languageId: string;
  capability: CapabilityName;
  evidence: CapabilityEvidence;
  producerExitCode: number;
};

type Score = {
  expected: number;
  matched: number;
  returnedInScope: number;
  forbiddenMatched: number;
  dangling: number;
  duplicate: number;
  recall: number;
  precision: number;
  passed: boolean;
  failures: string[];
};

type CheckResult = {
  exitCode: number;
  observations: CoverageObservation[];
  failures: string[];
};

const STATES: CapabilityState[] = ['active', 'partial', 'unsupported', 'failed', 'not_applicable'];
const CAPABILITIES: CapabilityName[] = [
  'syntax',
  'symbols',
  'imports',
  'calls',
  'references',
  'framework',
];
const OWNER = 'Example Maintainer';
const CORPUS_PIN = {
  remote: 'https://github.com/ivannovak/lux.git',
  commit: '5f1f053c635a7244d3d1c23045ce398170053623',
};

/** Independent executable reference for the documented Phase 3 contract seam. */
const deriveCapabilityContract: DeriveCapability = (input) => {
  let state: CapabilityState;
  let reason: string | undefined;
  if (!input.configured) {
    state = input.candidates ? 'unsupported' : 'not_applicable';
    reason = input.candidates ? 'no producer configured' : 'no applicable candidates';
  } else if (!input.ran) {
    state = 'failed';
    reason = 'configured producer did not run';
  } else if (
    input.failures ||
    input.documentedSubset ||
    (input.candidates > 0 && input.nodes + input.edges === 0)
  ) {
    state = 'partial';
    reason = input.failures
      ? `${input.failures} producer failure(s)`
      : input.documentedSubset
        ? 'documented subset'
        : 'applicable candidates produced no structural output';
  } else {
    state = 'active';
  }
  return {
    state,
    producer: input.producer,
    nodes: input.nodes,
    edges: input.edges,
    failures: input.failures,
    ...(reason ? { reason } : {}),
  };
};

function loadCases(): PhaseCase[] {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'benchmarks',
    'relationship',
    'cases',
    'phase-03.json'
  );
  return JSON.parse(readFileSync(path, 'utf8')) as PhaseCase[];
}

function observationKey(
  languageId: string,
  capability: CapabilityName,
  state: CapabilityState
): string {
  return `${languageId}/${capability}/${state}`;
}

function scoreCase(input: {
  expected: Set<string>;
  returned: string[];
  forbidden: Set<string>;
  dangling: Set<string>;
  minRecall: number;
  minPrecision: number;
}): Score {
  const unique = new Set(input.returned);
  const duplicate = input.returned.length - unique.size;
  const matched = [...input.expected].filter((value) => unique.has(value)).length;
  const forbiddenMatched = [...input.forbidden].filter((value) => unique.has(value)).length;
  const expected = input.expected.size;
  const returnedInScope = unique.size;
  const failures: string[] = [];
  if (expected === 0) failures.push('zero expected positives');
  if (returnedInScope === 0) failures.push('zero returned coverage observations');
  if (forbiddenMatched) failures.push(`${forbiddenMatched} forbidden state(s)`);
  if (input.dangling.size) failures.push(`${input.dangling.size} dangling observation(s)`);
  if (duplicate) failures.push(`${duplicate} duplicate observation(s)`);
  const recall = expected ? matched / expected : 0;
  const precision = returnedInScope ? matched / returnedInScope : 0;
  if (recall < input.minRecall) failures.push(`recall ${recall} < ${input.minRecall}`);
  if (precision < input.minPrecision) {
    failures.push(`precision ${precision} < ${input.minPrecision}`);
  }
  return {
    expected,
    matched,
    returnedInScope,
    forbiddenMatched,
    dangling: input.dangling.size,
    duplicate,
    recall,
    precision,
    passed: failures.length === 0,
    failures,
  };
}

function scoreObservation(testCase: PhaseCase, observation: CoverageObservation): Score {
  const { languageId, capability } = testCase.query.args;
  return scoreCase({
    expected: new Set([observationKey(languageId, capability, testCase.expectedCoverage.state)]),
    returned: [observationKey(languageId, capability, observation.evidence.state)],
    forbidden: new Set(
      testCase.forbiddenStates.map((state) => observationKey(languageId, capability, state))
    ),
    dangling: new Set(),
    minRecall: testCase.thresholds.minRecall,
    minPrecision: testCase.thresholds.minPrecision,
  });
}

function executeProducer(testCase: PhaseCase, derive: DeriveCapability): CoverageObservation {
  const { languageId, capability, input } = testCase.query.args;
  return {
    languageId,
    capability,
    evidence: derive(input),
    producerExitCode: input.failures > 0 || (input.configured && !input.ran) ? 1 : 0,
  };
}

function checkCoverage(cases: PhaseCase[], observations: CoverageObservation[]): CheckResult {
  const failures: string[] = [];
  if (cases.length === 0) failures.push('zero expected positives');
  if (observations.length === 0) failures.push('zero returned coverage observations');
  if (cases.length !== observations.length) {
    failures.push(`expected ${cases.length} observation(s), received ${observations.length}`);
  }

  for (const [index, testCase] of cases.entries()) {
    const observation = observations[index];
    const location = `${testCase.query.args.languageId}/${testCase.query.args.capability}`;
    if (!observation) {
      failures.push(`${location}: missing coverage observation`);
      continue;
    }
    if (
      observation.languageId !== testCase.query.args.languageId ||
      observation.capability !== testCase.query.args.capability
    ) {
      failures.push(`${location}: wrong language/capability identity`);
      continue;
    }

    const score = scoreObservation(testCase, observation);
    failures.push(...score.failures.map((failure) => `${location}: ${failure}`));
    if (JSON.stringify(observation.evidence) !== JSON.stringify(testCase.expectedCoverage)) {
      failures.push(`${location}: evidence does not match owner gold`);
    }
    if (observation.evidence.state === 'active') {
      if (observation.producerExitCode !== 0 || observation.evidence.failures !== 0) {
        failures.push(`${location}: active capability has producer failure`);
      }
      if (
        testCase.query.args.input.candidates > 0 &&
        observation.evidence.nodes + observation.evidence.edges === 0
      ) {
        failures.push(`${location}: vacuous active capability`);
      }
    }
  }

  return { exitCode: failures.length === 0 ? 0 : 1, observations, failures };
}

function runBattery(cases: PhaseCase[], derive: DeriveCapability): CheckResult {
  return checkCoverage(
    cases,
    cases.map((testCase) => executeProducer(testCase, derive))
  );
}

describe('Phase 3 acceptance: independent language/capability coverage battery (T10)', () => {
  it('pins owner gold with explicit nonzero positive/forbidden thresholds', () => {
    const cases = loadCases();
    const positives = cases.length;
    const forbidden = cases.reduce((count, testCase) => count + testCase.forbiddenStates.length, 0);

    expect(cases).toHaveLength(13);
    expect(positives).toBe(13);
    expect(forbidden).toBe(52);
    for (const testCase of cases) {
      expect(testCase).toMatchObject({
        corpus: 'lux',
        capability: 'language-capability-coverage',
        expectedOutcome: 'reported',
        owner: OWNER,
        fixtureSchemaVersion: 1,
        corpusPin: CORPUS_PIN,
        thresholds: {
          minRecall: 1,
          minPrecision: 1,
          minPositiveChecks: 1,
          minForbiddenControls: 4,
        },
      });
      expect(testCase.query.tool).toBe('deriveCapability');
      expect(CAPABILITIES).toContain(testCase.query.args.capability);
      expect(testCase.forbiddenStates).toHaveLength(4);
      expect(testCase.forbiddenStates).not.toContain(testCase.expectedCoverage.state);
      expect(testCase.thresholds.minRecall).toBeGreaterThanOrEqual(0);
      expect(testCase.thresholds.minRecall).toBeLessThanOrEqual(1);
      expect(testCase.thresholds.minPrecision).toBeGreaterThanOrEqual(0);
      expect(testCase.thresholds.minPrecision).toBeLessThanOrEqual(1);
      expect(1).toBeGreaterThanOrEqual(testCase.thresholds.minPositiveChecks);
      expect(testCase.forbiddenStates.length).toBeGreaterThanOrEqual(
        testCase.thresholds.minForbiddenControls
      );
    }
  });

  it('covers every state, every capability, and PHP/TS/JS/Vue plus unsupported language', () => {
    const cases = loadCases();
    expect(new Set(cases.map((testCase) => testCase.expectedCoverage.state))).toEqual(
      new Set(STATES)
    );
    expect(new Set(cases.map((testCase) => testCase.query.args.capability))).toEqual(
      new Set(CAPABILITIES)
    );

    for (const languageId of ['php', 'typescript', 'javascript', 'vue']) {
      expect(
        cases.some(
          (testCase) =>
            testCase.query.args.languageId === languageId &&
            testCase.expectedCoverage.state === 'active'
        ),
        `${languageId} active positive control`
      ).toBe(true);
    }
    expect(
      cases.some(
        (testCase) =>
          testCase.expectedCoverage.state === 'unsupported' &&
          testCase.query.args.input.candidates > 0 &&
          !testCase.query.args.input.configured
      )
    ).toBe(true);
  });

  it('covers zero candidates, zero output, configured failure, and partial subset branches', () => {
    const byId = new Map(loadCases().map((testCase) => [testCase.id, testCase]));
    expect(byId.get('p03-markdown-zero-candidates-not-applicable')).toMatchObject({
      expectedCoverage: { state: 'not_applicable', reason: 'no applicable candidates' },
      query: { args: { input: { candidates: 0, configured: false } } },
    });
    expect(byId.get('p03-javascript-candidates-zero-output-partial')).toMatchObject({
      expectedCoverage: {
        state: 'partial',
        reason: 'applicable candidates produced no structural output',
      },
      query: { args: { input: { candidates: 3, nodes: 0, edges: 0 } } },
    });
    expect(byId.get('p03-go-configured-producer-did-not-run')).toMatchObject({
      expectedCoverage: { state: 'failed', reason: 'configured producer did not run' },
      query: { args: { input: { configured: true, ran: false } } },
    });
    expect(byId.get('p03-vue-documented-subset-partial')).toMatchObject({
      expectedCoverage: { state: 'partial', reason: 'documented subset' },
      query: { args: { input: { documentedSubset: true } } },
    });
  });

  it('executes the contract seam at 1.0/1.0 with non-vacuous returned observations', () => {
    const cases = loadCases();
    const result = runBattery(cases, deriveCapabilityContract);
    expect(result).toMatchObject({ exitCode: 0, failures: [] });
    expect(result.observations).toHaveLength(13);

    for (const [index, observation] of result.observations.entries()) {
      const score = scoreObservation(cases[index], observation);
      expect(score, cases[index].id).toMatchObject({
        expected: 1,
        matched: 1,
        returnedInScope: 1,
        forbiddenMatched: 0,
        recall: 1,
        precision: 1,
        passed: true,
      });
    }
    const active = result.observations.filter(
      (observation) => observation.evidence.state === 'active'
    );
    expect(active).toHaveLength(7);
    expect(active.every((entry) => entry.evidence.nodes + entry.evidence.edges > 0)).toBe(true);
  });

  it('rejects zero-positive/zero-return, forbidden, duplicate, and dangling controls', () => {
    const testCase = loadCases()[0];
    const location = `${testCase.query.args.languageId}/${testCase.query.args.capability}`;
    const expected = new Set([
      observationKey(location.split('/')[0], testCase.query.args.capability, 'active'),
    ]);
    const returned = [...expected];
    const forbidden = new Set(
      testCase.forbiddenStates.map((state) =>
        observationKey(testCase.query.args.languageId, testCase.query.args.capability, state)
      )
    );
    const base = {
      expected,
      forbidden,
      dangling: new Set<string>(),
      minRecall: 1,
      minPrecision: 1,
    };

    expect(scoreCase({ ...base, returned })).toMatchObject({ passed: true });
    expect(scoreCase({ ...base, expected: new Set(), returned })).toMatchObject({ passed: false });
    expect(scoreCase({ ...base, returned: [] })).toMatchObject({ passed: false });
    expect(scoreCase({ ...base, returned: [forbidden.values().next().value!] })).toMatchObject({
      forbiddenMatched: 1,
      passed: false,
    });
    expect(scoreCase({ ...base, returned: [...returned, ...returned] })).toMatchObject({
      duplicate: 1,
      passed: false,
    });
    expect(
      scoreCase({ ...base, returned, dangling: new Set([`${location}/dangling`]) })
    ).toMatchObject({ dangling: 1, passed: false });
  });

  it('runs the independent battery against production deriveCapability', () => {
    const result = runBattery(loadCases(), deriveCapability);
    expect(result).toMatchObject({ exitCode: 0, failures: [] });
    expect(result.observations).toHaveLength(13);
  });

  it('records watched-red producer/checker exits when failure is forced but state stays active', () => {
    const sentinel = loadCases().find((testCase) => testCase.watchedMutation !== undefined)!;
    const mutation = sentinel.watchedMutation!;
    const forcedInput: DeriveInput = {
      ...sentinel.query.args.input,
      failures: mutation.forceFailures,
    };

    // The watched mutation simulates a dishonest producer: it exits red and
    // reports its failure count, but keeps the pre-mutation active state. The
    // checker must identify the exact language/capability and exit nonzero.
    const dishonestDerive: DeriveCapability = (input) => ({
      ...deriveCapabilityContract(input),
      state: mutation.keepState,
      reason: undefined,
    });
    const mutatedCase: PhaseCase = {
      ...sentinel,
      query: {
        ...sentinel.query,
        args: { ...sentinel.query.args, input: forcedInput },
      },
      expectedCoverage: {
        ...sentinel.expectedCoverage,
        state: mutation.keepState,
        failures: mutation.forceFailures,
      },
    };
    const observation = executeProducer(mutatedCase, dishonestDerive);
    const watchedRed = checkCoverage([mutatedCase], [observation]);

    expect(mutation.id).toBe('force-producer-failure-while-active');
    expect(observation.evidence.state).toBe('active');
    expect(observation.evidence.failures).toBe(1);
    expect(observation.producerExitCode).toBe(mutation.expectedProducerExitCode);
    expect(watchedRed.exitCode).toBe(mutation.expectedCheckerExitCode);
    expect(watchedRed.failures).toContain(
      `${mutation.expectedObservable}: active capability has producer failure`
    );
    expect(watchedRed.observations).toHaveLength(1);
  });
});
