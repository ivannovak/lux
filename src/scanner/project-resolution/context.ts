import { relative, sep } from 'node:path';

import type {
  AliasRuleV1,
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceFactsV1,
  WorkspacePackageV1,
} from '../contracts/program.js';
import type { Extraction } from '../ast/extract.js';
import { rememberProjectResolutionFingerprintInputs } from '../config-fingerprint.js';
import { buildModuleExportIndexes } from './export-index.js';
import { discoverProjectConfigs } from './config-discovery.js';
import { parseTsconfigAliases } from './tsconfig.js';
import { parseViteAliases } from './vite-alias.js';
import { discoverWorkspacePackages } from './workspaces.js';
import { resolveFileUniverse, type FileUniverse } from '../file-universe.js';
import { normalizeRepositoryPath, SOURCE_EXTENSIONS } from './candidates.js';

export interface BuildProjectContextInputV1 {
  rootPath: string;
  allowedRoots: readonly string[];
  sourceFiles: ReadonlySet<string>;
  facts: readonly SourceFactsV1[];
  extractions: ReadonlyMap<string, Extraction>;
  /** The universe the scan of `rootPath` selected from; resolved here when the caller has none. */
  universe?: FileUniverse;
}

export interface BuildProjectContextResultV1 {
  context: ProjectResolutionContextV1;
  diagnostics: SourceDiagnosticV1[];
}

/**
 * Build the one immutable project-resolution snapshot shared by AST and dependency consumers.
 * Repository configuration is discovered and parsed as confined data; Vite is accepted only
 * after the bounded Phase 6 worker has parsed it and is never imported or evaluated.
 */
export async function buildProjectResolutionContext(
  input: BuildProjectContextInputV1
): Promise<BuildProjectContextResultV1> {
  const sourceFiles = new Set(
    [...input.sourceFiles]
      .map((file) => normalizeRepositoryPath(file))
      .filter((file): file is string => file !== null && isResolvableSource(file))
      .sort()
  );
  const universe = input.universe ?? resolveFileUniverse(input.rootPath);
  const discovered = await discoverProjectConfigs(
    input.rootPath,
    input.allowedRoots,
    undefined,
    universe
  );
  // Parse roots independently. This preserves competing nearest configs for resolver-time
  // ambiguity and prevents aliases from unrelated projects replacing one another by pattern.
  const tsconfigParts = await Promise.all(
    discovered.tsconfigFiles.map((configFile) =>
      parseTsconfigAliases([configFile], input.rootPath, input.allowedRoots, sourceFiles)
    )
  );
  const tsconfig = {
    rules: tsconfigParts.flatMap((part) => part.rules),
    dependencies: tsconfigParts.flatMap((part) => part.dependencies),
    diagnostics: tsconfigParts.flatMap((part) => part.diagnostics),
  };
  const vite = await parseViteAliases(
    discovered.viteFiles,
    input.rootPath,
    input.allowedRoots,
    sourceFiles
  );
  const workspace = await discoverWorkspacePackages(
    input.rootPath,
    input.allowedRoots,
    sourceFiles,
    universe
  );

  const aliases: AliasRuleV1[] = [...tsconfig.rules, ...vite.rules]
    .map((rule) => ({ ...rule, configFile: repositoryPath(input.rootPath, rule.configFile) }))
    .sort(
      (a, b) =>
        sourceRank(a.source) - sourceRank(b.source) ||
        a.precedence - b.precedence ||
        a.pattern.localeCompare(b.pattern) ||
        a.configFile.localeCompare(b.configFile)
    );
  const workspacePackages: WorkspacePackageV1[] = [...workspace.packages].sort(
    (a, b) => a.name.localeCompare(b.name) || a.manifestPath.localeCompare(b.manifestPath)
  );
  const exportsByFile = buildModuleExportIndexes(
    [...input.extractions]
      .filter(([filePath]) => sourceFiles.has(filePath))
      .map(([filePath, extraction]) => ({ filePath, extraction }))
  );
  const fingerprintInputs = [
    ...discovered.dependencies,
    ...tsconfig.dependencies,
    ...vite.dependencies,
    ...workspace.dependencies,
  ]
    .map((file) => repositoryPath(input.rootPath, file))
    .filter((file, index, all) => file.length > 0 && all.indexOf(file) === index)
    .sort();

  rememberProjectResolutionFingerprintInputs(input.rootPath, fingerprintInputs);

  return {
    context: {
      rootPath: input.rootPath,
      sourceFiles,
      aliases,
      workspacePackages,
      exportsByFile,
      fingerprintInputs,
    },
    diagnostics: [
      ...discovered.diagnostics,
      ...tsconfig.diagnostics,
      ...vite.diagnostics,
      ...workspace.diagnostics,
    ].sort(compareDiagnostics),
  };
}

function repositoryPath(rootPath: string, filePath: string): string {
  const value = relative(rootPath, filePath);
  if (value !== '' && value !== '..' && !value.startsWith(`..${sep}`)) {
    return value.split(sep).join('/');
  }
  return filePath.split(sep).join('/');
}

function isResolvableSource(filePath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function sourceRank(source: AliasRuleV1['source']): number {
  return source === 'tsconfig' || source === 'jsconfig' ? 0 : source === 'vite' ? 1 : 2;
}

function compareDiagnostics(a: SourceDiagnosticV1, b: SourceDiagnosticV1): number {
  return (
    a.code.localeCompare(b.code) ||
    (a.location?.filePath ?? '').localeCompare(b.location?.filePath ?? '') ||
    a.message.localeCompare(b.message)
  );
}
