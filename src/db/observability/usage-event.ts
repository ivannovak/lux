import { createHash, randomUUID } from 'node:crypto';
import type { LuxDatabase } from '../index.js';

export type UsageEventSource = 'cli' | 'mcp' | 'hook' | 'agent' | 'benchmark';

export type UsageEventSurface =
  | 'search'
  | 'anchors'
  | 'ask'
  | 'feature-path'
  | 'operational'
  | 'spec-evidence'
  | 'trace'
  | 'deps-graph'
  | 'deps-clusters'
  | 'deps-impact'
  | 'deps-coverage'
  | 'expert-panel'
  | 'expert'
  | 'index-status'
  | 'overlay-status'
  | 'overlay-check'
  | 'overlay-ownership'
  | 'overlay-boundaries'
  | 'index-sync'
  | 'index-rebuild'
  | 'index-refresh'
  | 'index-node-embed'
  | 'discovery'
  | 'delta'
  | 'siblings'
  | 'hook';

export type UsageCommandOutcome = 'success' | 'error';
export type UsageRetrievalOutcome =
  'answered' | 'refused' | 'ambiguous' | 'unresolved' | 'fallback' | 'not_applicable';
export type UsageTrustState =
  'fresh' | 'stale' | 'degraded' | 'content-only' | 'absent' | 'unknown';

export interface UsageQueryPayload {
  hash?: string;
  length?: number;
  normalizedIntent?: string;
  text?: string;
}

export interface UsageEventV1 {
  schemaVersion: 1;
  eventId: string;
  invocationId: string;
  parentEventId?: string;
  timestamp: string;
  source: UsageEventSource;
  surface: UsageEventSurface;
  action: string;
  commandOutcome?: UsageCommandOutcome;
  retrievalOutcome?: UsageRetrievalOutcome;
  trustState?: UsageTrustState;
  durationMs?: number;
  exitCode?: number;
  corpusPathHash?: string;
  dbPathHash?: string;
  repoCommit?: string;
  query?: UsageQueryPayload;
  retrieval?: {
    promoted?: boolean;
    resolvedTargetType?: string;
    evidenceCount?: number;
    directEvidenceCount?: number;
    contextualEvidenceCount?: number;
    refusalReason?: string;
    fallbackSurface?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  attributes?: Record<string, unknown>;
}

export interface EmitUsageEventInput {
  source: UsageEventSource;
  surface: UsageEventSurface;
  action: string;
  invocationId?: string;
  parentEventId?: string;
  commandOutcome?: UsageCommandOutcome;
  retrievalOutcome?: UsageRetrievalOutcome;
  trustState?: UsageTrustState;
  durationMs?: number;
  exitCode?: number;
  corpusPath?: string;
  dbPath?: string;
  repoCommit?: string;
  queryText?: string;
  normalizedIntent?: string;
  retrieval?: UsageEventV1['retrieval'];
  error?: UsageEventV1['error'];
  attributes?: Record<string, unknown>;
}

export function createInvocationId(): string {
  return randomUUID();
}

function hashUsageValue(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function buildUsageEvent(input: EmitUsageEventInput): UsageEventV1 {
  const event: UsageEventV1 = {
    schemaVersion: 1,
    eventId: randomUUID(),
    invocationId: input.invocationId ?? createInvocationId(),
    parentEventId: input.parentEventId,
    timestamp: new Date().toISOString(),
    source: input.source,
    surface: input.surface,
    action: input.action,
    commandOutcome: input.commandOutcome,
    retrievalOutcome: input.retrievalOutcome,
    trustState: input.trustState,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    corpusPathHash: input.corpusPath ? hashUsageValue(input.corpusPath) : undefined,
    dbPathHash: input.dbPath ? hashUsageValue(input.dbPath) : undefined,
    repoCommit: input.repoCommit,
    query: input.queryText
      ? {
          hash: hashUsageValue(input.queryText),
          length: input.queryText.length,
          normalizedIntent: input.normalizedIntent,
        }
      : input.normalizedIntent
        ? { normalizedIntent: input.normalizedIntent }
        : undefined,
    retrieval: input.retrieval,
    error: input.error,
    attributes: input.attributes,
  };

  return removeUndefined(event) as UsageEventV1;
}

export function emitUsageEvent(db: LuxDatabase, input: EmitUsageEventInput): UsageEventV1 | null {
  // buildUsageEvent stays inside the guard: emission is best-effort observability and must never
  // crash the command it instruments, even for a malformed input (e.g. non-serializable attributes).
  try {
    const event = buildUsageEvent(input);
    db.insertEvent({
      source: input.source,
      source_id: event.invocationId,
      event_type: 'lux_usage_event',
      summary: `${event.surface}.${event.action}${event.commandOutcome ? ` ${event.commandOutcome}` : ''}`,
      payload: event as unknown as Record<string, unknown>,
    });
    return event;
  } catch {
    // lux-intentional-swallow: usage telemetry must never fail or degrade the command it observes.
    return null;
  }
}

export function safeUsageTrustState(value: string | undefined): UsageTrustState {
  switch (value) {
    case 'overlay-complete':
      return 'fresh';
    case 'stale-overlay':
      return 'stale';
    case 'degraded-overlay':
      return 'degraded';
    case 'content-only':
      return 'content-only';
    case 'no-overlay':
      return 'absent';
    default:
      return 'unknown';
  }
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefined(entry)])
    );
  }
  return value;
}
