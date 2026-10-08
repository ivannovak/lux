import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { defineConfig } from 'vitest/config';

const TESTS = 'src/**/__tests__/**/*.test.ts';

/**
 * Test files that replace a module (`vi.mock`, `vi.doMock`), found by reading every test file when
 * the config loads, so a new one is classified without anyone listing it. They run isolated, each
 * with a fresh module graph. Every other file shares its worker's module graph with the files the
 * worker ran before it (`isolate: false`): importing Lux's modules again for each of 340 files was
 * a tenth of the suite's time. A file that changes shared state must put it back, as these do.
 */
const MODULE_MOCKING_TESTS = globSync(TESTS).filter((file) =>
  /\bvi\.(?:do)?[mM]ock\(/.test(readFileSync(file, 'utf8'))
);

/**
 * Test files that run one at a time, after everything else, because they cannot share the machine:
 *
 * - request-queueing measures real time against a process it has just started, with limits of tens
 *   of milliseconds, and fails when other test files are using every core.
 * - lock-contention starts 48 CLI processes at once to contend for one lock. Beside other files it
 *   takes every core for as long as it runs, and the CLI tests next to it time out.
 */
const EXCLUSIVE_TESTS = [
  'src/scanner/lsp/__tests__/request-queueing.test.ts',
  'src/cli/__tests__/lock-contention.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Compiles `src` once per run for the tests that spawn the CLI (src/integration/__tests__/helpers).
    globalSetup: ['./src/integration/__tests__/helpers/cli-build.global-setup.ts'],
    // Fails a test file that runs over its time budget (the file says how long and why).
    setupFiles: ['./src/integration/__tests__/helpers/file-budget.setup.ts'],
    // The per-test and per-hook budgets. The slowest test takes about 15 s on the hosted runner
    // and the slowest hook (a beforeAll that indexes fixtures and runs a battery of CLI commands)
    // about 35 s, so these leave each twice its time. A test does not raise its own: one that needs
    // longer is made faster or split. (The one exception is the opt-in LUX_EMBED_SMOKE suite, which
    // downloads and runs the real embedding model and is never part of a default run.) A test that
    // blocks on spawnSync is checked when it returns, so its CLI calls carry their own kill timeouts
    // as hang guards. A hook that blocks is not checked at all (vitest's timer cannot fire during
    // it): hookTimeout bounds asynchronous hooks, and the file budget bounds the rest.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Test files run side by side, each in its own process. Four at a time is what a CI runner
    // has cores for; more than that on a large machine starves the tests that spawn the CLI or
    // a language server.
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: 'parallel',
          include: [TESTS],
          exclude: [...EXCLUSIVE_TESTS, ...MODULE_MOCKING_TESTS],
          isolate: false,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'isolated',
          include: MODULE_MOCKING_TESTS,
          exclude: EXCLUSIVE_TESTS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'exclusive',
          include: EXCLUSIVE_TESTS,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'src/**/__tests__/**', '**/*.config.*'],
    },
  },
});
