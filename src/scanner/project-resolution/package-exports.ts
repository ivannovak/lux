import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  ModuleResolutionResultV1,
  SourceDiagnosticV1,
  WorkspacePackageV1,
} from '../contracts/program.js';
import { SOURCE_EXTENSIONS, normalizeRepositoryPath } from './candidates.js';

const CONDITION_PRIORITY = ['types', 'import', 'default', 'require'] as const;
const CONFIG_FILES = ['tsconfig.json', 'jsconfig.json'] as const;
const MAX_CONFIG_BYTES = 1024 * 1024;
const SAFE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

interface CompilerDirectoriesV1 {
  rootDir: string;
  outDir: string;
}

export interface ParsePackageExportsResultV1 {
  exports: Record<string, string[]>;
  diagnostics: SourceDiagnosticV1[];
  dependencies: string[];
}

export interface ParsePackageExportsInputV1 {
  value: unknown;
  packageRoot: string;
  manifestPath: string;
  repositoryRoot: string;
  sourceFiles: ReadonlySet<string>;
}

interface ExportParseContextV1 extends ParsePackageExportsInputV1 {
  compilerDirectories?: CompilerDirectoriesV1;
  diagnostics: SourceDiagnosticV1[];
}

/**
 * Parse the deliberately small, static package-exports subset used by project resolution.
 * Repository configuration is treated as data: no package module or script is loaded.
 */
export async function parsePackageExports(
  input: ParsePackageExportsInputV1
): Promise<ParsePackageExportsResultV1> {
  const diagnostics: SourceDiagnosticV1[] = [];
  const dependencies: string[] = [];
  const compilerDirectories = await readCompilerDirectories(input, diagnostics, dependencies);
  const context: ExportParseContextV1 = { ...input, compilerDirectories, diagnostics };
  const mappings = classifyExports(input.value, input.manifestPath, diagnostics);
  const exports: Record<string, string[]> = {};

  if (mappings) {
    for (const [key, value] of mappings) {
      const targets = await parseTargetValue(value, key, context);
      if (targets !== null && targets.length > 0) exports[key] = [...new Set(targets)].sort();
    }
  }

  return {
    exports: Object.fromEntries(Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))),
    diagnostics: sortDiagnostics(diagnostics),
    dependencies: [...new Set(dependencies)].sort(),
  };
}

/** Resolve an exact workspace package name or one of its exported subpaths. */
export function resolvePackageExport(
  specifier: string,
  packages: readonly WorkspacePackageV1[],
  sourceFiles: ReadonlySet<string>
): ModuleResolutionResultV1 | undefined {
  const matching = packages
    .filter((item) => specifier === item.name || specifier.startsWith(`${item.name}/`))
    .sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
  if (matching.length === 0) return undefined;

  const longestName = Math.max(...matching.map((item) => item.name.length));
  const atRank = matching.filter((item) => item.name.length === longestName);
  if (atRank.length > 1) {
    return {
      status: 'ambiguous',
      candidates: [],
      governingConfigs: atRank.map((item) => item.manifestPath).sort(),
    };
  }

  const workspacePackage = atRank[0];
  const requestedSuffix = specifier.slice(workspacePackage.name.length + 1);
  if (
    specifier !== workspacePackage.name &&
    (normalizeRepositoryPath(requestedSuffix) !== requestedSuffix || requestedSuffix.length === 0)
  ) {
    return { status: 'missing', specifier };
  }
  const subpath = specifier === workspacePackage.name ? '.' : `./${requestedSuffix}`;
  const selected = selectExportMapping(workspacePackage.exports, subpath);
  if (selected.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: [...new Set(selected.targets.filter((target) => sourceFiles.has(target)))].sort(),
      governingConfigs: [workspacePackage.manifestPath],
    };
  }
  if (selected.status === 'missing') return { status: 'missing', specifier };

  const candidates = [
    ...new Set(selected.targets.filter((target) => sourceFiles.has(target))),
  ].sort();
  if (candidates.length === 0) return { status: 'missing', specifier };
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates,
      governingConfigs: [workspacePackage.manifestPath],
    };
  }

  return {
    status: 'resolved',
    targetFile: candidates[0],
    via: subpath === '.' ? 'workspace' : 'package-exports',
    evidenceFile: workspacePackage.manifestPath,
  };
}

function classifyExports(
  value: unknown,
  manifestPath: string,
  diagnostics: SourceDiagnosticV1[]
): Array<[string, unknown]> | null {
  if (value === undefined) return [];
  if (isTargetLeaf(value)) return [['.', value]];
  if (!isRecord(value)) {
    invalidExports(diagnostics, manifestPath, 'The exports field must be a target or object');
    return null;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    invalidExports(diagnostics, manifestPath, 'The exports object must not be empty');
    return null;
  }
  const subpathEntries = entries.filter(([key]) => key.startsWith('.'));
  if (subpathEntries.length === 0) return [['.', value]];
  if (subpathEntries.length !== entries.length) {
    invalidExports(diagnostics, manifestPath, 'Exports cannot mix subpath keys and conditions');
    return null;
  }

  const result: Array<[string, unknown]> = [];
  for (const [key, target] of entries) {
    if (!validExportKey(key)) {
      invalidExports(diagnostics, manifestPath, `Unsupported export key ${JSON.stringify(key)}`);
      continue;
    }
    result.push([key, target]);
  }
  return result;
}

async function parseTargetValue(
  value: unknown,
  key: string,
  context: ExportParseContextV1
): Promise<string[] | null> {
  if (typeof value === 'string') return parseStringTarget(value, key, context);
  if (Array.isArray(value)) {
    if (value.length === 0)
      return rejectTarget(context, key, 'Export target arrays must not be empty');
    const collected: string[] = [];
    for (const item of value) {
      const parsed = await parseTargetValue(item, key, context);
      if (parsed === null) return null;
      collected.push(...parsed);
    }
    return collected;
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return rejectTarget(context, key, 'Export target must be a string, array, or condition object');
  }

  const keys = Object.keys(value);
  const custom = keys.filter(
    (condition) => !CONDITION_PRIORITY.includes(condition as (typeof CONDITION_PRIORITY)[number])
  );
  if (custom.length > 0) {
    return rejectTarget(
      context,
      key,
      `Unsupported export condition${custom.length === 1 ? '' : 's'}: ${custom.sort().join(', ')}`
    );
  }
  for (const condition of CONDITION_PRIORITY) {
    if (Object.prototype.hasOwnProperty.call(value, condition)) {
      return parseTargetValue(value[condition], key, context);
    }
  }
  return rejectTarget(context, key, 'Export condition object has no supported condition');
}

async function parseStringTarget(
  target: string,
  key: string,
  context: ExportParseContextV1
): Promise<string[] | null> {
  if (!validTargetShape(target, key)) {
    return rejectTarget(context, key, `Unsupported export target ${JSON.stringify(target)}`);
  }

  const relativeTarget = target.slice(2).replaceAll('\\', '/');
  const absoluteTarget = resolve(context.packageRoot, relativeTarget);
  if (!isWithin(context.packageRoot, absoluteTarget)) {
    return rejectTarget(
      context,
      key,
      `Export target escapes its package: ${JSON.stringify(target)}`
    );
  }
  const repositoryTarget = toRepositoryPath(context.repositoryRoot, absoluteTarget);
  if (!repositoryTarget) {
    return rejectTarget(
      context,
      key,
      `Export target escapes the repository: ${JSON.stringify(target)}`
    );
  }

  const directStatus = await scannedTargetStatus(repositoryTarget, context);
  if (directStatus === 'confined') return [repositoryTarget];
  if (directStatus === 'outside') {
    return rejectTarget(
      context,
      key,
      `Export target escapes through a symlink: ${JSON.stringify(target)}`
    );
  }

  const remapped = remapOutputTarget(repositoryTarget, context);
  const surviving: string[] = [];
  for (const candidate of remapped) {
    const status = await scannedTargetStatus(candidate, context);
    if (status === 'outside') {
      return rejectTarget(context, key, `Remapped export target escapes through a symlink`);
    }
    if (status === 'confined') surviving.push(candidate);
  }
  return surviving;
}

function remapOutputTarget(target: string, context: ExportParseContextV1): string[] {
  const directories = context.compilerDirectories;
  if (!directories) return [];
  const suffix = relativePath(directories.outDir, target);
  if (suffix === null || suffix === '') return [];

  const sourceTarget = `${directories.rootDir}/${suffix}`.replaceAll('//', '/');
  const emitted = sourceTarget.match(/(?:\.d\.(?:mts|cts|ts)|\.(?:mjs|cjs|js|jsx))$/u);
  if (!emitted) return [sourceTarget];
  const base = sourceTarget.slice(0, -emitted[0].length);
  return SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`);
}

async function readCompilerDirectories(
  input: ParsePackageExportsInputV1,
  diagnostics: SourceDiagnosticV1[],
  dependencies: string[]
): Promise<CompilerDirectoriesV1 | undefined> {
  for (const fileName of CONFIG_FILES) {
    const absolute = resolve(input.packageRoot, fileName);
    if (!(await pathExists(absolute))) continue;
    const dependency = toRepositoryPath(input.repositoryRoot, absolute);
    if (!dependency || !(await canonicalWithin(input.repositoryRoot, absolute))) {
      diagnostics.push({
        code: 'package-config-outside-root',
        message: `${fileName} for ${input.manifestPath} is outside the repository`,
      });
      continue;
    }
    dependencies.push(dependency);

    try {
      const fileStat = await stat(absolute);
      if (!fileStat.isFile() || fileStat.size > MAX_CONFIG_BYTES) {
        diagnostics.push({
          code: 'package-config-invalid',
          message: `${dependency} is not a bounded regular file`,
        });
        return undefined;
      }
      const parsed = parseJsonc(await readBoundedFile(absolute, MAX_CONFIG_BYTES));
      if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) return undefined;
      const rootDir = parseCompilerDirectory(
        parsed.compilerOptions.rootDir,
        dirname(absolute),
        input.repositoryRoot
      );
      const outDir = parseCompilerDirectory(
        parsed.compilerOptions.outDir,
        dirname(absolute),
        input.repositoryRoot
      );
      if (rootDir && outDir) return { rootDir, outDir };
      if (
        parsed.compilerOptions.rootDir !== undefined ||
        parsed.compilerOptions.outDir !== undefined
      ) {
        diagnostics.push({
          code: 'package-config-invalid',
          message: `${dependency} has non-literal or non-confined rootDir/outDir`,
        });
      }
      return undefined;
    } catch (error) {
      diagnostics.push({
        code: 'package-config-invalid',
        message: `Cannot parse ${dependency}: ${errorMessage(error)}`,
      });
      return undefined;
    }
  }
  return undefined;
}

function parseCompilerDirectory(
  value: unknown,
  configDirectory: string,
  repositoryRoot: string
): string | null {
  if (typeof value !== 'string' || value.length === 0 || hasControl(value)) return null;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(configDirectory, value);
  return toRepositoryPath(repositoryRoot, absolute);
}

function selectExportMapping(
  exports: Readonly<Record<string, string[]>>,
  requested: string
):
  | { status: 'found'; targets: string[] }
  | { status: 'ambiguous'; targets: string[] }
  | { status: 'missing' } {
  const exact = exports[requested];
  if (exact) return { status: 'found', targets: exact };

  const matches = Object.entries(exports)
    .filter(([key]) => key.includes('*'))
    .map(([key, targets]) => {
      const capture = matchOneStar(key, requested);
      return {
        key,
        targets: capture === null ? [] : targets.map((target) => target.replace('*', capture)),
        matched: capture !== null,
      };
    })
    .filter(({ matched }) => matched);
  if (matches.length === 0) return { status: 'missing' };
  const bestRank = Math.max(...matches.map(({ key }) => key.replace('*', '').length));
  const winners = matches.filter(({ key }) => key.replace('*', '').length === bestRank);
  const targets = [...new Set(winners.flatMap((winner) => winner.targets))].sort();
  return winners.length === 1 ? { status: 'found', targets } : { status: 'ambiguous', targets };
}

function validExportKey(key: string): boolean {
  if (key !== '.' && !key.startsWith('./')) return false;
  if (hasControl(key) || key.includes('\\')) return false;
  if (key.split('*').length > 2) return false;
  const body = key === '.' ? 'root' : key.slice(2);
  const normalized = normalizeRepositoryPath(body);
  return normalized === body && normalized !== '' && !normalized.includes('node_modules/');
}

function validTargetShape(target: string, key: string): boolean {
  if (!target.startsWith('./') || target.length <= 2 || hasControl(target)) return false;
  if (target.includes('\\') || target.includes('?') || target.includes('#')) return false;
  if (target.split('*').length > 2) return false;
  if (key.includes('*') !== target.includes('*')) return false;
  const body = target.slice(2);
  const normalized = normalizeRepositoryPath(body);
  return normalized === body && normalized !== '' && !normalized.includes('node_modules/');
}

function isTargetLeaf(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectTarget(context: ExportParseContextV1, key: string, message: string): null {
  context.diagnostics.push({
    code: 'package-exports-invalid',
    message: `${context.manifestPath} export ${JSON.stringify(key)}: ${message}`,
  });
  return null;
}

function invalidExports(
  diagnostics: SourceDiagnosticV1[],
  manifestPath: string,
  message: string
): void {
  diagnostics.push({ code: 'package-exports-invalid', message: `${manifestPath}: ${message}` });
}

async function scannedTargetStatus(
  target: string,
  context: ExportParseContextV1
): Promise<'confined' | 'missing' | 'outside'> {
  if (!target.includes('*')) {
    if (!context.sourceFiles.has(target)) return 'missing';
    return (await canonicalWithin(context.repositoryRoot, resolve(context.repositoryRoot, target)))
      ? 'confined'
      : 'outside';
  }

  const expression = oneStarExpression(target);
  if (!expression) return 'missing';
  const matches = [...context.sourceFiles].filter((file) => expression.test(file));
  if (matches.length === 0) return 'missing';
  const confined = await Promise.all(
    matches.map((file) =>
      canonicalWithin(context.repositoryRoot, resolve(context.repositoryRoot, file))
    )
  );
  return confined.every(Boolean) ? 'confined' : 'outside';
}

function matchOneStar(pattern: string, value: string): string | null {
  const star = pattern.indexOf('*');
  if (star < 0 || pattern.indexOf('*', star + 1) >= 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const capture = value.slice(prefix.length, value.length - suffix.length);
  return capture.length > 0 && normalizeRepositoryPath(capture) === capture ? capture : null;
}

function oneStarExpression(pattern: string): RegExp | null {
  const star = pattern.indexOf('*');
  if (star < 0 || pattern.indexOf('*', star + 1) >= 0) return null;
  const escaped = pattern.split('*').map(escapeRegExp);
  return new RegExp(`^${escaped[0]}.+${escaped[1]}$`, 'u');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function toRepositoryPath(repositoryRoot: string, absolute: string): string | null {
  if (!isWithin(repositoryRoot, absolute)) return null;
  const path = relative(resolve(repositoryRoot), resolve(absolute)).split(sep).join('/');
  return normalizeRepositoryPath(path);
}

function relativePath(parent: string, child: string): string | null {
  if (child === parent) return '';
  if (!child.startsWith(`${parent}/`)) return null;
  return child.slice(parent.length + 1);
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function canonicalWithin(root: string, candidate: string): Promise<boolean> {
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    return isWithin(canonicalRoot, canonicalCandidate);
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, SAFE_OPEN_FLAGS);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maximumBytes) {
      throw new Error('not a bounded regular file');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}

function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingJsonCommas(stripJsonComments(text))) as unknown;
}

function removeTrailingJsonCommas(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === ',') {
      let lookahead = index + 1;
      while (/\s/u.test(text[lookahead] ?? '')) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') continue;
    }
    output += current;
  }
  return output;
}

function stripJsonComments(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        output += text[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function sortDiagnostics(diagnostics: SourceDiagnosticV1[]): SourceDiagnosticV1[] {
  return diagnostics.sort(
    (a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
