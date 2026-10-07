import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse, printParseErrorCode, type ParseError, type ParseOptions } from 'jsonc-parser';

import type { SourceDiagnosticV1 } from '../contracts/program.js';
import { resolveFileUniverse, universeIncludes, type FileUniverse } from '../file-universe.js';

const JSONC_OPTIONS: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: false,
};
const CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json']);
const VITE_CONFIG = /^vite\.config\.(?:[cm]?[jt]s)$/u;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;

export interface ParsedJsoncConfigV1 {
  filePath: string;
  value?: Record<string, unknown>;
  diagnostics: SourceDiagnosticV1[];
}

export interface ProjectConfigDiscoveryResultV1 {
  tsconfigFiles: string[];
  viteFiles: string[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
  /** Reserved for the Phase 8 context builder; config parsing never manufactures source ASTs. */
  extractions: ReadonlyMap<string, never>;
}

export interface ConfinedRootsV1 {
  rootPath: string;
  allowedRoots: readonly string[];
  canonicalRootPath: string;
  canonicalAllowedRoots: readonly string[];
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}

function unsafePath(value: string): boolean {
  return value.length === 0 || hasControlCharacter(value) || URI_SCHEME.test(value);
}

function locationForOffset(filePath: string, source: string, offset: number) {
  const before = source.slice(0, offset);
  const lines = before.split(/\r\n|\n|\r/u);
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function diagnostic(
  code: string,
  message: string,
  filePath?: string,
  source?: string,
  offset = 0
): SourceDiagnosticV1 {
  return {
    code,
    message,
    ...(filePath
      ? {
          location: source
            ? locationForOffset(filePath, source, offset)
            : { filePath, line: 1, column: 0 },
        }
      : {}),
  };
}

/** Canonicalize the corpus and allow-list once, refusing roots outside the corpus. */
export async function canonicalizeConfigRoots(
  rootPath: string,
  allowedRoots: readonly string[]
): Promise<ConfinedRootsV1 | undefined> {
  if (unsafePath(rootPath) || allowedRoots.length === 0 || allowedRoots.some(unsafePath)) {
    return undefined;
  }
  try {
    const lexicalRoot = resolve(rootPath);
    const canonicalRoot = await realpath(lexicalRoot);
    const lexicalRoots: string[] = [];
    const canonicalRoots: string[] = [];
    for (const item of allowedRoots) {
      const lexicalCandidate = isAbsolute(item) ? resolve(item) : resolve(lexicalRoot, item);
      const canonicalCandidate = await realpath(lexicalCandidate);
      // Project configuration must remain corpus-owned even when another scanner capability has
      // an additional allowed root.
      if (isWithin(canonicalRoot, canonicalCandidate)) {
        lexicalRoots.push(lexicalCandidate);
        canonicalRoots.push(canonicalCandidate);
      }
    }
    if (!canonicalRoots.some((candidate) => isWithin(candidate, canonicalRoot))) return undefined;
    return {
      rootPath: lexicalRoot,
      allowedRoots: [...new Set(lexicalRoots)].sort(),
      canonicalRootPath: canonicalRoot,
      canonicalAllowedRoots: [...new Set(canonicalRoots)].sort(),
    };
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return undefined;
  }
}

function confined(roots: ConfinedRootsV1, candidate: string): boolean {
  const canonical = isWithin(roots.canonicalRootPath, candidate);
  return canonical
    ? roots.canonicalAllowedRoots.some((allowedRoot) => isWithin(allowedRoot, candidate))
    : isWithin(roots.rootPath, candidate) &&
        roots.allowedRoots.some((allowedRoot) => isWithin(allowedRoot, candidate));
}

function lexicalPath(roots: ConfinedRootsV1, canonicalPath: string): string {
  return resolve(roots.rootPath, relative(roots.canonicalRootPath, canonicalPath));
}

/**
 * Read a regular file without following its final component and revalidate the opened inode.
 * This helper is shared by all Phase 8 config readers so aliases cannot widen the trust boundary.
 */
export async function readConfinedConfigFile(
  filePath: string,
  roots: ConfinedRootsV1
): Promise<{ filePath: string; source: string } | undefined> {
  if (unsafePath(filePath)) return undefined;
  const unresolved = isAbsolute(filePath) ? resolve(filePath) : resolve(roots.rootPath, filePath);
  if (!confined(roots, unresolved)) return undefined;

  try {
    const unresolvedMetadata = await lstat(unresolved);
    if (unresolvedMetadata.isSymbolicLink() || !unresolvedMetadata.isFile()) return undefined;
    const canonical = await realpath(unresolved);
    if (!confined(roots, canonical)) return undefined;

    const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const revalidated = await realpath(canonical);
      const pathname = await stat(revalidated);
      if (
        !opened.isFile() ||
        !confined(roots, revalidated) ||
        opened.dev !== pathname.dev ||
        opened.ino !== pathname.ino
      ) {
        return undefined;
      }
      return {
        filePath: lexicalPath(roots, revalidated),
        source: new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()),
      };
    } finally {
      await handle.close();
    }
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return undefined;
  }
}

export function parseJsoncConfig(filePath: string, source: string): ParsedJsoncConfigV1 {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, JSONC_OPTIONS);
  const diagnostics = errors.map((error) =>
    diagnostic(
      'config-jsonc-parse',
      `JSONC parse error ${printParseErrorCode(error.error)} at offset ${error.offset}.`,
      filePath,
      source,
      error.offset
    )
  );
  if (
    diagnostics.length > 0 ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    if (diagnostics.length === 0) {
      diagnostics.push(
        diagnostic('config-jsonc-shape', 'Project config must contain a JSON object.', filePath)
      );
    }
    return { filePath, diagnostics };
  }
  return { filePath, value: parsed as Record<string, unknown>, diagnostics };
}

function literalExtends(value: Record<string, unknown>): string | undefined {
  return typeof value.extends === 'string' ? value.extends : undefined;
}

function extendsCandidate(configFile: string, specifier: string): string | undefined {
  if (
    specifier.length === 0 ||
    hasControlCharacter(specifier) ||
    URI_SCHEME.test(specifier) ||
    isAbsolute(specifier) ||
    (!specifier.startsWith('./') && !specifier.startsWith('../'))
  ) {
    return undefined;
  }
  const candidate = resolve(configFile, '..', specifier);
  return candidate.endsWith('.json') ? candidate : `${candidate}.json`;
}

async function followExtends(
  entryFile: string,
  roots: ConfinedRootsV1,
  dependencies: Set<string>,
  diagnostics: SourceDiagnosticV1[],
  visited: Set<string>
): Promise<void> {
  const read = await readConfinedConfigFile(entryFile, roots);
  if (!read) {
    diagnostics.push(
      diagnostic(
        'config-path-escape',
        'Project config is unreadable or outside the allowed root.',
        entryFile
      )
    );
    return;
  }
  dependencies.add(read.filePath);
  if (visited.has(read.filePath)) {
    diagnostics.push(
      diagnostic('config-extends-cycle', 'Project config extends cycle was refused.', read.filePath)
    );
    return;
  }
  visited.add(read.filePath);

  const parsed = parseJsoncConfig(read.filePath, read.source);
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.value || parsed.value.extends === undefined) return;
  const specifier = literalExtends(parsed.value);
  if (!specifier) {
    diagnostics.push(
      diagnostic(
        'config-extends-dynamic',
        'Project config extends must be one literal string.',
        read.filePath
      )
    );
    return;
  }
  const candidate = extendsCandidate(read.filePath, specifier);
  if (!candidate || !confined(roots, candidate)) {
    diagnostics.push(
      diagnostic(
        'config-extends-external',
        'External, absolute, or root-escaping project config extends was refused.',
        read.filePath
      )
    );
    return;
  }
  await followExtends(candidate, roots, dependencies, diagnostics, visited);
}

async function walkConfigs(
  directory: string,
  roots: ConfinedRootsV1,
  configs: Set<string>,
  vite: Set<string>,
  diagnostics: SourceDiagnosticV1[]
): Promise<void> {
  if (!confined(roots, directory)) return;
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    diagnostics.push(
      diagnostic('config-read-error', 'Project config directory could not be read.', directory)
    );
    return;
  }
  for await (const entry of handle) {
    const candidate = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (CONFIG_NAMES.has(entry.name) || VITE_CONFIG.test(entry.name)) {
        diagnostics.push(
          diagnostic('config-symlink-refused', 'Symlinked project config was refused.', candidate)
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walkConfigs(candidate, roots, configs, vite, diagnostics);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (CONFIG_NAMES.has(entry.name)) configs.add(candidate);
    else if (VITE_CONFIG.test(entry.name)) vite.add(candidate);
  }
}

/** Select the nearest ts/jsconfig for one importer, refusing an equal-distance pair. */
export async function discoverNearestProjectConfig(
  importerFile: string,
  roots: ConfinedRootsV1,
  universe: FileUniverse = resolveFileUniverse(roots.rootPath)
): Promise<{ configFile?: string; diagnostics: SourceDiagnosticV1[] }> {
  const diagnostics: SourceDiagnosticV1[] = [];
  if (unsafePath(importerFile)) {
    return {
      diagnostics: [
        diagnostic('config-path-escape', 'Importer path is invalid or unsafe.', importerFile),
      ],
    };
  }
  let directory = resolve(
    isAbsolute(importerFile) ? importerFile : resolve(roots.rootPath, importerFile),
    '..'
  );
  if (!confined(roots, directory)) {
    return {
      diagnostics: [
        diagnostic('config-path-escape', 'Importer is outside the allowed root.', importerFile),
      ],
    };
  }
  while (confined(roots, directory)) {
    const existing: string[] = [];
    for (const name of CONFIG_NAMES) {
      const candidate = resolve(directory, name);
      if (!universeIncludes(universe, roots.rootPath, candidate)) continue;
      if (await readConfinedConfigFile(candidate, roots)) existing.push(candidate);
    }
    if (existing.length > 1) {
      diagnostics.push(
        diagnostic(
          'config-nearest-ambiguous',
          `Equal-distance tsconfig.json and jsconfig.json were refused: ${existing.sort().join(', ')}.`,
          importerFile
        )
      );
      return { diagnostics };
    }
    if (existing.length === 1) return { configFile: existing[0], diagnostics };
    if (directory === roots.rootPath) break;
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  return { diagnostics };
}

/**
 * Discover project configuration as data. With importer paths, only nearest ts/jsconfigs are
 * selected; without them, all corpus-owned configs are returned for the context builder.
 */
export async function discoverProjectConfigs(
  rootPath: string,
  allowedRoots: readonly string[],
  importerFiles?: readonly string[],
  universe?: FileUniverse
): Promise<ProjectConfigDiscoveryResultV1> {
  const roots = await canonicalizeConfigRoots(rootPath, allowedRoots);
  if (!roots) {
    return {
      tsconfigFiles: [],
      viteFiles: [],
      dependencies: [],
      diagnostics: [
        diagnostic('config-root-invalid', 'Project config root or allowed roots are invalid.'),
      ],
      extractions: new Map<string, never>(),
    };
  }

  const configs = new Set<string>();
  const vite = new Set<string>();
  const diagnostics: SourceDiagnosticV1[] = [];
  await walkConfigs(roots.rootPath, roots, configs, vite, diagnostics);
  // Only configs in the scan's file universe count: an ignored or untracked tsconfig must not
  // steer how tracked imports resolve (file-universe.ts).
  const files = universe ?? resolveFileUniverse(roots.rootPath);
  for (const set of [configs, vite]) {
    for (const candidate of [...set]) {
      if (!universeIncludes(files, roots.rootPath, candidate)) set.delete(candidate);
    }
  }

  if (importerFiles) {
    configs.clear();
    for (const importer of importerFiles) {
      const nearest = await discoverNearestProjectConfig(importer, roots, files);
      diagnostics.push(...nearest.diagnostics);
      if (nearest.configFile) configs.add(nearest.configFile);
    }
  }

  const dependencies = new Set<string>();
  for (const config of [...configs].sort()) {
    await followExtends(config, roots, dependencies, diagnostics, new Set());
  }
  for (const config of [...vite].sort()) {
    const read = await readConfinedConfigFile(config, roots);
    if (read) dependencies.add(read.filePath);
    else diagnostics.push(diagnostic('config-path-escape', 'Vite config was refused.', config));
  }

  return {
    tsconfigFiles: [...configs].sort(),
    viteFiles: [...vite].sort(),
    dependencies: [...dependencies].sort(),
    diagnostics,
    extractions: new Map<string, never>(),
  };
}
