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
import { extractAssignedArray, getLaravelPhpEntries, resolvePhpClassReference } from './shared.js';
import { phpSymbolNodeId } from '../../types.js';
import { compareCodeUnits } from '../../../scan-order.js';

/** Listener classes registered for each event class, per registering file, in declaration order. */
type EventRegistrations = Map<string, Map<string, string[]>>;

const EVENT_CLASS_LITERAL_RE = /([A-Za-z_\\][A-Za-z0-9_\\]*)::class/g;
const EVENT_LISTEN_CALL_RE =
  /Event::listen\s*\(\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*,\s*(\[[\s\S]*?\]|[A-Za-z_\\][A-Za-z0-9_\\]*::class)\s*\)/g;

export class LaravelEventListenerExtractor implements OperationalExtractor {
  readonly name = 'laravel-event-listeners';

  supports(context: AssociationContext): boolean {
    return context.entries.some(
      (entry) =>
        entry.languageId === 'php' &&
        (entry.filePath.endsWith('EventServiceProvider.php') ||
          ((entry.metadata?.content as string | undefined) ?? '').includes('Event::listen('))
    );
  }

  extract(context: AssociationContext): Promise<OperationalExtractionBatch> {
    const batch = emptyOperationalBatch();
    const entries = getLaravelPhpEntries(context);
    // Collect every file's registrations before any row is built: an event that several
    // providers register is one boundary holding all of them (operational/declaration-rules.ts).
    const registrations: EventRegistrations = new Map();

    for (const entry of entries) {
      const listenArray = extractAssignedArray(entry.content, 'listen');
      if (listenArray) {
        extractListenArray(registrations, entry, listenArray);
      }

      EVENT_LISTEN_CALL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EVENT_LISTEN_CALL_RE.exec(entry.content)) !== null) {
        const eventClass = resolvePhpClassReference(match[1], entry);
        const listenerClasses = extractListenerRefs(match[2], entry);
        register(registrations, entry.filePath, eventClass, listenerClasses);
      }
    }

    for (const eventClass of [...registrations.keys()].sort(compareCodeUnits)) {
      addEvent(batch, context.rootPath, eventClass, registrations.get(eventClass)!, entries);
    }

    return Promise.resolve(batch);
  }
}

function register(
  registrations: EventRegistrations,
  filePath: string,
  eventClass: string,
  listenerClasses: string[]
): void {
  const byFile = registrations.get(eventClass) ?? new Map<string, string[]>();
  registrations.set(eventClass, byFile);
  byFile.set(filePath, [...(byFile.get(filePath) ?? []), ...listenerClasses]);
}

function extractListenArray(
  registrations: EventRegistrations,
  entry: ReturnType<typeof getLaravelPhpEntries>[number],
  listenArray: string
): void {
  const eventEntryRe = /([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*=>\s*\[([\s\S]*?)\](?:,|$)/g;
  let match: RegExpExecArray | null;

  while ((match = eventEntryRe.exec(listenArray)) !== null) {
    const eventClass = resolvePhpClassReference(match[1], entry);
    const listenerClasses = extractListenerRefs(match[2], entry);
    register(registrations, entry.filePath, eventClass, listenerClasses);
  }
}

function extractListenerRefs(
  rawListeners: string,
  entry: ReturnType<typeof getLaravelPhpEntries>[number]
): string[] {
  const listeners: string[] = [];
  EVENT_CLASS_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = EVENT_CLASS_LITERAL_RE.exec(rawListeners)) !== null) {
    listeners.push(resolvePhpClassReference(match[1], entry));
  }

  return listeners;
}

/**
 * One event's rows from every file that registers listeners for it. Files are taken in path order
 * and listeners in declaration order within a file, each listener once.
 */
function addEvent(
  batch: OperationalExtractionBatch,
  repoRoot: string,
  eventClass: string,
  byFile: Map<string, string[]>,
  entries: ReturnType<typeof getLaravelPhpEntries>
): void {
  const trustTier = 5;
  const registeredIn = [...byFile.keys()].sort(compareCodeUnits);
  const listenerClasses = [...new Set(registeredIn.flatMap((file) => byFile.get(file)!))];
  const eventBoundaryId = operationalBoundaryId('event', eventClass);
  const payloadHints = inferEventPayloadHints(eventClass, entries);

  batch.boundaries.push({
    id: eventBoundaryId,
    repo_root: repoRoot,
    kind: 'event',
    name: eventClass,
    trust_tier: trustTier,
    file_path: registeredIn[0],
  });
  batch.contracts.push({
    id: operationalContractId(eventBoundaryId, 'event'),
    boundary_id: eventBoundaryId,
    payload_schema: JSON.stringify({
      eventClass,
      eventShortName: eventClass.split('\\').pop(),
      listenerCount: listenerClasses.length,
      listenerClasses,
      registeredIn,
      payloadHints,
    }),
    trust_tier: trustTier,
  });

  for (const listenerClass of listenerClasses) {
    const listenerSymbolId = phpSymbolNodeId(listenerClass);
    batch.handlers.push({
      id: operationalHandlerId(eventBoundaryId, listenerSymbolId),
      boundary_id: eventBoundaryId,
      symbol_id: listenerSymbolId,
      trust_tier: trustTier,
    });
    batch.edges.push({
      id: operationalEdgeId(eventBoundaryId, listenerSymbolId, 'HANDLED_BY'),
      source_id: eventBoundaryId,
      target_id: listenerSymbolId,
      edge_type: 'HANDLED_BY',
      transport: 'event-bus',
      trust_tier: trustTier,
    });
  }
}

function inferEventPayloadHints(
  eventClass: string,
  entries: ReturnType<typeof getLaravelPhpEntries>
): {
  sourceFile?: string;
  constructorParameters?: Array<{ name: string; type?: string; optional: boolean }>;
  publicProperties?: Array<{ name: string; type?: string }>;
} {
  // A class two files declare: read the first file by path, not the first one processed.
  const eventEntry = entries
    .filter((entry) => entry.classes.some((phpClass) => phpClass.qualifiedName === eventClass))
    .sort((a, b) => compareCodeUnits(a.filePath, b.filePath))[0];
  if (!eventEntry) return {};

  const eventClassDef = eventEntry.classes.find(
    (phpClass) => phpClass.qualifiedName === eventClass
  );
  if (!eventClassDef) return {};

  const constructorParameters = extractConstructorParameters(eventClassDef.body);
  const publicProperties = extractPublicProperties(eventClassDef.body);

  return {
    sourceFile: eventEntry.filePath,
    constructorParameters: constructorParameters.length > 0 ? constructorParameters : undefined,
    publicProperties: publicProperties.length > 0 ? publicProperties : undefined,
  };
}

function extractConstructorParameters(
  classBody: string
): Array<{ name: string; type?: string; optional: boolean }> {
  const constructorMatch = /function\s+__construct\s*\(([\s\S]*?)\)\s*\{/.exec(classBody);
  if (!constructorMatch) return [];

  const parameters: Array<{ name: string; type?: string; optional: boolean }> = [];

  for (const chunk of constructorMatch[1].split(',')) {
    const raw = chunk.trim();
    if (!raw) continue;

    const normalized = raw.replace(/^(public|protected|private|readonly)\s+/g, '').trim();
    const nameMatch = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(normalized);
    if (!nameMatch) continue;

    const beforeName = normalized.slice(0, normalized.indexOf(nameMatch[0])).trim();
    parameters.push({
      name: nameMatch[1],
      type: beforeName || undefined,
      optional: normalized.includes('='),
    });
  }

  return parameters;
}

function extractPublicProperties(classBody: string): Array<{ name: string; type?: string }> {
  const propertyMatches = classBody.matchAll(
    /public\s+(?:readonly\s+)?(?:(?<type>[A-Za-z_\\][A-Za-z0-9_\\|?]*)\s+)?\$(?<name>[A-Za-z_][A-Za-z0-9_]*)/g
  );

  const properties: Array<{ name: string; type?: string }> = [];
  for (const match of propertyMatches) {
    const name = match.groups?.name;
    if (!name) continue;
    properties.push({
      name,
      type: match.groups?.type,
    });
  }

  return properties;
}
