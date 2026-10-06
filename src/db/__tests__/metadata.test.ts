import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { LuxDatabase } from '../index.js';
import {
  OVERLAY_TRUST_STATE_KEY,
  persistRebuildTrustState,
  loadOverlayTrustState,
  markOverlayTrustAfterSync,
} from '../../scanner/overlay-trust-state.js';
import { tmpdir } from 'node:os';

describe('Index Metadata Operations', () => {
  const testDir = mkdtempSync(join(tmpdir(), 'lux-metadata-test-'));
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(dbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return undefined for missing key', () => {
    const value = db.getIndexMetadata('nonexistent');
    expect(value).toBeUndefined();
  });

  it('should set and get metadata round-trip', () => {
    db.setIndexMetadata('last_indexed_commit', 'abc123def456');
    const value = db.getIndexMetadata('last_indexed_commit');
    expect(value).toBe('abc123def456');
  });

  it('should overwrite existing value', () => {
    db.setIndexMetadata('last_indexed_commit', 'first');
    db.setIndexMetadata('last_indexed_commit', 'second');
    const value = db.getIndexMetadata('last_indexed_commit');
    expect(value).toBe('second');
  });

  it('should handle multiple keys independently', () => {
    db.setIndexMetadata('key1', 'value1');
    db.setIndexMetadata('key2', 'value2');
    expect(db.getIndexMetadata('key1')).toBe('value1');
    expect(db.getIndexMetadata('key2')).toBe('value2');
  });

  it('should persist and load overlay trust state', () => {
    persistRebuildTrustState(
      db,
      {
        mode: 'overlay-complete',
        repoPath: '/tmp/repo',
        configSource: 'lux.yaml',
        configLspEnabled: true,
        surfaceCount: 12,
        detectorEdgeCount: 24,
        propagatedEdgeCount: 30,
        fileNodeCount: 4,
        symbolNodeCount: 8,
        controllerBackedCount: 10,
        closureBackedCount: 2,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'active',
        propagationStatus: 'ran',
        warnings: [],
      },
      { lastIndexedCommit: 'abc123' }
    );

    const loaded = loadOverlayTrustState(db);
    expect(loaded).not.toBeNull();
    expect(loaded?.mode).toBe('overlay-complete');
    expect(loaded?.surfaceCount).toBe(12);
    expect(loaded?.lastIndexedCommit).toBe('abc123');
    expect(db.getIndexMetadata(OVERLAY_TRUST_STATE_KEY)).toBeTruthy();
  });

  it('should degrade persisted overlay trust state after source-only sync', () => {
    persistRebuildTrustState(
      db,
      {
        mode: 'overlay-complete',
        repoPath: '/tmp/repo',
        configSource: 'lux.yaml',
        configLspEnabled: true,
        surfaceCount: 12,
        detectorEdgeCount: 24,
        propagatedEdgeCount: 30,
        fileNodeCount: 4,
        symbolNodeCount: 8,
        controllerBackedCount: 10,
        closureBackedCount: 2,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'active',
        propagationStatus: 'ran',
        warnings: [],
      },
      { lastIndexedCommit: 'abc123' }
    );

    const mutated = markOverlayTrustAfterSync(db, {
      lastIndexedCommit: 'def456',
      overlayRelevantPaths: ['src/app.ts'],
      addedCount: 1,
      modifiedCount: 0,
      deletedCount: 0,
      indexedCount: 1,
      deletedEntryCount: 0,
    });

    expect(mutated.mode).toBe('degraded-overlay');
    expect(mutated.lastIndexedCommit).toBe('def456');
    expect(
      mutated.warnings.some((w) => w.includes('synced without rebuilding the structural overlay'))
    ).toBe(true);
  });
});
