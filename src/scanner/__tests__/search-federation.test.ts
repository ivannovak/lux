// Federated search — per-repo FTS union grouped + independently ranked (spec 13B / SC-5,9).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LuxDatabase, SearchRefusalError } from '../../db/index.js';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { runFederatedSearch } from '../search-federation.js';
import type { FederationBlock } from '../siblings.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-fed-search-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeDb(name: string): LuxDatabase {
  return new LuxDatabase(join(root, name, '.lux', 'lux.db'));
}

function addDoc(db: LuxDatabase, title: string, path: string, content: string): void {
  db.insertKnowledgeEntry({ type: 'documentation', title, file_path: path, content });
}

const BLOCK: FederationBlock = {
  siblings: [
    {
      name: 'sib_kernel',
      role: 'kernel',
      attached: true,
      worktree: null,
      freshness: { indexedCommit: 'a', headCommit: 'a', stale: false, dbSchemaVersion: 13 },
    },
  ],
};

describe('runFederatedSearch', () => {
  it('returns one group per repo (main first), each independently ranked', () => {
    const primary = makeDb('client');
    const kernel = makeDb('kernel');
    addDoc(primary, 'Client Settlement Notes', 'docs/settlement.md', 'settlement in the client');
    addDoc(kernel, 'Kernel Settlement Engine', 'docs/engine.md', 'settlement engine internals');

    const result = runFederatedSearch(
      primary,
      [{ name: 'sib_kernel', db: kernel }],
      'settlement',
      BLOCK,
      20
    );

    expect(result.groups.map((g) => g.repo)).toEqual(['main', 'sib_kernel']);
    expect(result.groups[0].results.length).toBeGreaterThan(0);
    expect(result.groups[1].results.length).toBeGreaterThan(0);
    expect(result.groups[0].results[0].path).toBe('docs/settlement.md');
    expect(result.groups[1].results[0].path).toBe('docs/engine.md');
    expect(result.federation).toBe(BLOCK);

    primary.close();
    kernel.close();
  });

  it('yields an empty group (not an error) for a sibling with no match', () => {
    const primary = makeDb('client');
    const kernel = makeDb('kernel');
    addDoc(primary, 'Client Settlement Notes', 'docs/settlement.md', 'settlement in the client');
    // kernel has no matching doc.

    const result = runFederatedSearch(
      primary,
      [{ name: 'sib_kernel', db: kernel }],
      'settlement',
      BLOCK,
      20
    );

    expect(result.groups).toHaveLength(2);
    expect(result.groups[1].repo).toBe('sib_kernel');
    expect(result.groups[1].results).toHaveLength(0);

    primary.close();
    kernel.close();
  });

  it('respects the per-repo limit', () => {
    const primary = makeDb('client');
    addDoc(primary, 'Settle One', '1.md', 'settlement one');
    addDoc(primary, 'Settle Two', '2.md', 'settlement two');
    addDoc(primary, 'Settle Three', '3.md', 'settlement three');

    const result = runFederatedSearch(primary, [], 'settlement', { siblings: [] }, 2);
    expect(result.groups[0].results).toHaveLength(2);

    primary.close();
  });

  it('RE-THROWS an invalid-query (fails identically for every group) instead of a fabricated empty (M1)', () => {
    const primary = makeDb('client');
    addDoc(primary, 'Client Settlement Notes', 'docs/settlement.md', 'settlement in the client');
    // `nosuchcol:term` is a FTS5 no-such-column QUERY error — it fails identically for main AND every
    // sibling, so swallowing it would fabricate an all-empty answer. The union must surface it.
    let refusal: unknown;
    try {
      runFederatedSearch(primary, [], 'nosuchcol:settlement', { siblings: [] }, 20);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(SearchRefusalError);
    expect((refusal as SearchRefusalError).reason).toBe('invalid-query');

    primary.close();
  });

  it('degrades a sibling with a missing FTS table (fts-unavailable) to an empty group, not a throw (M1)', () => {
    const primary = makeDb('client');
    const kernel = makeDb('kernel');
    addDoc(primary, 'Client Settlement Notes', 'docs/settlement.md', 'settlement in the client');
    addDoc(kernel, 'Kernel Settlement Engine', 'docs/engine.md', 'settlement engine internals');
    // Drop the kernel's FTS table out from under the open handle → its next MATCH raises
    // fts-unavailable at execution, which safeSearch degrades (repo-level fault), not re-throws.
    const kernelDbPath = join(root, 'kernel', '.lux', 'lux.db');
    const raw = new LuxSqlite(kernelDbPath);
    raw.exec('DROP TABLE IF EXISTS knowledge_entries_fts;');
    raw.close();

    const result = runFederatedSearch(
      primary,
      [{ name: 'sib_kernel', db: kernel }],
      'settlement',
      BLOCK,
      20
    );
    expect(result.groups[0].results.length).toBeGreaterThan(0); // main still answers
    expect(result.groups[1].repo).toBe('sib_kernel');
    expect(result.groups[1].results).toHaveLength(0); // sibling degraded, union intact

    primary.close();
    kernel.close();
  });
});
