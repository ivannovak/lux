// Structural overlay orchestration service.
//
// Single entry point for a complete overlay rebuild cycle:
//   1. Collect HEAD commit and dirty file state from git
//   2. Mark stale any fresh edges whose commit baseline has advanced
//   3. Materialize structural nodes from the scan result
//   4. Assemble AssociationContext from scan entries and enrichments
//   5. Run AssociationEngine with the enabled resolver pack
//   6. Run CapabilitySurfaceDetectors to persist surface nodes and boundary edges
//   7. Run symbolic propagation to expand surfaces to provider/consumer/artifact symbols
//
// Designed to be called after generalScan() completes, or from a dedicated
// CLI or MCP command.

import type { LuxDatabase } from '../../db/index.js';
import type { ScanResult, ScannedKnowledge } from '../types.js';
import type { EnrichmentMap } from '../lsp/index.js';
import { isGitRepository, getHeadCommit, getDirtyFiles } from '../git.js';
import { materializeNodes } from './materializer.js';
import { materializeAstSymbols } from '../ast/materialize.js';
import type { SharedExtractions } from '../ast/extraction-cache.js';
import { analyzeProgram, type ProgramAnalysisV1 } from '../adapters/program-analysis.js';
import { AstStructuralResolver } from '../ast/resolver.js';
import { buildVueComponentNodes } from '../vue/materialize.js';
import { VueEventResolver } from '../vue/event-resolver.js';
import { buildVueEventNodes } from '../vue/event-materialize.js';
import { analyzeReactContext } from '../react/association-wrapper.js';
import { toStructuralNode } from '../react/types.js';
import { analyzeExpoContext } from '../react-native/expo/association-wrapper.js';
import { analyzeNavigationContext } from '../react-native/navigation/association-wrapper.js';
import { analyzeMobileContext } from '../framework/mobile/association-wrapper.js';
import { analyzeEventBusContext } from '../framework/event-bus/association-wrapper.js';
import { analyzeContainerContext } from '../infrastructure/containers/association-wrapper.js';
import { analyzeTerraformContext } from '../infrastructure/terraform/association-wrapper.js';
import { analyzeActionsContext } from '../infrastructure/actions/association-wrapper.js';
import { analyzeGoContext } from '../go/association-wrapper.js';
import { resolveLivewire } from './framework/laravel/livewire-resolver.js';
import { NovaAssociationResolver, resolveNova } from './framework/laravel/nova-resolver.js';
import { AssociationEngine } from './engine.js';
import { createDefaultResolvers } from './framework/index.js';
import type { AssociationContext, AssociationResolver } from './types.js';
import type { CapabilitySurfaceDetector } from './detectors/types.js';
import { runDetectors } from './detectors/index.js';
import {
  createDefaultOperationalExtractors,
  runOperationalExtractors,
} from './operational/index.js';
import type { OperationalExtractor } from './operational/types.js';
import { propagateSurfaces } from './propagation.js';
import { reporterFrom, type Reporter } from '../reporter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OverlayRebuildOptions {
  /** Enable the tree-sitter AST structural tier (symbols + calls/references). Default: false. */
  astEnabled?: boolean;
  /** Include heuristic edges (default: false). */
  includeHeuristics?: boolean;
  /** Override resolver pack (default: createDefaultResolvers()). */
  resolvers?: AssociationResolver[];
  /** Validated static frontend-framework configuration. */
  frameworks?: import('../config.js').FrontendFrameworkConfigV1;
  /** Canonical source roots promoted by the existing first-party package mechanism. */
  firstPartyRoots?: readonly string[];
  /** Override detector pack (default: createDefaultDetectors()). */
  detectors?: CapabilitySurfaceDetector[];
  /** Override operational extractor pack. */
  operationalExtractors?: OperationalExtractor[];
  /** Reuse the project/parser analysis already built by the scan orchestrator. */
  programAnalysis?: ProgramAnalysisV1 & { shared: { extractions: SharedExtractions } };
  /** Progress callback. */
  onProgress?: (message: string) => void;
  /** Warning callback: a tier or detector that failed. Without it, warnings reach `onProgress`. */
  onWarning?: (message: string) => void;
  /** A ready-made Reporter, used instead of onProgress/onWarning (keeps warning components). */
  reporter?: Reporter;
}

export interface OverlayRebuildResult {
  fileNodes: number;
  symbolNodes: number;
  edgesStored: number;
  heuristicsFiltered: number;
  staleMarked: number;
  currentCommit: string | undefined;
  dirtyFileCount: number;
  surfacesDetected: number;
  surfaceEdgesStored: number;
  propagationEdgesAdded: number;
  /**
   * The shared per-rebuild AST extraction cache (Lever D), when the AST tier ran.
   * Returned so the caller's typed-receiver pass (general.ts step 8b) can reuse
   * it instead of re-parsing every file a third time.
   */
  sharedExtractions?: SharedExtractions;
  /** Contract-shaped facts, project context, diagnostics, and producer evidence. */
  programAnalysis?: ProgramAnalysisV1;
  /**
   * Phases that failed without aborting the overlay, each with how far it got and why. Their
   * partial writes are on disk, so the counts above do not describe the index; read it instead.
   */
  phaseFailures?: string[];
}

/**
 * Run a complete structural overlay rebuild.
 *
 * @param db - Database to read nodes from and write edges into.
 * @param rootPath - Absolute repository root.
 * @param scan - Completed ScanResult from GeneralScanner.
 * @param enrichments - LSP enrichment map from generalScan().
 * @param options - Rebuild options.
 */
export async function rebuildStructuralOverlay(
  db: LuxDatabase,
  rootPath: string,
  scan: ScanResult,
  enrichments: EnrichmentMap,
  options: OverlayRebuildOptions = {}
): Promise<OverlayRebuildResult> {
  const reporter = options.reporter ?? reporterFrom(options.onProgress, options.onWarning);
  const report = reporter.progress;

  // 1. Collect git state
  let currentCommit: string | undefined;
  let dirtyFiles: string[] = [];

  if (isGitRepository(rootPath)) {
    try {
      currentCommit = getHeadCommit(rootPath);
      dirtyFiles = getDirtyFiles(rootPath);
      report(`Git state: commit=${currentCommit.slice(0, 8)}, dirty=${dirtyFiles.length} file(s).`);
    } catch {
      reporter.warn('could not read git state — freshness tracking will use "unknown".');
    }
  } else {
    report('Not a git repository — freshness tracking will use "unknown".');
  }

  // 2. Mark stale edges from an earlier commit baseline
  let staleMarked = 0;
  if (currentCommit) {
    staleMarked = db.markEdgesStaleByCommit(currentCommit);
    if (staleMarked > 0) {
      report(
        `Marked ${staleMarked} edge(s) stale (commit advanced to ${currentCommit.slice(0, 8)}).`
      );
    }
  }

  // 3. Materialize structural nodes from scan output
  report('Materializing structural nodes...');
  const materialized = materializeNodes(db, scan, enrichments, rootPath);
  const fileNodes = materialized.fileNodes;
  let symbolNodes = materialized.symbolNodes;
  report(`Materialized ${fileNodes} file node(s) and ${symbolNodes} symbol node(s).`);

  // 3a. Build the shared per-rebuild AST extraction cache ONCE (Lever D), so the
  // materializer, the structural resolver, and the caller's typed-receiver pass
  // read one Extraction per file instead of re-parsing it three times. Isolated:
  // a build failure degrades to each consumer parsing on demand (cache absent).
  let sharedExtractions: SharedExtractions | undefined =
    options.programAnalysis?.shared.extractions;
  let programAnalysis: ProgramAnalysisV1 | undefined = options.programAnalysis;
  if (options.astEnabled && !programAnalysis) {
    try {
      const analysis = await analyzeProgram(scan, rootPath, reporter.warn);
      sharedExtractions = analysis.shared.extractions;
      programAnalysis = analysis;
    } catch (error) {
      reporter.warn(
        `shared AST extraction failed — ${error instanceof Error ? error.message : String(error)}`,
        'ast'
      );
    }
  }

  // 3b. AST symbol tier (default on) — supplies symbols without LSP. Isolated:
  // a tree-sitter/WASM failure here must degrade only this tier, not abort the
  // whole overlay (surfaces, propagation) for a feature the user didn't opt into.
  const phaseFailures: string[] = [];
  if (options.astEnabled) {
    report('Materializing AST symbol nodes...');
    try {
      const astNodes = await materializeAstSymbols(
        db,
        scan,
        rootPath,
        Math.floor(Date.now() / 1000),
        sharedExtractions,
        reporter.warn
      );
      symbolNodes += astNodes;
      report(`Materialized ${astNodes} AST symbol node(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The message names the phase, how far it got and why.
      reporter.warn(message, 'ast');
      phaseFailures.push(message);
    }
  }

  // 3c. Vue components must exist before render edges can reference them.
  if (programAnalysis?.vueFacts.length) {
    const vueNodes = buildVueComponentNodes(
      programAnalysis.vueFacts,
      Math.floor(Date.now() / 1000)
    );
    db.transaction(() => {
      for (const node of vueNodes) db.upsertStructuralNode(node);
    });
    symbolNodes += vueNodes.length;
    const eventNodes = buildVueEventNodes(
      new VueEventResolver({ now: () => Math.floor(Date.now() / 1000) }).resolve(
        programAnalysis.vueFacts,
        []
      ).artifacts,
      Math.floor(Date.now() / 1000)
    );
    db.transaction(() => {
      for (const node of eventNodes) db.upsertStructuralNode(node);
    });
  }

  // 4. Assemble association context
  const entries = buildContextEntries(scan, enrichments, rootPath);
  const materializedNodes = db.getStructuralNodesForFilePaths(
    scan.knowledge.map((entry) =>
      entry.filePath.startsWith(rootPath + '/')
        ? entry.filePath.slice(rootPath.length + 1)
        : entry.filePath
    )
  );

  const context: AssociationContext = {
    rootPath,
    nodes: materializedNodes,
    entries,
    currentCommit,
    dirtyFiles,
    sharedExtractions,
    programAnalysis,
  };

  // React relationships target deterministic framework nodes (components, custom hooks, contexts).
  // Materialize the complete node set before the association resolver filters exact endpoints.
  const react = await analyzeReactContext(context);
  if (react?.nodes.length) {
    const updatedAt = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const node of react.nodes) db.upsertStructuralNode(toStructuralNode(node, updatedAt));
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const expo = await analyzeExpoContext(context);
  if (expo?.nodes.length) {
    const updatedAt = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const node of expo.nodes) db.upsertStructuralNode(toStructuralNode(node, updatedAt));
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const navigation = await analyzeNavigationContext(context);
  if (navigation?.nodes.length) {
    const updatedAt = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const node of navigation.nodes)
        db.upsertStructuralNode(toStructuralNode(node, updatedAt));
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const mobile = await analyzeMobileContext(context);
  if (mobile?.nodes.length) {
    const updatedAt = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const node of mobile.nodes) db.upsertStructuralNode({ ...node, updated_at: updatedAt });
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const eventBus = await analyzeEventBusContext(context);
  if (eventBus?.nodes.length) {
    const updatedAt = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const node of eventBus.nodes) db.upsertStructuralNode(toStructuralNode(node, updatedAt));
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const containers = analyzeContainerContext(context);
  if (containers.nodes.length) {
    db.transaction(() => {
      for (const node of containers.nodes) db.upsertStructuralNode(node);
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const terraform = await analyzeTerraformContext(context);
  if (terraform.nodes.length) {
    db.transaction(() => {
      for (const node of terraform.nodes) db.upsertStructuralNode(node);
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const actions = await analyzeActionsContext(context);
  if (actions.nodes.length) {
    db.transaction(() => {
      for (const node of actions.nodes) db.upsertStructuralNode(node);
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  const go = await analyzeGoContext(context);
  if (go?.nodes.length) {
    db.transaction(() => {
      for (const node of go.nodes) db.upsertStructuralNode(node);
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  // Livewire edges target canonical Blade template nodes. Materialize those nodes before the
  // framework resolver pack runs, then refresh the context from the database so endpoint checks
  // see the exact persisted identities.
  const livewire = resolveLivewire(context, {
    config: options.frameworks?.livewire,
    now: () => Math.floor(Date.now() / 1000),
  });
  if (livewire.nodes.length) {
    db.transaction(() => {
      for (const node of livewire.nodes) db.upsertStructuralNode(node);
    });
    context.nodes = db.getStructuralNodesForFilePaths(
      scan.knowledge.map((entry) =>
        entry.filePath.startsWith(rootPath + '/')
          ? entry.filePath.slice(rootPath.length + 1)
          : entry.filePath
      )
    );
  }

  // Nova produces artifact nodes in addition to edges. Persist every node first so the
  // AssociationEngine can only store edges whose exact PHP/Vue/file endpoints already exist.
  const novaOptions = { firstPartyRoots: options.firstPartyRoots };
  const novaResolver = new NovaAssociationResolver(novaOptions);
  if (options.frameworks?.nova.enabled && novaResolver.supports(context)) {
    const nova = resolveNova(context, novaOptions);
    if (nova.nodes.length) {
      db.transaction(() => {
        for (const node of nova.nodes) db.upsertStructuralNode(node);
      });
      context.nodes = db.getStructuralNodesForFilePaths(
        scan.knowledge.map((entry) =>
          entry.filePath.startsWith(rootPath + '/')
            ? entry.filePath.slice(rootPath.length + 1)
            : entry.filePath
        )
      );
    }
  }

  // 5. Run association engine
  const resolvers =
    options.resolvers ??
    (options.astEnabled
      ? [
          ...createDefaultResolvers(options.frameworks, {
            firstPartyRoots: options.firstPartyRoots,
          }),
          new AstStructuralResolver(),
        ]
      : createDefaultResolvers(options.frameworks, {
          firstPartyRoots: options.firstPartyRoots,
        }));
  const engine = new AssociationEngine(db, resolvers, {
    includeHeuristics: options.includeHeuristics ?? false,
    reporter,
  });

  report('Running association engine...');
  const engineResult = await engine.rebuild(context);
  report(
    `Engine complete: ${engineResult.edgesStored} edge(s) stored, ` +
      `${engineResult.heuristicsFiltered} heuristic(s) filtered.`
  );

  // 6. Run capability surface detectors
  report('Running capability surface detectors...');
  const detectors = options.detectors ?? undefined; // undefined → runDetectors picks defaults
  const detectorResult = await runDetectors(db, context, detectors, reporter);
  report(
    `Detectors complete: ${detectorResult.surfacesDetected} surface(s) detected, ` +
      `${detectorResult.surfaceEdgesStored} edge(s) stored.`
  );

  // 6b. Run operational boundary extractors
  report('Running operational boundary extractors...');
  const operationalExtractorPack =
    options.operationalExtractors ?? createDefaultOperationalExtractors();
  const operationalResult = await runOperationalExtractors(
    db,
    context,
    operationalExtractorPack,
    reporter
  );
  report(
    `Operational extraction complete: ${operationalResult.boundariesStored} boundary(s), ` +
      `${operationalResult.handlersStored} handler(s), ` +
      `${operationalResult.edgesStored} edge(s), ` +
      `${operationalResult.contractsStored} contract(s).`
  );

  // 7. Run symbolic propagation from detected surfaces outward
  report('Running symbolic propagation...');
  const propagationResult = await propagateSurfaces(db, context);
  const propagationEdgesAdded =
    propagationResult.providerEdgesAdded +
    propagationResult.consumerEdgesAdded +
    propagationResult.artifactEdgesAdded;
  if (propagationEdgesAdded > 0) {
    report(
      `Propagation complete: ${propagationResult.providerEdgesAdded} provider edge(s), ` +
        `${propagationResult.consumerEdgesAdded} consumer edge(s), ` +
        `${propagationResult.artifactEdgesAdded} artifact edge(s).`
    );
  }

  return {
    fileNodes,
    symbolNodes,
    edgesStored: engineResult.edgesStored,
    heuristicsFiltered: engineResult.heuristicsFiltered,
    staleMarked,
    currentCommit,
    dirtyFileCount: dirtyFiles.length,
    surfacesDetected: detectorResult.surfacesDetected,
    surfaceEdgesStored: detectorResult.surfaceEdgesStored,
    propagationEdgesAdded,
    sharedExtractions,
    programAnalysis,
    ...(phaseFailures.length > 0 ? { phaseFailures } : {}),
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the entries array for AssociationContext.
 * Each entry carries the file path, language ID, and a metadata record
 * that includes file content (for resolver pattern matching) and any
 * LSP enrichment data.
 */
function buildContextEntries(
  scan: ScanResult,
  enrichments: EnrichmentMap,
  rootPath: string
): AssociationContext['entries'] {
  return scan.knowledge
    .filter((k) => k.type === 'source-code')
    .map((k: ScannedKnowledge) => {
      const fm = k.frontmatter;
      const languageId = fm?.language as string | undefined;
      const metadata: Record<string, unknown> = {};

      // Expose file content so resolvers can do pattern matching on it
      if (k.content) {
        metadata.content = k.content;
      }

      // Expose LSP enrichment data (symbols, definitions, references, etc.)
      const enrichment = enrichments.get(k.filePath);
      if (enrichment) {
        metadata.lsp = enrichment;
      }

      // Use relative path so resolvers can build correct node IDs
      const relPath = k.filePath.startsWith(rootPath + '/')
        ? k.filePath.slice(rootPath.length + 1)
        : k.filePath;

      return {
        filePath: relPath,
        languageId,
        metadata,
      };
    });
}
