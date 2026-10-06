import type { LuxDatabase } from '../../../db/index.js';
import type { AssociationContext } from '../types.js';
import type { OperationalExtractionBatch, OperationalExtractor } from './types.js';
import {
  type OperationalBoundaryDescriptor,
  type OperationalContractDescriptor,
  type OperationalEdgeDescriptor,
  type OperationalHandlerDescriptor,
} from './types.js';
import { LaravelCommandExtractor } from '../framework/laravel/commands.js';
import { LaravelSchedulerExtractor } from '../framework/laravel/scheduler.js';
import { LaravelJobDispatchExtractor } from '../framework/laravel/jobs.js';
import { LaravelEventListenerExtractor } from '../framework/laravel/events.js';
export {
  formatFileOperationalBoundaryBlock,
  formatOperationalNeighborhoodSummary,
  getOperationalBoundaryHandlers,
  getOperationalDispatchSourcesForJob,
  getOperationalDispatchedJobs,
  getOperationalEventListeners,
  getOperationalUpstreamTriggers,
  getTrustAwareOperationalNeighborhood,
} from './retrieval.js';
export type {
  BoundaryHandlerLink,
  OperationalBoundaryHandlersResult,
  OperationalDispatchSource,
  OperationalDispatchSourcesResult,
  OperationalDispatchedJob,
  OperationalDispatchedJobsResult,
  OperationalEventListener,
  OperationalEventListenersResult,
  OperationalNeighborhoodEdge,
  OperationalNeighborhoodNode,
  OperationalNeighborhoodResult,
  OperationalUpstreamTrigger,
  OperationalUpstreamTriggersResult,
} from './retrieval.js';

export type {
  OperationalBoundaryDescriptor,
  OperationalContractDescriptor,
  OperationalEdgeDescriptor,
  OperationalExtractionBatch,
  OperationalExtractor,
  OperationalHandlerDescriptor,
} from './types.js';
import { silentReporter, type Reporter } from '../../reporter.js';

export interface OperationalExtractionResult {
  extractorsRun: number;
  boundariesStored: number;
  handlersStored: number;
  edgesStored: number;
  contractsStored: number;
}

export function createDefaultOperationalExtractors(): OperationalExtractor[] {
  return [
    new LaravelCommandExtractor(),
    new LaravelSchedulerExtractor(),
    new LaravelJobDispatchExtractor(),
    new LaravelEventListenerExtractor(),
  ];
}

export async function runOperationalExtractors(
  db: LuxDatabase,
  context: AssociationContext,
  extractors?: OperationalExtractor[],
  reporter: Reporter = silentReporter
): Promise<OperationalExtractionResult> {
  const pack = extractors ?? createDefaultOperationalExtractors();
  const boundaries = new Map<string, OperationalBoundaryDescriptor>();
  const handlers = new Map<string, OperationalHandlerDescriptor>();
  const edges = new Map<string, OperationalEdgeDescriptor>();
  const contracts = new Map<string, OperationalContractDescriptor>();
  let extractorsRun = 0;

  for (const extractor of pack) {
    if (!extractor.supports(context)) continue;
    reporter.ran(`extractor:${extractor.name}`);
    extractorsRun++;

    let batch: OperationalExtractionBatch;
    try {
      batch = await extractor.extract(context);
    } catch (error) {
      reporter.warn(
        `operational extractor "${extractor.name}" threw — ${
          error instanceof Error ? error.message : String(error)
        }`,
        `extractor:${extractor.name}`
      );
      continue;
    }

    for (const boundary of batch.boundaries) boundaries.set(boundary.id, boundary);
    for (const handler of batch.handlers) handlers.set(handler.id, handler);
    for (const edge of batch.edges) edges.set(edge.id, edge);
    for (const contract of batch.contracts) contracts.set(contract.id, contract);

    if (
      batch.boundaries.length > 0 ||
      batch.handlers.length > 0 ||
      batch.edges.length > 0 ||
      batch.contracts.length > 0
    ) {
      reporter.progress(
        `Operational extractor "${extractor.name}": ${batch.boundaries.length} boundary(s), ` +
          `${batch.handlers.length} handler(s), ${batch.edges.length} edge(s), ` +
          `${batch.contracts.length} contract(s).`
      );
    }
  }

  // One transaction for every operational row (a commit per row is a journal round-trip each).
  db.transaction(() => {
    for (const boundary of boundaries.values()) {
      db.upsertOperationalBoundary(boundary);
    }
    for (const handler of handlers.values()) {
      db.upsertOperationalHandler(handler);
    }
    for (const edge of edges.values()) {
      db.upsertOperationalEdge(edge);
    }
    for (const contract of contracts.values()) {
      db.upsertOperationalContract(contract);
    }
  });

  return {
    extractorsRun,
    boundariesStored: boundaries.size,
    handlersStored: handlers.size,
    edgesStored: edges.size,
    contractsStored: contracts.size,
  };
}
