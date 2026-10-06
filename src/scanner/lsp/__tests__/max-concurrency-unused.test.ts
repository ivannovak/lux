// `max_concurrency` no longer does anything: requests go to a language server one at a time. A
// lux.yaml that still sets it is told so, not left to believe the setting is in effect.

import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../../general.js';
import { warnSink } from '../../reporter.js';

describe('lsp.enrichers max_concurrency', () => {
  it('is reported as unused, once per enricher that sets it', () => {
    const warnings: string[] = [];
    buildRegistry(
      [
        { languageId: 'php', maxConcurrency: 8 },
        { languageId: 'typescript' },
        { languageId: 'vue', enabled: false, maxConcurrency: 4 },
      ],
      warnSink((message) => void warnings.push(message))
    );
    expect(warnings).toEqual([expect.stringMatching(/"php": max_concurrency is no longer used/)]);
  });
});
