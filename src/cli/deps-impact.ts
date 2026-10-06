// Shared blast-radius computation behind `lux deps impact` and the `lux_deps_impact` MCP tool.
//
// Extracted verbatim from the inline body of the `deps impact` CLI action so the CLI and the MCP
// layer resolve a file to its module and enumerate dependent modules through ONE code path — the
// MCP tool must not fork this query logic. The CLI keeps its own text/JSON rendering; this module
// only produces the structural `ImpactData` (or reports an unresolvable file).

import { toStoredPath, type LuxDatabase } from '../db/index.js';
import { resolveModule, detectModuleBoundaries } from '../scanner/imports/module-boundary.js';

export interface DependentModuleImpact {
  module: string;
  referenceCount: number;
  sampleFiles: string[];
}

export interface ImpactData {
  file: string;
  module: string;
  dependentModules: DependentModuleImpact[];
  blastRadius: {
    modules: number;
    totalReferences: number;
  };
}

export type ImpactResult =
  { resolved: true; impact: ImpactData } | { resolved: false; file: string };

/**
 * Resolve `filePath` to its module and gather every module that depends on it (blast radius).
 * Returns `{ resolved: false }` when the file cannot be mapped to a module boundary — the caller
 * decides how to surface that (the CLI writes to stderr; the MCP tool returns an error envelope).
 */
export function computeImpact(db: LuxDatabase, corpusPath: string, filePath: string): ImpactResult {
  const patterns = detectModuleBoundaries(corpusPath);
  const sourceModule = resolveModule(filePath, corpusPath, patterns);

  if (!sourceModule) {
    return { resolved: false, file: filePath };
  }

  // Find all modules that depend on this module (target = sourceModule)
  const dependents = db.getModuleDependencies(sourceModule, 'target');

  const impact: ImpactData = {
    // Corpus-relative, like every path Lux reports. A relative argument already is: resolving it
    // against the working directory would report a path that depends on where the command ran.
    file: toStoredPath(corpusPath, filePath) || filePath,
    module: sourceModule,
    dependentModules: dependents.map((d) => ({
      module: d.source_module,
      referenceCount: d.reference_count,
      sampleFiles: d.sample_files ? (JSON.parse(d.sample_files) as string[]) : [],
    })),
    blastRadius: {
      modules: dependents.length,
      totalReferences: dependents.reduce((sum, d) => sum + d.reference_count, 0),
    },
  };

  return { resolved: true, impact };
}
