// Tests for tranche-one bounded downstream step.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../../db/index.js';
import type { StructuralNode } from '../../../../db/types.js';
import { findBoundedDownstreamStep } from '../downstream.js';

const testDir = mkdtempSync(join(tmpdir(), 'lux-downstream-test-'));

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

const HANDLER_ID = 'symbol:php:App\\Modules\\Listings\\Http\\Controllers\\OfferController@store';
const HANDLER_FILE = 'app/Modules/Listings/Http/Controllers/OfferController.php';

function makeHandler(): StructuralNode {
  return {
    id: HANDLER_ID,
    node_type: 'symbol',
    symbol_name: 'OfferController@store',
    language_id: 'php',
    file_path: HANDLER_FILE,
    metadata: '{}',
    updated_at: Math.floor(Date.now() / 1000),
  };
}

describe('findBoundedDownstreamStep', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when handler is null', () => {
    expect(findBoundedDownstreamStep(db, { handler: null })).toBeNull();
  });

  it('returns null when no edges exist for the handler', () => {
    expect(findBoundedDownstreamStep(db, { handler: makeHandler() })).toBeNull();
  });

  it('returns null when only inverse edge types exist (HANDLED_BY, CONSUMES)', () => {
    db.upsertOperationalEdge({
      id: 'ope:handled-by',
      source_id: HANDLER_ID,
      target_id: 'opb:event:Foo',
      edge_type: 'HANDLED_BY',
      transport: 'event-bus',
      trust_tier: 5,
    });
    db.upsertOperationalEdge({
      id: 'ope:consumes',
      source_id: HANDLER_ID,
      target_id: 'opb:event:Bar',
      edge_type: 'CONSUMES',
      transport: 'event-bus',
      trust_tier: 5,
    });
    expect(findBoundedDownstreamStep(db, { handler: makeHandler() })).toBeNull();
  });

  it('returns a single DISPATCHES edge as a downstream step with target boundary label', () => {
    db.upsertOperationalBoundary({
      id: 'opb:job:NotifyOfferCreated',
      repo_root: '/app',
      kind: 'job',
      name: 'NotifyOfferCreated',
      trust_tier: 4,
      file_path: 'app/Jobs/NotifyOfferCreated.php',
    });
    db.upsertOperationalEdge({
      id: 'ope:dispatch-notify',
      source_id: HANDLER_ID,
      target_id: 'opb:job:NotifyOfferCreated',
      edge_type: 'DISPATCHES',
      transport: 'queue',
      trust_tier: 4,
    });

    const step = findBoundedDownstreamStep(db, { handler: makeHandler() });
    expect(step).not.toBeNull();
    expect(step!.edgeType).toBe('DISPATCHES');
    expect(step!.transport).toBe('queue');
    expect(step!.trustTier).toBe(4);
    expect(step!.source.id).toBe(HANDLER_ID);
    expect(step!.source.label).toBe('OfferController@store');
    expect(step!.source.filePath).toBe(HANDLER_FILE);
    expect(step!.target.id).toBe('opb:job:NotifyOfferCreated');
    expect(step!.target.label).toBe('NotifyOfferCreated');
    expect(step!.target.filePath).toBe('app/Jobs/NotifyOfferCreated.php');
    expect(step!.description).toBe('OfferController@store dispatches NotifyOfferCreated via queue');
    expect(step!.rationale).toContain('only persisted');
  });

  it('picks the highest trust_tier when multiple downstream edges exist', () => {
    db.upsertOperationalBoundary({
      id: 'opb:job:Weak',
      repo_root: '/app',
      kind: 'job',
      name: 'Weak',
      trust_tier: 2,
    });
    db.upsertOperationalBoundary({
      id: 'opb:job:Strong',
      repo_root: '/app',
      kind: 'job',
      name: 'Strong',
      trust_tier: 5,
    });
    db.upsertOperationalEdge({
      id: 'ope:weak',
      source_id: HANDLER_ID,
      target_id: 'opb:job:Weak',
      edge_type: 'DISPATCHES',
      transport: 'async',
      trust_tier: 2,
    });
    db.upsertOperationalEdge({
      id: 'ope:strong',
      source_id: HANDLER_ID,
      target_id: 'opb:job:Strong',
      edge_type: 'DISPATCHES',
      transport: 'queue',
      trust_tier: 5,
    });

    const step = findBoundedDownstreamStep(db, { handler: makeHandler() });
    expect(step).not.toBeNull();
    expect(step!.target.id).toBe('opb:job:Strong');
    expect(step!.trustTier).toBe(5);
    expect(step!.rationale).toContain('Strongest of 2');
  });

  it('falls back to target_id when no boundary record exists', () => {
    db.upsertOperationalEdge({
      id: 'ope:no-boundary',
      source_id: HANDLER_ID,
      target_id: 'opb:job:Detached',
      edge_type: 'DISPATCHES',
      trust_tier: 3,
    });

    const step = findBoundedDownstreamStep(db, { handler: makeHandler() });
    expect(step).not.toBeNull();
    expect(step!.target.id).toBe('opb:job:Detached');
    expect(step!.target.label).toBeUndefined();
    expect(step!.target.filePath).toBeUndefined();
    expect(step!.description).toBe('OfferController@store dispatches opb:job:Detached');
  });

  it('handles TRIGGERS and PRODUCES edge types with appropriate verbs', () => {
    db.upsertOperationalBoundary({
      id: 'opb:event:OfferCreated',
      repo_root: '/app',
      kind: 'event',
      name: 'OfferCreated',
      trust_tier: 4,
    });
    db.upsertOperationalEdge({
      id: 'ope:produces',
      source_id: HANDLER_ID,
      target_id: 'opb:event:OfferCreated',
      edge_type: 'PRODUCES',
      transport: 'event-bus',
      trust_tier: 4,
    });

    const step = findBoundedDownstreamStep(db, { handler: makeHandler() });
    expect(step).not.toBeNull();
    expect(step!.edgeType).toBe('PRODUCES');
    expect(step!.description).toBe('OfferController@store produces OfferCreated via event-bus');
  });

  it('omits transport from description when the edge has none', () => {
    db.upsertOperationalEdge({
      id: 'ope:notransport',
      source_id: HANDLER_ID,
      target_id: 'opb:job:Plain',
      edge_type: 'DISPATCHES',
      trust_tier: 3,
    });

    const step = findBoundedDownstreamStep(db, { handler: makeHandler() });
    expect(step).not.toBeNull();
    expect(step!.transport).toBeUndefined();
    expect(step!.description).toBe('OfferController@store dispatches opb:job:Plain');
  });

  it('does not chase sibling-method dispatches via the controller class id', () => {
    // Sibling method @destroy on the same controller dispatches a job. The
    // bounded-downstream lookup must NOT surface that as the @store handler's
    // downstream step — that would break "bounded".
    db.upsertOperationalEdge({
      id: 'ope:sibling-dispatch',
      source_id: 'symbol:php:App\\Modules\\Listings\\Http\\Controllers\\OfferController@destroy',
      target_id: 'opb:job:DeleteOffer',
      edge_type: 'DISPATCHES',
      trust_tier: 5,
    });

    expect(findBoundedDownstreamStep(db, { handler: makeHandler() })).toBeNull();
  });

  it('breaks ties between equal-tier edges deterministically by edge id', () => {
    db.upsertOperationalEdge({
      id: 'ope:bbb',
      source_id: HANDLER_ID,
      target_id: 'opb:job:Bbb',
      edge_type: 'DISPATCHES',
      trust_tier: 4,
    });
    db.upsertOperationalEdge({
      id: 'ope:aaa',
      source_id: HANDLER_ID,
      target_id: 'opb:job:Aaa',
      edge_type: 'DISPATCHES',
      trust_tier: 4,
    });

    const step = findBoundedDownstreamStep(db, { handler: makeHandler() });
    expect(step).not.toBeNull();
    expect(step!.target.id).toBe('opb:job:Aaa');
  });
});
