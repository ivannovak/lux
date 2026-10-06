// Internal rebuild plumbing stays out of the package entry point. It is reachable from its own
// module for the code (and tests) that need it, but it is not public API.

import { describe, it, expect } from 'vitest';
import * as pkg from '../../index.js';

describe('package entry point', () => {
  it('does not export the module-dependency writer', () => {
    expect(Object.keys(pkg)).not.toContain('persistModuleDependencies');
  });

  it('still exports the rebuild orchestration surface', () => {
    expect(Object.keys(pkg)).toEqual(
      expect.arrayContaining(['rebuildWithOverlay', 'rebuildContentOnly'])
    );
  });
});
