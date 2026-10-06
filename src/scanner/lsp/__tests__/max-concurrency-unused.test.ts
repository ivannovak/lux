// `max_concurrency` no longer does anything: requests go to a language server one at a time. A
// lux.yaml that still sets it is told so, not left to believe the setting is in effect.

import { describe, expect, it } from 'vitest';
import { buildRegistry } from '../../general.js';
import { warnSink } from '../../reporter.js';

describe('lsp.enrichers max_concurrency', () => {
  it('is reported as unused in one warning that names the enrichers setting it', () => {
    const warnings: string[] = [];
    buildRegistry(
      [
        { languageId: 'php', maxConcurrency: 8 },
        { languageId: 'typescript' },
        { languageId: 'vue', maxConcurrency: 4 },
        { languageId: 'go', enabled: false, maxConcurrency: 4 },
      ],
      warnSink((message) => void warnings.push(message))
    );
    // "go" is disabled, so its setting is not in play; it would otherwise be warned as unsupported.
    expect(warnings).toEqual([
      expect.stringMatching(/^max_concurrency is no longer used \(php, vue\); remove it/),
    ]);
  });
});
