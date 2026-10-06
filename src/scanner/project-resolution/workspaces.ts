import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { glob } from 'glob';
import { parseDocument, visit } from 'yaml';

import type { SourceDiagnosticV1, WorkspacePackageV1 } from '../contracts/program.js';
import { normalizeRepositoryPath } from './candidates.js';
import { parsePackageExports } from './package-exports.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SAFE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const ROOT_PACKAGE = 'package.json';
const PNPM_WORKSPACE = 'pnpm-workspace.yaml';

export interface WorkspaceDiscoveryResultV1 {
  packages: WorkspacePackageV1[];
  diagnostics: SourceDiagnosticV1[];
  dependencies: string[];
}

interface WorkspaceManifestV1 {
  path: string;
  contents: Record<string, unknown>;
}

/** Discover static npm/yarn and pnpm workspace package manifests beneath the repository root. */
export async function discoverWorkspacePackages(
  rootPath: string,
  allowedRoots: readonly string[],
  sourceFiles: ReadonlySet<string>
): Promise<WorkspaceDiscoveryResultV1> {
  const diagnostics: SourceDiagnosticV1[] = [];
  const dependencies: string[] = [];
  const canonicalRoot = await validateRoot(rootPath, allowedRoots, diagnostics);
  if (!canonicalRoot) return { packages: [], diagnostics, dependencies };

  const patterns: string[] = [];
  const rootManifest = await readConfinedManifest(
    resolve(rootPath, ROOT_PACKAGE),
    rootPath,
    canonicalRoot,
    diagnostics,
    dependencies,
    true
  );
  if (rootManifest) patterns.push(...parseNpmWorkspacePatterns(rootManifest, diagnostics));

  const pnpmPath = resolve(rootPath, PNPM_WORKSPACE);
  if (await pathExists(pnpmPath)) {
    const relativePnpm = toRepositoryPath(rootPath, pnpmPath);
    if (relativePnpm && (await isCanonicalWithin(canonicalRoot, pnpmPath))) {
      dependencies.push(relativePnpm);
      patterns.push(...(await parsePnpmWorkspacePatterns(pnpmPath, relativePnpm, diagnostics)));
    } else {
      diagnostics.push({
        code: 'workspace-manifest-outside-root',
        message: `${PNPM_WORKSPACE} resolves outside the repository root`,
      });
    }
  }

  const manifestPaths = await expandWorkspacePatterns(
    patterns,
    rootPath,
    canonicalRoot,
    diagnostics
  );
  const records: WorkspacePackageV1[] = [];
  for (const manifestPath of manifestPaths) {
    const manifest = await readConfinedManifest(
      manifestPath,
      rootPath,
      canonicalRoot,
      diagnostics,
      dependencies,
      false
    );
    if (!manifest) continue;
    const name = manifest.contents.name;
    if (typeof name !== 'string' || !validPackageName(name)) {
      diagnostics.push({
        code: 'workspace-package-invalid',
        message: `${manifest.path} has no static non-empty package name`,
      });
      continue;
    }

    const packageRootAbsolute = resolve(rootPath, manifest.path, '..');
    const packageRoot = toRepositoryPath(rootPath, packageRootAbsolute);
    if (packageRoot === null) continue;
    const parsedExports = await parsePackageExports({
      value: manifest.contents.exports,
      packageRoot: packageRootAbsolute,
      manifestPath: manifest.path,
      repositoryRoot: rootPath,
      sourceFiles,
    });
    diagnostics.push(...parsedExports.diagnostics);
    dependencies.push(...parsedExports.dependencies);
    records.push({
      name,
      rootPath: packageRoot,
      manifestPath: manifest.path,
      exports: parsedExports.exports,
    });
  }

  const packages = removeDuplicateNames(records, diagnostics);
  return {
    packages: packages.sort(
      (a, b) => a.name.localeCompare(b.name) || a.manifestPath.localeCompare(b.manifestPath)
    ),
    diagnostics: diagnostics.sort(
      (a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message)
    ),
    dependencies: [...new Set(dependencies)].sort(),
  };
}

function parseNpmWorkspacePatterns(
  manifest: WorkspaceManifestV1,
  diagnostics: SourceDiagnosticV1[]
): string[] {
  const workspaces = manifest.contents.workspaces;
  if (workspaces === undefined) return [];
  if (Array.isArray(workspaces)) return validatePatterns(workspaces, manifest.path, diagnostics);
  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return validatePatterns(workspaces.packages, manifest.path, diagnostics);
  }
  diagnostics.push({
    code: 'workspace-manifest-invalid',
    message: `${manifest.path}#workspaces must be an array or an object with a packages array`,
  });
  return [];
}

async function parsePnpmWorkspacePatterns(
  absolutePath: string,
  relativePath: string,
  diagnostics: SourceDiagnosticV1[]
): Promise<string[]> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_MANIFEST_BYTES) {
      diagnostics.push({
        code: 'workspace-manifest-invalid',
        message: `${relativePath} is not a bounded regular file`,
      });
      return [];
    }
    const document = parseDocument(await readBoundedFile(absolutePath, MAX_MANIFEST_BYTES), {
      schema: 'core',
      uniqueKeys: true,
    });
    let customTag = false;
    visit(document, (_key, node) => {
      if (
        typeof node === 'object' &&
        node !== null &&
        'tag' in node &&
        typeof node.tag === 'string' &&
        node.tag.startsWith('!')
      ) {
        customTag = true;
      }
    });
    if (document.errors.length > 0 || customTag) {
      const detail = customTag ? 'custom YAML tags are not supported' : document.errors[0].message;
      diagnostics.push({
        code: 'workspace-manifest-invalid',
        message: `${relativePath}: ${detail}`,
      });
      return [];
    }
    const parsed = document.toJS({ maxAliasCount: 50 }) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.packages)) {
      diagnostics.push({
        code: 'workspace-manifest-invalid',
        message: `${relativePath}#packages must be an array`,
      });
      return [];
    }
    return validatePatterns(parsed.packages, relativePath, diagnostics);
  } catch (error) {
    diagnostics.push({
      code: 'workspace-manifest-invalid',
      message: `Cannot parse ${relativePath}: ${errorMessage(error)}`,
    });
    return [];
  }
}

function validatePatterns(
  values: unknown[],
  manifestPath: string,
  diagnostics: SourceDiagnosticV1[]
): string[] {
  const valid: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !validWorkspacePattern(value)) {
      diagnostics.push({
        code: 'workspace-pattern-invalid',
        message: `${manifestPath} contains an unsafe or non-string workspace pattern`,
      });
      continue;
    }
    valid.push(value);
  }
  return valid;
}

async function expandWorkspacePatterns(
  patterns: readonly string[],
  rootPath: string,
  canonicalRoot: string,
  diagnostics: SourceDiagnosticV1[]
): Promise<string[]> {
  const positive = patterns.filter((pattern) => !pattern.startsWith('!'));
  if (positive.length === 0) return [];
  const ignored = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => manifestGlob(pattern.slice(1)));
  const matches = await glob(positive.map(manifestGlob), {
    cwd: rootPath,
    absolute: true,
    nodir: true,
    dot: false,
    follow: false,
    ignore: ['**/node_modules/**', ...ignored],
  });

  const accepted: string[] = [];
  for (const match of matches.sort()) {
    const lexical = toRepositoryPath(rootPath, match);
    if (!lexical || !(await isCanonicalWithin(canonicalRoot, match))) {
      diagnostics.push({
        code: 'workspace-manifest-outside-root',
        message: `Workspace manifest resolves outside the repository: ${lexical ?? match}`,
      });
      continue;
    }
    accepted.push(resolve(match));
  }
  return [...new Set(accepted)].sort();
}

function manifestGlob(pattern: string): string {
  const normalized = pattern.replace(/\/+$/u, '');
  return normalized.endsWith('/package.json') || normalized === 'package.json'
    ? normalized
    : `${normalized}/package.json`;
}

async function readConfinedManifest(
  absolutePath: string,
  rootPath: string,
  canonicalRoot: string,
  diagnostics: SourceDiagnosticV1[],
  dependencies: string[],
  optional: boolean
): Promise<WorkspaceManifestV1 | null> {
  if (!(await pathExists(absolutePath))) {
    if (!optional) {
      diagnostics.push({
        code: 'workspace-manifest-invalid',
        message: `Workspace manifest does not exist: ${absolutePath}`,
      });
    }
    return null;
  }
  const relativePath = toRepositoryPath(rootPath, absolutePath);
  if (!relativePath || !(await isCanonicalWithin(canonicalRoot, absolutePath))) {
    diagnostics.push({
      code: 'workspace-manifest-outside-root',
      message: `Refusing to read a workspace manifest outside the repository root: ${relativePath ?? absolutePath}`,
    });
    return null;
  }
  dependencies.push(relativePath);

  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_MANIFEST_BYTES) {
      diagnostics.push({
        code: 'workspace-manifest-invalid',
        message: `${relativePath} is not a bounded regular file`,
      });
      return null;
    }
    const parsed = JSON.parse(await readBoundedFile(absolutePath, MAX_MANIFEST_BYTES)) as unknown;
    if (!isRecord(parsed)) throw new Error('manifest root must be an object');
    return { path: relativePath, contents: parsed };
  } catch (error) {
    diagnostics.push({
      code: 'workspace-manifest-invalid',
      message: `Cannot parse ${relativePath}: ${errorMessage(error)}`,
    });
    return null;
  }
}

function removeDuplicateNames(
  packages: WorkspacePackageV1[],
  diagnostics: SourceDiagnosticV1[]
): WorkspacePackageV1[] {
  const byName = new Map<string, WorkspacePackageV1[]>();
  for (const workspacePackage of packages) {
    const entries = byName.get(workspacePackage.name) ?? [];
    if (!entries.some((item) => item.manifestPath === workspacePackage.manifestPath)) {
      entries.push(workspacePackage);
    }
    byName.set(workspacePackage.name, entries);
  }

  const result: WorkspacePackageV1[] = [];
  for (const [name, entries] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.length === 1) {
      result.push(entries[0]);
      continue;
    }
    diagnostics.push({
      code: 'workspace-package-ambiguous',
      message: `Workspace package ${JSON.stringify(name)} is declared by ${entries
        .map((item) => item.manifestPath)
        .sort()
        .join(', ')}`,
    });
  }
  return result;
}

async function validateRoot(
  rootPath: string,
  allowedRoots: readonly string[],
  diagnostics: SourceDiagnosticV1[]
): Promise<string | null> {
  try {
    const canonicalRoot = await realpath(rootPath);
    const boundaries = allowedRoots.length > 0 ? allowedRoots : [rootPath];
    const canonicalBoundaries = (
      await Promise.all(
        boundaries.map(async (boundary) => {
          try {
            return await realpath(boundary);
          } catch {
            // lux-intentional-swallow: a path that cannot be canonicalized is used as written.
            return null;
          }
        })
      )
    ).filter((value): value is string => value !== null);
    if (
      canonicalBoundaries.length === 0 ||
      !canonicalBoundaries.some((boundary) => isWithin(boundary, canonicalRoot))
    ) {
      diagnostics.push({
        code: 'workspace-root-not-allowed',
        message: 'Repository root is not within an allowed root',
      });
      return null;
    }
    return canonicalRoot;
  } catch (error) {
    diagnostics.push({
      code: 'workspace-root-invalid',
      message: `Cannot canonicalize repository root: ${errorMessage(error)}`,
    });
    return null;
  }
}

function validPackageName(value: string): boolean {
  if (value.length === 0 || value.length > 214 || hasControl(value) || value.includes('\\')) {
    return false;
  }
  const parts = value.split('/');
  if (value.startsWith('@')) {
    return (
      parts.length === 2 &&
      validPackageNamePart(parts[0].slice(1)) &&
      validPackageNamePart(parts[1])
    );
  }
  return parts.length === 1 && validPackageNamePart(parts[0]);
}

function validPackageNamePart(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.startsWith('.');
}

function validWorkspacePattern(value: string): boolean {
  if (value.length === 0 || hasControl(value) || value.includes('\\')) return false;
  const body = value.startsWith('!') ? value.slice(1) : value;
  if (body.length === 0 || isAbsolute(body) || body.startsWith('/')) return false;
  const segments = body.split('/');
  return !segments.some((segment) => segment === '..' || segment === 'node_modules');
}

function toRepositoryPath(rootPath: string, absolutePath: string): string | null {
  const value = relative(resolve(rootPath), resolve(absolutePath));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value))
    return null;
  return normalizeRepositoryPath(value.split(sep).join('/'));
}

async function isCanonicalWithin(canonicalRoot: string, path: string): Promise<boolean> {
  try {
    return isWithin(canonicalRoot, await realpath(path));
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
