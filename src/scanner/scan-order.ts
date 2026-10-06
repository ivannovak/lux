// Canonical processing order for discovered files.
//
// `glob` walks directories asynchronously, so the order it returns paths in varies from run to
// run. Everything downstream of the scan iterates the knowledge list in that order, so the scan
// sorts it once, by UTF-16 code unit (locale-independent), before anything reads it.
//
// LUX_TEST_SCAN_ORDER_SEED is a test seam, not a configuration knob: when set, the sorted list is
// permuted with a seeded shuffle. The determinism test sets a different seed for each of two
// rebuilds, so a stage that depends on processing order makes the two indexes diverge instead of
// hiding behind the sort.

export const SCAN_ORDER_SEED_ENV = 'LUX_TEST_SCAN_ORDER_SEED';

/** Sort paths by code unit, then apply the test permutation when the seed is set. */
export function canonicalScanOrder(paths: readonly string[]): string[] {
  const sorted = [...paths].sort(compareCodeUnits);
  const seed = process.env[SCAN_ORDER_SEED_ENV];
  return seed ? seededShuffle(sorted, seed) : sorted;
}

/** Locale-independent string comparison, for every sort whose result is persisted or printed. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
