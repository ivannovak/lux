import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T6 is deliberately independent from T5. This in-memory seam implements the
 * frozen Phase 2 traversal contract, so the gold battery can land and go red
 * before production traversal exists. Integration can substitute the production
 * function without changing this fixture, scorer, or either watched mutation.
 */
type Direction = 'outgoing' | 'incoming' | 'both';
type Traversed = 'forward' | 'reverse';
type Confidence = 'proven' | 'artifact-backed' | 'framework-inferred' | 'heuristic';
type Freshness = 'fresh' | 'stale';

type GoldEdge = {
  source: string;
  type: string;
  target: string;
  minConfidence?: Confidence;
  traversed: Traversed;
  repo: string;
  freshness?: Freshness;
};

type ForbiddenEdge = Partial<Omit<GoldEdge, 'minConfidence' | 'freshness'>>;

type PhaseCase = {
  id: string;
  corpus: string;
  capability: string;
  query: {
    tool: string;
    args: {
      symbol: string;
      direction: Direction;
      maxDepth: number;
      maxNodes: number;
      maxFanout: number;
      edgeTypes: string[];
      minConfidenceClass: Confidence;
      includeExternal: boolean;
      withRepos?: string[];
    };
  };
  expectedEdges: GoldEdge[];
  forbiddenEdges: ForbiddenEdge[];
  expectedOutcome: 'answered' | 'refused';
  expectedRefusalReason?: 'ambiguous';
  owner: string;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  thresholds: { minRecall: number; minPrecision: number };
};

type FixtureEdge = {
  id: string;
  source: string;
  type: string;
  target: string;
  confidence: Confidence;
  freshness: Freshness;
  repo: string;
};

type ReturnedEdge = FixtureEdge & { traversed: Traversed; revisit: boolean };

type TraceResult =
  | { status: 'ambiguous'; candidates: string[]; edges: [] }
  | {
      status: 'answered';
      direction: Direction;
      edges: ReturnedEdge[];
      nodes: string[];
      truncated: boolean;
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

const CONFIDENCE_RANK: Record<Confidence, number> = {
  proven: 3,
  'artifact-backed': 2,
  'framework-inferred': 1,
  heuristic: 0,
};

const DISPATCH_EDGES = new Set([
  'dispatches_job',
  'handles_job',
  'emits_event',
  'listens_event',
  'subscribes_event',
]);

const PORTABLE_ID = /^symbol:php:/;
const EXTERNAL_ID = /^symbol:php:Vendor\\/;
const AMBIGUOUS: Record<string, string[]> = {
  SharedHandler: [
    'symbol:php:App\\One\\SharedHandler::run',
    'symbol:php:App\\Two\\SharedHandler::run',
  ],
};

let edgeSequence = 0;
const e = (
  source: string,
  type: string,
  target: string,
  confidence: Confidence = 'framework-inferred',
  freshness: Freshness = 'fresh',
  repo = 'main'
): FixtureEdge => ({
  id: `${repo}:edge:${String(++edgeSequence).padStart(3, '0')}`,
  source,
  type,
  target,
  confidence,
  freshness,
  repo,
});

const T = 'symbol:php:App\\Services\\Pricing::quote';
const JOB = 'artifact:job:App\\Jobs\\SyncOrder';
const EVENT = 'event:php:App\\Events\\OrderPlaced';
const PORTABLE = 'symbol:php:App\\Contracts\\Billable::bill';
const LOCAL = 'symbol:ts:src/shared.ts#run';

/** Hand-authored source graph, separate from the JSON gold oracle. */
const FIXTURE_EDGES: FixtureEdge[] = [
  e('symbol:php:App\\Http\\Controllers\\CartController::total', 'calls', T, 'proven'),
  e('symbol:php:App\\Jobs\\PriceCart::handle', 'calls', T, 'artifact-backed'),
  e(T, 'calls', 'symbol:php:App\\Support\\Money::round', 'proven'),
  e(
    'surface:route:laravel:GET%20%2Forders',
    'handled_by',
    'symbol:php:App\\Http\\Controllers\\OrderController::index',
    'artifact-backed'
  ),
  e(
    'symbol:php:App\\Http\\Controllers\\OrderController::store',
    'validates_with',
    'contract:php:App\\Http\\Requests\\StoreOrderRequest',
    'artifact-backed'
  ),
  e(
    'symbol:php:App\\Http\\Controllers\\OrderController::store',
    'returns_contract',
    'contract:php:App\\Http\\Resources\\OrderResource',
    'artifact-backed'
  ),
  e('symbol:php:App\\Services\\Checkout::place', 'emits_event', EVENT),
  e('symbol:php:App\\Listeners\\SendReceipt::handle', 'listens_event', EVENT),
  e(EVENT, 'calls', 'symbol:php:App\\Projections\\Orders::apply', 'proven'),
  e(
    'symbol:php:App\\Http\\Controllers\\SyncController::queue',
    'dispatches_job',
    JOB,
    'artifact-backed'
  ),
  e(JOB, 'handles_job', 'symbol:php:App\\Jobs\\SyncOrder::handle', 'artifact-backed'),
  e(
    'surface:route:laravel:POST%20%2Fsync',
    'handled_by',
    'symbol:php:App\\Http\\Controllers\\SyncController::queue',
    'artifact-backed'
  ),
  e(
    'component:vue:src/pages/Orders.vue',
    'calls_surface',
    'surface:route:laravel:GET%20%2Fapi%2Forders'
  ),
  e('symbol:ts:src/cycle.ts#A', 'calls', 'symbol:ts:src/cycle.ts#B', 'proven'),
  e('symbol:ts:src/cycle.ts#B', 'calls', 'symbol:ts:src/cycle.ts#A', 'proven'),
  e('symbol:ts:src/cycle.ts#B', 'calls', 'symbol:ts:src/cycle.ts#C', 'proven'),
  e('symbol:ts:src/depth.ts#one', 'calls', 'symbol:ts:src/depth.ts#root', 'proven'),
  e('symbol:ts:src/depth.ts#two', 'calls', 'symbol:ts:src/depth.ts#one', 'proven'),
  e('symbol:ts:src/depth.ts#three', 'calls', 'symbol:ts:src/depth.ts#two', 'proven'),
  e('symbol:ts:src/budget.ts#a', 'calls', 'symbol:ts:src/budget.ts#root', 'proven'),
  e('symbol:ts:src/budget.ts#root', 'calls', 'symbol:ts:src/budget.ts#b', 'proven'),
  e('symbol:ts:src/budget.ts#c', 'calls', 'symbol:ts:src/budget.ts#root', 'proven'),
  e('symbol:ts:src/fan.ts#a', 'calls', 'symbol:ts:src/fan.ts#hub', 'proven'),
  e('symbol:ts:src/fan.ts#b', 'calls', 'symbol:ts:src/fan.ts#hub', 'proven'),
  e('symbol:ts:src/fan.ts#c', 'calls', 'symbol:ts:src/fan.ts#hub', 'proven'),
  e(
    'symbol:php:App\\Exact::call',
    'calls',
    'symbol:php:App\\Services\\ConfidenceTarget::run',
    'proven'
  ),
  e(
    'symbol:php:App\\Manifest::call',
    'calls',
    'symbol:php:App\\Services\\ConfidenceTarget::run',
    'artifact-backed'
  ),
  e('symbol:php:App\\Convention::call', 'calls', 'symbol:php:App\\Services\\ConfidenceTarget::run'),
  e(
    'symbol:php:App\\Guess::call',
    'calls',
    'symbol:php:App\\Services\\ConfidenceTarget::run',
    'heuristic'
  ),
  e(
    'symbol:php:App\\LegacyCaller::call',
    'calls',
    'symbol:php:App\\Services\\LegacyTarget::run',
    'proven',
    'stale'
  ),
  e('symbol:php:App\\Billing\\LocalBillable::bill', 'implements_contract', PORTABLE, 'proven'),
  e(
    'symbol:php:Peer\\Billing\\RemoteBillable::bill',
    'implements_contract',
    PORTABLE,
    'proven',
    'fresh',
    'peer'
  ),
  e('symbol:ts:src/main-caller.ts#call', 'calls', LOCAL, 'proven'),
  e('symbol:ts:src/peer-caller.ts#call', 'calls', LOCAL, 'proven', 'fresh', 'peer'),
  e(
    'symbol:php:App\\Http\\Controllers\\LocalController::call',
    'calls',
    'symbol:php:App\\Services\\LocalTarget::run',
    'proven'
  ),
  e(
    'symbol:php:Vendor\\Framework\\Proxy::call',
    'calls',
    'symbol:php:App\\Services\\LocalTarget::run',
    'proven'
  ),
];

function adjacent(edge: FixtureEdge, traversed: Traversed): string {
  return traversed === 'forward' ? edge.target : edge.source;
}

function traceWithContract(testCase: PhaseCase): TraceResult {
  const options = testCase.query.args;
  const candidates = AMBIGUOUS[options.symbol];
  if (candidates) return { status: 'ambiguous', candidates, edges: [] };

  const allowedRepos = new Set(['main', ...(options.withRepos ?? [])]);
  const visitedNodes = new Set([options.symbol]);
  const seenEdges = new Set<string>();
  const returned: ReturnedEdge[] = [];
  let frontier: Array<{ node: string; repo: string; depth: number }> = [
    { node: options.symbol, repo: 'main', depth: 0 },
  ];
  let truncated = false;

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    if (current.depth >= options.maxDepth) {
      truncated = true;
      continue;
    }

    const queryRepos = PORTABLE_ID.test(current.node) ? allowedRepos : new Set([current.repo]);
    const candidatesForNode: Array<{ edge: FixtureEdge; traversed: Traversed }> = [];
    for (const edge of FIXTURE_EDGES) {
      if (!queryRepos.has(edge.repo)) continue;
      if (!options.edgeTypes.includes(edge.type)) continue;
      if (CONFIDENCE_RANK[edge.confidence] < CONFIDENCE_RANK[options.minConfidenceClass]) continue;
      if (options.direction !== 'incoming' && edge.source === current.node) {
        candidatesForNode.push({ edge, traversed: 'forward' });
      }
      if (options.direction !== 'outgoing' && edge.target === current.node) {
        candidatesForNode.push({ edge, traversed: 'reverse' });
      }
    }

    candidatesForNode.sort((a, b) =>
      `${a.edge.id}:${a.traversed}`.localeCompare(`${b.edge.id}:${b.traversed}`)
    );
    if (candidatesForNode.length > options.maxFanout) truncated = true;

    for (const candidate of candidatesForNode.slice(0, options.maxFanout)) {
      const key = `${candidate.edge.id}\0${candidate.traversed}`;
      if (seenEdges.has(key)) continue;
      const next = adjacent(candidate.edge, candidate.traversed);
      if (!options.includeExternal && EXTERNAL_ID.test(next)) continue;
      const revisit = visitedNodes.has(next);
      if (!revisit && visitedNodes.size >= options.maxNodes) {
        truncated = true;
        continue;
      }

      seenEdges.add(key);
      returned.push({ ...candidate.edge, traversed: candidate.traversed, revisit });
      if (!revisit) {
        visitedNodes.add(next);
        // A reverse walk across a stored dispatch edge is ordinary inverse
        // navigation. Only forward dispatch marks a dynamic continuation.
        if (!(candidate.traversed === 'forward' && DISPATCH_EDGES.has(candidate.edge.type))) {
          frontier.push({ node: next, repo: candidate.edge.repo, depth: current.depth + 1 });
        }
      }
    }
  }

  return {
    status: 'answered',
    direction: options.direction,
    edges: returned,
    nodes: [...visitedNodes],
    truncated,
  };
}

function edgeKey(edge: GoldEdge | ReturnedEdge): string {
  const confidence = 'confidence' in edge ? edge.confidence : edge.minConfidence;
  return [
    edge.repo,
    edge.source,
    edge.type,
    edge.target,
    edge.traversed,
    confidence ?? 'framework-inferred',
    edge.freshness ?? 'fresh',
  ].join('\0');
}

function forbiddenMatches(edge: ReturnedEdge, forbidden: ForbiddenEdge): boolean {
  return (['repo', 'source', 'type', 'target', 'traversed'] as const).every(
    (field) => forbidden[field] === undefined || forbidden[field] === edge[field]
  );
}

function scoreCase(input: {
  expected: Set<string>;
  returned: ReturnedEdge[];
  forbidden: ForbiddenEdge[];
  dangling: Set<string>;
  minRecall: number;
  minPrecision: number;
}): Score {
  const returnedKeys = input.returned.map(edgeKey);
  const unique = new Set(returnedKeys);
  const duplicate = returnedKeys.length - unique.size;
  const matched = [...input.expected].filter((key) => unique.has(key)).length;
  const forbiddenMatched = input.returned.filter((edge) =>
    input.forbidden.some((control) => forbiddenMatches(edge, control))
  ).length;
  const expected = input.expected.size;
  const returnedInScope = unique.size;
  const failures: string[] = [];
  if (expected === 0) failures.push('zero expected positives');
  if (returnedInScope === 0) failures.push('zero returned edges');
  if (forbiddenMatched) failures.push(`${forbiddenMatched} forbidden edge(s)`);
  if (input.dangling.size) failures.push(`${input.dangling.size} dangling edge(s)`);
  if (duplicate) failures.push(`${duplicate} duplicate edge(s)`);
  const recall = expected ? matched / expected : 0;
  const precision = returnedInScope ? matched / returnedInScope : 0;
  if (recall < input.minRecall) failures.push(`recall ${recall} < ${input.minRecall}`);
  if (precision < input.minPrecision)
    failures.push(`precision ${precision} < ${input.minPrecision}`);
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

function loadCases(): PhaseCase[] {
  const path = join(process.cwd(), 'benchmarks', 'relationship', 'cases', 'phase-02.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PhaseCase[];
}

function runAnsweredBattery(cases: PhaseCase[]): {
  returned: ReturnedEdge[];
  expected: GoldEdge[];
} {
  const expected: GoldEdge[] = [];
  const returned: ReturnedEdge[] = [];
  for (const testCase of cases.filter((entry) => entry.expectedOutcome === 'answered')) {
    const result = traceWithContract(testCase);
    expect(result.status, testCase.id).toBe('answered');
    if (result.status !== 'answered') continue;
    expect(result.direction, testCase.id).toBe(testCase.query.args.direction);
    expected.push(...testCase.expectedEdges);
    returned.push(...result.edges);

    const score = scoreCase({
      expected: new Set(testCase.expectedEdges.map(edgeKey)),
      returned: result.edges,
      forbidden: testCase.forbiddenEdges,
      dangling: new Set(),
      ...testCase.thresholds,
    });
    expect(score, `${testCase.id}: ${score.failures.join(', ')}`).toMatchObject({
      recall: 1,
      precision: 1,
      passed: true,
    });
  }
  return { expected, returned };
}

describe('Phase 2 acceptance: independent incoming/both trace battery (T6)', () => {
  it('pins portable owner-approved cases with >=20 positive and >=10 negative controls', () => {
    const cases = loadCases();
    const positives = cases.reduce((count, testCase) => count + testCase.expectedEdges.length, 0);
    const negatives = cases.reduce((count, testCase) => count + testCase.forbiddenEdges.length, 0);

    expect(cases).toHaveLength(21);
    expect(cases.filter((testCase) => testCase.expectedOutcome === 'answered')).toHaveLength(20);
    expect(positives).toBeGreaterThanOrEqual(20);
    expect(negatives).toBeGreaterThanOrEqual(10);
    for (const testCase of cases) {
      expect(testCase).toMatchObject({
        corpus: 'lux',
        capability: 'incoming-bidirectional-trace',
        owner: 'Example Maintainer',
        fixtureSchemaVersion: 1,
        corpusPin: {
          remote: 'https://github.com/ivannovak/lux.git',
          commit: '5f1f053c635a7244d3d1c23045ce398170053623',
        },
        thresholds: { minRecall: 1, minPrecision: 1 },
      });
      expect(testCase.query.tool).toBe('lux_trace');
      expect(['incoming', 'both']).toContain(testCase.query.args.direction);
      expect(testCase.query.args.maxDepth).toBeGreaterThanOrEqual(1);
      expect(testCase.query.args.maxNodes).toBeGreaterThanOrEqual(1);
      expect(testCase.query.args.maxFanout).toBeGreaterThanOrEqual(1);
    }
  });

  it('answers every incoming/both gold case at 1.0 recall and precision', () => {
    const battery = runAnsweredBattery(loadCases());
    expect(battery.expected).toHaveLength(38);
    expect(battery.returned).toHaveLength(38);
  });

  it('covers direction, cycles, shared budgets, confidence, stale, dispatch, and federation laws', () => {
    const byId = new Map(loadCases().map((testCase) => [testCase.id, testCase]));
    const run = (id: string): Extract<TraceResult, { status: 'answered' }> => {
      const result = traceWithContract(byId.get(id)!);
      expect(result.status).toBe('answered');
      return result as Extract<TraceResult, { status: 'answered' }>;
    };

    const both = run('p02-direct-callers-both');
    expect(new Set(both.edges.map((edge) => edge.traversed))).toEqual(
      new Set<Traversed>(['forward', 'reverse'])
    );

    const cycle = run('p02-cycle-both-once-per-direction');
    expect(cycle.nodes).toHaveLength(3);
    expect(new Set(cycle.edges.map((edge) => `${edge.id}:${edge.traversed}`)).size).toBe(6);
    expect(cycle.edges.some((edge) => edge.revisit)).toBe(true);

    expect(run('p02-max-depth-incoming')).toMatchObject({ truncated: true });
    expect(run('p02-max-nodes-shared-both')).toMatchObject({ truncated: true });
    expect(run('p02-max-fanout-incoming')).toMatchObject({ truncated: true });
    expect(run('p02-stale-edge-is-visible').edges[0].freshness).toBe('stale');

    const reverseDispatch = run('p02-reverse-dispatch-continues-to-caller');
    expect(reverseDispatch.edges.map((edge) => edge.type)).toEqual([
      'dispatches_job',
      'handled_by',
    ]);
    expect(reverseDispatch.edges.every((edge) => edge.traversed === 'reverse')).toBe(true);

    const portable = run('p02-federation-portable-incoming');
    expect(new Set(portable.edges.map((edge) => edge.repo))).toEqual(new Set(['main', 'peer']));
    const local = run('p02-federation-repo-local-does-not-cross');
    expect(local.edges.map((edge) => edge.repo)).toEqual(['main']);
  });

  it('refuses ambiguous starts without guessing or emitting an edge', () => {
    const ambiguous = loadCases().find(
      (testCase) => testCase.id === 'p02-ambiguous-start-refused'
    )!;
    const result = traceWithContract(ambiguous);
    expect(result).toEqual({
      status: 'ambiguous',
      candidates: AMBIGUOUS.SharedHandler,
      edges: [],
    });
    expect(ambiguous.expectedRefusalReason).toBe('ambiguous');
  });

  it('is non-vacuous and records watched-red remove-required/inject-forbidden exit codes', () => {
    const cases = loadCases();
    runAnsweredBattery(cases);
    const sentinel = cases.find((testCase) => testCase.id === 'p02-direct-callers-both')!;
    const result = traceWithContract(sentinel);
    expect(result.status).toBe('answered');
    if (result.status !== 'answered') throw new Error('sentinel trace refused');
    const base = {
      expected: new Set(sentinel.expectedEdges.map(edgeKey)),
      forbidden: sentinel.forbiddenEdges,
      dangling: new Set<string>(),
      minRecall: 1,
      minPrecision: 1,
    };
    const green = scoreCase({ ...base, returned: result.edges });
    expect(green).toMatchObject({
      expected: 3,
      returnedInScope: 3,
      recall: 1,
      precision: 1,
      passed: true,
    });

    const removeRequired = scoreCase({ ...base, returned: result.edges.slice(1) });
    const injected: ReturnedEdge = {
      id: 'mutation:forbidden',
      source: T,
      type: 'calls',
      target: 'symbol:php:App\\Support\\Money::round',
      confidence: 'proven',
      freshness: 'fresh',
      repo: 'main',
      traversed: 'reverse',
      revisit: false,
    };
    const injectForbidden = scoreCase({ ...base, returned: [...result.edges, injected] });
    const watched = [
      {
        mutation: 'remove-required-edge',
        checkerExitCode: removeRequired.passed ? 0 : 1,
        observable: removeRequired.failures,
      },
      {
        mutation: 'inject-forbidden-edge',
        checkerExitCode: injectForbidden.passed ? 0 : 1,
        observable: injectForbidden.failures,
      },
    ];

    expect(watched).toEqual([
      expect.objectContaining({ mutation: 'remove-required-edge', checkerExitCode: 1 }),
      expect.objectContaining({ mutation: 'inject-forbidden-edge', checkerExitCode: 1 }),
    ]);
    expect(removeRequired.recall).toBeLessThan(1);
    expect(injectForbidden.forbiddenMatched).toBe(1);
    expect(injectForbidden.precision).toBeLessThan(1);
  });
});
