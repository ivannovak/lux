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
  inferStructuralContextId,
  getLaravelPhpEntries,
  resolvePhpClassReference,
  shortName,
} from './shared.js';
import { phpSymbolNodeId } from '../../types.js';

const STATIC_JOB_DISPATCH_RE = /\b([A-Za-z_\\][A-Za-z0-9_\\]*)::(dispatch|dispatchSync)\s*\(/g;
const FUNCTION_JOB_DISPATCH_RE =
  /(?<!::)\b(dispatch|dispatchSync)\s*\(\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/g;
const BUS_JOB_DISPATCH_RE =
  /\bBus::(dispatch|dispatchSync)\s*\(\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/g;

export class LaravelJobDispatchExtractor implements OperationalExtractor {
  readonly name = 'laravel-job-dispatch';

  supports(context: AssociationContext): boolean {
    return context.entries.some((entry) => entry.languageId === 'php');
  }

  extract(context: AssociationContext): Promise<OperationalExtractionBatch> {
    const batch = emptyOperationalBatch();
    const payloadHints = new Map<
      string,
      {
        methods: Set<string>;
        literalArgs: Set<string>;
        maxArity: number;
      }
    >();

    for (const entry of getLaravelPhpEntries(context)) {
      const sourceId = inferStructuralContextId(entry);

      STATIC_JOB_DISPATCH_RE.lastIndex = 0;
      let staticMatch: RegExpExecArray | null;
      while ((staticMatch = STATIC_JOB_DISPATCH_RE.exec(entry.content)) !== null) {
        const resolvedClass = resolvePhpClassReference(staticMatch[1], entry);
        if (
          shortName(resolvedClass) === 'Bus' ||
          resolvedClass === 'Illuminate\\Support\\Facades\\Bus'
        ) {
          continue;
        }

        addDispatch(
          batch,
          context.rootPath,
          sourceId,
          resolvedClass,
          staticMatch[2],
          extractDispatchArgumentsFromStaticDispatch(staticMatch[0]),
          payloadHints
        );
      }

      FUNCTION_JOB_DISPATCH_RE.lastIndex = 0;
      let dispatchMatch: RegExpExecArray | null;
      while ((dispatchMatch = FUNCTION_JOB_DISPATCH_RE.exec(entry.content)) !== null) {
        addDispatch(
          batch,
          context.rootPath,
          sourceId,
          resolvePhpClassReference(dispatchMatch[2], entry),
          dispatchMatch[1],
          extractDispatchArgumentsFromNewExpression(dispatchMatch[0], dispatchMatch[2]),
          payloadHints
        );
      }

      BUS_JOB_DISPATCH_RE.lastIndex = 0;
      let busMatch: RegExpExecArray | null;
      while ((busMatch = BUS_JOB_DISPATCH_RE.exec(entry.content)) !== null) {
        addDispatch(
          batch,
          context.rootPath,
          sourceId,
          resolvePhpClassReference(busMatch[2], entry),
          busMatch[1],
          extractDispatchArgumentsFromNewExpression(busMatch[0], busMatch[2]),
          payloadHints
        );
      }
    }

    for (const [jobClass, hint] of payloadHints.entries()) {
      const boundaryId = operationalBoundaryId('job', jobClass);
      batch.contracts.push({
        id: operationalContractId(boundaryId, 'payload-hints'),
        boundary_id: boundaryId,
        payload_schema: JSON.stringify({
          dispatchMethods: Array.from(hint.methods).sort(),
          maxArity: hint.maxArity,
          literalArguments: Array.from(hint.literalArgs).sort(),
        }),
        trust_tier: 4,
      });
    }

    return Promise.resolve(batch);
  }
}

function addDispatch(
  batch: OperationalExtractionBatch,
  repoRoot: string,
  sourceId: string,
  jobClass: string,
  dispatchMethod: string,
  dispatchArgs: string[],
  payloadHints: Map<
    string,
    {
      methods: Set<string>;
      literalArgs: Set<string>;
      maxArity: number;
    }
  >
): void {
  if (!jobClass) return;

  const jobBoundaryId = operationalBoundaryId('job', jobClass);
  const jobSymbolId = phpSymbolNodeId(jobClass);
  const transport = dispatchMethod === 'dispatchSync' ? 'sync' : 'async';

  batch.boundaries.push({
    id: jobBoundaryId,
    repo_root: repoRoot,
    kind: 'job',
    name: jobClass,
    trust_tier: 4,
  });
  batch.handlers.push({
    id: operationalHandlerId(jobBoundaryId, jobSymbolId),
    boundary_id: jobBoundaryId,
    symbol_id: jobSymbolId,
    trust_tier: 4,
  });
  batch.edges.push({
    id: operationalEdgeId(sourceId, jobBoundaryId, 'DISPATCHES', transport),
    source_id: sourceId,
    target_id: jobBoundaryId,
    edge_type: 'DISPATCHES',
    transport,
    trust_tier: 4,
  });
  // One edge per job, shared by every dispatch site, so it states no transport: the sites can
  // disagree (`dispatch` here, `dispatchSync` there), and each DISPATCHES edge above has its own.
  batch.edges.push({
    id: operationalEdgeId(jobBoundaryId, jobSymbolId, 'HANDLED_BY'),
    source_id: jobBoundaryId,
    target_id: jobSymbolId,
    edge_type: 'HANDLED_BY',
    trust_tier: 4,
  });

  const hint = payloadHints.get(jobClass) ?? {
    methods: new Set<string>(),
    literalArgs: new Set<string>(),
    maxArity: 0,
  };
  hint.methods.add(dispatchMethod);
  hint.maxArity = Math.max(hint.maxArity, dispatchArgs.length);
  for (const arg of dispatchArgs) {
    const literal = classifyLiteralArg(arg);
    if (literal) {
      hint.literalArgs.add(literal);
    }
  }
  payloadHints.set(jobClass, hint);
}

function extractDispatchArgumentsFromStaticDispatch(fragment: string): string[] {
  const match = /::dispatch(?:Sync)?\s*\(([\s\S]*?)\)/.exec(fragment);
  if (!match) return [];
  return splitArguments(match[1]);
}

function extractDispatchArgumentsFromNewExpression(
  fragment: string,
  rawClassRef: string
): string[] {
  const classPattern = rawClassRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`new\\\\s+${classPattern}\\\\s*\\\\(([^)]*)\\\\)`).exec(fragment);
  if (!match) return [];
  return splitArguments(match[1]);
}

function splitArguments(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function classifyLiteralArg(rawArg: string): string | null {
  const arg = rawArg.trim();
  if (!arg) return null;

  if (/^['"].*['"]$/.test(arg)) return 'string';
  if (/^(true|false)$/i.test(arg)) return 'boolean';
  if (/^\d+(\.\d+)?$/.test(arg)) return 'number';
  if (/^\[.*\]$/.test(arg)) return 'array';
  if (/^null$/i.test(arg)) return 'null';
  return null;
}
