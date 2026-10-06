import { defineConfig } from 'vitest/config';

const TESTS = 'src/**/__tests__/**/*.test.ts';

/**
 * Test files that measure real time against a process they have just started, with limits of tens
 * of milliseconds. They pass on an idle machine and fail when other test files are using every
 * core, so they run on their own, one at a time, after everything else.
 */
const REAL_CLOCK_TESTS = ['src/scanner/lsp/__tests__/request-queueing.test.ts'];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Compiles `src` once per run for the tests that spawn the CLI (src/__tests__/helpers).
    globalSetup: ['./src/__tests__/helpers/cli-build.global-setup.ts'],
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
          exclude: REAL_CLOCK_TESTS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'real-clock',
          include: REAL_CLOCK_TESTS,
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
