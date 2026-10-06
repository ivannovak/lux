import { readFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { glob, globSync } from 'glob';
import type { Frontmatter, ScannedKnowledge, ScanResult } from './types.js';
import { ROWS_PER_COMMIT, writeInChunks, type LuxDatabase } from '../db/index.js';
import {
  loadLspConfig,
  type LuxLspConfig,
  type LspEnricherEntry,
  type ScanConfig,
} from './config.js';
import { EnricherRegistry, type EnrichmentMap } from './lsp/index.js';
import { mapWithConcurrency } from './lsp/pool.js';
import { PhpLspEnricher } from './lsp/php.js';
import { TypeScriptLspEnricher } from './lsp/typescript.js';
import { VueLspEnricher } from './lsp/vue.js';
import { parseImports } from './imports/index.js';
import {
  detectModuleBoundaries,
  resolveModule as resolveModuleBoundary,
} from './imports/module-boundary.js';
import { resolveProjectModule } from './project-resolution/resolver.js';
import { analyzeProgram, type ProgramAnalysisBuildV1 } from './adapters/program-analysis.js';
import {
  rebuildStructuralOverlay,
  type OverlayRebuildResult,
} from './associations/overlay-service.js';
import { AssociationEngine } from './associations/engine.js';
import { langForFile, type Extraction } from './ast/extract.js';
import { resolveTypedReceiverEdges } from './ast/lsp-resolve.js';
import { makeExternalTargetResolver } from './pack/external-resolve.js';
import { resolveFacadeAndHelperEdges } from './pack/facade-resolve.js';
import { classifyHandlerOwnership, resolveAppNamespace } from './associations/ownership.js';
import { WarningLog, warnSink, type WarnFn } from './reporter.js';
import { parseMarkdownSource, unreadableWarning } from './markdown.js';
import { canonicalScanOrder, compareCodeUnits } from './scan-order.js';
import {
  failedStartFailure,
  fileFailure,
  incompleteIndexFailure,
  lostServerFailure,
  requestIssueFailures,
  summarizeLspFailures,
  type LspEnrichmentFailure,
} from './lsp/enrichment-failures.js';

// ---------------------------------------------------------------------------
// Source Code Scanning Constants
// ---------------------------------------------------------------------------

/** File extensions to scan as source code, grouped by language. */
export const SOURCE_CODE_EXTENSIONS: string[] = [
  '.php',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rb',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.tf',
  '.tfvars',
  '.hcl',
];

/** Map file extension to language identifier. */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.php': 'php',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.hcl': 'hcl',
};

/** Directory patterns to always exclude from content and source code scanning. */
export const SOURCE_CODE_IGNORE_PATTERNS: string[] = [
  'node_modules/**',
  'vendor/**',
  '.git/**',
  '.claude/**',
  'dist/**',
  'build/**',
  'out/**',
  '.next/**',
  '.nuxt/**',
  'coverage/**',
  '__pycache__/**',
  'target/**',
  '**/*.min.js',
  '**/*.min.css',
  '.terraform/**',
  '**/*.tfstate',
  '**/*.tfstate.*',
  '**/*.tfplan',
  '**/*.auto.tfvars',
  '**/crash.log',
];

/**
 * Generated build artifacts: compiled/minified bundles and sourcemaps that are
 * a derived copy of authored source. Excluded by default (Decision 3 /
 * ADR-6 / REQ-3), but NOT dependencies — vendor/ and node_modules/ live in
 * SOURCE_CODE_IGNORE_PATTERNS and are always excluded regardless of this flag.
 */
export const GENERATED_ARTIFACT_PATTERNS: string[] = ['public/**', '**/*.bundle.js', '**/*.js.map'];

/**
 * Resolve the effective ignore set from the always-excluded built-ins plus the
 * configurable generated-artifact / extra patterns. Dependencies (vendor/,
 * node_modules/) are always in the built-in base set and can never be re-included.
 */
export function resolveIgnorePatterns(scan?: ScanConfig): string[] {
  const patterns = [...SOURCE_CODE_IGNORE_PATTERNS];
  if (scan?.excludeGeneratedArtifacts ?? true) patterns.push(...GENERATED_ARTIFACT_PATTERNS);
  if (scan?.ignorePatterns?.length) patterns.push(...scan.ignorePatterns);
  return patterns;
}

/** Manifest files whose presence indicates a source code repository. */
const SOURCE_CODE_MANIFEST_FILES: string[] = [
  'package.json',
  'composer.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Gemfile',
  'build.gradle',
  'pom.xml',
  'Makefile',
  'CMakeLists.txt',
  'setup.py',
  'requirements.txt',
];

/**
 * Detect the language identifier for a file based on its extension.
 */
export function detectLanguage(ext: string): string {
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Infer tags from a source code file path by extracting meaningful
 * directory and filename segments.
 */
export function inferTagsFromPath(filePath: string): string[] {
  const parts = filePath.split('/');
  const tags: string[] = [];

  for (const part of parts) {
    const name = part.includes('.') ? basename(part, extname(part)) : part;
    if (name && name !== 'src' && name !== 'lib' && name !== 'index') {
      tags.push(name);
    }
  }

  return tags;
}

export class GeneralScanner {
  private rootPath?: string;
  private readonly ignorePatterns: string[];

  constructor(rootPath?: string, ignorePatterns: string[] = SOURCE_CODE_IGNORE_PATTERNS) {
    this.rootPath = rootPath;
    this.ignorePatterns = ignorePatterns;
  }

  async scan(rootPath?: string): Promise<ScanResult> {
    // Allow root path to be passed to scan() or use constructor value
    const scanPath = rootPath ?? this.rootPath;
    if (!scanPath) {
      throw new Error('Root path must be provided either to constructor or scan()');
    }
    const knowledge: ScannedKnowledge[] = [];
    const warnings: Array<{ message: string; component?: string }> = [];
    const warn = warnSink((message, component) => {
      warnings.push({ message, component });
    });

    // Scan all markdown files recursively from the root, excluding vendored
    // and tooling trees (e.g. node_modules, .git, .claude worktrees) so nested
    // repo checkouts don't inject duplicate content entries.
    const mdFiles = canonicalScanOrder(
      await glob('**/*.md', { cwd: scanPath, ignore: this.ignorePatterns })
    );

    for (const mdFile of mdFiles) {
      const filePath = join(scanPath, mdFile);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch (error) {
        warn(unreadableWarning(mdFile, error), `file:${mdFile}`);
        continue;
      }
      const fileData = parseMarkdownSource(raw, mdFile, warn);

      knowledge.push({
        type: this.inferKnowledgeType(mdFile, fileData.frontmatter),
        title:
          fileData.frontmatter?.title ??
          fileData.frontmatter?.name ??
          this.extractTitleFromFilename(mdFile),
        filePath,
        tags: fileData.frontmatter?.tags,
        frontmatter: fileData.frontmatter,
        content: fileData.content,
      });
    }

    // Scan source code files if this looks like a code repository
    if (this.isSourceCodeRepository(scanPath)) {
      const sourceFiles = await this.discoverSourceCodeFiles(scanPath);

      for (const sourceFile of sourceFiles) {
        const filePath = join(scanPath, sourceFile);
        const ext = extname(sourceFile);
        const language = sourceFile.endsWith('.blade.php')
          ? 'blade'
          : (EXTENSION_TO_LANGUAGE[ext] ?? 'unknown');

        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch (error) {
          warn(unreadableWarning(sourceFile, error), `file:${sourceFile}`);
          continue;
        }

        knowledge.push({
          type: 'source-code',
          title: sourceFile,
          filePath,
          tags: this.inferTagsFromPath(sourceFile),
          frontmatter: { language, extension: ext },
          content,
        });
      }
    }

    return { knowledge, warnings };
  }

  /**
   * Check if a directory looks like a source code repository by checking
   * for common manifest/build files.
   */
  private isSourceCodeRepository(rootPath: string): boolean {
    return (
      SOURCE_CODE_MANIFEST_FILES.some((manifest) => existsSync(join(rootPath, manifest))) ||
      globSync(['**/*.tf', '**/*.hcl'], {
        cwd: rootPath,
        nodir: true,
        ignore: this.ignorePatterns,
      }).length > 0
    );
  }

  /**
   * Discover source code files in a directory, respecting ignore patterns.
   */
  private async discoverSourceCodeFiles(rootPath: string): Promise<string[]> {
    const extensionGlobs = SOURCE_CODE_EXTENSIONS.map((ext) => `**/*${ext}`);
    const files = await glob(extensionGlobs, {
      cwd: rootPath,
      ignore: this.ignorePatterns,
      nodir: true,
    });
    return canonicalScanOrder(files);
  }

  /**
   * Infer tags from a source code file path by extracting meaningful
   * directory and filename segments.
   */
  private inferTagsFromPath(filePath: string): string[] {
    const parts = filePath.split('/');
    const tags: string[] = [];

    for (const part of parts) {
      // Use directory names and the file stem (without extension)
      const name = part.includes('.') ? basename(part, extname(part)) : part;
      // Skip common uninformative segments
      if (name && name !== 'src' && name !== 'lib' && name !== 'index') {
        tags.push(name);
      }
    }

    return tags;
  }

  private slugToTitle(slug: string): string {
    return slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private extractTitleFromFilename(filename: string): string {
    const base = basename(filename, '.md');
    // Remove date prefix if present
    const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
    return this.slugToTitle(withoutDate);
  }

  private inferKnowledgeType(filePath: string, frontmatter?: Frontmatter): string {
    if (frontmatter?.type) return String(frontmatter.type);

    if (filePath.includes('methodology')) return 'methodology';
    if (filePath.includes('specs')) return 'spec';
    if (filePath.includes('architecture')) return 'architecture';
    if (filePath.includes('explorations')) return 'exploration';
    if (filePath.includes('implementation-payloads')) return 'implementation-payload';
    if (filePath.includes('payloads')) return 'payload';

    return 'general';
  }

  /**
   * Index scanned entities into the database.
   * This method takes the result of scan() and writes all entities to SQLite.
   *
   * @param db - The LuxDatabase instance to write to
   * @param scanResult - The result from scan() containing all entities
   * @returns Summary of indexed entities with counts
   */
  index(
    db: LuxDatabase,
    scanResult: ScanResult
  ): Promise<{
    knowledge: number;
  }> {
    // Validate inputs
    if (!db) {
      return Promise.reject(new Error('Database instance is required for indexing'));
    }
    if (!scanResult || typeof scanResult !== 'object') {
      return Promise.reject(new Error('Invalid scan result: must be an object'));
    }
    if (!Array.isArray(scanResult.knowledge)) {
      return Promise.reject(new Error('Invalid scan result: knowledge must be an array'));
    }

    const indexedCounts = { knowledge: 0 };

    try {
      // Index knowledge entries in bounded transactions (issue #15: a commit per entry costs a
      // rollback-journal create/sync/delete each). A failing entry stops the run; the partial index
      // reported below counts exactly the entries that committed.
      const result = writeInChunks(db, scanResult.knowledge, ROWS_PER_COMMIT, (entry) => {
        // Validate knowledge data
        if (!entry.type || typeof entry.type !== 'string') {
          throw new Error(
            `Invalid knowledge entry: missing or invalid type (file: ${entry.filePath})`
          );
        }
        if (!entry.title || typeof entry.title !== 'string') {
          throw new Error(
            `Invalid knowledge entry: missing or invalid title (file: ${entry.filePath})`
          );
        }

        try {
          db.insertKnowledgeEntry({
            type: entry.type,
            title: entry.title,
            file_path: entry.filePath,
            tags: entry.tags,
            metadata: entry.frontmatter,
            content: entry.content,
          });
        } catch (error) {
          throw new Error(
            `Failed to insert knowledge entry "${entry.title}" (${entry.filePath}): ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          );
        }
      });
      indexedCounts.knowledge = result.committed;
      if (result.error) throw result.error;

      return Promise.resolve(indexedCounts);
    } catch (error) {
      // lux-intentional-swallow: rejected just below with the partial-index context added.
      // Add context about what was successfully indexed before the error
      const partialMsg = `Partial index created: ${indexedCounts.knowledge} knowledge entries. `;
      if (error instanceof Error) {
        return Promise.reject(new Error(partialMsg + error.message));
      }
      return Promise.reject(new Error(partialMsg + String(error)));
    }
  }
}

// ---------------------------------------------------------------------------
// LSP Enrichment Pipeline
// ---------------------------------------------------------------------------

/** Enrichment results indexed by file path. Re-exported from lsp/index for convenience. */
export type { EnrichmentMap } from './lsp/index.js';

/** Aggregated module dependency ready for DB insertion. */
export interface AggregatedDependency {
  source_module: string;
  target_module: string;
  reference_count: number;
  sample_files: string[];
}

/** Result of a full scan+enrich pipeline run. */
export interface GeneralScanResult {
  /** The base scan result from GeneralScanner. */
  scan: ScanResult;
  /** LSP enrichment results keyed by file path. */
  enrichments: EnrichmentMap;
  /** Aggregated module dependencies from import parsing. */
  dependencies: AggregatedDependency[];
  /** Summary statistics. */
  stats: {
    /** Number of files that were enriched. */
    enrichedFiles: number;
    /** Number of enrichers that were initialized. */
    activeEnrichers: number;
    /** Errors encountered during enrichment (non-fatal). */
    enrichmentErrors: Array<{ filePath: string; error: string }>;
    /**
     * Everything the language servers left missing, by repo-relative path and stage
     * (lsp/enrichment-failures.ts). Empty means the LSP output is complete.
     */
    lspFailures: LspEnrichmentFailure[];
  };
  /** Structural overlay rebuild result (only present when overlayEnabled=true). */
  overlay?: OverlayRebuildResult;
  /** Why the overlay rebuild failed, when it was enabled and threw (overlay is then absent). */
  overlayError?: string;
  /** Problems the scan absorbed and carried on past (a failed tier, a detector that threw). */
  warnings: string[];
  /** The component (`detector:<name>`, `ast-file:<path>`, …) that raised each warning, by message. */
  warningComponents: Record<string, string>;
}

/** Options for the general scan pipeline. */
export interface GeneralScanOptions {
  /** Override LSP config instead of loading from lux.yaml. */
  config?: LuxLspConfig;
  /**
   * First-party package source roots to scan as app-source and merge into the
   * overlay (E1 first-party promotion). Resolved from `firstParty.packages`
   * globs against the app's composer install map. Empty ⇒ single-root (default).
   */
  firstPartyRoots?: string[];
  /** Callback for progress reporting. */
  onProgress?: (message: string) => void;
  /** Callback for enrichment errors. */
  onEnrichmentError?: (filePath: string, error: Error) => void;
  /** Database to write structural overlay into. Required when overlayEnabled=true. */
  db?: LuxDatabase;
  /** Run structural overlay rebuild after scan+enrich. Requires db option. */
  overlayEnabled?: boolean;
  /**
   * Inject a pre-built enricher registry instead of constructing one from config
   * (dependency-injection seam for tests and embedding). When provided, its
   * enrichers are still initialized, used, and shut down by the scan lifecycle.
   */
  enricherRegistry?: EnricherRegistry;
  /**
   * Absolute path to a built vendor pack DB (ADR-1). When set and overlay is
   * enabled, the pack is merged into the overlay after app materialization and
   * before boundary resolution (step 8a). Null/undefined ⇒ no merge (app-only).
   */
  vendorPackPath?: string | null;
}

/** Map of language IDs to factory functions for built-in enrichers. */
const ENRICHER_FACTORIES: Record<
  string,
  (entry: LspEnricherEntry) => PhpLspEnricher | TypeScriptLspEnricher | VueLspEnricher
> = {
  php: (entry) =>
    new PhpLspEnricher({
      serverCommand: entry.serverCommand,
      serverArgs: entry.serverArgs,
      requestTimeoutMs: entry.requestTimeoutMs,
      initTimeoutMs: entry.initTimeoutMs,
    }),
  typescript: (entry) =>
    new TypeScriptLspEnricher({
      serverCommand: entry.serverCommand,
      serverArgs: entry.serverArgs,
      requestTimeoutMs: entry.requestTimeoutMs,
      initTimeoutMs: entry.initTimeoutMs,
    }),
  vue: (entry) =>
    new VueLspEnricher({
      serverCommand: entry.serverCommand,
      serverArgs: entry.serverArgs,
      requestTimeoutMs: entry.requestTimeoutMs,
      initTimeoutMs: entry.initTimeoutMs,
    }),
};

/**
 * Max files enriched concurrently (Lever B). Aligns with the LspClient's
 * `maxOpenDocuments` cap so in-flight file reads and open documents stay bounded
 * together; the client sends the requests of those files one at a time.
 * The pack build (REQ-4, 3–6× the files) is the real beneficiary — treat this as
 * a conservative tuning knob, not a correctness parameter.
 */
const ENRICH_FILE_CONCURRENCY = 12;

/**
 * Build the typed-receiver LSP work-list (E1 follow-up #2): app source plus any
 * promoted first-party source, filtered to enrichable source-code files. First-party
 * entries are unioned only when present, so single-repo runs are byte-identical.
 * The language server (rooted at the client) resolves promoted files' kernel-internal
 * calls because the promoted package is already indexed via the client's `vendor/`.
 */
export function buildTypedReceiverEntries(
  baseKnowledge: ScannedKnowledge[],
  firstPartySource: ScannedKnowledge[]
): Array<{ filePath: string; content: string }> {
  const all = firstPartySource.length > 0 ? [...baseKnowledge, ...firstPartySource] : baseKnowledge;
  return all
    .filter((k) => k.type === 'source-code' && !!k.content && langForFile(k.filePath) !== null)
    .map((k) => ({ filePath: k.filePath, content: k.content as string }));
}

/**
 * Run the full scan-then-enrich pipeline.
 *
 * 1. Loads LSP configuration from lux.yaml (or uses provided config)
 * 2. Scans the content directory for entities
 * 3. If LSP enrichment is enabled, initializes enrichers and enriches files
 * 4. Returns combined scan + enrichment results
 *
 * LSP enrichment failures are non-fatal — the scan result is always returned
 * even if enrichment partially or fully fails.
 *
 * @param rootPath - Root path of the content directory.
 * @param options - Pipeline options.
 * @returns Combined scan and enrichment results.
 */
export async function generalScan(
  rootPath: string,
  options?: GeneralScanOptions
): Promise<GeneralScanResult> {
  const log = new WarningLog(options?.onProgress);
  const report = log.reporter.progress;
  const warn = log.reporter.warn;
  const config = options?.config ?? loadLspConfig(rootPath);

  // 1. Run the base scan (generated-artifact exclusion resolved from config — Lever A)
  report('Scanning content directory...');
  const ignore = resolveIgnorePatterns(config.scan);
  const scanner = new GeneralScanner(rootPath, ignore);
  const scan = await scanner.scan();
  for (const w of scan.warnings ?? []) warn(w.message, w.component);

  // 1a. First-party promotion (E1): scan declared first-party package roots and
  //     collect their SOURCE files. These augment the structural OVERLAY only
  //     (so a shared kernel's routes resolve to the consuming app's controllers)
  //     — NOT the content/knowledge index, which stays app-local (promoted
  //     packages carry their own markdown/build files that would collide there).
  const firstPartyRoots = options?.firstPartyRoots ?? [];
  const firstPartySource: ScannedKnowledge[] = [];
  for (const fpRoot of firstPartyRoots) {
    report(`Scanning first-party root: ${fpRoot}`);
    const fpScan = await new GeneralScanner(fpRoot, ignore).scan();
    for (const w of fpScan.warnings ?? []) warn(w.message, w.component);
    for (const k of fpScan.knowledge) {
      if (k.type === 'source-code') firstPartySource.push(k);
    }
  }

  // 2. Build the canonical project-resolution snapshot before both dependency and AST consumers.
  // The overlay reuses the same extraction facts; config parsing is data-only and root-confined.
  let projectAnalysis: ProgramAnalysisBuildV1 | undefined;
  try {
    projectAnalysis = await analyzeProgram(scan, rootPath, warn);
  } catch (error) {
    warn(
      `project resolution analysis failed — ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const dependencies = parseDependencies(scan, rootPath, config, report, projectAnalysis);

  const enrichments: EnrichmentMap = new Map();
  const errors: Array<{ filePath: string; error: string }> = [];
  const callResolutionErrors: Array<{ filePath: string; error: string }> = [];
  const incompleteIndexes: string[] = [];
  const failedEnrichers: Array<{ languageId: string; error: string }> = [];
  const startedServers = new Set<string>();
  const lostServers: LspEnrichmentFailure[] = [];
  let activeCount = 0;
  // Kept alive past enrichment so the typed-receiver LSP pass can query it.
  let activeRegistry: EnricherRegistry | null = null;

  if (!config.lsp.enabled) {
    report('LSP enrichment disabled.');
  } else {
    // 3. Build enricher registry from config (or use an injected one)
    report('Initializing LSP enrichers...');
    const registry = options?.enricherRegistry ?? buildRegistry(config.lsp.enrichers, warn);

    if (registry.size === 0) {
      report('No LSP enrichers configured.');
    } else {
      // 4. Initialize enrichers
      const workspaceRoot = config.lsp.workspaceRoot ?? rootPath;

      for (const enricher of registry.getAll()) {
        try {
          report(`Initializing ${enricher.languageId} enricher...`);
          await enricher.initialize(workspaceRoot);
          activeCount++;
          startedServers.add(enricher.languageId);
          if (enricher.indexIncomplete) {
            incompleteIndexes.push(enricher.languageId);
            report(
              `${enricher.languageId} enricher was still indexing the workspace after ` +
                `${enricher.config.initTimeoutMs}ms.`
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failedEnrichers.push({ languageId: enricher.languageId, error: message });
          warn(
            `Failed to initialize ${enricher.languageId} enricher: ${message}`,
            `enricher:${enricher.languageId}`
          );
        }
      }

      activeRegistry = registry;

      // 5. Collect enrichable files from scan results
      const filesToEnrich = collectEnrichableFiles(scan, registry);
      report(`Found ${filesToEnrich.size} files to enrich across ${activeCount} enrichers.`);

      // 6. Run enrichment (bounded-parallel — Lever B). The refcounted document
      //    lease + open-document semaphore in LspClient make this safe; a naive
      //    Promise.all would flush every didOpen past the request semaphore and
      //    let one file's didClose close a URI another op is mid-request on.
      //
      //    NOTE (Lever C, deferred per CANONICAL-DECISIONS §8): the combined-open
      //    warmth micro-optimization — running this enrichment pass and the
      //    step-8b typed-receiver pass against ONE document open per file — is
      //    deferred. It conflicts with Phase-3's step-8a merge sequencing (the
      //    typed-receiver pass must stay AFTER materialization + merge). Lever A
      //    alone meets the REQ-3 app-build target; B+D+E carry the rest.
      for (const [languageId, filePaths] of filesToEnrich) {
        const enricher = registry.get(languageId);
        if (!enricher?.isReady) {
          // A server that started and died before its files came up leaves the whole language
          // without LSP data; skipping it without a record would read as complete output.
          const lost = enricher && lostServerFailure(enricher, startedServers);
          if (lost) lostServers.push(lost);
          continue;
        }

        report(`Enriching ${filePaths.length} ${languageId} files (bounded parallel)...`);

        await mapWithConcurrency(filePaths, ENRICH_FILE_CONCURRENCY, async (filePath) => {
          try {
            const result = await enricher.enrich(filePath);
            if (result) {
              // Safe under the single-threaded event loop — no shared-index write.
              enrichments.set(filePath, result);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ filePath, error: message });
            options?.onEnrichmentError?.(
              filePath,
              error instanceof Error ? error : new Error(message)
            );
          }
        });
      }
    }
  }

  report(`Enrichment complete: ${enrichments.size} files enriched, ${errors.length} errors.`);

  // 8. Optionally rebuild structural overlay
  let overlay: OverlayRebuildResult | undefined;
  let overlayError: string | undefined;
  if (options?.overlayEnabled && options.db) {
    report('Rebuilding structural overlay...');
    try {
      // First-party source augments the overlay scan only (app-local knowledge
      // index is unchanged — see step 1a).
      const overlayScan =
        firstPartySource.length > 0
          ? { ...scan, knowledge: [...scan.knowledge, ...firstPartySource] }
          : scan;
      overlay = await rebuildStructuralOverlay(options.db, rootPath, overlayScan, enrichments, {
        reporter: log.reporter,
        astEnabled: config.ast?.enabled ?? true,
        // A promoted first-party overlay has a larger source universe than the app-only dependency
        // analysis above; let the overlay build one complete context rather than reusing a partial one.
        programAnalysis: firstPartySource.length === 0 ? projectAnalysis : undefined,
        frameworks: config.frameworks,
        firstPartyRoots,
      });
      report(
        `Overlay complete: ${overlay.fileNodes} file node(s), ${overlay.symbolNodes} symbol node(s), ` +
          `${overlay.edgesStored} edge(s) stored.`
      );
    } catch (error) {
      overlayError = error instanceof Error ? error.message : String(error);
      // lux-intentional-swallow: the rebuild's classification reports it as a warning, with the
      // file and symbol nodes the failed rebuild left on disk.
    }
  }

  // 8a. Merge the vendor pack (ADR-2). Runs AFTER app materialization (step 8, so
  //     capability-surface propagation ran on the clean app-only graph) and
  //     BEFORE boundary resolution (step 8b needs the merged vendor nodes present
  //     to resolve into). clearOverlay() wiped any prior merge at the top of this
  //     rebuild, so the merge RECURS — re-applied here every rebuild. App nodes
  //     from step 8 win on FQN-id collision (importVendorPack is INSERT OR IGNORE).
  if (overlay && options?.db && options?.vendorPackPath) {
    report('Merging vendor pack into overlay...');
    try {
      const merged = options.db.importVendorPack(options.vendorPackPath);
      report(`Vendor pack merged: ${merged.nodes} node(s), ${merged.edges} edge(s).`);
    } catch (error) {
      warn(`vendor pack merge failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 8b. LSP-resolve typed-receiver cross-file calls while the registry is alive.
  if (
    overlay &&
    options?.db &&
    (config.ast?.enabled ?? true) &&
    activeRegistry &&
    activeCount > 0
  ) {
    report('Resolving typed-receiver cross-file calls via LSP...');
    try {
      const reg = activeRegistry;
      // First-party promotion (E1 follow-up #2): include promoted first-party source
      // in the work-list so kernel-INTERNAL calls (a promoted controller → a promoted
      // service) are offered for resolution. The language server, rooted at the client,
      // already indexes the kernel via the client's vendor/ (the promoted package is a
      // composer dependency), so a single-root server resolves these — no multi-root
      // workspace needed (validated by spike). Their extractions are already in the
      // shared cache (built from overlayScan).
      const astEntries = buildTypedReceiverEntries(scan.knowledge, firstPartySource);
      // Upgraded per CANONICAL-DECISIONS §8: pooled per-file loop + one warm
      // document open per file (Lever B), reusing the overlay's shared extraction
      // cache (Lever D) so this pass never re-parses. Still a DISTINCT pass after
      // materialization — the step 8a merge above runs ahead of it.
      // When a vendor pack was merged (step 8a), the boundary resolver turns
      // app→vendor calls (formerly dropped) into proven edges into merged nodes.
      const resolveExternalTarget = options.vendorPackPath
        ? makeExternalTargetResolver(options.db, rootPath)
        : undefined;
      const edges = await resolveTypedReceiverEdges(
        astEntries,
        rootPath,
        (fp, line, char) => reg.resolveDefinition(fp, line, char),
        Math.floor(Date.now() / 1000),
        {
          resolveInFile: (fp, positions) => reg.resolveDefinitionsInFile(fp, positions),
          sharedExtractions: overlay.sharedExtractions,
          concurrency: ENRICH_FILE_CONCURRENCY,
          resolveExternalTarget,
          symbolCollisions: overlay.symbolCollisions,
          onTransientFailure: (filePath, error) =>
            callResolutionErrors.push({ filePath, error: error.message }),
        }
      );
      const stored = AssociationEngine.persistEdges(options.db, edges);
      report(`Typed-receiver resolution: ${stored} edge(s) stored.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The whole pass is lost, not one file: recorded once for the workspace.
      callResolutionErrors.push({ filePath: '.', error: message });
      warn(`typed-receiver resolution failed — ${message}`);
    }
  }

  // 8c. Resolve facade-static + bare-helper calls against the framework catalogs
  //     (framework-inferred, driver-aware, CONTINUING). Needs step 8a's merged pack for
  //     the service/driver target nodes and the shared extraction cache (Lever D). It is
  //     disjoint from step 8b's `proven` edges BY CONSTRUCTION — not by running after it:
  //     the catalog is __callStatic-only (ADR-7), so a real-static call 8b resolves is
  //     never in it, and every catalog edge id carries a distinct `:facade-catalog` /
  //     `:helper-catalog` suffix so it cannot collide with an 8b `:lsp` edge on the same
  //     node pair. contentOnly / no-pack rebuilds skip it and behaviour is unchanged (REQ-5).
  if (overlay?.sharedExtractions && options?.db && options?.vendorPackPath) {
    report('Resolving facade & helper calls against the framework catalog...');
    try {
      const files: Array<{ relPath: string; extraction: Extraction }> = [];
      for (const [relPath, extraction] of overlay.sharedExtractions) {
        if (langForFile(relPath) === 'php') files.push({ relPath, extraction });
      }
      const edges = resolveFacadeAndHelperEdges(
        files,
        options.db,
        Math.floor(Date.now() / 1000),
        overlay.symbolCollisions
      );
      const stored = AssociationEngine.persistEdges(options.db, edges);
      report(`Facade & helper resolution: ${stored} edge(s) stored.`);
    } catch (error) {
      // Log the full error (stack, not just .message) so a genuine resolver fault is
      // distinguishable from the benign "0 edges to resolve" success path above.
      warn(
        `facade & helper resolution failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    }
  }

  // 8d. Classify HTTP handler-edge ownership across the app/kernel boundary (E1).
  //     Runs after all node materialization (overlay + pack merge + facade) so
  //     'external' (third-party, absent) is distinguished from 'client-gap' (an
  //     App\* route the client doesn't implement). Most meaningful with first-party
  //     promotion — the app/kernel boundary only exists when a first-party kernel is
  //     promoted, so the pass is gated on that (also avoids a per-rebuild cost single-repo).
  if (overlay && options?.db && firstPartyRoots.length > 0) {
    try {
      const summary = classifyHandlerOwnership(options.db, resolveAppNamespace(rootPath, warn));
      report(
        `Handler ownership: ${summary.counts['kernel-owned']} kernel-owned, ` +
          `${summary.counts['client-override']} client-override, ` +
          `${summary.counts['client-gap']} client-gap, ${summary.counts.external} external.`
      );
    } catch (error) {
      warn(
        `ownership classification failed — ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 8e. Collect what the language servers left missing, and say so once per stage: a run with any
  //     recorded failure must close on a warning, not read as complete.
  const toRelative = (absolutePath: string): string =>
    absolutePath.startsWith(rootPath + '/')
      ? absolutePath.slice(rootPath.length + 1)
      : absolutePath;
  const lspFailures: LspEnrichmentFailure[] = [
    ...failedEnrichers.map((failure) => failedStartFailure(failure.languageId, failure.error)),
    ...lostServers,
    ...incompleteIndexes.map(incompleteIndexFailure),
    ...errors.map((error) => fileFailure(toRelative(error.filePath), 'symbols', error.error)),
    ...callResolutionErrors.map((error) =>
      fileFailure(toRelative(error.filePath), 'calls', error.error)
    ),
    ...requestIssueFailures(activeRegistry?.drainRequestIssues() ?? [], toRelative),
  ];
  for (const line of summarizeLspFailures(lspFailures)) warn(line, 'lsp-output');

  // 9. Shut down LSP enrichers (kept alive through the overlay + typed-receiver pass).
  if (activeRegistry) {
    report('Shutting down LSP enrichers...');
    try {
      await activeRegistry.shutdownAll();
    } catch (error) {
      warn(`enricher shutdown errors: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    scan,
    enrichments,
    dependencies,
    stats: {
      enrichedFiles: enrichments.size,
      activeEnrichers: activeCount,
      enrichmentErrors: errors,
      lspFailures,
    },
    overlay,
    ...(overlayError !== undefined ? { overlayError } : {}),
    warnings: log.messages,
    warningComponents: log.components,
  };
}

/**
 * Build an EnricherRegistry from lux.yaml enricher entries.
 * Only creates enrichers for known language IDs with enabled=true.
 *
 * Exported (T3a.1) so the scoped overlay-refresh engine (spec 13 Part F `runLspTier`)
 * reuses the exact same registry construction rather than forking it.
 */
export function buildRegistry(entries: LspEnricherEntry[], warn?: WarnFn): EnricherRegistry {
  const registry = new EnricherRegistry();

  for (const entry of entries) {
    if (entry.enabled === false) continue;

    const factory = ENRICHER_FACTORIES[entry.languageId];
    if (!factory) {
      // Previously a bare `continue`. A configured enricher then vanished with no
      // error and no warning, and the index simply carried no symbols for that
      // language — a result indistinguishable from a repository that has none.
      warn?.(
        `LSP enricher for "${entry.languageId}" was configured but is not supported and has been ` +
          `skipped. Supported language ids: ${Object.keys(ENRICHER_FACTORIES).sort().join(', ')}.`
      );
      continue;
    }

    if (entry.maxConcurrency !== undefined) {
      warn?.(
        `lsp.enrichers "${entry.languageId}": max_concurrency is no longer used and can be removed. ` +
          'Requests are sent to a language server one at a time, so that request_timeout_ms ' +
          "measures the server's work on a request and not the time it spent queued."
      );
    }

    try {
      const enricher = factory(entry);
      registry.register(enricher);
    } catch (error) {
      warn?.(
        `LSP enricher for "${entry.languageId}" could not be created and has been skipped: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return registry;
}

/**
 * Collect files from scan results that match registered enrichers.
 * Groups file paths by language ID for batch processing.
 */
function collectEnrichableFiles(
  scan: ScanResult,
  registry: EnricherRegistry
): Map<string, string[]> {
  const filesByLanguage = new Map<string, string[]>();
  const supportedExtensions = new Set(registry.getSupportedExtensions());

  // Collect all file paths from scan results
  const allFiles: string[] = [];

  for (const entry of scan.knowledge) {
    allFiles.push(entry.filePath);
  }

  // Group by enricher language ID
  for (const filePath of allFiles) {
    const ext = extname(filePath);
    if (!ext || !supportedExtensions.has(ext)) continue;

    const enricher = registry.getByExtension(ext);
    if (!enricher) continue;

    const existing = filesByLanguage.get(enricher.languageId);
    if (existing) {
      existing.push(filePath);
    } else {
      filesByLanguage.set(enricher.languageId, [filePath]);
    }
  }

  return filesByLanguage;
}

/** Files kept per module dependency: the first ones by path, so the choice is reproducible. */
const MODULE_DEPENDENCY_SAMPLE_SIZE = 5;

/**
 * Parse imports from scanned source files and aggregate into module-level dependencies.
 *
 * This runs independently of LSP enrichment — it only needs file content (already in memory).
 */
function parseDependencies(
  scan: ScanResult,
  rootPath: string,
  config: LuxLspConfig,
  report: (msg: string) => void,
  programAnalysis?: ProgramAnalysisBuildV1
): AggregatedDependency[] {
  if (!config.deps?.enabled) {
    return [];
  }

  // Detect module boundaries
  const boundaryConfig = config.deps.moduleBoundary
    ? { patterns: [config.deps.moduleBoundary] }
    : undefined;
  const patterns = detectModuleBoundaries(rootPath, boundaryConfig);

  if (patterns.length === 0) {
    return [];
  }

  report(`Detected module boundaries: ${patterns.join(', ')}`);

  // Aggregate: (sourceModule, targetModule) → { count, files }. Every referencing file is kept so
  // the sample can be chosen by path, not by which files the scan happened to reach first.
  const depMap = new Map<string, { count: number; files: Set<string> }>();

  const sourceEntries = scan.knowledge.filter((k) => k.type === 'source-code');
  const sourceFiles =
    programAnalysis?.project.sourceFiles ??
    new Set(
      sourceEntries.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  let parsedCount = 0;

  for (const entry of sourceEntries) {
    if (!entry.content) continue;

    const lang = (entry.frontmatter as Record<string, unknown>)?.language as string | undefined;
    if (!lang) continue;

    const sourceModule = resolveModuleBoundary(entry.filePath, rootPath, patterns);
    if (!sourceModule) continue;

    const imports = parseImports(entry.content, lang, { includeExternal: true });
    if (imports.length === 0) continue;

    parsedCount++;

    for (const imp of imports) {
      // Try to resolve the import to a target module
      // For PHP: map namespace segments to file path heuristic
      // For TS/JS: resolve relative paths against source file
      const targetModule = resolveImportToModule(
        imp.rawImport,
        entry.filePath,
        rootPath,
        patterns,
        lang,
        sourceFiles,
        imp.mode,
        programAnalysis
      );
      if (!targetModule || targetModule === sourceModule) continue;

      const key = `${sourceModule}\0${targetModule}`;
      const existing = depMap.get(key);
      if (existing) {
        existing.count++;
        existing.files.add(entry.filePath);
      } else {
        depMap.set(key, { count: 1, files: new Set([entry.filePath]) });
      }
    }
  }

  if (parsedCount > 0) {
    report(
      `Parsed imports from ${parsedCount} source files, found ${depMap.size} module dependencies`
    );
  }

  return Array.from(depMap.entries()).map(([key, val]) => {
    const [source_module, target_module] = key.split('\0');
    return {
      source_module,
      target_module,
      reference_count: val.count,
      sample_files: [...val.files].sort(compareCodeUnits).slice(0, MODULE_DEPENDENCY_SAMPLE_SIZE),
    };
  });
}

/**
 * Attempt to resolve an import path to a target module name.
 *
 * For PHP: maps namespace segments (e.g. App\Module\Users\Service) to directory
 * patterns by matching namespace prefixes against module boundary patterns.
 *
 * For JS/TS: resolves relative paths against the source file's location and
 * then applies module boundary resolution.
 */
function resolveImportToModule(
  rawImport: string,
  sourceFilePath: string,
  rootPath: string,
  patterns: string[],
  language: string,
  sourceFiles: ReadonlySet<string>,
  mode: 'import' | 'require' | 'reexport' | 'dynamic-import' = 'import',
  programAnalysis?: ProgramAnalysisBuildV1
): string | null {
  if (language === 'php') {
    return resolvePhpNamespaceToModule(rawImport, rootPath, patterns);
  }

  if (language === 'typescript' || language === 'javascript') {
    const importerFile = sourceFilePath.startsWith(rootPath + '/')
      ? sourceFilePath.slice(rootPath.length + 1)
      : sourceFilePath;
    const resolution = programAnalysis
      ? resolveProjectModule({ importerFile, specifier: rawImport, mode }, programAnalysis.project)
      : resolveProjectModule(
          { importerFile, specifier: rawImport, mode },
          {
            rootPath,
            sourceFiles,
            aliases: [],
            workspacePackages: [],
            exportsByFile: new Map(),
            fingerprintInputs: [],
          }
        );
    if (resolution.status !== 'resolved') return null;
    return resolveModuleBoundary(join(rootPath, resolution.targetFile), rootPath, patterns);
  }

  return null;
}

/**
 * Map a PHP namespace to a module by trying multiple resolution strategies:
 * 1. Direct namespace-to-path mapping
 * 2. Extract module name from namespace segments that match pattern structure
 */
function resolvePhpNamespaceToModule(
  namespace: string,
  rootPath: string,
  patterns: string[]
): string | null {
  const segments = namespace.replace(/\\/g, '/').split('/');

  // Strategy 1: Direct path mapping
  const asPath = segments.join('/');
  const fakePath = join(rootPath, asPath + '.php');
  const direct = resolveModuleBoundary(fakePath, rootPath, patterns);
  if (direct) return direct;

  // Strategy 2: For each pattern, try to match namespace segments
  // e.g. pattern "src/Module/{name}" has depth 2 before {name}
  // namespace "App\Module\Users\Service" — try matching from each offset
  for (const pattern of patterns) {
    const nameIndex = pattern.indexOf('{name}');
    if (nameIndex === -1) continue;

    const patternPrefix = pattern.slice(0, nameIndex);
    const patternParts = patternPrefix.split('/').filter((p) => p.length > 0);
    const patternDepth = patternParts.length;

    // Strategy 2a (namespace-prefix-aware): a module directory may sit under
    // a namespace prefix that is DEEPER than the filesystem pattern prefix.
    // e.g. files live at "src/Module/{Name}" (prefix depth 2) but the PHP
    // namespace is "Acme\\Core\\Module\\{Name}\\..." (module name at
    // depth 3). Anchor on the last literal segment of the pattern prefix
    // (e.g. "Module") and take the namespace segment immediately after it,
    // wherever it occurs — instead of assuming a fixed segment index. The
    // constructed module directory is verified to actually exist, which
    // also filters out vendor namespaces (Illuminate\*, Spatie\*, Carbon\*)
    // that would otherwise resolve to phantom modules.
    const anchor = patternParts[patternParts.length - 1];
    if (anchor) {
      const anchorIndex = segments.lastIndexOf(anchor);
      if (anchorIndex !== -1 && anchorIndex + 1 < segments.length) {
        const moduleName = segments[anchorIndex + 1];
        if (existsSync(join(rootPath, patternPrefix, moduleName))) {
          const constructedPath = join(rootPath, patternPrefix, moduleName, 'dummy.php');
          const resolved = resolveModuleBoundary(constructedPath, rootPath, patterns);
          if (resolved) return resolved;
        }
      }
    }

    // Strategy 2b (fixed-index fallback): original behaviour for repos whose
    // namespace depth matches the filesystem pattern depth. Also existence-
    // verified so non-module namespaces do not produce phantom modules.
    if (segments.length > patternDepth) {
      const moduleName = segments[patternDepth];
      if (existsSync(join(rootPath, patternPrefix, moduleName))) {
        // Verify this forms a valid path under the pattern
        const constructedPath = join(rootPath, patternPrefix, moduleName, 'dummy.php');
        const resolved = resolveModuleBoundary(constructedPath, rootPath, patterns);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

/**
 * Attach enrichment data to a scanned knowledge entry's frontmatter.
 * Merges the enrichment result into frontmatter.lsp for downstream
 * storage in the database metadata field.
 *
 * @param entry - The scanned knowledge entry to enrich.
 * @param enrichments - Map of file path to enrichment results.
 * @returns The entry with lsp data merged into frontmatter, or unchanged.
 */
export function attachEnrichment(
  entry: ScannedKnowledge,
  enrichments: EnrichmentMap
): ScannedKnowledge {
  const enrichment = enrichments.get(entry.filePath);
  if (!enrichment) return entry;

  const ext = enrichment as unknown as Record<string, unknown>;

  return {
    ...entry,
    frontmatter: {
      ...entry.frontmatter,
      lsp: {
        symbols: enrichment.symbols,
        diagnostics: enrichment.diagnostics,
        definitions: enrichment.definitions,
        references: ext['references'] as unknown[] | undefined,
        typeHierarchy: ext['typeHierarchy'] as unknown[] | undefined,
        enrichedAt: enrichment.enrichedAt,
        languageId: enrichment.languageId,
      },
    },
  };
}
