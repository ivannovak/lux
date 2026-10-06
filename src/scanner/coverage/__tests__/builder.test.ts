import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';
import { buildCoverage, COVERAGE_PRODUCER_CATALOG } from '../builder.js';
import {
  loadCoverageProducerRuns,
  persistScopedCoverageProducerRuns,
} from '../producer-runs.js';
import { persistRebuildTrustState } from '../../overlay-trust-state.js';
import type { LuxLspConfig } from '../../config.js';

const CONFIG: LuxLspConfig = {
  lsp: { enabled: true, enrichers: [{ languageId: 'vue' }] },
  deps: { enabled: false },
  ast: { enabled: true },
};

function rebuildResult(repoPath: string) {
  return {
    mode: 'overlay-complete' as const,
    repoPath,
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
    enrichmentStatus: 'active' as const,
    propagationStatus: 'empty' as const,
    warnings: [],
  };
}

function node(id: string, filePath: string): StructuralNode {
  return {
    id,
    node_type: 'symbol',
    file_path: filePath,
    language_id: 'typescript',
    symbol_name: id,
    updated_at: 1,
  };
}

function edge(id: string, source: string, target: string): StructuralEdge {
  return {
    id,
    source_node_id: source,
    target_node_id: target,
    edge_type: 'calls',
    confidence: 1,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: 1,
  };
}

describe('production coverage builder', () => {
  let root: string;
  let db: LuxDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lux-coverage-'));
    db = new LuxDatabase(join(root, 'lux.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('derives candidates only from source-code metadata and output only from local canonical rows', () => {
    for (const [language, path] of [
      ['php', 'a.php'],
      ['typescript', 'a.ts'],
      ['javascript', 'a.js'],
      ['vue', 'A.vue'],
      ['ruby', 'a.rb'],
    ]) {
      db.insertKnowledgeEntry({
        type: 'source-code',
        title: path,
        file_path: path,
        metadata: {
          language,
          ...(language === 'vue'
            ? { lsp: { languageId: 'vue', enrichedAt: 1 } }
            : {}),
        },
      });
    }
    db.insertKnowledgeEntry({
      type: 'general',
      title: 'not source',
      file_path: 'ignored.ts',
      metadata: { language: 'typescript' },
    });
    db.upsertStructuralNode(node('ts-a', 'a.ts'));
    db.upsertStructuralNode(node('ts-b', 'a.ts'));
    db.upsertStructuralNode({ ...node('vendor', 'a.ts'), origin: 'vendor-pack' });
    db.upsertStructuralEdge(edge('call', 'ts-a', 'ts-b'));
    persistRebuildTrustState(db, rebuildResult(root));

    const beforeTrust = db.getIndexMetadata('overlay_trust_state');
    const payload = buildCoverage(db, { corpusPath: root, loadConfig: () => CONFIG });
    const byLanguage = new Map(payload.languages.map((language) => [language.languageId, language]));

    expect(byLanguage.get('php')?.files).toBe(1);
    expect(byLanguage.get('typescript')).toMatchObject({
      schemaVersion: 1,
      files: 1,
      symbolizedFiles: 1,
      symbols: 2,
      relatedSymbols: 2,
      capabilities: {
        syntax: { state: 'active', nodes: 2 },
        calls: { state: 'active', edges: 1 },
      },
    });
    expect(byLanguage.get('javascript')?.capabilities.calls.state).toBe('partial');
    expect(byLanguage.get('vue')?.capabilities.symbols.state).toBe('partial');
    expect(byLanguage.get('ruby')?.capabilities.syntax.state).toBe('unsupported');
    expect(db.getIndexMetadata('overlay_trust_state')).toBe(beforeTrust);
  });

  it('does not call zero errors success: absent run trust is failed and no candidates are explicit', () => {
    db.insertKnowledgeEntry({
      type: 'source-code',
      title: 'a.ts',
      file_path: 'a.ts',
      metadata: { language: 'typescript' },
    });
    const payload = buildCoverage(db, { corpusPath: root, loadConfig: () => CONFIG });
    const ts = payload.languages.find((language) => language.languageId === 'typescript')!;
    const php = payload.languages.find((language) => language.languageId === 'php')!;
    expect(ts.capabilities.syntax).toMatchObject({
      state: 'failed',
      reason: 'configured producer did not run',
    });
    expect(php.capabilities.syntax).toMatchObject({
      state: 'not_applicable',
      reason: 'no applicable candidates',
    });
  });

  it('scoped evidence is recomputed from the working tree; an un-refreshed Vue signal stands', () => {
    db.setIndexMetadata(
      'coverage_producer_runs_v1',
      JSON.stringify({
        'php-tree-sitter': { status: 'success', failures: 0, completedCandidates: 8 },
        'typescript-tree-sitter': { status: 'success', failures: 0, completedCandidates: 10 },
        'vue-language-server': { status: 'success', failures: 0, completedCandidates: 4 },
        'structural-overlay': { status: 'success', failures: 0, completedCandidates: 22 },
      })
    );
    const source = (filePath: string, language: string) => ({
      type: 'source-code',
      title: filePath,
      filePath: `/repo/${filePath}`,
      frontmatter: { language },
      content: '',
    });

    persistScopedCoverageProducerRuns(db, '/repo', {
      tiers: { ast: 'ran', lsp: 'ran' },
      refreshedPaths: ['src/changed.ts'],
      lspEnrichmentFailures: [],
      enrichments: new Map(),
      workingTree: {
        scan: {
          knowledge: [
            source('src/changed.ts', 'typescript'),
            source('src/added.ts', 'typescript'),
            source('app/A.php', 'php'),
            source('resources/B.vue', 'vue'),
          ],
        },
      },
    });

    expect(loadCoverageProducerRuns(db)).toMatchObject({
      // Counted from the tree as it is now, not carried from the last full run.
      'php-tree-sitter': { status: 'success', failures: 0, completedCandidates: 1 },
      'typescript-tree-sitter': { status: 'success', failures: 0, completedCandidates: 2 },
      // B.vue was not refreshed, so the server's last recorded outcome stands.
      'vue-language-server': { status: 'success', failures: 0, completedCandidates: 4 },
      'structural-overlay': { status: 'success', failures: 0, completedCandidates: 0 },
    });
  });

  it('exports an immutable explicit producer catalog', () => {
    expect(Object.isFrozen(COVERAGE_PRODUCER_CATALOG)).toBe(true);
    expect(Object.isFrozen(COVERAGE_PRODUCER_CATALOG.php)).toBe(true);
    expect(COVERAGE_PRODUCER_CATALOG.javascript.calls).toMatchObject({
      producer: 'javascript-tree-sitter',
      runSignal: 'overlay',
      output: 'calls',
    });
  });
});
