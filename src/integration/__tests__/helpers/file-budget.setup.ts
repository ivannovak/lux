// The time budget of one test file, enforced in every file (vitest.config.ts `setupFiles`).
//
// The suite as a whole has a ceiling (the Test step's timeout in CI), but a slow file added under
// that ceiling only erodes it. This fails the file that is over its budget, on the change that made
// it slow: the time from before the file's first hook to after its last, which is every test and
// hook in the file and not its import. The budget is TEST_FILE_BUDGET_MS, and the environment
// variable LUX_TEST_FILE_BUDGET_MS overrides it (to try the guard, or to profile a slow file).
//
// A file over budget is made faster or split; the budget is not raised for it.

import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll } from 'vitest';

/**
 * The slowest file takes about 38 s on the hosted runner and about 40 s on a loaded workstation; most
 * take under 10 s. A minute leaves room for a slower runner without letting a new file of that size
 * pass unnoticed.
 */
export const TEST_FILE_BUDGET_MS = 60_000;

function budgetMs(): number {
  const override = Number(process.env.LUX_TEST_FILE_BUDGET_MS);
  return Number.isFinite(override) && override > 0 ? override : TEST_FILE_BUDGET_MS;
}

let startedAt = 0;

beforeAll(() => {
  startedAt = performance.now();
});

afterAll(() => {
  const elapsedMs = performance.now() - startedAt;
  const budget = budgetMs();
  if (elapsedMs > budget) {
    throw new Error(
      `This test file took ${(elapsedMs / 1000).toFixed(1)} s, over its budget of ` +
        `${(budget / 1000).toFixed(1)} s (src/integration/__tests__/helpers/file-budget.setup.ts). ` +
        'Make it faster or split it.'
    );
  }
});
