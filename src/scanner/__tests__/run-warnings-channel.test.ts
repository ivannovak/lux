// Degradations the scanner absorbs reach the run's warnings through Reporter.warn (issue #6): LSP
// enrichers that fail to start, cannot be built or fail per file, the Laravel detector failing, and the
// scoped refresh's LSP tier giving up.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import { buildRegistry, generalScan } from '../general.js';
import { loadLspConfig } from '../config.js';
import { EnricherRegistry, type LspEnricher } from '../lsp/index.js';
import { runDetectors } from '../associations/detectors/index.js';
import { LaravelHttpSurfaceDetector } from '../associations/detectors/laravel-http.js';
import { rebuildWithOverlay } from '../rebuild-orchestrator.js';
import { refreshOverlayScoped } from '../associations/overlay-refresh.js';
import type { AssociationContext } from '../associations/types.js';
import { persistRefreshTrustState } from '../overlay-trust-state.js';
import { resolveFirstPartyRoots } from '../pack/first-party.js';
import { resolveAppNamespace } from '../associations/ownership.js';
import { progressSink, warnSink } from '../reporter.js';
import type { RebuildResult } from '../rebuild-orchestrator.js';

const roots: string[] = [];

function tempRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'lux-warn-channel-'));
  roots.push(repo);
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(repo, rel), content);
  return repo;
}

/** A stand-in enricher for `.ts` files with configurable failures. */
function mockEnricher(opts: { initFails?: boolean; enrichFails?: boolean }): LspEnricher {
  let ready = false;
  return {
    languageId: 'mock',
    fileExtensions: ['.ts'],
    config: { serverCommand: 'mock', serverArgs: [] },
    get isReady() {
      return ready;
    },
    initialize: () => {
      if (opts.initFails) return Promise.reject(new Error('server would not start'));
      ready = true;
      return Promise.resolve();
    },
    enrich: () =>
      opts.enrichFails ? Promise.reject(new Error('request timed out')) : Promise.resolve(null),
    enrichBatch: () => Promise.resolve([]),
    shutdown: () => Promise.resolve(),
  };
}

async function scanWith(enricher: LspEnricher) {
  const repo = tempRepo({
    'lux.yaml': 'lsp:\n  enabled: true\n  enrichers: []\n',
    'package.json': '{}',
    'a.ts': 'export const a = 1;\n',
  });
  const registry = new EnricherRegistry();
  registry.register(enricher);
  return generalScan(repo, { config: loadLspConfig(repo), enricherRegistry: registry });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('scanner degradations reach the warnings channel', () => {
  it('an enricher that fails to initialize', async () => {
    const result = await scanWith(mockEnricher({ initFails: true }));
    expect(result.warnings).toContain('Failed to initialize mock enricher: server would not start');
  });

  it('per-file enrichment failures, as one summary', async () => {
    const result = await scanWith(mockEnricher({ enrichFails: true }));
    expect(result.warnings).toEqual([
      expect.stringMatching(/^LSP enrichment failed for 1 item\(s\) — .*a\.ts: request timed out$/),
    ]);
  });

  it('a configured enricher with no implementation', () => {
    const warnings: string[] = [];
    buildRegistry(
      [{ languageId: 'cobol', enabled: true, serverCommand: 'x', serverArgs: [] }] as Parameters<
        typeof buildRegistry
      >[0],
      warnSink((m) => {
        warnings.push(m);
      })
    );
    expect(warnings).toEqual([
      expect.stringContaining('LSP enricher for "cobol" was configured but is not supported'),
    ]);
  });

  it('the Laravel HTTP detector failing', async () => {
    vi.spyOn(
      LaravelHttpSurfaceDetector.prototype as unknown as { detectSync: () => never },
      'detectSync'
    ).mockImplementation(() => {
      throw new Error('route parse exploded');
    });
    vi.spyOn(LaravelHttpSurfaceDetector.prototype, 'supports').mockReturnValue(true);
    const dbDir = mkdtempSync(join(tmpdir(), 'lux-warn-channel-db-'));
    roots.push(dbDir);
    const db = new LuxDatabase(join(dbDir, 'lux.db'));
    const warnings: string[] = [];
    const context = {
      rootPath: dbDir,
      entries: [
        {
          filePath: join(dbDir, 'routes', 'web.php'),
          type: 'source-code',
          content: "<?php\nRoute::get('/a', fn () => 'a');\n",
          frontmatter: { language: 'php' },
        },
      ],
    } as unknown as AssociationContext;
    try {
      await runDetectors(db, context, [new LaravelHttpSurfaceDetector()], {
        progress: progressSink(() => {}),
        warn: warnSink((m) => {
          warnings.push(m);
        }),
        ran: () => {},
      });
    } finally {
      db.close();
    }
    expect(warnings).toEqual(['detector "laravel-http-surfaces" threw — route parse exploded']);
  });

  it("the scoped refresh's LSP tier giving up", async () => {
    const repo = tempRepo({
      'package.json': '{}',
      'lux.yaml': [
        'lsp:',
        '  enabled: true',
        '  enrichers:',
        '    - language_id: typescript',
        '      enabled: true',
        '      server_command: typescript-language-server',
        '      server_args:',
        '        - --stdio',
        '',
      ].join('\n'),
      'a.ts': 'export function a(): number { return 1; }\n',
    });
    execSync('git init -q && git config user.email a@b.c && git config user.name x', { cwd: repo });
    execSync('git add -A && git commit -q -m i', { cwd: repo });
    const dbDir = mkdtempSync(join(tmpdir(), 'lux-warn-channel-db-'));
    roots.push(dbDir);
    const db = new LuxDatabase(join(dbDir, 'lux.db'));
    try {
      await rebuildWithOverlay(db, repo, { vendorPackPath: null });
      writeFileSync(join(repo, 'a.ts'), 'export function a(): number { return 2; }\n');
      execSync('git add -A && git commit -q -m e', { cwd: repo });

      // A budget already spent before the tier starts: the tier gives up at its first check.
      const result = await refreshOverlayScoped(
        db,
        repo,
        [{ relPath: 'a.ts', status: 'modified' }],
        loadLspConfig(repo),
        { lspBudgetMs: -1 }
      );

      expect(result.tiers.lsp).toBe('skipped-budget');
      expect(result.warnings).toContain(
        'LSP tier exceeded budget or failed — skipping; :lsp edges of R left stale.'
      );
    } finally {
      db.close();
    }
  }, 120000);

  it('a scoped refresh that absorbed a warning settles degraded, even over a complete overlay', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'lux-warn-channel-db-'));
    roots.push(dbDir);
    const db = new LuxDatabase(join(dbDir, 'lux.db'));
    const complete: RebuildResult = {
      mode: 'overlay-complete',
      repoPath: dbDir,
      configSource: 'lux.yaml',
      configLspEnabled: true,
      surfaceCount: 0,
      detectorEdgeCount: 0,
      propagatedEdgeCount: 0,
      fileNodeCount: 1,
      symbolNodeCount: 1,
      controllerBackedCount: 0,
      closureBackedCount: 0,
      unknownProviderKindCount: 0,
      enrichmentStatus: 'active',
      propagationStatus: 'skipped',
      warnings: [],
    };
    try {
      const clean = persistRefreshTrustState(db, complete, { residualStaleEdges: 0, warnings: [] });
      expect(clean.mode).toBe('overlay-complete');

      const warned = persistRefreshTrustState(db, complete, {
        residualStaleEdges: 0,
        warnings: ['detector "d" threw — boom'],
      });
      expect(warned.mode).toBe('degraded-overlay');
      expect(warned.warnings).toEqual(['detector "d" threw — boom']);
    } finally {
      db.close();
    }
  });

  it('an unreadable installed.json, and a first-party package not installed', () => {
    const repo = tempRepo({ 'package.json': '{}' });
    mkdirSync(join(repo, 'vendor', 'composer'), { recursive: true });
    const warnings: string[] = [];
    const warn = warnSink((m) => {
      warnings.push(m);
    });

    writeFileSync(join(repo, 'vendor', 'composer', 'installed.json'), '{ not json');
    expect(resolveFirstPartyRoots(repo, ['acme/*'], warn)).toEqual([]);
    writeFileSync(
      join(repo, 'vendor', 'composer', 'installed.json'),
      JSON.stringify({ packages: [{ name: 'acme/kernel', 'install-path': '../acme/kernel' }] })
    );
    expect(resolveFirstPartyRoots(repo, ['acme/*'], warn)).toEqual([]);

    expect(warnings).toEqual([
      expect.stringMatching(
        /^vendor\/composer\/installed\.json could not be read, so no first-party/
      ),
      'first-party package acme/kernel is configured but not installed at ../acme/kernel',
    ]);
  });

  it('an unreadable composer.json when classifying handler ownership', () => {
    const repo = tempRepo({ 'composer.json': '{ not json' });
    const warnings: string[] = [];
    expect(
      resolveAppNamespace(
        repo,
        warnSink((m) => {
          warnings.push(m);
        })
      )
    ).toBe('App');
    expect(warnings).toEqual([
      expect.stringMatching(/^composer\.json could not be read, so handlers were classified/),
    ]);
  });

  it('a vendor pack lookup that fails', async () => {
    const repo = tempRepo({ 'package.json': '{}', 'lux.yaml': 'lsp:\n  enabled: false\n' });
    mkdirSync(join(repo, 'composer.lock')); // a directory: the lookup cannot read it
    const dbDir = mkdtempSync(join(tmpdir(), 'lux-warn-channel-db-'));
    roots.push(dbDir);
    const db = new LuxDatabase(join(dbDir, 'lux.db'));
    try {
      const { result } = await rebuildWithOverlay(db, repo);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^vendor pack lookup failed, so this rebuild is app-only — /),
        ])
      );
    } finally {
      db.close();
    }
  });
});
