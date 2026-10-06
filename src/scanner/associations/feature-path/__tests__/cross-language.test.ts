// Tests for tranche-one cross-language promotion threshold (T9, R10).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../../db/index.js';
import type { ConfidenceClass, EdgeEvidence } from '../../../../db/types.js';
import type { FeaturePathTarget } from '../contract.js';
import {
  CROSS_LANGUAGE_PROMOTION_TRUST_TIER,
  buildCrossLanguageDirectEvidence,
  evaluateCrossLanguagePromotion,
  promotedFrontendNodeIds,
} from '../cross-language.js';
import type { FeaturePathCrossLanguage } from '../contract.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-cross-language-test-'));

const SURFACE_ID = 'surface:http:POST:/offers';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function upsertSurface(db: LuxDatabase): void {
  db.upsertStructuralNode({
    id: SURFACE_ID,
    node_type: 'capability-surface',
    symbol_name: 'POST /offers',
    language_id: 'http',
    file_path: 'routes/api.php',
    metadata: JSON.stringify({ transport: 'http', method: 'POST', path: '/offers' }),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertConsumer(
  db: LuxDatabase,
  id: string,
  symbolName: string,
  languageId: string,
  filePath: string
): void {
  db.upsertStructuralNode({
    id,
    node_type: 'symbol',
    symbol_name: symbolName,
    language_id: languageId,
    file_path: filePath,
    metadata: '{}',
    updated_at: Math.floor(Date.now() / 1000),
  });
}

function upsertCallsSurface(
  db: LuxDatabase,
  edgeId: string,
  consumerId: string,
  confidenceClass: ConfidenceClass,
  resolver?: string
): void {
  const confidence =
    confidenceClass === 'proven'
      ? 0.99
      : confidenceClass === 'artifact-backed'
        ? 0.9
        : confidenceClass === 'framework-inferred'
          ? 0.7
          : 0.4;
  db.upsertStructuralEdge({
    id: edgeId,
    source_node_id: consumerId,
    target_node_id: SURFACE_ID,
    edge_type: 'calls_surface',
    confidence,
    confidence_class: confidenceClass,
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    provenance_summary: 'test',
    updated_at: Math.floor(Date.now() / 1000),
  });
  if (resolver) {
    const ev: EdgeEvidence = {
      id: `ev:${edgeId}`,
      edge_id: edgeId,
      resolver,
      evidence_kind: 'test',
      recorded_at: Math.floor(Date.now() / 1000),
    };
    db.replaceEdgeEvidence(edgeId, [ev]);
  }
}

function routeSurfaceTarget(): FeaturePathTarget {
  return {
    kind: 'route-surface',
    id: SURFACE_ID,
    label: 'POST /offers',
    surfaceMethod: 'POST',
    surfacePath: '/offers',
    filePath: 'routes/api.php',
  };
}

describe('evaluateCrossLanguagePromotion', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
    upsertSurface(db);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when target is null', () => {
    expect(
      evaluateCrossLanguagePromotion(db, { target: null, handlerLanguageId: 'php' })
    ).toBeNull();
  });

  it('returns null when target is not a route-surface', () => {
    expect(
      evaluateCrossLanguagePromotion(db, {
        target: { kind: 'handler-symbol', id: 'symbol:php:Foo@bar' },
        handlerLanguageId: 'php',
      })
    ).toBeNull();
  });

  it('returns null when handlerLanguageId is missing', () => {
    expect(
      evaluateCrossLanguagePromotion(db, {
        target: routeSurfaceTarget(),
        handlerLanguageId: null,
      })
    ).toBeNull();
  });

  it('returns null when no calls_surface edges exist', () => {
    expect(
      evaluateCrossLanguagePromotion(db, {
        target: routeSurfaceTarget(),
        handlerLanguageId: 'php',
      })
    ).toBeNull();
  });

  it('ignores same-language consumers (not cross-language)', () => {
    upsertConsumer(
      db,
      'symbol:php:OfferService.dispatch',
      'OfferService.dispatch',
      'php',
      'app/Services/OfferService.php'
    );
    upsertCallsSurface(
      db,
      'edge:same-lang',
      'symbol:php:OfferService.dispatch',
      'framework-inferred'
    );
    expect(
      evaluateCrossLanguagePromotion(db, {
        target: routeSurfaceTarget(),
        handlerLanguageId: 'php',
      })
    ).toBeNull();
  });

  it('refuses naming-only when only heuristic edges exist', () => {
    upsertConsumer(
      db,
      'symbol:ts:OffersClient.create',
      'OffersClient.create',
      'typescript',
      'frontend/services/offers-client.ts'
    );
    upsertCallsSurface(db, 'edge:naming', 'symbol:ts:OffersClient.create', 'heuristic');

    const result = evaluateCrossLanguagePromotion(db, {
      target: routeSurfaceTarget(),
      handlerLanguageId: 'php',
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('refused-naming-only');
    expect(result!.trustTier).toBeUndefined();
    expect(result!.associations).toHaveLength(1);
    expect(result!.associations[0].basis).toBe('naming-only');
    expect(result!.associations[0].trustTier).toBe(2);
    expect(result!.rationale).toContain('naming-only');
  });

  it('refuses naming-only when only framework-inferred edges exist (still naming-only basis without resolver hint)', () => {
    upsertConsumer(
      db,
      'symbol:ts:OffersClient.create',
      'OffersClient.create',
      'typescript',
      'frontend/services/offers-client.ts'
    );
    upsertCallsSurface(db, 'edge:framework', 'symbol:ts:OffersClient.create', 'framework-inferred');

    const result = evaluateCrossLanguagePromotion(db, {
      target: routeSurfaceTarget(),
      handlerLanguageId: 'php',
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('refused-naming-only');
  });

  it('promotes when an artifact-backed cross-language association exists at tier ≥ 4', () => {
    upsertConsumer(
      db,
      'symbol:ts:OffersClient.create',
      'OffersClient.create',
      'typescript',
      'frontend/services/offers-client.ts'
    );
    upsertCallsSurface(db, 'edge:strong', 'symbol:ts:OffersClient.create', 'artifact-backed');

    const result = evaluateCrossLanguagePromotion(db, {
      target: routeSurfaceTarget(),
      handlerLanguageId: 'php',
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('promoted');
    expect(result!.trustTier).toBe(4);
    expect(result!.associations[0].basis).toBe('generated-types');
    expect(result!.associations[0].trustTier).toBe(4);
    expect(result!.rationale).toContain('artifact-backed');
  });

  it('classifies as generated-types when the resolver name matches even if confidence_class is heuristic', () => {
    upsertConsumer(db, 'symbol:ts:client', 'client', 'typescript', 'frontend/client.ts');
    upsertCallsSurface(db, 'edge:gen', 'symbol:ts:client', 'heuristic', 'generated-types');

    const result = evaluateCrossLanguagePromotion(db, {
      target: routeSurfaceTarget(),
      handlerLanguageId: 'php',
    });

    expect(result).not.toBeNull();
    expect(result!.associations[0].basis).toBe('generated-types');
    // resolver-named bridge but trust tier from confidence_class is still 2 → refused-low-trust
    expect(result!.status).toBe('refused-low-trust');
    expect(result!.rationale).toContain(`tier (${CROSS_LANGUAGE_PROMOTION_TRUST_TIER})`);
  });

  it('selects the highest-tier promotable association as the aggregate trust tier', () => {
    upsertConsumer(db, 'symbol:ts:strong', 'strong', 'typescript', 'frontend/strong.ts');
    upsertConsumer(db, 'symbol:ts:weak', 'weak', 'typescript', 'frontend/weak.ts');
    upsertCallsSurface(db, 'edge:strong', 'symbol:ts:strong', 'proven');
    upsertCallsSurface(db, 'edge:weak', 'symbol:ts:weak', 'heuristic');

    const result = evaluateCrossLanguagePromotion(db, {
      target: routeSurfaceTarget(),
      handlerLanguageId: 'php',
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('promoted');
    expect(result!.trustTier).toBe(5);
    expect(result!.associations).toHaveLength(2);
    // strongest first
    expect(result!.associations[0].frontendNodeId).toBe('symbol:ts:strong');
  });

  it('keeps refused associations in associations[] for auditability but does not promote them', () => {
    upsertConsumer(
      db,
      'symbol:ts:OffersClient.create',
      'OffersClient.create',
      'typescript',
      'frontend/services/offers-client.ts'
    );
    upsertCallsSurface(db, 'edge:naming', 'symbol:ts:OffersClient.create', 'heuristic');

    const result = evaluateCrossLanguagePromotion(db, {
      target: routeSurfaceTarget(),
      handlerLanguageId: 'php',
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('refused-naming-only');
    expect(result!.associations).toHaveLength(1);
    expect(result!.trustTier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T10: refusal vs promotion → direct-evidence + dedupe
// ---------------------------------------------------------------------------

function refused(): FeaturePathCrossLanguage {
  return {
    status: 'refused-naming-only',
    associations: [
      {
        backendNodeId: SURFACE_ID,
        frontendNodeId: 'symbol:ts:OffersClient.create',
        basis: 'naming-only',
        trustTier: 2,
      },
    ],
    rationale: 'naming only',
  };
}

function promoted(tier: 4 | 5 = 4): FeaturePathCrossLanguage {
  return {
    status: 'promoted',
    trustTier: tier,
    associations: [
      {
        backendNodeId: SURFACE_ID,
        frontendNodeId: 'symbol:ts:OffersClient.create',
        basis: 'generated-types',
        trustTier: tier,
        filePath: 'frontend/services/offers-client.ts',
      },
    ],
  };
}

describe('buildCrossLanguageDirectEvidence', () => {
  it('returns empty for null input', () => {
    expect(buildCrossLanguageDirectEvidence(null)).toEqual([]);
  });

  it('returns empty for refused-naming-only — refused associations must NOT surface as direct evidence', () => {
    expect(buildCrossLanguageDirectEvidence(refused())).toEqual([]);
  });

  it('returns empty for refused-low-trust — refused associations must NOT surface as direct evidence', () => {
    const block: FeaturePathCrossLanguage = {
      status: 'refused-low-trust',
      associations: [
        {
          backendNodeId: SURFACE_ID,
          frontendNodeId: 'symbol:ts:client',
          basis: 'generated-types',
          trustTier: 3,
        },
      ],
    };
    expect(buildCrossLanguageDirectEvidence(block)).toEqual([]);
  });

  it('emits a high-trust-cross-language-association item for promoted', () => {
    const items = buildCrossLanguageDirectEvidence(promoted(4));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('high-trust-cross-language-association');
    expect(items[0].nodeId).toBe('symbol:ts:OffersClient.create');
    expect(items[0].trustTier).toBe(4);
    expect(items[0].confidenceClass).toBe('artifact-backed');
    expect(items[0].filePath).toBe('frontend/services/offers-client.ts');
  });

  it('marks tier-5 promoted associations as proven', () => {
    const items = buildCrossLanguageDirectEvidence(promoted(5));
    expect(items[0].confidenceClass).toBe('proven');
  });
});

describe('promotedFrontendNodeIds', () => {
  it('returns empty for refused / null inputs', () => {
    expect(promotedFrontendNodeIds(null).size).toBe(0);
    expect(promotedFrontendNodeIds(refused()).size).toBe(0);
  });

  it('returns the promoted frontend node ids only', () => {
    const ids = promotedFrontendNodeIds(promoted());
    expect(Array.from(ids)).toEqual(['symbol:ts:OffersClient.create']);
  });
});
