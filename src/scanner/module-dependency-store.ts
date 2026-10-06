// Persistence for the module-dependency graph a scan computes.
//
// Kept out of rebuild-orchestrator.ts because that module is re-exported from the package entry
// point; this writer is internal plumbing for the rebuild and sync paths, not public API.

import type { LuxDatabase } from '../db/index.js';
import type { GeneralScanResult } from './general.js';

/**
 * Replace the module dependencies with the ones a scan computed, returning a warning on failure
 * (null on success) for the caller to fold into its trust classification.
 *
 * The write is one transaction, so it never leaves a partial table. A rollback restores whatever the
 * table held before, which may be another commit's rows, so on failure the table is cleared again:
 * after a failed write it is empty and the warning says so. If that clear fails too, the warning
 * says the table's contents are unknown instead.
 */
export function persistModuleDependencies(
  db: LuxDatabase,
  scanResult: Pick<GeneralScanResult, 'dependencies'>
): string | null {
  try {
    db.transaction(() => {
      db.clearModuleDependencies();
      for (const dep of scanResult.dependencies) {
        db.insertModuleDependency({
          source_module: dep.source_module,
          target_module: dep.target_module,
          reference_count: dep.reference_count,
          sample_files: JSON.stringify(dep.sample_files),
        });
      }
    });
    return null;
  } catch (error) {
    // lux-intentional-swallow: the failure is returned as the warning the caller folds into the run.
    const reason = `Failed to write module dependencies (${errorMessage(error)})`;
    try {
      db.clearModuleDependencies();
    } catch (clearError) {
      // lux-intentional-swallow: the failure is returned as the warning the caller folds into the run.
      return (
        `${reason}, and clearing the table afterwards also failed (${errorMessage(clearError)}); ` +
        'the contents of module_dependencies are unknown until the next successful rebuild.'
      );
    }
    return `${reason}; the module dependency graph is empty until the next successful rebuild.`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
