import { glob } from 'glob';
import { confinedRead } from '../adapters/path-policy.js';
import { DEFAULT_PARSER_LIMITS } from '../adapters/types.js';
import { posix } from 'node:path';
import type { GoProjectV1 } from '../languages/contracts.js';
export interface GoModV1 {
  filePath: string;
  modulePath: string;
  goVersion?: string;
  replaces: Array<{ from: string; version?: string; to: string; toVersion?: string }>;
}
function parseGoMod(text: string, filePath: string): GoModV1 {
  let modulePath = '',
    goVersion: string | undefined;
  const replaces: GoModV1['replaces'] = [],
    clean = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  let inReplace = false;
  for (const raw of clean.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'replace (') {
      inReplace = true;
      continue;
    }
    if (inReplace && line === ')') {
      inReplace = false;
      continue;
    }
    const m = /^module\s+(\S+)$/u.exec(line);
    if (m) modulePath = unquote(m[1]);
    const g = /^go\s+(\S+)$/u.exec(line);
    if (g) goVersion = g[1];
    const r = /^(?:replace\s+)?(\S+)(?:\s+(v\S+))?\s+=>\s+(\S+)(?:\s+(v\S+))?$/u.exec(line);
    if (r && (inReplace || line.startsWith('replace ')))
      replaces.push({
        from: unquote(r[1]),
        ...(r[2] ? { version: r[2] } : {}),
        to: unquote(r[3]),
        ...(r[4] ? { toVersion: r[4] } : {}),
      });
  }
  if (!/^[A-Za-z0-9._~/-]+$/u.test(modulePath)) throw new Error('invalid go module path');
  return { filePath, modulePath, goVersion, replaces };
}
export async function discoverGoProject(input: {
  corpusRoot: string;
  allowedRoots: readonly string[];
  sourceRoots: readonly string[];
  maxFiles: number;
}): Promise<GoProjectV1 | null> {
  let text: string;
  try {
    const bytes = confinedRead({
      corpusRoot: input.corpusRoot,
      allowedRoots: input.allowedRoots,
      filePath: 'go.mod',
      limits: DEFAULT_PARSER_LIMITS,
    }).bytes;
    text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } catch {
    // lux-intentional-swallow: no readable go.mod: not a Go module.
    return null;
  }
  const mod = parseGoMod(text, 'go.mod'),
    files = (
      await glob(
        input.sourceRoots.map((r) => `${r === '.' ? '' : r + '/'}**/*.go`),
        { cwd: input.corpusRoot, nodir: true, ignore: ['vendor/**', '.git/**'] }
      )
    ).sort();
  if (files.length > input.maxFiles) throw new Error('go maxFiles exceeded');
  const packages = new Map<string, string[]>();
  for (const f of files) {
    const dir = posix.dirname(f) === '.' ? '.' : posix.dirname(f);
    packages.set(dir, [...(packages.get(dir) ?? []), f]);
  }
  return {
    schemaVersion: 1,
    languageId: 'go',
    corpusRoot: input.corpusRoot,
    allowedRoots: input.allowedRoots,
    sourceRoots: input.sourceRoots,
    manifestFiles: ['go.mod'],
    files,
    fingerprintInputs: ['go.mod'],
    modulePath: mod.modulePath,
    goModPath: 'go.mod',
    packages,
  };
}
export function goImportToPackage(specifier: string, project: GoProjectV1) {
  if (!specifier.startsWith(project.modulePath))
    return { status: 'external' as const, importPath: specifier };
  const path = specifier.slice(project.modulePath.length).replace(/^\//u, '') || '.',
    files = project.packages.get(path);
  return files
    ? { status: 'first-party' as const, packagePath: path, files }
    : { status: 'missing' as const, candidates: [] };
}
function unquote(v: string) {
  return /^(["'`]).*\1$/u.test(v) ? v.slice(1, -1) : v;
}
