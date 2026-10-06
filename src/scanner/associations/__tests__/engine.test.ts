import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { AssociationEngine } from '../engine.js';
import type { AssociationContext, AssociationResolver, StructuralRelationEdge } from '../types.js';
import { fileNodeId, surfaceNodeId } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testDir = join(import.meta.dirname, 'fixtures', 'engine-test');

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function makeContext(overrides: Partial<AssociationContext> = {}): AssociationContext {
  return {
    rootPath: '/app',
    nodes: [],
    entries: [],
    dirtyFiles: [],
    ...overrides,
  };
}

function makeEdge(overrides: Partial<StructuralRelationEdge> = {}): StructuralRelationEdge {
  return {
    id: 'edge:test',
    edgeType: 'calls_surface',
    sourceNodeId: fileNodeId('resources/js/pages/Invoice.tsx'),
    targetNodeId: surfaceNodeId('http', 'GET /api/invoices'),
    sourceLanguage: 'typescript',
    targetLanguage: 'php',
    confidence: 0.9,
    confidenceClass: 'framework-inferred',
    provenance: {
      resolver: 'test-resolver',
      evidenceKind: 'test-match',
      evidenceLocations: [
        { filePath: 'resources/js/pages/Invoice.tsx', line: 10, note: 'GET /api/invoices' },
      ],
      extractedAt: now(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock resolver factory
// ---------------------------------------------------------------------------

function mockResolver(
  name: string,
  edges: StructuralRelationEdge[],
  supportsResult = true
): AssociationResolver {
  return {
    name,
    supports: (_ctx) => supportsResult,
    resolve: (_ctx) => Promise.resolve(edges),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AssociationEngine', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
    // Seed structural nodes for the edges to reference
    db.upsertStructuralNode({
      id: fileNodeId('resources/js/pages/Invoice.tsx'),
      node_type: 'file',
      file_path: 'resources/js/pages/Invoice.tsx',
      language_id: 'typescript',
      updated_at: now(),
    });
    db.upsertStructuralNode({
      id: surfaceNodeId('http', 'GET /api/invoices'),
      node_type: 'capability-surface',
      file_path: 'routes/api.php',
      language_id: 'php',
      updated_at: now(),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('rebuild()', () => {
    it('should run a resolver and persist its edges', async () => {
      const edge = makeEdge();
      const engine = new AssociationEngine(db, [mockResolver('test', [edge])]);

      const result = await engine.rebuild(makeContext());

      expect(result.resolversRun).toBe(1);
      expect(result.edgesProduced).toBe(1);
      expect(result.edgesStored).toBe(1);

      const stored = db.getStructuralEdgesForNode(edge.sourceNodeId);
      expect(stored).toHaveLength(1);
      expect(stored[0].edge_type).toBe('calls_surface');
      expect(stored[0].confidence).toBe(0.9);
    });

    it('should persist evidence alongside edges', async () => {
      const edge = makeEdge();
      const engine = new AssociationEngine(db, [mockResolver('test', [edge])]);

      await engine.rebuild(makeContext());

      const evidence = db.getEdgeEvidence(edge.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].resolver).toBe('test-resolver');
      expect(evidence[0].evidence_kind).toBe('test-match');
      expect(evidence[0].file_path).toBe('resources/js/pages/Invoice.tsx');
      expect(evidence[0].line).toBe(10);
    });

    it('should skip resolvers that return supports=false', async () => {
      const unsupported = mockResolver('unsupported', [makeEdge()], false);
      const engine = new AssociationEngine(db, [unsupported]);

      const result = await engine.rebuild(makeContext());

      expect(result.resolversRun).toBe(0);
      expect(result.edgesProduced).toBe(0);
      expect(result.edgesStored).toBe(0);
    });

    it('should deduplicate edges by ID (last write wins)', async () => {
      const edge1 = makeEdge({ confidence: 0.5 });
      const edge2 = makeEdge({ confidence: 0.9 }); // same id

      const engine = new AssociationEngine(db, [
        mockResolver('resolver-a', [edge1]),
        mockResolver('resolver-b', [edge2]),
      ]);

      const result = await engine.rebuild(makeContext());

      expect(result.edgesProduced).toBe(2);
      expect(result.edgesStored).toBe(1);

      const stored = db.getStructuralEdgesForNode(edge1.sourceNodeId);
      expect(stored[0].confidence).toBe(0.9); // last write wins
    });

    it('should filter uncorroborated heuristic edges by default', async () => {
      const heuristic = makeEdge({ id: 'edge:heuristic', confidenceClass: 'heuristic' });
      const engine = new AssociationEngine(db, [mockResolver('test', [heuristic])]);

      const result = await engine.rebuild(makeContext());

      expect(result.heuristicsFiltered).toBe(1);
      expect(result.edgesStored).toBe(0);
    });

    it('should keep heuristic edges when corroborated by a non-heuristic edge', async () => {
      const proven = makeEdge({ id: 'edge:proven', confidenceClass: 'framework-inferred' });
      const heuristic = makeEdge({ id: 'edge:heuristic', confidenceClass: 'heuristic' });

      // Both edges connect the same node pair — heuristic is corroborated
      const engine = new AssociationEngine(db, [mockResolver('test', [proven, heuristic])]);

      const result = await engine.rebuild(makeContext());

      expect(result.heuristicsFiltered).toBe(0);
      expect(result.edgesStored).toBe(2);
    });

    it('should include heuristics when includeHeuristics option is set', async () => {
      const heuristic = makeEdge({ confidenceClass: 'heuristic' });
      const engine = new AssociationEngine(db, [mockResolver('test', [heuristic])], {
        includeHeuristics: true,
      });

      const result = await engine.rebuild(makeContext());

      expect(result.heuristicsFiltered).toBe(0);
      expect(result.edgesStored).toBe(1);
    });

    it('should mark edges dirty-dependent when source file is dirty', async () => {
      const edge = makeEdge();
      const context = makeContext({
        dirtyFiles: ['resources/js/pages/Invoice.tsx'],
      });

      const engine = new AssociationEngine(db, [mockResolver('test', [edge])]);
      await engine.rebuild(context);

      const stored = db.getStructuralEdgesForNode(edge.sourceNodeId);
      expect(stored[0].freshness_status).toBe('dirty-dependent');
      expect(stored[0].dirty_dependency_count).toBeGreaterThan(0);
    });

    it('should mark edges fresh when no dirty files', async () => {
      const edge = makeEdge();
      const context = makeContext({ dirtyFiles: [] });

      const engine = new AssociationEngine(db, [mockResolver('test', [edge])]);
      await engine.rebuild(context);

      const stored = db.getStructuralEdgesForNode(edge.sourceNodeId);
      expect(stored[0].freshness_status).toBe('fresh');
    });

    it('should store the source_commit when provided in context', async () => {
      const edge = makeEdge();
      const context = makeContext({ currentCommit: 'deadbeef123' });

      const engine = new AssociationEngine(db, [mockResolver('test', [edge])]);
      await engine.rebuild(context);

      const stored = db.getStructuralEdgesForNode(edge.sourceNodeId);
      expect(stored[0].source_commit).toBe('deadbeef123');
    });

    it('should continue processing resolvers even if one throws', async () => {
      const throwing: AssociationResolver = {
        name: 'thrower',
        supports: () => true,
        resolve: () => Promise.reject(new Error('resolver exploded')),
      };
      const good = mockResolver('good', [makeEdge()]);

      const messages: string[] = [];
      const engine = new AssociationEngine(db, [throwing, good], {
        onProgress: (m) => messages.push(m),
      });

      const result = await engine.rebuild(makeContext());

      expect(result.edgesStored).toBe(1);
      expect(messages.some((m) => m.includes('resolver exploded'))).toBe(true);
    });

    it('reports a resolver that throws as a warning, not as progress', async () => {
      const throwing: AssociationResolver = {
        name: 'thrower',
        supports: () => true,
        resolve: () => Promise.reject(new Error('resolver exploded')),
      };
      const progress: string[] = [];
      const warnings: string[] = [];
      const engine = new AssociationEngine(db, [throwing], {
        onProgress: (m) => progress.push(m),
        onWarning: (m) => warnings.push(m),
      });

      await engine.rebuild(makeContext());

      expect(warnings).toEqual(['resolver thrower threw — resolver exploded']);
      expect(progress.some((m) => m.includes('resolver exploded'))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Node ID helpers
// ---------------------------------------------------------------------------

describe('node ID helpers', () => {
  it('fileNodeId produces stable IDs', () => {
    expect(fileNodeId('src/app.ts')).toBe('file:src/app.ts');
  });
});
