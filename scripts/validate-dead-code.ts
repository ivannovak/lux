#!/usr/bin/env npx tsx
/**
 * Dead code validator — detects unused exports across the codebase.
 *
 * Scans all source files for exported symbols, then checks whether each export
 * is referenced by at least one other file. Exports with no external references
 * are reported as potentially dead code.
 *
 * Exclusions:
 *   - Entry point files (bin targets) — their exports are consumed externally
 *   - Test files (__tests__/) — their exports are consumed by the test runner
 *   - Test file imports DO count as usage (an export used only in tests is alive)
 *
 * Usage:
 *   npx tsx scripts/validate-dead-code.ts [--json] [--verbose]
 *
 * Exit codes:
 *   0 — no unused exports found
 *   1 — unused exports detected
 */

import { Project, type SourceFile, type ExportedDeclarations, SyntaxKind, Node } from 'ts-morph';
import { resolve, relative } from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const SRC = resolve(ROOT, 'src');

/**
 * Entry point files whose exports are consumed externally (CLI, MCP server).
 * Relative to src/.
 */
const ENTRY_POINTS = new Set(['index.ts', 'cli/index.ts', 'mcp/server.ts']);

/**
 * Files that are barrel re-exports consumed by entry points.
 * Their exports are transitively entry-point exports.
 */
const ENTRY_ADJACENT = new Set([
  'scanner/index.ts',
  'scanner/lsp/index.ts',
  // Frozen Tranche 2 identities are public cross-phase contracts; some are consumed only after
  // their dependent phases land, so they intentionally precede their first source import.
  'scanner/identity/program-identity.ts',
]);

/**
 * Modules loaded only via a dynamic `import()` expression, invisible to this validator's static
 * import graph (buildImportGraph reads static import/export-from declarations, not `import()` call
 * expressions). Their exports are live at runtime but would otherwise be reported as unused.
 *
 * Relative to src/. Documented per entry so a future reader sees WHY it is exempt:
 *   - scanner/embeddings/wasm-local-embedder.ts — its `WasmLocalEmbedder` class is loaded solely via
 *     `createEmbedder`'s `await import('./wasm-local-embedder.js')` (scanner/embeddings/embedder.ts),
 *     kept behind a dynamic import so the heavy onnxruntime-web weight never eagerly loads. The
 *     static graph cannot see that edge, so the class is a dead-code false positive here.
 */
const DYNAMIC_IMPORT_MODULES = new Set(['scanner/embeddings/wasm-local-embedder.ts']);

/**
 * Third-party code copied into src/. Its exports are the upstream package's API, not Lux's, and
 * are reached as members of an `export =` namespace (`sqlite.Database`), which the static import
 * graph does not follow. src/db/vendor/node-sqlite3-wasm/README.md says what is vendored and why.
 * Relative to src/.
 */
const VENDORED_DIR = 'db/vendor/';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UnusedExport {
  file: string;
  line: number;
  exportName: string;
  kind: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTestFile(filePath: string): boolean {
  return filePath.includes('__tests__');
}

function isEntryPoint(filePath: string): boolean {
  const rel = relative(SRC, filePath).replace(/\\/g, '/');
  return ENTRY_POINTS.has(rel);
}

function isEntryAdjacent(filePath: string): boolean {
  const rel = relative(SRC, filePath).replace(/\\/g, '/');
  return ENTRY_ADJACENT.has(rel);
}

function isDynamicImportModule(filePath: string): boolean {
  const rel = relative(SRC, filePath).replace(/\\/g, '/');
  return DYNAMIC_IMPORT_MODULES.has(rel);
}

function isVendored(filePath: string): boolean {
  return relative(SRC, filePath).replace(/\\/g, '/').startsWith(VENDORED_DIR);
}

function getExportKind(declarations: ExportedDeclarations[]): string {
  if (declarations.length === 0) return 'unknown';
  const decl = declarations[0];
  const kind = decl.getKind();

  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
      return 'function';
    case SyntaxKind.ClassDeclaration:
      return 'class';
    case SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case SyntaxKind.TypeAliasDeclaration:
      return 'type';
    case SyntaxKind.VariableDeclaration:
      return 'const';
    case SyntaxKind.EnumDeclaration:
      return 'enum';
    default:
      return 'declaration';
  }
}

function getExportLine(declarations: ExportedDeclarations[]): number {
  if (declarations.length === 0) return 0;
  return declarations[0].getStartLineNumber();
}

// ---------------------------------------------------------------------------
// Import graph builder
// ---------------------------------------------------------------------------

interface ImportRecord {
  /** The importing file (absolute path). */
  importer: string;
  /** The resolved target file (absolute path). */
  target: string;
  /** Named imports (empty = namespace/side-effect import). */
  names: Set<string>;
  /** Whether this is a namespace import (import * as X). */
  isNamespace: boolean;
}

function buildImportGraph(project: Project): ImportRecord[] {
  const records: ImportRecord[] = [];

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const rel = relative(SRC, filePath);
    if (rel.startsWith('..')) continue; // outside src/

    for (const decl of sf.getImportDeclarations()) {
      const moduleSpecifier = decl.getModuleSpecifierValue();
      if (!moduleSpecifier.startsWith('.')) continue; // skip external packages

      const targetFile = decl.getModuleSpecifierSourceFile();
      if (!targetFile) continue;

      const names = new Set<string>();
      let isNamespace = false;

      // Named imports: import { Foo, Bar } from '...'
      for (const named of decl.getNamedImports()) {
        // Use the original name (not alias) for matching
        const name = named.getAliasNode() ? named.getNameNode().getText() : named.getName();
        names.add(name);
      }

      // Default import: import Foo from '...'
      const defaultImport = decl.getDefaultImport();
      if (defaultImport) {
        names.add('default');
      }

      // Namespace import: import * as Foo from '...'
      const namespaceImport = decl.getNamespaceImport();
      if (namespaceImport) {
        isNamespace = true;
      }

      records.push({
        importer: filePath,
        target: targetFile.getFilePath(),
        names,
        isNamespace,
      });
    }

    // Also handle export-from declarations: export { Foo } from './bar.js'
    for (const exportDecl of sf.getExportDeclarations()) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue();
      if (!moduleSpecifier) continue; // export { local } without from
      if (!moduleSpecifier.startsWith('.')) continue;

      const targetFile = exportDecl.getModuleSpecifierSourceFile();
      if (!targetFile) continue;

      const names = new Set<string>();
      let isNamespace = false;

      const namedExports = exportDecl.getNamedExports();
      if (namedExports.length > 0) {
        for (const named of namedExports) {
          const name = named.getAliasNode() ? named.getNameNode().getText() : named.getName();
          names.add(name);
        }
      } else {
        // export * from '...' — counts as namespace
        isNamespace = true;
      }

      records.push({
        importer: filePath,
        target: targetFile.getFilePath(),
        names,
        isNamespace,
      });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Usage analysis
// ---------------------------------------------------------------------------

/**
 * Build a map: (filePath, exportName) → number of external references.
 */
function analyzeUsage(
  project: Project,
  importGraph: ImportRecord[]
): Map<string, Map<string, number>> {
  // Map<filePath, Map<exportName, refCount>>
  const usage = new Map<string, Map<string, number>>();

  // Initialize usage map for all source files
  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const rel = relative(SRC, filePath);
    if (rel.startsWith('..')) continue;

    const exports = sf.getExportedDeclarations();
    const exportMap = new Map<string, number>();
    for (const [name] of exports) {
      exportMap.set(name, 0);
    }
    usage.set(filePath, exportMap);
  }

  // Count imports
  for (const record of importGraph) {
    const targetUsage = usage.get(record.target);
    if (!targetUsage) continue;

    if (record.isNamespace) {
      // Namespace import — all exports of the target are considered used
      for (const name of targetUsage.keys()) {
        targetUsage.set(name, (targetUsage.get(name) ?? 0) + 1);
      }
    } else {
      for (const name of record.names) {
        if (targetUsage.has(name)) {
          targetUsage.set(name, (targetUsage.get(name) ?? 0) + 1);
        }
      }
    }
  }

  return usage;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const verbose = args.includes('--verbose');

  const project = new Project({
    tsConfigFilePath: resolve(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
  });

  const importGraph = buildImportGraph(project);
  const usage = analyzeUsage(project, importGraph);

  const unused: UnusedExport[] = [];
  let totalExports = 0;
  let filesAnalyzed = 0;

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const rel = relative(SRC, filePath).replace(/\\/g, '/');

    // Skip files outside src/
    if (rel.startsWith('..')) continue;

    // Skip test files — their exports are consumed by the test runner
    if (isTestFile(filePath)) continue;

    // Skip entry points — their exports are consumed externally
    if (isEntryPoint(filePath)) continue;

    // Skip entry-adjacent barrel files — they re-export for entry points
    if (isEntryAdjacent(filePath)) continue;

    // Skip modules loaded only via dynamic import() — invisible to the static import graph
    if (isDynamicImportModule(filePath)) continue;

    // Skip vendored third-party code
    if (isVendored(filePath)) continue;

    filesAnalyzed++;

    const exports = sf.getExportedDeclarations();
    const fileUsage = usage.get(filePath);

    for (const [name, declarations] of exports) {
      totalExports++;
      const refCount = fileUsage?.get(name) ?? 0;

      if (refCount === 0) {
        // Skip type-only exports (interfaces, type aliases) — they have zero
        // runtime cost and form part of the public API contract for consumers.
        const kind = getExportKind(declarations);
        if (kind === 'interface' || kind === 'type') continue;

        unused.push({
          file: `src/${rel}`,
          line: getExportLine(declarations),
          exportName: name,
          kind,
          message: `Export "${name}" (${kind}) is not imported by any other file`,
        });
      }
    }
  }

  if (jsonOutput) {
    const output = {
      unused,
      summary: {
        totalExports,
        usedExports: totalExports - unused.length,
        unusedExports: unused.length,
        filesAnalyzed,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (unused.length === 0) {
      console.log(
        `Dead code check passed. ${totalExports} exports across ${filesAnalyzed} files, all referenced.`
      );
    } else {
      console.error(`\nUnused exports found:\n`);
      for (const u of unused) {
        console.error(`  ${u.file}:${u.line}`);
        console.error(`    ${u.kind} "${u.exportName}" — not imported by any other file`);
        console.error('');
      }
      console.error(
        `${unused.length} unused export(s) across ${filesAnalyzed} files (${totalExports} total exports).`
      );
    }

    if (verbose) {
      console.log(`\nFiles analyzed: ${filesAnalyzed}`);
      console.log(`Entry points excluded: ${ENTRY_POINTS.size}`);
      console.log(`Entry-adjacent barrels excluded: ${ENTRY_ADJACENT.size}`);
      console.log(`Import records: ${importGraph.length}`);
    }
  }

  process.exit(unused.length > 0 ? 1 : 0);
}

main();
