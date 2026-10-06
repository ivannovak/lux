import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Compiles `src` once per run for the tests that spawn the CLI (src/__tests__/helpers).
    globalSetup: ['./src/__tests__/helpers/cli-build.global-setup.ts'],
    // The suite includes CLI integration tests that spawn multiple lux
    // subprocesses plus a real language server and run a full overlay rebuild.
    // The default 5s is too tight for those on slower CI runners (they take
    // ~6s there vs ~1.5s locally), so raise the ceiling for the whole suite.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'src/**/__tests__/**', '**/*.config.*'],
    },
  },
});
