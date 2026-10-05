// Lever E — the overlay persist loops are batched into ONE transaction each, and
// the batch is all-or-nothing. A fake db models transaction atomicity (staged
// writes commit on success, discard on throw) so these tests assert the wrapping
// itself, independent of SQLite. (The PRAGMA + LuxDatabase.transaction wrapper
// live in the DB layer and are exercised in db/__tests__.)

import { describe, it, expect } from 'vitest';
import type { LuxDatabase } from '../../../db/index.js';
import type { StructuralEdge, StructuralNode, EdgeEvidence } from '../../../db/types.js';
import type { AssociationContext, AssociationResolver, StructuralRelationEdge } from '../types.js';
import { AssociationEngine } from '../engine.js';
import type { ScanResult } from '../../types.js';
import { materializeAstSymbols } from '../../ast/materialize.js';

/** Models transaction atomicity: staged writes commit on success, drop on throw. */
class FakeTxDb {
  committedEdges: StructuralEdge[] = [];
  committedNodes: StructuralNode[] = [];
  committedEvidence: EdgeEvidence[] = [];
  txCount = 0;
  failOnEdgeId?: string;

  private inTx = false;
  private stagedEdges: StructuralEdge[] = [];
  private stagedNodes: StructuralNode[] = [];
  private stagedEvidence: EdgeEvidence[] = [];

  transaction<T>(fn: () => T): T {
    // Nested transactions (replaceEdgeEvidence) behave as savepoints — no new commit.
    if (this.inTx) return fn();
    this.txCount++;
    this.inTx = true;
    this.stagedEdges = [];
    this.stagedNodes = [];
    this.stagedEvidence = [];
    try {
      const result = fn();
      // Commit only on success; a throw skips this and the staged writes are
      // discarded (rollback).
      this.committedEdges.push(...this.stagedEdges);
      this.committedNodes.push(...this.stagedNodes);
      this.committedEvidence.push(...this.stagedEvidence);
      return result;
    } finally {
      this.inTx = false;
    }
  }

  inTransaction(): boolean {
    return this.inTx;
  }

  upsertStructuralEdge(edge: StructuralEdge): void {
    if (edge.id === this.failOnEdgeId) throw new Error('write failed');
    (this.inTx ? this.stagedEdges : this.committedEdges).push(edge);
  }

  replaceEdgeEvidence(edgeId: string, evidence: EdgeEvidence[]): void {
    void edgeId;
    (this.inTx ? this.stagedEvidence : this.committedEvidence).push(...evidence);
  }

  // materializeAstSymbols also upserts anchor texts (mig 014) in the same transaction — a no-op here
  // (this fake models edge/node/evidence atomicity, not the anchor plane).
  upsertNodeAnchorText(): void {}

  upsertStructuralNode(node: StructuralNode): void {
    (this.inTx ? this.stagedNodes : this.committedNodes).push(node);
  }

  getStructuralNode(): null {
    return null;
  }

  asDb(): LuxDatabase {
    return this as unknown as LuxDatabase;
  }
}

function relEdge(id: string): StructuralRelationEdge {
  return {
    id,
    edgeType: 'calls',
    sourceNodeId: 'symbol:ts:a.ts#x',
    targetNodeId: 'symbol:ts:b.ts#y',
    sourceLanguage: 'typescript',
    targetLanguage: 'typescript',
    confidence: 0.9,
    confidenceClass: 'proven',
    provenance: {
      resolver: 'test',
      evidenceKind: 'unit',
      evidenceLocations: [{ filePath: 'a.ts', line: 1, note: 'y' }],
      extractedAt: 1,
    },
  };
}

function context(): AssociationContext {
  return { rootPath: '/repo', nodes: [], entries: [], dirtyFiles: [] };
}

describe('Lever E — batched, atomic persistence', () => {
  it('persistEdges writes all edges + evidence in a single transaction', () => {
    const db = new FakeTxDb();
    const n = AssociationEngine.persistEdges(db.asDb(), [
      relEdge('e1'),
      relEdge('e2'),
      relEdge('e3'),
    ]);

    expect(n).toBe(3);
    expect(db.txCount).toBe(1); // one commit, not three
    expect(db.committedEdges).toHaveLength(3);
    expect(db.committedEvidence).toHaveLength(3);
  });

  it('persistEdges rolls back every edge when one write throws', () => {
    const db = new FakeTxDb();
    db.failOnEdgeId = 'e2';

    expect(() =>
      AssociationEngine.persistEdges(db.asDb(), [relEdge('e1'), relEdge('e2'), relEdge('e3')])
    ).toThrow('write failed');

    // All-or-nothing: e1 (written before the throw) must NOT be committed.
    expect(db.committedEdges).toHaveLength(0);
    expect(db.txCount).toBe(1);
  });

  it('engine.rebuild persists its edges in a single transaction', async () => {
    const db = new FakeTxDb();
    const resolver: AssociationResolver = {
      name: 'fake',
      supports: () => true,
      resolve: () => Promise.resolve([relEdge('r1'), relEdge('r2')]),
    };
    const result = await new AssociationEngine(db.asDb(), [resolver]).rebuild(context());

    expect(result.edgesStored).toBe(2);
    expect(db.txCount).toBe(1);
    expect(db.committedEdges).toHaveLength(2);
  });

  it('materializeAstSymbols upserts its nodes, then its anchor texts, in one transaction each', async () => {
    const db = new FakeTxDb();
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'a.ts',
          filePath: '/repo/a.ts',
          frontmatter: { language: 'typescript' },
          content: 'export function foo() {}\nexport class Bar {}',
        },
      ],
    };

    const count = await materializeAstSymbols(db.asDb(), scan, '/repo', 1000);

    expect(count).toBeGreaterThan(0);
    expect(db.txCount).toBe(2);
    expect(db.committedNodes.length).toBe(count);
  });
});
