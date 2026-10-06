import type { AssociationContext } from '../../types.js';
import {
  emptyOperationalBatch,
  operationalBoundaryId,
  operationalContractId,
  operationalEdgeId,
  operationalHandlerId,
  type OperationalExtractor,
  type OperationalExtractionBatch,
} from '../../operational/types.js';
import {
  extractStatementSnippet,
  getLaravelPhpEntries,
  lineNumberAt,
  resolvePhpClassReference,
} from './shared.js';
import { phpSymbolNodeId } from '../../types.js';

const SCHEDULE_COMMAND_RE =
  /(?:\$schedule|Schedule)\s*(?:->|::)\s*command\s*\(\s*['"]([^'"]+)['"]/g;
const SCHEDULE_JOB_RE =
  /(?:\$schedule|Schedule)\s*(?:->|::)\s*job\s*\(\s*(?:new\s+)?([A-Za-z_\\][A-Za-z0-9_\\]*)/g;
const SCHEDULE_CHAIN_RE = /->([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

export class LaravelSchedulerExtractor implements OperationalExtractor {
  readonly name = 'laravel-scheduler';

  supports(context: AssociationContext): boolean {
    return context.entries.some(
      (entry) =>
        entry.languageId === 'php' &&
        (entry.filePath.endsWith('Console/Kernel.php') || entry.filePath === 'routes/console.php')
    );
  }

  extract(context: AssociationContext): Promise<OperationalExtractionBatch> {
    const batch = emptyOperationalBatch();

    for (const entry of getLaravelPhpEntries(context)) {
      if (
        !entry.filePath.endsWith('Console/Kernel.php') &&
        entry.filePath !== 'routes/console.php'
      ) {
        continue;
      }

      SCHEDULE_COMMAND_RE.lastIndex = 0;
      let commandMatch: RegExpExecArray | null;
      while ((commandMatch = SCHEDULE_COMMAND_RE.exec(entry.content)) !== null) {
        const commandName = commandMatch[1].trim();
        const line = lineNumberAt(entry.content, commandMatch.index);
        const scheduleName = `command:${commandName}@${entry.filePath}:${line}`;
        const scheduleBoundaryId = operationalBoundaryId('schedule', scheduleName);
        const commandBoundaryId = operationalBoundaryId('command', commandName);
        const snippet = extractStatementSnippet(entry.content, commandMatch.index);

        batch.boundaries.push({
          id: scheduleBoundaryId,
          repo_root: context.rootPath,
          kind: 'schedule',
          name: scheduleName,
          trust_tier: 5,
          file_path: entry.filePath,
        });
        batch.boundaries.push({
          id: commandBoundaryId,
          repo_root: context.rootPath,
          kind: 'command',
          name: commandName,
          trust_tier: 5,
        });
        batch.edges.push({
          id: operationalEdgeId(scheduleBoundaryId, commandBoundaryId, 'TRIGGERS'),
          source_id: scheduleBoundaryId,
          target_id: commandBoundaryId,
          edge_type: 'TRIGGERS',
          transport: 'sync',
          trust_tier: 5,
        });
        batch.contracts.push({
          id: operationalContractId(scheduleBoundaryId, 'cadence'),
          boundary_id: scheduleBoundaryId,
          payload_schema: JSON.stringify({
            targetKind: 'command',
            targetName: commandName,
            cadence: describeScheduleCadence(snippet),
          }),
          trust_tier: 5,
        });
      }

      SCHEDULE_JOB_RE.lastIndex = 0;
      let jobMatch: RegExpExecArray | null;
      while ((jobMatch = SCHEDULE_JOB_RE.exec(entry.content)) !== null) {
        const resolvedJobClass = resolvePhpClassReference(jobMatch[1], entry);
        const line = lineNumberAt(entry.content, jobMatch.index);
        const scheduleName = `job:${resolvedJobClass}@${entry.filePath}:${line}`;
        const scheduleBoundaryId = operationalBoundaryId('schedule', scheduleName);
        const jobBoundaryId = operationalBoundaryId('job', resolvedJobClass);
        const jobSymbolId = phpSymbolNodeId(resolvedJobClass);
        const snippet = extractStatementSnippet(entry.content, jobMatch.index);

        batch.boundaries.push({
          id: scheduleBoundaryId,
          repo_root: context.rootPath,
          kind: 'schedule',
          name: scheduleName,
          trust_tier: 5,
          file_path: entry.filePath,
        });
        batch.boundaries.push({
          id: jobBoundaryId,
          repo_root: context.rootPath,
          kind: 'job',
          name: resolvedJobClass,
          trust_tier: 5,
        });
        batch.handlers.push({
          id: operationalHandlerId(jobBoundaryId, jobSymbolId),
          boundary_id: jobBoundaryId,
          symbol_id: jobSymbolId,
          trust_tier: 5,
        });
        batch.edges.push({
          id: operationalEdgeId(scheduleBoundaryId, jobBoundaryId, 'TRIGGERS'),
          source_id: scheduleBoundaryId,
          target_id: jobBoundaryId,
          edge_type: 'TRIGGERS',
          transport: 'queue',
          trust_tier: 5,
        });
        batch.edges.push({
          // Shared with every dispatch site of the job, so it states no transport; the
          // TRIGGERS edge above carries the scheduler's.
          id: operationalEdgeId(jobBoundaryId, jobSymbolId, 'HANDLED_BY'),
          source_id: jobBoundaryId,
          target_id: jobSymbolId,
          edge_type: 'HANDLED_BY',
          trust_tier: 5,
        });
        batch.contracts.push({
          id: operationalContractId(scheduleBoundaryId, 'cadence'),
          boundary_id: scheduleBoundaryId,
          payload_schema: JSON.stringify({
            targetKind: 'job',
            targetName: resolvedJobClass,
            cadence: describeScheduleCadence(snippet),
          }),
          trust_tier: 5,
        });
      }
    }

    return Promise.resolve(batch);
  }
}

function describeScheduleCadence(snippet: string): {
  methods: string[];
  chain: Array<{ method: string; arguments: string[] }>;
  summary: string;
} {
  const methods: string[] = [];
  const chain: Array<{ method: string; arguments: string[] }> = [];
  SCHEDULE_CHAIN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SCHEDULE_CHAIN_RE.exec(snippet)) !== null) {
    const methodName = match[1];
    if (methodName === 'command' || methodName === 'job') continue;
    methods.push(methodName);
    const args = extractMethodArguments(snippet, match.index + match[0].length);
    chain.push({
      method: methodName,
      arguments: args,
    });
  }

  return {
    methods,
    chain,
    summary: chain.map((item) => `${item.method}(${item.arguments.join(', ')})`).join(' -> '),
  };
}

function extractMethodArguments(snippet: string, startIndex: number): string[] {
  const closeIndex = snippet.indexOf(')', startIndex);
  if (closeIndex < 0) return [];

  const raw = snippet.slice(startIndex, closeIndex).trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((arg) => arg.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}
