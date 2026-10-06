import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { SourceDiagnosticV1, SourceLocationV1 } from '../../contracts/program.js';
import type { EventBusInputV1 } from './types.js';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
export const PUBLISH_METHODS = new Set(['emit', 'emitAppEvent']);
export const SUBSCRIBE_METHODS = new Set(['on', 'once']);

export function sourceLocation(filePath: string, source: string, offset: number): SourceLocationV1 {
  const lines = source.slice(0, Math.max(0, offset)).split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

export async function sourceFiles(input: EventBusInputV1): Promise<Map<string, string>> {
  const supplied = input.sources;
  const result = new Map<string, string>();
  for (const filePath of [...new Set(input.files)]
    .filter((file) => SOURCE_EXTENSION.test(file))
    .sort()) {
    const cached = supplied?.get(filePath);
    if (cached !== undefined) {
      result.set(filePath, cached);
      continue;
    }
    const absolute = isAbsolute(filePath) ? filePath : resolve(input.rootPath, filePath);
    const rel = relative(resolve(input.rootPath), absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    try {
      result.set(filePath, await readFile(absolute, 'utf8'));
    } catch {
      // lux-intentional-swallow: a listed file that no longer exists is a bounded-input omission, not a failure.
      // Missing files are bounded-input omissions. Other files and cached text remain usable.
    }
  }
  return result;
}

export function exportedNames(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(
    /\bexport\s+(?:declare\s+)?(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/gu
  )) {
    result.set(match[1], match[1]);
  }
  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/gu)) {
    for (const item of match[1].split(',')) {
      const named = /^\s*([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(item);
      if (named) result.set(named[1], named[2] ?? named[1]);
    }
  }
  const defaultName = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/u.exec(source)?.[1];
  if (defaultName) result.set(defaultName, 'default');
  return result;
}

export interface ImportSpecV1 {
  localName: string;
  importedName: string;
  sourceSpecifier: string;
}

export function imports(source: string): Map<string, ImportSpecV1> {
  const result = new Map<string, ImportSpecV1>();
  for (const match of source.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/gu
  )) {
    result.set(match[1], {
      localName: match[1],
      importedName: 'default',
      sourceSpecifier: match[3],
    });
  }
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2/gu)) {
    for (const item of match[1].split(',')) {
      const named = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(
        item
      );
      if (!named) continue;
      const localName = named[2] ?? named[1];
      result.set(localName, { localName, importedName: named[1], sourceSpecifier: match[3] });
    }
  }
  return result;
}

function matchingDelimiter(source: string, open: number, opening = '(', closing = ')'): number {
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === opening) depth++;
    else if (character === closing && --depth === 0) return index;
  }
  return -1;
}

export function firstArgument(source: string, open: number): string | undefined {
  const close = matchingDelimiter(source, open);
  if (close < 0) return undefined;
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let index = open + 1; index < close; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if ('([{'.includes(character)) depth++;
    else if (')]}'.includes(character)) depth--;
    else if (character === ',' && depth === 0) return source.slice(open + 1, index).trim();
  }
  return source.slice(open + 1, close).trim();
}

export function literal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^\s*(['"])([^'"]+)\1\s*$/u.exec(value);
  if (match) return match[2];
  const template = /^\s*`([^`$]+)`\s*$/u.exec(value);
  return template?.[1];
}

export function sortDiagnostics(values: SourceDiagnosticV1[]): SourceDiagnosticV1[] {
  return values.sort((left, right) =>
    [
      left.location?.filePath ?? '',
      left.location?.line ?? 0,
      left.location?.column ?? 0,
      left.code,
      left.message,
    ]
      .join('\0')
      .localeCompare(
        [
          right.location?.filePath ?? '',
          right.location?.line ?? 0,
          right.location?.column ?? 0,
          right.code,
          right.message,
        ].join('\0')
      )
  );
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}
