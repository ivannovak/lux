import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import type { ModuleBoundaryConfig } from './types.js';

/** Known directory patterns that indicate module boundaries (order matters). */
const KNOWN_PATTERNS: Array<{ dir: string; pattern: string }> = [
  { dir: 'src/Module', pattern: 'src/Module/{name}' },
  { dir: 'app/Module', pattern: 'app/Module/{name}' },
  { dir: 'app/Modules', pattern: 'app/Modules/{name}' },
  { dir: 'packages', pattern: 'packages/{name}' },
  { dir: 'apps', pattern: 'apps/{name}' },
  { dir: 'libs', pattern: 'libs/{name}' },
];

/**
 * Detect module boundary patterns for a given root path.
 *
 * Priority:
 * 1. Explicit config patterns from lux.yaml
 * 2. Known directory structure patterns
 * 3. Top-level directories containing source files (fallback)
 *
 * @returns Array of pattern strings like "src/Module/{name}".
 */
export function detectModuleBoundaries(rootPath: string, config?: ModuleBoundaryConfig): string[] {
  // 1. Config override
  if (config?.patterns && config.patterns.length > 0) {
    return config.patterns;
  }

  // 2. Known patterns
  for (const { dir, pattern } of KNOWN_PATTERNS) {
    const fullDir = join(rootPath, dir);
    if (existsSync(fullDir) && hasSubdirectories(fullDir)) {
      return [pattern];
    }
  }

  // 3. Fallback: top-level directories with source files
  const topLevelDirs = getTopLevelSourceDirs(rootPath);
  if (topLevelDirs.length > 0) {
    return ['{name}'];
  }

  return [];
}

/**
 * Resolve a file path to the module it belongs to using the given patterns.
 *
 * @param filePath - Absolute or relative file path.
 * @param rootPath - Root path of the project.
 * @param patterns - Module boundary patterns with {name} token.
 * @returns The module name, or null if the file doesn't match any pattern.
 */
export function resolveModule(
  filePath: string,
  rootPath: string,
  patterns: string[]
): string | null {
  const normalizedFilePath = filePath.split(sep).join('/');
  const normalizedRootPath = rootPath.split(sep).join('/');
  const rel = normalizedFilePath.startsWith(normalizedRootPath)
    ? relative(rootPath, filePath).split(sep).join('/')
    : filePath.split(sep).join('/').replace(/^\.\//, '').replace(/^\//, '');

  for (const pattern of patterns) {
    const nameIndex = pattern.indexOf('{name}');
    if (nameIndex === -1) continue;

    const prefix = pattern.slice(0, nameIndex);

    if (!rel.startsWith(prefix)) continue;

    const rest = rel.slice(prefix.length);
    const slashIndex = rest.indexOf('/');
    const moduleName = slashIndex === -1 ? rest : rest.slice(0, slashIndex);

    if (moduleName && !moduleName.includes('.')) {
      return moduleName;
    }
  }

  return null;
}

function hasSubdirectories(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries.some((e) => e.isDirectory());
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}

function getTopLevelSourceDirs(rootPath: string): string[] {
  try {
    const entries = readdirSync(rootPath, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          e.name !== 'node_modules' &&
          e.name !== 'vendor'
      )
      .filter((e) => {
        const dirPath = join(rootPath, e.name);
        return containsSourceFiles(dirPath);
      })
      .map((e) => e.name);
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return [];
  }
}

function containsSourceFiles(dirPath: string): boolean {
  try {
    const entries = readdirSync(dirPath);
    const sourceExts = new Set([
      '.php',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.go',
      '.rs',
      '.java',
    ]);
    return entries.some((entry) => {
      const ext = entry.slice(entry.lastIndexOf('.'));
      if (sourceExts.has(ext)) return true;
      // Check one level of subdirs
      try {
        const subPath = join(dirPath, entry);
        if (statSync(subPath).isDirectory()) {
          const subEntries = readdirSync(subPath);
          return subEntries.some((sub) => sourceExts.has(sub.slice(sub.lastIndexOf('.'))));
        }
      } catch {
        // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
        // ignore
      }
      return false;
    });
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}
