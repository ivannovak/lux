import type { Event } from '../types.js';
import type {
  UsageCommandOutcome,
  UsageEventSurface,
  UsageEventV1,
  UsageRetrievalOutcome,
  UsageTrustState,
} from './usage-event.js';

export interface UsageReportFilters {
  since?: Date;
  surface?: UsageEventSurface;
  commandOutcome?: UsageCommandOutcome;
  retrievalOutcome?: UsageRetrievalOutcome;
  trustState?: UsageTrustState;
}

export interface UsageReportBucket {
  events: number;
  invocations: number;
  commandOutcomes: Record<string, number>;
  retrievalOutcomes: Record<string, number>;
}

export interface UsageReportV1 {
  schemaVersion: 1;
  since?: string;
  until: string;
  totals: {
    invocations: number;
    events: number;
  };
  surfaces: Record<string, UsageReportBucket>;
  commandOutcomes: Record<string, number>;
  retrievalOutcomes: Record<string, number>;
  trustStates: Record<string, number>;
  fallbacks: Array<{ from: string; to: string; count: number }>;
  benchmarkCandidates: Array<{
    intentHash: string;
    surface: string;
    reason: 'repeated_unresolved' | 'repeated_refused';
    count: number;
  }>;
}

export function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const relative = value.match(/^(\d+)([dhw])$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const millis =
      unit === 'd'
        ? amount * 24 * 60 * 60 * 1000
        : unit === 'h'
          ? amount * 60 * 60 * 1000
          : amount * 7 * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - millis);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      'Error: --since must be an ISO timestamp or relative value like 7d, 24h, or 2w.'
    );
  }
  return parsed;
}

function parseUsageEvent(event: Event): UsageEventV1 | null {
  if (event.event_type !== 'lux_usage_event' || !event.payload) return null;
  try {
    const parsed = JSON.parse(event.payload) as UsageEventV1;
    return parsed.schemaVersion === 1 ? parsed : null;
  } catch {
    // lux-intentional-swallow: an event that is not a usage event is skipped by the report.
    return null;
  }
}

export function buildUsageReport(events: Event[], filters: UsageReportFilters = {}): UsageReportV1 {
  const sinceMs = filters.since?.getTime();
  const usageEvents = events
    .map(parseUsageEvent)
    .filter((event): event is UsageEventV1 => Boolean(event))
    .filter((event) => (sinceMs ? Date.parse(event.timestamp) >= sinceMs : true))
    .filter((event) => (filters.surface ? event.surface === filters.surface : true))
    .filter((event) =>
      filters.commandOutcome ? event.commandOutcome === filters.commandOutcome : true
    )
    .filter((event) =>
      filters.retrievalOutcome ? event.retrievalOutcome === filters.retrievalOutcome : true
    )
    .filter((event) => (filters.trustState ? event.trustState === filters.trustState : true));

  const invocationIds = new Set<string>();
  const surfaces: Record<string, UsageReportBucket> = {};
  const commandOutcomes: Record<string, number> = {};
  const retrievalOutcomes: Record<string, number> = {};
  const trustStates: Record<string, number> = {};
  const fallbackCounts = new Map<string, number>();
  const benchmarkClusters = new Map<
    string,
    { surface: string; outcome: UsageRetrievalOutcome; count: number }
  >();

  for (const event of usageEvents) {
    invocationIds.add(event.invocationId);
    const bucket = (surfaces[event.surface] ??= {
      events: 0,
      invocations: 0,
      commandOutcomes: {},
      retrievalOutcomes: {},
    });
    bucket.events += 1;

    if (event.commandOutcome) {
      increment(commandOutcomes, event.commandOutcome);
      increment(bucket.commandOutcomes, event.commandOutcome);
    }
    if (event.retrievalOutcome) {
      increment(retrievalOutcomes, event.retrievalOutcome);
      increment(bucket.retrievalOutcomes, event.retrievalOutcome);

      if (
        (event.retrievalOutcome === 'unresolved' || event.retrievalOutcome === 'refused') &&
        event.query?.hash
      ) {
        const key = `${event.surface}:${event.retrievalOutcome}:${event.query.hash}`;
        const current = benchmarkClusters.get(key) ?? {
          surface: event.surface,
          outcome: event.retrievalOutcome,
          count: 0,
        };
        current.count += 1;
        benchmarkClusters.set(key, current);
      }
    }
    if (event.trustState) increment(trustStates, event.trustState);
    if (event.retrievalOutcome === 'fallback' && event.retrieval?.fallbackSurface) {
      const key = `${event.surface}->${event.retrieval.fallbackSurface}`;
      fallbackCounts.set(key, (fallbackCounts.get(key) ?? 0) + 1);
    }
  }

  for (const surface of Object.keys(surfaces)) {
    const ids = new Set(
      usageEvents.filter((event) => event.surface === surface).map((event) => event.invocationId)
    );
    surfaces[surface].invocations = ids.size;
  }

  return {
    schemaVersion: 1,
    since: filters.since?.toISOString(),
    until: new Date().toISOString(),
    totals: {
      invocations: invocationIds.size,
      events: usageEvents.length,
    },
    surfaces,
    commandOutcomes,
    retrievalOutcomes,
    trustStates,
    fallbacks: Array.from(fallbackCounts.entries()).map(([key, count]) => {
      const [from, to] = key.split('->');
      return { from, to, count };
    }),
    benchmarkCandidates: Array.from(benchmarkClusters.entries())
      .filter(([, cluster]) => cluster.count >= 2)
      .map(([key, cluster]) => ({
        intentHash: key.split(':').slice(2).join(':'),
        surface: cluster.surface,
        reason: cluster.outcome === 'unresolved' ? 'repeated_unresolved' : 'repeated_refused',
        count: cluster.count,
      })),
  };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}
