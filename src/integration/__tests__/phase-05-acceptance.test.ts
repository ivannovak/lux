import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T18 is deliberately independent from T17. This deterministic virtual Git
 * seam implements the frozen Phase 5 preflight contract without importing the
 * producer. T19 can inject a production adapter into runBattery while keeping
 * owner gold, mutations, scoring, and the preflight execution gate unchanged.
 *
 * The adapter boundary is Phase5Preflight: manifest + corpus id + checkout
 * override/environment in, stable refusal or CorpusResolutionV1 out. Real Git
 * discovery/worktree creation belongs behind that boundary; DB opening and
 * benchmark case execution belong strictly after a successful result.
 */
type Scenario =
  | 'exact-checkout'
  | 'ssh-https-equivalence'
  | 'operator-override'
  | 'mismatched-head-isolated'
  | 'dirty-checkout-isolated'
  | 'missing-checkout'
  | 'remote-mismatch'
  | 'unreachable-commit'
  | 'mismatched-head-unisolated'
  | 'dirty-checkout-unisolated'
  | 'missing-owner'
  | 'schema-drift';
type PreflightCode =
  | 'corpus.ready'
  | 'corpus.schema-unsupported'
  | 'corpus.owner-missing'
  | 'corpus.id-missing'
  | 'corpus.checkout-missing'
  | 'corpus.remote-mismatch'
  | 'corpus.commit-unreachable'
  | 'corpus.commit-mismatch'
  | 'corpus.dirty-requires-isolation';
type CorpusManifestEntry = {
  id: string;
  remote: string;
  checkoutHints: string[];
  commit: string;
};
type CorpusManifest = {
  schemaVersion?: number;
  owner?: string;
  corpora: CorpusManifestEntry[];
};
type VirtualCheckout = {
  hint: string;
  remote: string;
  head: string;
  reachableCommits: string[];
  dirty: boolean;
};
type PreflightArgs = {
  manifest: CorpusManifest;
  corpusId: string;
  operatorOverrides?: Record<string, string>;
  environment: {
    checkouts: VirtualCheckout[];
    canCreateIsolatedWorktree: boolean;
  };
};
type CorpusResolutionV1 = {
  id: string;
  rootPath: string;
  remote: string;
  commit: string;
  owner: string;
  isolated: boolean;
};
type PreflightResult =
  | {
      status: 'ready';
      exitCode: 0;
      code: 'corpus.ready';
      resolution: CorpusResolutionV1;
    }
  | {
      status: 'refused';
      exitCode: 1;
      code: Exclude<PreflightCode, 'corpus.ready'>;
    };
type ExecutionEvent = 'preflight:success' | 'preflight:failure' | 'db:open' | `case:${string}`;
type ContractObservation = {
  preflight: PreflightResult;
  events: ExecutionEvent[];
};
type ScoreDimension =
  | 'status'
  | 'exit-code'
  | 'stable-code'
  | 'resolution-id'
  | 'canonical-remote'
  | 'exact-commit'
  | 'owner-approved'
  | 'isolation-policy'
  | 'no-resolution-on-failure'
  | 'execution-gate'
  | 'existing-positive-control'
  | 'portable-fixture';
type MutationId =
  'alter-remote' | 'alter-sha' | 'remove-owner' | 'alter-checkout-hint' | 'alter-override';
type WatchedMutation = {
  id: MutationId;
  expectedPreflightExitCode: 1;
  expectedCheckerExitCode: 1;
  expectedCode: PreflightCode;
  expectedObservable: string;
};
type PhaseCase = {
  id: string;
  corpus: 'lux';
  capability: 'portable-corpus-preflight';
  scenario: Scenario;
  query: { tool: 'phase5PreflightContract'; args: PreflightArgs };
  benchmarkControl?: { fixture: 'lux-ts' | 'example-app'; caseId: string };
  expected: ContractObservation;
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
  watchedMutations?: WatchedMutation[];
};
type Phase5Preflight = (args: PreflightArgs) => PreflightResult;
type ExecutionGate = (preflight: PreflightResult) => boolean;
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
  scores: Score[];
  observations: ContractObservation[];
  failures: string[];
};

const OWNER = 'Example Maintainer';
const PIN = '5f1f053c635a7244d3d1c23045ce398170053623';
const CORPUS_PIN = { remote: 'https://github.com/ivannovak/lux.git', commit: PIN };
const STABLE_CODE = /^corpus\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCEPTED_SCHEMA_VERSION = 1;

function benchmarkPath(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'benchmarks', ...parts);
}

function loadCases(): PhaseCase[] {
  return JSON.parse(
    readFileSync(benchmarkPath('relationship', 'cases', 'phase-05.json'), 'utf8')
  ) as PhaseCase[];
}

function canonicalGithubRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\/+$/, '');
  const scp = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) return `github.com/${scp[1].replace(/\.git$/i, '').toLowerCase()}`;

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const ownerRepo = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (ownerRepo.split('/').length !== 2) return undefined;
    return `github.com/${ownerRepo.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

function refusal(code: Exclude<PreflightCode, 'corpus.ready'>): PreflightResult {
  return { status: 'refused', exitCode: 1, code };
}

/** Independent executable reference implementation for the phase-5-contract seam. */
const phase5PreflightContract: Phase5Preflight = (args) => {
  if (args.manifest.schemaVersion !== ACCEPTED_SCHEMA_VERSION) {
    return refusal('corpus.schema-unsupported');
  }
  if (!args.manifest.owner?.trim()) return refusal('corpus.owner-missing');

  const corpus = args.manifest.corpora.find(({ id }) => id === args.corpusId);
  if (!corpus) return refusal('corpus.id-missing');

  const override = args.operatorOverrides?.[corpus.id];
  const candidates = override ? [override] : corpus.checkoutHints;
  const checkout = candidates
    .map((candidate) => args.environment.checkouts.find(({ hint }) => hint === candidate))
    .find((candidate): candidate is VirtualCheckout => candidate !== undefined);
  if (!checkout) return refusal('corpus.checkout-missing');

  const expectedRemote = canonicalGithubRemote(corpus.remote);
  const actualRemote = canonicalGithubRemote(checkout.remote);
  if (!expectedRemote || expectedRemote !== actualRemote) return refusal('corpus.remote-mismatch');
  if (!checkout.reachableCommits.includes(corpus.commit)) {
    return refusal('corpus.commit-unreachable');
  }

  const requiresIsolation = checkout.dirty || checkout.head !== corpus.commit;
  if (requiresIsolation && !args.environment.canCreateIsolatedWorktree) {
    return refusal(checkout.dirty ? 'corpus.dirty-requires-isolation' : 'corpus.commit-mismatch');
  }

  return {
    status: 'ready',
    exitCode: 0,
    code: 'corpus.ready',
    resolution: {
      id: corpus.id,
      rootPath: requiresIsolation ? `${checkout.hint}#detached:${corpus.commit}` : checkout.hint,
      remote: expectedRemote,
      commit: corpus.commit,
      owner: args.manifest.owner,
      isolated: requiresIsolation,
    },
  };
};

function execute(
  testCase: PhaseCase,
  preflight: Phase5Preflight,
  gate: ExecutionGate = (result) => result.status === 'ready'
): ContractObservation {
  const result = preflight(testCase.query.args);
  const events: ExecutionEvent[] = [
    result.status === 'ready' ? 'preflight:success' : 'preflight:failure',
  ];
  if (gate(result) && testCase.benchmarkControl) {
    events.push('db:open', `case:${testCase.benchmarkControl.caseId}`);
  }
  return { preflight: result, events };
}

function containsAbsoluteRepoPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAbsoluteRepoPath);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => {
    if (key === 'repoPath') return true;
    if (typeof entry === 'string' && key === 'rootPath') {
      return isAbsolute(entry) || win32.isAbsolute(entry) || entry.startsWith('\\\\');
    }
    return containsAbsoluteRepoPath(entry);
  });
}

function executionIsGated(observation: ContractObservation): boolean {
  const success = observation.events.indexOf('preflight:success');
  const dbOpen = observation.events.indexOf('db:open');
  const caseRun = observation.events.findIndex((event) => event.startsWith('case:'));
  if (observation.preflight.status === 'refused') return dbOpen === -1 && caseRun === -1;
  return (
    success >= 0 &&
    (dbOpen === -1 || dbOpen > success) &&
    (caseRun === -1 || (dbOpen >= 0 && caseRun > dbOpen))
  );
}

function existingControlExists(testCase: PhaseCase, observation: ContractObservation): boolean {
  if (!testCase.benchmarkControl) return true;
  const fixturePath = benchmarkPath(
    'retrieval',
    'fixtures',
    `${testCase.benchmarkControl.fixture}.json`
  );
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cases: { id: string; expect: { exitCode: number } }[];
  };
  const selected = fixture.cases.find(({ id }) => id === testCase.benchmarkControl?.caseId);
  return (
    selected?.expect.exitCode === 0 &&
    observation.events.includes('db:open') &&
    observation.events.includes(`case:${testCase.benchmarkControl.caseId}`)
  );
}

function dimensionPasses(
  dimension: ScoreDimension,
  testCase: PhaseCase,
  observation: ContractObservation
): boolean {
  const expected = testCase.expected.preflight;
  const actual = observation.preflight;
  switch (dimension) {
    case 'status':
      return actual.status === expected.status;
    case 'exit-code':
      return actual.exitCode === expected.exitCode;
    case 'stable-code':
      return actual.code === expected.code && STABLE_CODE.test(actual.code);
    case 'resolution-id':
      return (
        actual.status === 'ready' &&
        expected.status === 'ready' &&
        actual.resolution.id === expected.resolution.id
      );
    case 'canonical-remote':
      return (
        actual.status === 'ready' &&
        expected.status === 'ready' &&
        actual.resolution.remote === expected.resolution.remote &&
        actual.resolution.remote === canonicalGithubRemote(testCase.corpusPin.remote)
      );
    case 'exact-commit':
      return (
        actual.status === 'ready' &&
        expected.status === 'ready' &&
        actual.resolution.commit === expected.resolution.commit &&
        actual.resolution.commit === testCase.corpusPin.commit
      );
    case 'owner-approved':
      return (
        actual.status === 'ready' &&
        expected.status === 'ready' &&
        actual.resolution.owner === testCase.owner &&
        actual.resolution.owner === testCase.query.args.manifest.owner
      );
    case 'isolation-policy':
      return (
        actual.status === 'ready' &&
        expected.status === 'ready' &&
        actual.resolution.isolated === expected.resolution.isolated &&
        actual.resolution.rootPath === expected.resolution.rootPath
      );
    case 'no-resolution-on-failure':
      return actual.status === 'refused' && !('resolution' in actual);
    case 'execution-gate':
      return (
        executionIsGated(observation) &&
        JSON.stringify(observation.events) === JSON.stringify(testCase.expected.events)
      );
    case 'existing-positive-control':
      return existingControlExists(testCase, observation);
    case 'portable-fixture':
      return !containsAbsoluteRepoPath(testCase);
  }
}

function detectedForbiddenControls(
  testCase: PhaseCase,
  observation: ContractObservation
): string[] {
  const detected: string[] = [];
  const result = observation.preflight;
  const args = testCase.query.args;
  const corpus = args.manifest.corpora.find(({ id }) => id === args.corpusId);
  const override = corpus ? args.operatorOverrides?.[corpus.id] : undefined;
  const candidates = corpus ? (override ? [override] : corpus.checkoutHints) : [];
  const checkout = args.environment.checkouts.find(({ hint }) => candidates.includes(hint));
  const hasDb = observation.events.includes('db:open');
  const hasCase = observation.events.some((event) => event.startsWith('case:'));
  const successIndex = observation.events.indexOf('preflight:success');
  const dbIndex = observation.events.indexOf('db:open');
  const caseIndex = observation.events.findIndex((event) => event.startsWith('case:'));

  if (hasDb && (successIndex === -1 || dbIndex < successIndex)) {
    detected.push('db-open-before-preflight-success');
  }
  if (hasCase && (successIndex === -1 || caseIndex < successIndex)) {
    detected.push('case-execution-before-preflight-success');
  }
  if (containsAbsoluteRepoPath(testCase)) detected.push('absolute-repo-path');
  if (!checkout && result.status === 'ready') detected.push('missing-checkout-accepted');
  if (!args.manifest.owner?.trim() && result.status === 'ready') {
    detected.push('ownerless-manifest-accepted', 'unchecked-owner');
  }
  if (args.manifest.schemaVersion !== ACCEPTED_SCHEMA_VERSION && result.status === 'ready') {
    detected.push('schema-drift-accepted', 'unchecked-schema');
  }
  if (corpus && checkout) {
    const expectedRemote = canonicalGithubRemote(corpus.remote);
    const checkoutRemote = canonicalGithubRemote(checkout.remote);
    if (expectedRemote !== checkoutRemote && result.status === 'ready') {
      detected.push('remote-mismatch-accepted', 'unchecked-remote');
    }
    if (!checkout.reachableCommits.includes(corpus.commit) && result.status === 'ready') {
      detected.push('unreachable-commit-accepted', 'unchecked-commit');
    }
    if (result.status === 'ready' && result.resolution.isolated === false) {
      if (checkout.dirty) detected.push('dirty-source-benchmarked');
      if (checkout.head !== corpus.commit) detected.push('mismatched-sha-benchmarked');
    }
  }
  if (testCase.scenario === 'ssh-https-equivalence' && result.status !== 'ready') {
    detected.push('ssh-https-equivalence-rejected');
  }
  if (
    testCase.scenario === 'operator-override' &&
    result.status === 'ready' &&
    result.resolution.rootPath !== override
  ) {
    detected.push('override-ignored');
  }
  return [...new Set(detected)].filter((control) => testCase.forbiddenControls.includes(control));
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
  const matched = [...input.expected].filter((check) => unique.has(check)).length;
  const forbiddenMatched = [...input.forbidden].filter((check) => unique.has(check)).length;
  const expected = input.expected.size;
  const returnedInScope = unique.size;
  const failures: string[] = [];
  if (expected === 0) failures.push('zero expected positives');
  if (returnedInScope === 0) failures.push('zero returned checks');
  if (forbiddenMatched) failures.push(`${forbiddenMatched} forbidden check(s)`);
  if (input.dangling.size) failures.push(`${input.dangling.size} dangling check(s)`);
  if (duplicate) failures.push(`${duplicate} duplicate check(s)`);
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

function scoreObservation(testCase: PhaseCase, observation: ContractObservation): Score {
  const returned: string[] = testCase.scoreDimensions.filter((dimension) =>
    dimensionPasses(dimension, testCase, observation)
  );
  const forbidden = detectedForbiddenControls(testCase, observation);
  returned.push(...forbidden);
  const score = scoreCase({
    expected: new Set(testCase.scoreDimensions),
    returned,
    forbidden: new Set(testCase.forbiddenControls),
    dangling: new Set(),
    minRecall: testCase.thresholds.minRecall,
    minPrecision: testCase.thresholds.minPrecision,
  });
  score.failures = [
    ...testCase.scoreDimensions
      .filter((dimension) => !returned.includes(dimension))
      .map((dimension) => `${testCase.id}: ${dimension.replaceAll('-', ' ')}`),
    ...forbidden.map((control) => `${testCase.id}: forbidden ${control}`),
    ...score.failures.map((failure) => `${testCase.id}: ${failure}`),
  ];
  score.passed = score.failures.length === 0;
  return score;
}

function checkBattery(cases: PhaseCase[], observations: ContractObservation[]): CheckResult {
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
        dangling: 0,
        duplicate: 0,
        recall: 0,
        precision: 0,
        passed: false,
        failures: [failure],
      };
    }
    const score = scoreObservation(testCase, observation);
    failures.push(...score.failures);
    return score;
  });
  return { exitCode: failures.length ? 1 : 0, scores, observations, failures };
}

function runBattery(
  cases: PhaseCase[],
  preflight: Phase5Preflight,
  gate?: ExecutionGate
): CheckResult {
  return checkBattery(
    cases,
    cases.map((testCase) => execute(testCase, preflight, gate))
  );
}

function cloneCase(testCase: PhaseCase): PhaseCase {
  return JSON.parse(JSON.stringify(testCase)) as PhaseCase;
}

function applyMutation(testCase: PhaseCase, mutation: MutationId): PhaseCase {
  const mutated = cloneCase(testCase);
  const corpus = mutated.query.args.manifest.corpora[0];
  switch (mutation) {
    case 'alter-remote':
      corpus.remote = 'https://github.com/other/lux.git';
      return mutated;
    case 'alter-sha':
      corpus.commit = '0000000000000000000000000000000000000000';
      return mutated;
    case 'remove-owner':
      delete mutated.query.args.manifest.owner;
      return mutated;
    case 'alter-checkout-hint':
      corpus.checkoutHints = ['~/mutated/missing-checkout'];
      return mutated;
    case 'alter-override':
      mutated.query.args.operatorOverrides = { lux: '~/mutated/missing-override' };
      return mutated;
  }
}

function allWatchedMutations(
  cases: PhaseCase[]
): { testCase: PhaseCase; mutation: WatchedMutation }[] {
  return cases.flatMap((testCase) =>
    (testCase.watchedMutations ?? []).map((mutation) => ({ testCase, mutation }))
  );
}

describe('Phase 5 acceptance: independent portable corpus preflight battery (T18)', () => {
  it('pins owner/schema/corpus gold with nonzero positive and forbidden thresholds', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(12);
    expect(new Set(cases.map(({ scenario }) => scenario))).toEqual(
      new Set<Scenario>([
        'exact-checkout',
        'ssh-https-equivalence',
        'operator-override',
        'mismatched-head-isolated',
        'dirty-checkout-isolated',
        'missing-checkout',
        'remote-mismatch',
        'unreachable-commit',
        'mismatched-head-unisolated',
        'dirty-checkout-unisolated',
        'missing-owner',
        'schema-drift',
      ])
    );
    for (const testCase of cases) {
      expect(testCase).toMatchObject({
        corpus: 'lux',
        capability: 'portable-corpus-preflight',
        owner: OWNER,
        fixtureSchemaVersion: 1,
        corpusPin: CORPUS_PIN,
        thresholds: { minRecall: 1, minPrecision: 1 },
      });
      expect(testCase.query.tool).toBe('phase5PreflightContract');
      expect(testCase.scoreDimensions.length).toBeGreaterThanOrEqual(
        testCase.thresholds.minPositiveChecks
      );
      expect(testCase.forbiddenControls.length).toBeGreaterThanOrEqual(
        testCase.thresholds.minForbiddenControls
      );
      expect(testCase.thresholds.minPositiveChecks).toBeGreaterThan(0);
      expect(testCase.thresholds.minForbiddenControls).toBeGreaterThan(0);
      expect(testCase.thresholds.minRecall).toBeGreaterThanOrEqual(0);
      expect(testCase.thresholds.minRecall).toBeLessThanOrEqual(1);
      expect(testCase.thresholds.minPrecision).toBeGreaterThanOrEqual(0);
      expect(testCase.thresholds.minPrecision).toBeLessThanOrEqual(1);
      expect(containsAbsoluteRepoPath(testCase)).toBe(false);
    }
  });

  it('executes all positive and refusal cases at 1.0/1.0 through the contract seam', () => {
    const checked = runBattery(loadCases(), phase5PreflightContract);
    expect(checked).toMatchObject({ exitCode: 0, failures: [] });
    expect(checked.observations).toHaveLength(12);
    for (const score of checked.scores) {
      expect(score.expected).toBeGreaterThanOrEqual(6);
      expect(score).toMatchObject({
        recall: 1,
        precision: 1,
        forbiddenMatched: 0,
        dangling: 0,
        duplicate: 0,
        passed: true,
      });
    }
  });

  it('normalizes HTTPS, SCP SSH, and ssh:// GitHub remotes to owner/repo identity', () => {
    expect(canonicalGithubRemote('https://github.com/ivannovak/lux.git')).toBe(
      'github.com/ivannovak/lux'
    );
    expect(canonicalGithubRemote('git@github.com:ivannovak/lux.git')).toBe(
      'github.com/ivannovak/lux'
    );
    expect(canonicalGithubRemote('ssh://git@github.com/ivannovak/lux.git')).toBe(
      'github.com/ivannovak/lux'
    );
    expect(canonicalGithubRemote('https://github.com/other/lux.git')).not.toBe(
      'github.com/ivannovak/lux'
    );
  });

  it('requires exact or isolated pinned SHA and never benchmarks a dirty source checkout', () => {
    const selected = loadCases().filter(({ scenario }) =>
      [
        'mismatched-head-isolated',
        'dirty-checkout-isolated',
        'mismatched-head-unisolated',
        'dirty-checkout-unisolated',
      ].includes(scenario)
    );
    const checked = runBattery(selected, phase5PreflightContract);
    expect(checked).toMatchObject({ exitCode: 0, failures: [] });
    expect(checked.observations.map(({ preflight }) => preflight)).toEqual([
      expect.objectContaining({
        status: 'ready',
        resolution: expect.objectContaining({ isolated: true }),
      }),
      expect.objectContaining({
        status: 'ready',
        resolution: expect.objectContaining({ isolated: true }),
      }),
      expect.objectContaining({ status: 'refused', code: 'corpus.commit-mismatch' }),
      expect.objectContaining({ status: 'refused', code: 'corpus.dirty-requires-isolation' }),
    ]);
  });

  it('opens no DB and runs no case until preflight succeeds', () => {
    const checked = runBattery(loadCases(), phase5PreflightContract);
    for (const observation of checked.observations)
      expect(executionIsGated(observation)).toBe(true);
    const refused = checked.observations.filter(({ preflight }) => preflight.status === 'refused');
    expect(refused.length).toBeGreaterThan(0);
    for (const observation of refused) {
      expect(observation.events).toEqual(['preflight:failure']);
    }

    const positive = loadCases().find(({ benchmarkControl }) => benchmarkControl !== undefined)!;
    const bypassed = execute(
      positive,
      () => refusal('corpus.remote-mismatch'),
      () => true
    );
    expect(executionIsGated(bypassed)).toBe(false);
    expect(scoreObservation(positive, bypassed)).toMatchObject({
      passed: false,
      forbiddenMatched: 2,
    });
  });

  it('runs one existing owner-approved Lux positive control only after successful preflight', () => {
    const testCase = loadCases().find(({ benchmarkControl }) => benchmarkControl !== undefined)!;
    expect(testCase.benchmarkControl).toEqual({
      fixture: 'lux-ts',
      caseId: 'lux-ts-search-content-scoped',
    });
    const observation = execute(testCase, phase5PreflightContract);
    expect(observation.preflight).toMatchObject({ status: 'ready', exitCode: 0 });
    expect(observation.events).toEqual([
      'preflight:success',
      'db:open',
      'case:lux-ts-search-content-scoped',
    ]);
    expect(existingControlExists(testCase, observation)).toBe(true);
  });

  it('rejects zero-positive/zero-return, missing, forbidden, duplicate, and dangling controls', () => {
    expect(checkBattery([], [])).toMatchObject({ exitCode: 1 });
    const testCase = loadCases()[0];
    const observation = execute(testCase, phase5PreflightContract);
    expect(scoreObservation(testCase, observation)).toMatchObject({ passed: true });
    expect(checkBattery([testCase], [])).toMatchObject({ exitCode: 1 });

    const expected = new Set(['status', 'exit-code']);
    const base = { expected, minRecall: 1, minPrecision: 1 };
    expect(
      scoreCase({ ...base, returned: ['status'], forbidden: new Set(), dangling: new Set() })
    ).toMatchObject({ passed: false, recall: 0.5 });
    expect(
      scoreCase({
        ...base,
        returned: ['status', 'exit-code', 'forbidden'],
        forbidden: new Set(['forbidden']),
        dangling: new Set(),
      })
    ).toMatchObject({ passed: false, forbiddenMatched: 1 });
    expect(
      scoreCase({
        ...base,
        returned: ['status', 'exit-code', 'status'],
        forbidden: new Set(),
        dangling: new Set(),
      })
    ).toMatchObject({ passed: false, duplicate: 1 });
    expect(
      scoreCase({
        ...base,
        returned: ['status', 'exit-code'],
        forbidden: new Set(),
        dangling: new Set(['orphan']),
      })
    ).toMatchObject({ passed: false, dangling: 1 });
  });

  it('records watched-red remote, SHA, owner, checkout-hint, and override exits', () => {
    const watched = allWatchedMutations(loadCases());
    expect(watched.map(({ mutation }) => mutation.id)).toEqual([
      'alter-remote',
      'alter-sha',
      'remove-owner',
      'alter-checkout-hint',
      'alter-override',
    ]);

    const records = watched.map(({ testCase, mutation }) => {
      const mutated = applyMutation(testCase, mutation.id);
      const preflight = phase5PreflightContract(mutated.query.args);
      const checked = runBattery([mutated], phase5PreflightContract);
      expect(preflight.exitCode).toBe(mutation.expectedPreflightExitCode);
      expect(preflight.code).toBe(mutation.expectedCode);
      expect(checked.exitCode).toBe(mutation.expectedCheckerExitCode);
      expect(checked.failures).toContain(mutation.expectedObservable);
      expect(checked.observations[0].events).toEqual(['preflight:failure']);
      return {
        id: mutation.id,
        preflightExitCode: preflight.exitCode,
        checkerExitCode: checked.exitCode,
        code: preflight.code,
      };
    });

    expect(records).toEqual([
      {
        id: 'alter-remote',
        preflightExitCode: 1,
        checkerExitCode: 1,
        code: 'corpus.remote-mismatch',
      },
      {
        id: 'alter-sha',
        preflightExitCode: 1,
        checkerExitCode: 1,
        code: 'corpus.commit-unreachable',
      },
      {
        id: 'remove-owner',
        preflightExitCode: 1,
        checkerExitCode: 1,
        code: 'corpus.owner-missing',
      },
      {
        id: 'alter-checkout-hint',
        preflightExitCode: 1,
        checkerExitCode: 1,
        code: 'corpus.checkout-missing',
      },
      {
        id: 'alter-override',
        preflightExitCode: 1,
        checkerExitCode: 1,
        code: 'corpus.checkout-missing',
      },
    ]);
  });
});
