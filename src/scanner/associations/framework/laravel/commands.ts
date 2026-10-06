import { phpSymbolNodeId, type AssociationContext } from '../../types.js';
import {
  emptyOperationalBatch,
  operationalBoundaryId,
  operationalContractId,
  operationalEdgeId,
  operationalHandlerId,
  type OperationalExtractor,
  type OperationalExtractionBatch,
} from '../../operational/types.js';
import { getLaravelPhpEntries, type LaravelPhpClass } from './shared.js';
import { fileQualifiedId, idsDeclaredByManyFiles } from '../../../identity/file-qualified-id.js';

const COMMAND_SIGNATURE_RE = /\$(?:signature|name)\s*=\s*['"]([^'"]+)['"]/;

export class LaravelCommandExtractor implements OperationalExtractor {
  readonly name = 'laravel-commands';

  supports(context: AssociationContext): boolean {
    return context.entries.some((entry) => entry.languageId === 'php');
  }

  extract(context: AssociationContext): Promise<OperationalExtractionBatch> {
    const batch = emptyOperationalBatch();

    // Find every command class before any id is built: a name two files declare is stored once
    // per file, under a file-qualified id (operational/declaration-rules.ts).
    const declared: Array<{ filePath: string; phpClass: LaravelPhpClass; rawSignature: string }> =
      [];
    for (const entry of getLaravelPhpEntries(context)) {
      for (const phpClass of entry.classes) {
        if (!isLaravelCommandClass(phpClass.extendsQualifiedName, phpClass.extendsName)) continue;

        const rawSignature = COMMAND_SIGNATURE_RE.exec(phpClass.body)?.[1]?.trim();
        if (!rawSignature) continue;
        declared.push({ filePath: entry.filePath, phpClass, rawSignature });
      }
    }
    const sharedIds = idsDeclaredByManyFiles(
      declared.map(({ filePath, rawSignature }) => ({
        id: operationalBoundaryId('command', commandNameOf(rawSignature)),
        relPath: filePath,
      }))
    );

    for (const { filePath, phpClass, rawSignature } of declared) {
      const commandName = commandNameOf(rawSignature);
      const bareBoundaryId = operationalBoundaryId('command', commandName);
      const boundaryId = sharedIds.has(bareBoundaryId)
        ? fileQualifiedId(bareBoundaryId, filePath)
        : bareBoundaryId;
      const symbolId = phpSymbolNodeId(phpClass.qualifiedName);

      batch.boundaries.push({
        id: boundaryId,
        repo_root: context.rootPath,
        kind: 'command',
        name: commandName,
        trust_tier: 5,
        file_path: filePath,
      });
      batch.handlers.push({
        id: operationalHandlerId(boundaryId, symbolId),
        boundary_id: boundaryId,
        symbol_id: symbolId,
        trust_tier: 5,
      });
      batch.edges.push({
        id: operationalEdgeId(boundaryId, symbolId, 'HANDLED_BY'),
        source_id: boundaryId,
        target_id: symbolId,
        edge_type: 'HANDLED_BY',
        transport: 'sync',
        trust_tier: 5,
      });
      batch.contracts.push({
        id: operationalContractId(boundaryId, 'signature'),
        boundary_id: boundaryId,
        payload_schema: JSON.stringify({
          signature: rawSignature,
          command: commandName,
          source: rawSignature === commandName ? 'name' : 'signature',
          tokens: parseCommandSignatureTokens(rawSignature),
        }),
        trust_tier: 5,
      });
    }

    return Promise.resolve(batch);
  }
}

function commandNameOf(rawSignature: string): string {
  return rawSignature.split(/\s+/)[0];
}

function isLaravelCommandClass(
  extendsQualifiedName: string | undefined,
  extendsName: string | undefined
): boolean {
  if (extendsQualifiedName === 'Illuminate\\Console\\Command') return true;
  return extendsName === 'Command';
}

function parseCommandSignatureTokens(rawSignature: string): Array<Record<string, unknown>> {
  const braces = Array.from(rawSignature.matchAll(/\{([^}]+)\}/g));
  if (braces.length === 0) return [];

  const tokens: Array<Record<string, unknown>> = [];

  for (const brace of braces) {
    const body = brace[1].trim();
    const [specRaw, descriptionRaw] = body.split(/\s*:\s*/, 2);
    const spec = specRaw.trim();
    const description = descriptionRaw?.trim();

    if (spec.startsWith('--')) {
      const optionMatch =
        /^--(?:(?<shortcut>[A-Za-z])\|)?(?<name>[A-Za-z0-9_-]+)(?<value>[=?*]*)$/.exec(spec);
      if (!optionMatch?.groups?.name) continue;

      const valueFlags = optionMatch.groups.value ?? '';
      tokens.push({
        kind: 'option',
        name: optionMatch.groups.name,
        shortcut: optionMatch.groups.shortcut,
        takesValue: valueFlags.includes('='),
        optionalValue: valueFlags.includes('?'),
        variadic: valueFlags.includes('*'),
        description,
      });
      continue;
    }

    const argumentMatch = /^(?<name>[A-Za-z0-9_-]+)(?<flags>[?*]*)$/.exec(spec);
    if (!argumentMatch?.groups?.name) continue;

    const flags = argumentMatch.groups.flags ?? '';
    tokens.push({
      kind: 'argument',
      name: argumentMatch.groups.name,
      required: !flags.includes('?'),
      variadic: flags.includes('*'),
      description,
    });
  }

  return tokens;
}
