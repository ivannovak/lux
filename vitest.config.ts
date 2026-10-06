import { defineConfig } from 'vitest/config';

const TESTS = 'src/**/__tests__/**/*.test.ts';

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
    // The suite includes CLI integration tests that spawn multiple lux
    // subprocesses plus a real language server and run a full overlay rebuild.
    // The default 5s is too tight for those on slower CI runners (they take
    // ~6s there vs ~1.5s locally), so raise the ceiling for the whole suite.
    testTimeout: 20000,
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
