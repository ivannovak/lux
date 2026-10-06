// A parser worker that fails to start fails every JavaScript or Vue file it was meant to parse.
// The run must say so, once per parser, with the reason and how many files it cost — not report a
// quiet success, and not one warning per file.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START_TIMEOUT = {
  schemaVersion: 1,
  ok: false,
  diagnostic: { code: 'start-timeout', message: 'Parser worker did not start within 30s.' },
} as const;

vi.mock('../adapters/worker-host.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/worker-host.js')>();
  return {
    ...actual,
    runBoundedParserWorker: () => Promise.resolve(START_TIMEOUT),
    runBoundedExtractionWorker: () => Promise.resolve({ response: START_TIMEOUT }),
  };
});

const { generalScan } = await import('../general.js');

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('generalScan — parser worker that fails to start', () => {
  it('warns once per parser with the reason and the number of files not parsed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'lux-worker-start-failure-'));
    dirs.push(repo);
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'package.json'), '{}');
    for (const name of ['a.js', 'b.js', 'c.js']) {
      writeFileSync(join(repo, 'src', name), 'export const value = 1;\n');
    }
    for (const name of ['A.vue', 'B.vue']) {
      writeFileSync(join(repo, 'src', name), '<template><div /></template>\n');
    }

    const result = await generalScan(repo, {
      config: { lsp: { enabled: false, enrichers: [] }, deps: { enabled: false } },
    });

    expect(result.warnings).toContain(
      'JavaScript parser worker failed to start: Parser worker did not start within 30s. ' +
        '3 file(s) were not parsed.'
    );
    expect(result.warnings).toContain(
      'Vue parser worker failed to start: Parser worker did not start within 30s. ' +
        '2 file(s) were not parsed.'
    );
    expect(result.warnings.filter((message) => message.includes('failed to start'))).toHaveLength(
      2
    );
  });
});
