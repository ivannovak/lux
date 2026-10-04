// A failed module-dependency write, or a warning the scan absorbed, downgrades an otherwise
// overlay-complete rebuild (issue #6).
//
// A complete overlay needs LSP-materialized symbols, which no fast fixture produces, so the scan is
// stubbed with one that would classify as overlay-complete. The control case proves it does; each
// failure case then shows that one problem alone is what degrades it.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import type { GeneralScanOptions, GeneralScanResult } from '../general.js';

const stub = vi.hoisted(() => ({ scanWarnings: [] as string[] }));

/** The classification reads the database, so the stub persists the nodes its tallies report. */
function seedOverlay(db: LuxDatabase | undefined): void {
  db?.upsertStructuralNode({
    id: 'file:a.php',
    node_type: 'file',
    file_path: 'a.php',
    updated_at: 1,
  });
  db?.upsertStructuralNode({
    id: 'symbol:php:A',
    node_type: 'symbol',
    file_path: 'a.php',
    symbol_name: 'A',
    updated_at: 1,
  });
}

vi.mock('../general.js', () => ({
  generalScan: vi.fn(
    async (_root: string, options?: GeneralScanOptions): Promise<GeneralScanResult> => {
      seedOverlay(options?.db);
      return {
        scan: { knowledge: [] } as unknown as GeneralScanResult['scan'],
        enrichments: new Map() as unknown as GeneralScanResult['enrichments'],
        dependencies: [
          { source_module: 'Users', target_module: 'Orders', reference_count: 1, sample_files: [] },
        ],
        stats: { enrichedFiles: 1, activeEnrichers: 1, enrichmentErrors: [], lspFailures: [] },
        overlay: {
          fileNodes: 1,
          symbolNodes: 1,
          edgesStored: 0,
          heuristicsFiltered: 0,
          staleMarked: 0,
          currentCommit: undefined,
          dirtyFileCount: 0,
          surfacesDetected: 0,
          surfaceEdgesStored: 0,
          propagationEdgesAdded: 0,
          symbolCollisions: (await import('../identity/symbol-collisions.js')).SymbolIdCollisions
            .NONE,
        },
        warnings: [...stub.scanWarnings],
        warningComponents: {},
      };
    }
  ),
}));

const { rebuildWithOverlay } = await import('../rebuild-orchestrator.js');

const roots: string[] = [];

function setup(): { repo: string; db: LuxDatabase } {
  const repo = mkdtempSync(join(tmpdir(), 'lux-deps-trust-'));
  roots.push(repo);
  writeFileSync(join(repo, 'lux.yaml'), 'lsp:\n  enabled: true\n  enrichers: []\n');
  return { repo, db: new LuxDatabase(join(repo, 'lux.db')) };
}

afterEach(() => {
  stub.scanWarnings = [];
  vi.restoreAllMocks();
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('rebuild orchestrator — dependency write failure and trust', () => {
  it('stays overlay-complete when the dependency write succeeds', async () => {
    const { repo, db } = setup();
    try {
      const { result } = await rebuildWithOverlay(db, repo, { vendorPackPath: null });

      expect(result.mode).toBe('overlay-complete');
      expect(result.warnings).toEqual([]);
      expect(db.getAllModuleDependencies()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('degrades to degraded-overlay when the dependency write fails', async () => {
    const { repo, db } = setup();
    try {
      vi.spyOn(db, 'insertModuleDependency').mockImplementation(() => {
        throw new Error('disk full');
      });

      const { result } = await rebuildWithOverlay(db, repo, { vendorPackPath: null });

      expect(result.mode).toBe('degraded-overlay');
      expect(result.warnings).toEqual([
        'Failed to write module dependencies (disk full); the module dependency graph is empty until the next successful rebuild.',
      ]);
      expect(db.getAllModuleDependencies()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('degrades to degraded-overlay when the scan absorbed a warning', async () => {
    const { repo, db } = setup();
    stub.scanWarnings = ['detector "d" threw — boom'];
    try {
      const { result } = await rebuildWithOverlay(db, repo, { vendorPackPath: null });

      expect(result.mode).toBe('degraded-overlay');
      expect(result.warnings).toEqual(['detector "d" threw — boom']);
      expect(db.getAllModuleDependencies()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
