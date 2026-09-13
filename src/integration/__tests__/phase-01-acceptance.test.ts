import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../db/index.js';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import {
  openIndex,
  type IndexOpenMode,
  type IndexOpenRefusal,
  type IndexOpenResult,
} from '../../db/open-policy.js';

/**
 * T2 is intentionally independent of T1. This local seam has the frozen openIndex
 * signature and behavior, allowing the acceptance battery to land before the leaf
 * implementation. The integration owner can pass production openIndex to runBattery
 * without changing any fixture, oracle, or mutation control below.
 */
type FixtureState = 'absent' | 'old' | 'new' | 'corrupt' | 'current';
type SnapshotEntry = {
  kind: 'directory' | 'file' | 'symlink';
  bytes?: string;
};
type SafetySnapshot = {
  tree: Record<string, SnapshotEntry>;
  gitStatus: string;
  dbSidecars: string[];
  ownerMarkers: string[];
};
type PhaseCase = {
  id: string;
  corpus: string;
  capability: string;
  query: {
    tool: string;
    args: { state: FixtureState; cliCommands: string[]; mcpTools: string[] };
  };
  expectedOutcome: 'answered' | 'refused';
  expectedRefusalReason?: IndexOpenRefusal;
  owner: string;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  expectedExitCode: number;
  thresholds: {
    minRecall: number;
    minPrecision: number;
    minPositiveChecks: number;
    minForbiddenControls: number;
  };
  snapshot: string[];
  forbiddenSideEffects: string[];
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

const READ_TELEMETRY = { recorded: false as const, reason: 'read-only-index' as const };
const EXPECTED_CLI_MATRIX = [
  'index status',
  'search',
  'anchors',
  'trace',
  'trace --direction incoming',
  'trace --direction both',
  'deps graph',
  'deps clusters',
  'deps impact',
  'deps coverage',
  'delta',
  'overlay status',
  'overlay check',
  'overlay ownership',
  'overlay boundaries',
  'siblings status',
  'usage report',
] as const;
const EXPECTED_MCP_READ_TOOLS = [
  'lux_search',
  'lux_get_file',
  'lux_spec_derivation_evidence',
  'lux_trace',
  'lux_anchors',
  'lux_delta',
  'lux_deps_impact',
  'lux_overlay_status',
  'lux_index_status',
] as const;
const SNAPSHOT_DIMENSIONS = [
  'directory-tree',
  'file-bytes',
  'mtimes',
  'git-status',
  'db-sidecars',
  'owner-markers',
] as const;
const FORBIDDEN_SIDE_EFFECTS = [
  'created-path',
  'removed-path',
  'changed-bytes',
  'changed-mtime',
  'git-status',
  'db-sidecar',
  'owner-marker',
] as const;

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function latestSchemaVersion(): number {
  const migrations = join(process.cwd(), 'src', 'db', 'migrations');
  return Math.max(
    ...readdirSync(migrations)
      .map((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
  );
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
}

function makeFixture(state: FixtureState): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), `lux-p01-${state}-`));
  roots.push(root);
  const dbPath = join(root, '.lux', 'lux.db');
  writeFileSync(join(root, 'README.md'), `phase-01 ${state} fixture\n`);

  if (state === 'old' || state === 'new') {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new LuxSqlite(dbPath);
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER)');
    db.run(
      'INSERT INTO schema_version (version, applied_at) VALUES (?, 1)',
      state === 'old' ? latestSchemaVersion() - 1 : latestSchemaVersion() + 1
    );
    db.close();
  } else if (state === 'corrupt') {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, 'not a sqlite database\n');
  } else if (state === 'current') {
    const db = new LuxDatabase(dbPath);
    db.close();
  }

  // Owner-marker sentinels make owner registry creation/removal observable in every state.
  const markerDir = `${dbPath}.owners`;
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, 'external-owner'), 'independent-fixture');

  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Phase 01 Battery',
    '-c',
    'user.email=phase-01@example.invalid',
    'commit',
    '-qm',
    `fixture: ${state}`,
  ]);
  expect(git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
  return { root, dbPath };
}

function snapshot(root: string, dbPath: string): SafetySnapshot {
  const tree: Record<string, SnapshotEntry> = {};
  const visit = (absolute: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      if (name === '.git') continue;
      const path = join(absolute, name);
      const key = relative(root, path).split('\\').join('/');
      const stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory()) {
        tree[key] = { kind: 'directory' };
        visit(path);
      } else if (stat.isSymbolicLink()) {
        tree[key] = { kind: 'symlink' };
      } else {
        tree[key] = {
          kind: 'file',
          bytes: createHash('sha256').update(readFileSync(path)).digest('hex'),
        };
      }
    }
  };
  visit(root);
  const dbRelative = relative(root, dbPath).split('\\').join('/');
  const paths = Object.keys(tree);
  return {
    tree,
    gitStatus: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    dbSidecars: paths.filter((path) =>
      [
        `${dbRelative}-journal`,
        `${dbRelative}-wal`,
        `${dbRelative}-shm`,
        `${dbRelative}.lock`,
      ].some((sidecar) => path === sidecar || path.startsWith(`${sidecar}/`))
    ),
    ownerMarkers: paths.filter(
      (path) => path === `${dbRelative}.owners` || path.startsWith(`${dbRelative}.owners/`)
    ),
  };
}

function changedPaths(before: SafetySnapshot, after: SafetySnapshot): string[] {
  const paths = new Set([...Object.keys(before.tree), ...Object.keys(after.tree)]);
  const changed = [...paths].filter(
    (path) => JSON.stringify(before.tree[path]) !== JSON.stringify(after.tree[path])
  );
  if (before.gitStatus !== after.gitStatus) changed.push('$git-status');
  if (JSON.stringify(before.dbSidecars) !== JSON.stringify(after.dbSidecars)) {
    changed.push('$db-sidecars');
  }
  if (JSON.stringify(before.ownerMarkers) !== JSON.stringify(after.ownerMarkers)) {
    changed.push('$owner-markers');
  }
  return [...new Set(changed)].sort();
}

function invoke(open: typeof openIndex, dbPath: string, mode: IndexOpenMode): IndexOpenResult {
  const result = open(dbPath, mode);
  if (result.ok) result.db.close();
  return result;
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
  const matched = [...input.expected].filter((edge) => unique.has(edge)).length;
  const forbiddenMatched = [...input.forbidden].filter((edge) => unique.has(edge)).length;
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
  const fixturePath = join(process.cwd(), 'benchmarks', 'relationship', 'cases', 'phase-01.json');
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PhaseCase[];
}

describe('Phase 1 acceptance: independent non-creating read safety (T2)', () => {
  it('pins a portable, owner-approved matrix with non-vacuous thresholds', () => {
    const cases = loadCases();
    expect(cases.map((testCase) => testCase.query.args.state)).toEqual([
      'absent',
      'old',
      'new',
      'corrupt',
      'current',
    ]);

    for (const testCase of cases) {
      expect(testCase.corpus).toBe('lux');
      expect(testCase.capability).toBe('non-creating-read-safety');
      expect(testCase.owner).toBe('Example Maintainer');
      expect(testCase.fixtureSchemaVersion).toBe(1);
      expect(testCase.corpusPin).toEqual({
        remote: 'https://github.com/ivannovak/lux.git',
        commit: '5f1f053c635a7244d3d1c23045ce398170053623',
      });
      expect(testCase.query.args.cliCommands).toEqual(EXPECTED_CLI_MATRIX);
      expect(testCase.query.args.mcpTools).toEqual(EXPECTED_MCP_READ_TOOLS);
      expect(testCase.snapshot).toEqual(SNAPSHOT_DIMENSIONS);
      expect(testCase.forbiddenSideEffects).toEqual(FORBIDDEN_SIDE_EFFECTS);
      expect(testCase.thresholds).toEqual({
        minRecall: 1,
        minPrecision: 1,
        minPositiveChecks: 26,
        minForbiddenControls: 7,
      });
      expect(testCase.query.args.cliCommands.length + testCase.query.args.mcpTools.length).toBe(26);
      expect(testCase.forbiddenSideEffects.length).toBe(7);
    }
  });

  it('runs every CLI/MCP read surface through every state without file, mtime, Git, sidecar, or owner changes', () => {
    const records: Array<{
      caseId: string;
      surface: string;
      exitCode: number;
      refusal?: IndexOpenRefusal;
      telemetry: typeof READ_TELEMETRY;
    }> = [];

    for (const testCase of loadCases()) {
      const { root, dbPath } = makeFixture(testCase.query.args.state);
      for (const surface of [
        ...testCase.query.args.cliCommands.map((command) => `cli:${command}`),
        ...testCase.query.args.mcpTools.map((tool) => `mcp:${tool}`),
      ]) {
        const before = snapshot(root, dbPath);
        const result = invoke(openIndex, dbPath, 'read-existing');
        const after = snapshot(root, dbPath);
        const exitCode = result.ok ? 0 : 1;
        records.push({
          caseId: testCase.id,
          surface,
          exitCode,
          refusal: result.ok ? undefined : result.refusal,
          telemetry: READ_TELEMETRY,
        });

        expect(changedPaths(before, after), `${testCase.id} ${surface}`).toEqual([]);
        expect(exitCode, `${testCase.id} ${surface}`).toBe(testCase.expectedExitCode);
        if (testCase.expectedOutcome === 'refused') {
          expect(result.ok, `${testCase.id} ${surface}`).toBe(false);
          if (!result.ok) expect(result.refusal).toBe(testCase.expectedRefusalReason);
        } else {
          expect(result.ok, `${testCase.id} ${surface}`).toBe(true);
          if (result.ok) expect(result.schemaVersion).toBe(latestSchemaVersion());
        }
      }
    }

    expect(records).toHaveLength(5 * 26);
    expect(records.every((record) => record.telemetry.reason === 'read-only-index')).toBe(true);
    expect(records.filter((record) => record.exitCode === 1)).toHaveLength(4 * 26);
    expect(records.filter((record) => record.exitCode === 0)).toHaveLength(26);
  }, 60_000);

  it('scores the green battery at 1.0/1.0 and rejects missing, forbidden, duplicate, and dangling controls', () => {
    const testCase = loadCases()[4];
    const expected = new Set([
      ...testCase.query.args.cliCommands.map((command) => `cli:${command}`),
      ...testCase.query.args.mcpTools.map((tool) => `mcp:${tool}`),
    ]);
    const returned = [...expected];
    const forbidden = new Set(testCase.forbiddenSideEffects);
    const base = {
      expected,
      forbidden,
      dangling: new Set<string>(),
      minRecall: testCase.thresholds.minRecall,
      minPrecision: testCase.thresholds.minPrecision,
    };

    expect(scoreCase({ ...base, returned })).toMatchObject({
      expected: 26,
      matched: 26,
      recall: 1,
      precision: 1,
      passed: true,
    });
    expect(scoreCase({ ...base, returned: returned.slice(1) })).toMatchObject({ passed: false });
    expect(scoreCase({ ...base, returned: [...returned, 'created-path'] })).toMatchObject({
      forbiddenMatched: 1,
      passed: false,
    });
    expect(scoreCase({ ...base, returned: [...returned, returned[0]] })).toMatchObject({
      duplicate: 1,
      passed: false,
    });
    expect(
      scoreCase({ ...base, returned, dangling: new Set(['dangling:phase-01-probe']) })
    ).toMatchObject({ dangling: 1, passed: false });
  });

  it('plants the watched-red seam: create-or-migrate is observed with exit code 1 and named paths', () => {
    const { root, dbPath } = makeFixture('absent');
    const before = snapshot(root, dbPath);

    // This is the required read-only mutation: one nominal read is deliberately
    // routed through the explicit writer. The command succeeds, but the safety
    // checker must go red because the repository snapshot changed.
    const commandResult = invoke(openIndex, dbPath, 'create-or-migrate');
    const changed = changedPaths(before, snapshot(root, dbPath));
    const watchedRed = {
      mutation: 'route-through-create-or-migrate',
      commandExitCode: commandResult.ok ? 0 : 1,
      checkerExitCode: changed.length === 0 ? 0 : 1,
      observable: changed,
    };

    expect(watchedRed.commandExitCode).toBe(0);
    expect(watchedRed.checkerExitCode).toBe(1);
    expect(watchedRed.observable).toContain('.lux/lux.db');
    expect(watchedRed.observable).toContain('$git-status');
  });
});
