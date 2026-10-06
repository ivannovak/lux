// Scoped overlay refresh engine (Phase 3a / spec 13 Parts E + F).
//
// refreshOverlayScoped re-derives only the changed files and their reverse-import closure,
// contractually equivalent to a full rebuild on a divergence-sensitive slice (the equivalence
// oracle, spec 14). It is built entirely on existing rebuild primitives + the shipped
// deltaChunkedIn layer — no whole-repo scan.
//
// The correctness properties (Decision 13), realized WITHOUT a single literal SQL transaction
// spanning the async LSP/resolver tiers (unachievable on the WASM adapter — the full rebuild
// itself uses per-step transactions):
//   1. Soundness — all of R's nodes are materialized BEFORE the single resolver pass whose
//      entries are exactly R, so a co-changed A↔B resolves against both fresh symbols (the reason
//      it must NOT be a per-file loop).
//   2. Crash floor — a committed mark-before-repair fence writes the whole victim set
//      dirty-dependent BEFORE any deletion, so a crash leaves marks, never a partially-fresh lie.

import type { LuxDatabase } from '../../db/index.js';
import type { LuxLspConfig } from '../config.js';
import type { ScanResult, ScannedKnowledge } from '../types.js';
import type { AssociationContext, StructuralRelationEdge } from './types.js';
import type { EnrichmentMap } from '../lsp/index.js';
import type { Extraction } from '../ast/extract.js';
import type { SharedExtractions } from '../ast/extraction-cache.js';
import { analyzeProgram, type ProgramAnalysisV1 } from '../adapters/program-analysis.js';
import { getHeadCommit, isGitRepository } from '../git.js';
import { materializeNodes } from './materializer.js';
import { materializeAstSymbols } from '../ast/materialize.js';
import { buildVueComponentNodes } from '../vue/materialize.js';
import { VueEventResolver } from '../vue/event-resolver.js';
import { buildVueEventNodes } from '../vue/event-materialize.js';
import { analyzeReactContext, isReactSourcePath } from '../react/association-wrapper.js';
import { toStructuralNode } from '../react/types.js';
import { resolveLivewire } from './framework/laravel/livewire-resolver.js';
import { NovaAssociationResolver, resolveNova } from './framework/laravel/nova-resolver.js';
import { AstStructuralResolver } from '../ast/resolver.js';
import { AssociationEngine } from './engine.js';
import { createDefaultResolvers } from './framework/index.js';
import { runDetectors } from './detectors/index.js';
import {
  createDefaultOperationalExtractors,
  runOperationalExtractors,
} from './operational/index.js';
import { propagateSurfaces } from './propagation.js';
import { buildTypedReceiverEntries, buildRegistry } from '../general.js'; // buildRegistry: export added in T3a.1
import { resolveTypedReceiverEdges } from '../ast/lsp-resolve.js';
import { resolveFacadeAndHelperEdges } from '../pack/facade-resolve.js';
import { makeExternalTargetResolver } from '../pack/external-resolve.js';
import { resolveVendorPackPathForRefresh } from '../rebuild-orchestrator.js'; // small export, T3a.1
import { extractSource, getGrammars, langForFile } from '../ast/extract.js';
import { buildAstSymbolNodes } from '../ast/symbols.js';
import { buildEntry } from '../incremental.js';
import { detectModuleBoundaries, resolveModule } from '../imports/module-boundary.js';

export interface ChangedFile {
  relPath: string;
  status: 'added' | 'modified' | 'deleted';
}

export interface ScopedRefreshOptions {
  lspBudgetMs?: number; // LSP-tier budget; exceeded ⇒ tier skipped + reported (default 30000)
  onProgress?: (msg: string) => void;
}
// NOTE: there is no `maxFiles` option — the changed-count budget is enforced UPSTREAM by
// decideScopedEligibility (spec 15 C, `over-budget`) before the engine is ever entered, never
// re-checked here. The engine repairs exactly the R it is handed.

export interface ScopedRefreshResult {
  refreshedFiles: number; // |R| = changed ∪ reverse-import-closure
  changedFiles: number; // |F|
  closureFiles: number; // |R \ F|
  nodesReplaced: number;
  edgesReplaced: number;
  inboundMarkedStale: number; // orphaned-target downgrades (Decision 5)
  tiers: {
    ast: 'ran' | 'failed';
    lsp: 'ran' | 'skipped-budget' | 'unavailable';
    facade: 'ran' | 'skipped-no-pack';
  };
  residualStaleEdges: number; // residual not-fresh edges (stale + dirty-dependent) — drives trust settlement
  currentCommit?: string;
}

/**
 * The reverse-import closure (Decision 14): callers whose references NEWLY resolve into a changed
 * file after it GAINS a symbol. Gate is the added-symbol test — a change that only modifies/deletes
 * symbols contributes nothing (stays cheap). Two adjacency signals unioned:
 *   (a) module adjacency — importers of the changed file's module (getModuleDependencies target),
 *       complete for the newly-resolvable case where no edge exists yet;
 *   (b) target-edge adjacency — files with an existing edge into the changed file's symbols.
 * Returns closure rel paths (excluding F).
 */
export async function computeReverseImportClosure(
  db: LuxDatabase,
  rootPath: string,
  changed: ChangedFile[]
): Promise<string[]> {
  const patterns = detectModuleBoundaries(rootPath);
  const grownModules = new Set<string>();
  const targetEdgeSourceFiles = new Set<string>();
  const grammars = await getGrammars();

  for (const f of changed) {
    if (f.status === 'deleted') continue; // a deletion removes symbols — no growth
    const persisted = new Set(db.getSymbolNodeIdsForFiles([f.relPath]));
    const entry = buildEntry(rootPath, f.relPath);
    if (!entry || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;
    let newIds: string[];
    try {
      const extraction = extractSource(grammars, entry.content, f.relPath, lang).extraction;
      newIds = buildAstSymbolNodes(f.relPath, extraction, lang, 0).map((n) => n.id);
    } catch {
      continue;
    }
    // Growth gate (Decision 14): a symbol was ADDED (an id absent from the persisted set). This is
    // the literal "a symbol was added" test; it is the essential half of strict-superset and is
    // sound (it also covers a rename that introduces a new name — never under-pulls the closure).
    const grew = newIds.some((id) => !persisted.has(id));
    if (!grew) continue;

    const module = resolveModule(f.relPath, rootPath, patterns);
    if (module) grownModules.add(module);
    // (b) existing callers of F's persisted symbols — they may reference the new symbol too.
    for (const sym of persisted) {
      for (const edge of db.getIncomingStructuralEdges(sym)) {
        const src = db.getStructuralNode(edge.source_node_id);
        if (src?.file_path) targetEdgeSourceFiles.add(src.file_path);
      }
    }
  }

  if (grownModules.size === 0 && targetEdgeSourceFiles.size === 0) return [];

  // (a) module adjacency → importer modules → their files. Module granularity is complete but
  // coarse (OQ3): it enumerates every file of an importing module. getModuleDependencies(m,'target')
  // gives importer MODULES; we map them to files via the persisted local file nodes.
  const importerModules = new Set<string>();
  for (const m of grownModules) {
    for (const dep of db.getModuleDependencies(m, 'target')) importerModules.add(dep.source_module);
  }
  const closure = new Set<string>(targetEdgeSourceFiles);
  if (importerModules.size > 0) {
    for (const fileNode of db.getLocalStructuralNodesByType('file')) {
      const fp = fileNode.file_path;
      if (!fp) continue;
      const mod = resolveModule(fp, rootPath, patterns);
      if (mod && importerModules.has(mod)) closure.add(fp);
    }
  }
  for (const f of changed) closure.delete(f.relPath); // F itself is already in R
  return [...closure];
}

export async function refreshOverlayScoped(
  db: LuxDatabase,
  rootPath: string,
  changed: ChangedFile[],
  config: LuxLspConfig,
  options: ScopedRefreshOptions = {}
): Promise<ScopedRefreshResult> {
  const report = options.onProgress ?? (() => {});
  const now = Math.floor(Date.now() / 1000);
  const currentCommit = isGitRepository(rootPath) ? safeHead(rootPath) : undefined;

  // 0. Repair set R = F ∪ reverse-import-closure(F) (Decision 14).
  const changedPaths = changed.map((c) => c.relPath);
  const closure = await computeReverseImportClosure(db, rootPath, changed);
  let R = [...new Set([...changedPaths, ...closure])];
  const persistedSourcePaths = db
    .getLocalStructuralNodesByType('file')
    .map((node) => node.file_path)
    .filter((path): path is string => Boolean(path));
  // React binding/export resolution joins declarations and uses across files. Expand to the full
  // JS/TS universe only for an applicable React change. A blanket expansion for every .ts change
  // would erase the scoped refresh contract's stale-inbound signal for ordinary AST-only files.
  const persistedReactPaths = new Set(
    db
      .getLocalStructuralNodesByType('symbol')
      .filter((node) => /^(?:component|hook|context):react:/u.test(node.id))
      .map((node) => node.file_path)
      .filter((path): path is string => Boolean(path))
  );
  if (changedPaths.some((path) => isReactCandidateChange(rootPath, path, persistedReactPaths))) {
    R = [...new Set([...R, ...persistedSourcePaths.filter(isReactSourcePath)])];
  } else if (
    config.frameworks?.nova.enabled &&
    changedPaths.some((path) => isNovaProgramPath(path))
  ) {
    R = [...new Set([...R, ...persistedSourcePaths.filter(isNovaProgramPath)])];
  } else {
    // Component resolution needs the complete materialized Vue universe.
    if (changedPaths.some((path) => path.toLowerCase().endsWith('.vue'))) {
      R = [
        ...new Set([
          ...R,
          ...persistedSourcePaths.filter((path) => path.toLowerCase().endsWith('.vue')),
        ]),
      ];
    }
    // Livewire registrations, namespaces, class roots, and Blade mounts are whole-PHP.
    if (changedPaths.some((path) => path.toLowerCase().endsWith('.php'))) {
      R = [
        ...new Set([
          ...R,
          ...persistedSourcePaths.filter((path) => path.toLowerCase().endsWith('.php')),
        ]),
      ];
    }
  }
  const deletedPaths = new Set(changed.filter((c) => c.status === 'deleted').map((c) => c.relPath));
  const rematPaths = R.filter((p) => !deletedPaths.has(p)); // deleted files: nodes stay deleted
  report(
    `Scoped refresh: |F|=${changedPaths.length}, |closure|=${closure.length}, |R|=${R.length}.`
  );

  // Capture the victim node/symbol universe BEFORE any mutation (orphan detection, Decision 5).
  const oldSymbolIds = new Set(db.getSymbolNodeIdsForFiles(R));

  // 1. FENCE (committed) — mark the whole victim set dirty-dependent so a crash leaves marks,
  //    not lies (Decision 13 crash floor). Both dimensions.
  db.transaction(() => {
    db.invalidateEdgesForFiles(R);
    db.invalidateEdgesByEvidencePaths(R);
  });

  // 2. Async pre-compute (reads only) — extraction + LSP so tier fate is known before the clear.
  const scanR: ScanResult = { knowledge: buildScanFor(rootPath, rematPaths) };
  let sharedExtractions: SharedExtractions | undefined;
  let programAnalysis: ProgramAnalysisV1 | undefined;
  let astOk = true;
  try {
    const analysis = await analyzeProgram(scanR, rootPath, report);
    sharedExtractions = analysis.shared.extractions;
    programAnalysis = analysis;
  } catch {
    astOk = false;
  }

  const vendorPackPath = resolveVendorPackPathForRefresh(rootPath); // null ⇒ facade skipped
  const { enrichments, lspTier, typedReceiverEdges } = await runLspTier(
    rootPath,
    config,
    scanR,
    sharedExtractions,
    vendorPackPath,
    options.lspBudgetMs,
    now,
    report,
    db
  );
  const facadeEdges =
    vendorPackPath && sharedExtractions
      ? resolveFacadeAndHelperEdges(phpFilesFrom(sharedExtractions), db, now)
      : [];
  const facadeTier: ScopedRefreshResult['tiers']['facade'] = vendorPackPath
    ? 'ran'
    : 'skipped-no-pack';

  // 3. CLEAR the victim slice. Keep R's :lsp edges when the LSP tier is skipped (Decision 8) —
  //    they become the enumerated stale residual, not an under-production.
  const keepLsp = lspTier !== 'ran';
  const victimNodeIds = db.getStructuralNodesForFilePaths(R).map((n) => n.id);
  // Anchor freshness (Decision 5): drop the victims' prepared-text/FTS rows (Phase 3 extends this to
  // embeddings, spec 16 Part C) next to the edge deletes. The re-materialisation below re-creates
  // surviving nodes' rows with fresh content; vanished nodes' rows stay deleted. Without this, a
  // NULL-only Phase-3 queue would keep a stale vector behind a live, changed node whose deterministic
  // id never churned. The clear is one transaction; outside one, each helper commits per chunk of ids.
  let edgesReplaced = 0;
  const nodesReplaced = db.transaction(() => {
    db.deleteNodeAnchorRowsForNodeIds(victimNodeIds);
    edgesReplaced += db.deleteEdgesBySourceNodes(victimNodeIds, { keepLsp });
    edgesReplaced += db.deleteEdgesByEvidencePaths(R, { keepLsp });
    if (keepLsp) db.markEdgesStaleLspBySourceNodes(victimNodeIds);
    db.deleteOperationalForFiles(R);
    return db.deleteStructuralNodesForFiles(R);
  });

  // 4. REMATERIALIZE all of R's nodes BEFORE the single resolver pass (Decision 13 soundness).
  materializeNodes(db, scanR, enrichments, rootPath);
  if (config.ast?.enabled ?? true) {
    await materializeAstSymbols(db, scanR, rootPath, now, sharedExtractions, report);
  }
  if (programAnalysis?.vueFacts.length) {
    db.transaction(() => {
      for (const node of buildVueComponentNodes(programAnalysis.vueFacts, now)) {
        db.upsertStructuralNode(node);
      }
      const artifacts = new VueEventResolver({ now: () => now }).resolve(
        programAnalysis.vueFacts,
        []
      ).artifacts;
      for (const node of buildVueEventNodes(artifacts, now)) db.upsertStructuralNode(node);
    });
  }

  // 5. ONE resolver pass over R's entries, DB-backed universe for out-of-R targets (Decision 13).
  const context: AssociationContext = {
    rootPath,
    nodes: db.getStructuralNodesForFilePaths(rematPaths),
    entries: buildContextEntriesFor(scanR, enrichments, rootPath),
    currentCommit, // toDbEdge stamps source_commit for the resolver tiers
    dirtyFiles: [],
    sharedExtractions,
    programAnalysis,
  };
  const react = await analyzeReactContext(context);
  if (react?.nodes.length) {
    db.transaction(() => {
      for (const node of react.nodes) db.upsertStructuralNode(toStructuralNode(node, now));
    });
    context.nodes = db.getStructuralNodesForFilePaths(rematPaths);
  }
  const livewire = resolveLivewire(context, {
    config: config.frameworks?.livewire,
    now: () => now,
  });
  if (livewire.nodes.length) {
    db.transaction(() => {
      for (const node of livewire.nodes) db.upsertStructuralNode(node);
    });
    context.nodes = db.getStructuralNodesForFilePaths(rematPaths);
  }
  const novaResolver = new NovaAssociationResolver();
  if (config.frameworks?.nova.enabled && novaResolver.supports(context)) {
    const nova = resolveNova(context, { now: () => now });
    if (nova.nodes.length) {
      db.transaction(() => {
        for (const node of nova.nodes) db.upsertStructuralNode(node);
      });
      context.nodes = db.getStructuralNodesForFilePaths(rematPaths);
    }
  }
  const resolvers = [
    ...createDefaultResolvers(config.frameworks),
    new AstStructuralResolver({ verifyExternalTarget: (id) => db.getStructuralNode(id) !== null }),
  ];
  const engine = new AssociationEngine(db, resolvers, {
    includeHeuristics: false,
    onProgress: report,
  });
  await engine.rebuild(context);

  // 6. Detectors + operational over R (source_commit=HEAD on the static-persist detector tier, SC-8).
  await runDetectors(db, context, undefined, report, currentCommit);
  await runOperationalExtractors(db, context, createDefaultOperationalExtractors(), report);

  // 7. Persist the pre-computed LSP + facade edges with explicit source_commit=HEAD (SC-8).
  if (typedReceiverEdges.length)
    AssociationEngine.persistEdges(db, typedReceiverEdges, currentCommit);
  if (facadeEdges.length) AssociationEngine.persistEdges(db, facadeEdges, currentCommit);

  // 8. Scoped propagation — only surfaces touched by the victim set (Part D). NOTE: the propagation
  //    edges (`validates_with` / `returns_contract` / `calls_surface` / `derived_from`) are written
  //    via the static `AssociationEngine.persistEdges(db, [propEdge])` with NO commit threaded, so
  //    they settle `source_commit = NULL`. This MATCHES a full rebuild exactly (no regression) and
  //    those edges are evidence-invalidatable, so SC-8's `source_commit = HEAD` guarantee is bounded
  //    to the detector / `:lsp` / `:facade-catalog` tiers — the propagation tier is a documented
  //    exclusion, not an escape hatch.
  const surfaceIds = computeTouchedSurfaceIds(db, R, victimNodeIds);
  await propagateSurfaces(db, context, { surfaceIds });

  // 9. Orphaned-inbound residual (Decision 5): symbols removed by re-derivation → any surviving
  //    inbound edge into them is marked stale (never deleted).
  const newSymbolIds = new Set(db.getSymbolNodeIdsForFiles(rematPaths));
  const removed = [...oldSymbolIds].filter((id) => !newSymbolIds.has(id));
  const inboundMarkedStale = removed.length ? db.markEdgesStaleByTargetNodes(removed) : 0;

  // 9b. Surviving-inbound restore (SC-7, symmetric to the orphan step). The step-1 fence marks
  //     EVERY edge touching R dirty-dependent; a surviving-target inbound edge C→A (A∈R survives,
  //     C∉R so it is NOT re-derived, and it is NOT an orphan) is otherwise left dirty-dependent
  //     forever, dropping C→A out of the fresh slice even though a full rebuild keeps it fresh.
  //     Promote it back to fresh so a complete refresh settles to ZERO residual dirty-dependent.
  //     Keyed on ALL surviving re-materialized R node ids (file + symbol + surface) — the fence
  //     downgraded inbound edges into any of them; only `dirty-dependent` edges are promoted, so a
  //     `stale` orphan/skipped-LSP residual and an already re-derived `fresh` edge are both left as-is.
  const survivingNodeIds = db.getStructuralNodesForFilePaths(rematPaths).map((n) => n.id);
  const inboundRefreshed = survivingNodeIds.length
    ? db.markEdgesFreshByTargetNodes(survivingNodeIds)
    : 0;

  // Residual reflects BOTH not-fresh maintained states: the orphan/skipped-LSP `stale` residual AND
  // any leftover `dirty-dependent` (step 9b drives this to zero on a complete refresh — a non-zero
  // value is an honest settle failure that downgrades trust rather than silently reading complete).
  const freshnessCounts = db.countEdgesByFreshness();
  const residualStaleEdges = freshnessCounts.stale + freshnessCounts['dirty-dependent'];
  report(
    `Scoped refresh complete: ${nodesReplaced} node(s) replaced, ${edgesReplaced} edge(s) cleared, ` +
      `${inboundMarkedStale} inbound orphaned→stale, ${inboundRefreshed} inbound survived→fresh, ` +
      `${residualStaleEdges} residual not-fresh.`
  );

  return {
    refreshedFiles: R.length,
    changedFiles: changedPaths.length,
    closureFiles: closure.length,
    nodesReplaced,
    edgesReplaced,
    inboundMarkedStale,
    tiers: { ast: astOk ? 'ran' : 'failed', lsp: lspTier, facade: facadeTier },
    residualStaleEdges,
    currentCommit,
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function isNovaProgramPath(filePath: string): boolean {
  return /(?:\.php|\.vue|\.[cm]?[jt]sx?)$/iu.test(filePath);
}

function isReactCandidateChange(
  rootPath: string,
  filePath: string,
  persistedReactPaths: ReadonlySet<string>
): boolean {
  if (!isReactSourcePath(filePath)) return false;
  if (persistedReactPaths.has(filePath)) return true;
  const entry = buildEntry(rootPath, filePath);
  const source = entry?.content ?? '';
  return (
    /(?:<[A-Z]|React\.createElement\s*\(|\bcreateContext\s*\(|React\.createContext\s*\(|\buse[A-Z0-9][\w$]*\s*\()/u.test(
      source
    ) ||
    /\bfrom\s+['"]react['"]|\bfrom\s+['"]react-native['"]|\bfrom\s+['"]expo-router['"]/u.test(
      source
    )
  );
}

function safeHead(rootPath: string): string | undefined {
  try {
    return getHeadCommit(rootPath);
  } catch {
    return undefined;
  }
}

/** Build a partial ScanResult for R's rematerialize paths, reusing the incremental entry builder. */
function buildScanFor(rootPath: string, relPaths: string[]): ScannedKnowledge[] {
  const out: ScannedKnowledge[] = [];
  for (const rel of relPaths) {
    const entry = buildEntry(rootPath, rel);
    if (entry && entry.type === 'source-code') out.push(entry);
  }
  return out;
}

function phpFilesFrom(
  shared: SharedExtractions
): Array<{ relPath: string; extraction: Extraction }> {
  const files: Array<{ relPath: string; extraction: Extraction }> = [];
  for (const [relPath, extraction] of shared) {
    if (langForFile(relPath) === 'php') files.push({ relPath, extraction });
  }
  return files;
}

/** entries for the single resolver pass — mirrors overlay-service.buildContextEntries but over R. */
function buildContextEntriesFor(
  scan: ScanResult,
  enrichments: EnrichmentMap,
  rootPath: string
): AssociationContext['entries'] {
  return scan.knowledge
    .filter((k) => k.type === 'source-code')
    .map((k) => {
      const metadata: Record<string, unknown> = {};
      if (k.content) metadata.content = k.content;
      const enr = enrichments.get(k.filePath);
      if (enr) metadata.lsp = enr;
      const relPath = k.filePath.startsWith(rootPath + '/')
        ? k.filePath.slice(rootPath.length + 1)
        : k.filePath;
      return {
        filePath: relPath,
        languageId: k.frontmatter?.language as string | undefined,
        metadata,
      };
    });
}

/** Surfaces touched by the victim set: declared in R's files, or connected to an R node. */
function computeTouchedSurfaceIds(
  db: LuxDatabase,
  R: string[],
  victimNodeIds: string[]
): Set<string> {
  const ids = new Set<string>();
  for (const n of db.getStructuralNodesForFilePaths(R)) {
    if (n.node_type === 'capability-surface') ids.add(n.id);
  }
  // handled_by edges whose handler (target) is an R symbol → the surface (source) re-propagates.
  for (const nodeId of victimNodeIds) {
    for (const edge of db.getIncomingStructuralEdges(nodeId)) {
      if (edge.edge_type === 'handled_by') ids.add(edge.source_node_id);
    }
  }
  return ids;
}

/** The LSP tier (async, budgeted — Decision 8). */
async function runLspTier(
  rootPath: string,
  config: LuxLspConfig,
  scanR: ScanResult,
  sharedExtractions: SharedExtractions | undefined,
  vendorPackPath: string | null,
  lspBudgetMs: number | undefined,
  now: number,
  report: (m: string) => void,
  db: LuxDatabase
): Promise<{
  enrichments: EnrichmentMap;
  lspTier: ScopedRefreshResult['tiers']['lsp'];
  typedReceiverEdges: StructuralRelationEdge[];
}> {
  const enrichments: EnrichmentMap = new Map();
  if (!config.lsp.enabled) return { enrichments, lspTier: 'unavailable', typedReceiverEdges: [] };
  const registry = buildRegistry(config.lsp.enrichers);
  if (registry.size === 0) return { enrichments, lspTier: 'unavailable', typedReceiverEdges: [] };

  const budgetMs = lspBudgetMs ?? 30000;
  const deadline = Date.now() + budgetMs;
  const workspaceRoot = config.lsp.workspaceRoot ?? rootPath;
  try {
    let active = 0;
    for (const e of registry.getAll()) {
      if (Date.now() > deadline) throw new Error('lsp-budget');
      try {
        await e.initialize(workspaceRoot);
        active++;
      } catch {
        /* per-enricher isolation */
      }
    }
    if (active === 0) return { enrichments, lspTier: 'unavailable', typedReceiverEdges: [] };

    for (const k of scanR.knowledge) {
      if (Date.now() > deadline) throw new Error('lsp-budget');
      if (k.type !== 'source-code' || !k.content) continue;
      const lang = langForFile(k.filePath);
      const enricher = lang ? registry.get(lang === 'php' ? 'php' : 'typescript') : undefined;
      if (!enricher?.isReady) continue;
      try {
        const r = await enricher.enrich(k.filePath);
        if (r) enrichments.set(k.filePath, r);
      } catch {
        /* isolated */
      }
    }

    if (Date.now() > deadline) throw new Error('lsp-budget');
    const reg = registry;
    const resolveExternalTarget = vendorPackPath
      ? makeExternalTargetResolver(db, rootPath)
      : undefined;
    const edges = await resolveTypedReceiverEdges(
      buildTypedReceiverEntries(scanR.knowledge, []),
      rootPath,
      (fp, line, char) => reg.resolveDefinition(fp, line, char),
      now,
      {
        resolveInFile: (fp, ps) => reg.resolveDefinitionsInFile(fp, ps),
        sharedExtractions,
        resolveExternalTarget,
      }
    );
    return { enrichments, lspTier: 'ran', typedReceiverEdges: edges };
  } catch {
    report('LSP tier exceeded budget or failed — skipping; :lsp edges of R left stale.');
    return { enrichments, lspTier: 'skipped-budget', typedReceiverEdges: [] };
  } finally {
    // Shut down enrichers (mirrors generalScan step 9) so a scoped refresh never leaks a language
    // server process — the spec's tier is budget-bounded but must not outlive the call.
    try {
      await registry.shutdownAll();
    } catch {
      /* ignore shutdown errors */
    }
  }
}
