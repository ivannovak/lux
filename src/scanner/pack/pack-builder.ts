// Vendor pack build pipeline (ADR-1, ADR-4, REQ-4).
//
// Builds the vendor structural graph once per dependency-set and caches it (see
// cache.ts). vendor/ is invisible to the normal app scan by construction
// (SOURCE_CODE_IGNORE_PATTERNS excludes it — src/scanner/general.ts), so this
// builder OPTS IN by globbing vendor/**/*.php directly, then reuses the shipped
// AST tier over that file set:
//
//   1. discover   glob vendor/**/*.php (excludes package test dirs + bin/)
//   2. parse-once every file parsed a SINGLE time into a shared Extraction map
//                 (Lever D) — the map feeds every downstream stage, and a parse
//                 failure on one file is isolated, not fatal
//   3. symbols    buildAstSymbolNodes per file → StructuralNode[] (origin stamped)
//   4. syntactic  AstStructuralResolver.resolve → same-file + import-bound edges
//   5. LSP depth  (full-lsp only, ADR-4 default) within-vendor typed-receiver
//                 calls via a warm, bounded intelephense pass; targets outside
//                 vendor are dropped by the resolver
//   6. persist    write the pack (structural_nodes + structural_edges) + manifest
//
// The pack build does NOT emit edge_evidence: vendor edges carry their provenance
// inline in provenance_summary and the merge skips per-edge evidence (CANONICAL
// -DECISIONS §3–§4), so it is never built or stored.

import { readFileSync } from 'fs';
import { glob } from 'glob';
import { join } from 'path';
import type { StructuralNode, StructuralEdge } from '../../db/types.js';
import type { StructuralRelationEdge } from '../associations/types.js';
import {
  extractSource,
  getGrammars,
  langForFile,
  type AstLang,
  type Extraction,
} from '../ast/extract.js';
import type { SharedExtractions } from '../ast/extraction-cache.js';
import { buildAstSymbolNodes } from '../ast/symbols.js';
import { AstStructuralResolver } from '../ast/resolver.js';
import { resolveTypedReceiverEdges } from '../ast/lsp-resolve.js';
import { EnricherRegistry } from '../lsp/index.js';
import { PhpLspEnricher } from '../lsp/php.js';
import { loadLspConfig } from '../config.js';
import {
  VendorPackWriter,
  VendorPackReader,
  VENDOR_PACK_ORIGIN,
  PACK_FORMAT_VERSION,
  type VendorPackDepth,
  type VendorPackManifest,
} from './pack-format.js';
import { derivePackKey, lookupPack, packPathForKey, type PackKeyScheme } from './cache.js';

/** Vendor subtrees excluded from the pack: package test suites carry no runtime behavior. */
const VENDOR_IGNORE = ['vendor/**/{tests,Tests,test,Test}/**', 'vendor/bin/**'];

/**
 * Max vendor files resolved concurrently in the full-lsp pass (mirrors general.ts
 * ENRICH_FILE_CONCURRENCY). Makes the ~52k-file within-vendor LSP pass affordable
 * (REQ-4) by keeping intelephense saturated without unbounded parallel opens.
 */
const PACK_LSP_CONCURRENCY = 12;

export interface BuildVendorPackOptions {
  /** ADR-4 within-vendor depth. Default 'full-lsp'. */
  depth?: VendorPackDepth;
  /** Keying scheme (cache.ts). Default 'composer-lock'. */
  scheme?: PackKeyScheme;
  /** Explicit cache ROOT dir (else LUX_PACK_CACHE, else ~/.lux/packs). */
  packCache?: string;
  /** lux version string, for the manifest. */
  luxVersion: string;
  /** Progress callback (mirrors generalScan's reporter). */
  onProgress?: (message: string) => void;
}

export interface BuildVendorPackResult {
  packPath: string;
  manifest: VendorPackManifest;
}

/** One discovered vendor PHP file with its content and language. */
interface FileRecord {
  /** Path relative to projectRoot — "vendor/…", portable across projects. */
  relPath: string;
  absPath: string;
  lang: AstLang;
  content: string;
}

/** Build (or rebuild) the vendor pack for a project's current composer.lock. */
export async function buildVendorPack(
  projectRoot: string,
  options: BuildVendorPackOptions
): Promise<BuildVendorPackResult> {
  const report = options.onProgress ?? (() => {});
  const depth: VendorPackDepth = options.depth ?? 'full-lsp';
  const startedAt = Date.now();
  const now = Math.floor(Date.now() / 1000);

  const key = derivePackKey(projectRoot, options.scheme);
  const packPath = packPathForKey(key, { packCache: options.packCache });

  // 1. Discover vendor PHP files (opt-in against SOURCE_CODE_IGNORE_PATTERNS).
  report('Discovering vendor/ PHP files...');
  const rel = await glob('vendor/**/*.php', {
    cwd: projectRoot,
    ignore: VENDOR_IGNORE,
    nodir: true,
  });
  report(`Found ${rel.length} vendor PHP file(s).`);

  // 2. Parse each file EXACTLY ONCE into a shared extraction map (Lever D). The
  //    map is threaded into the resolver and the LSP pass so nothing re-parses.
  report('Parsing vendor sources...');
  const grammars = await getGrammars();
  const shared: SharedExtractions = new Map();
  const records: FileRecord[] = [];
  for (const relPath of rel) {
    const lang = langForFile(relPath);
    if (lang !== 'php') continue; // node_modules/TS out of scope per ADR-1
    const absPath = join(projectRoot, relPath);
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch (err) {
      // lux-intentional-swallow: pack build: the skipped vendor file is listed in the build's own output.
      report(`  skip ${relPath}: ${errMsg(err)}`);
      continue;
    }
    let extraction: Extraction;
    try {
      extraction = extractSource(grammars, content, relPath, lang).extraction;
    } catch (err) {
      // lux-intentional-swallow: pack build: the skipped vendor file is listed in the build's own output.
      report(`  skip ${relPath}: ${errMsg(err)}`); // isolate a pathological file
      continue;
    }
    shared.set(relPath, extraction);
    records.push({ relPath, absPath, lang, content });
  }

  // 3. Symbol nodes — reuse buildAstSymbolNodes over the single parse; stamp origin.
  report('Extracting vendor symbol nodes...');
  const nodes: StructuralNode[] = [];
  const seenNode = new Set<string>();
  for (const r of records) {
    const extraction = shared.get(r.relPath);
    if (!extraction) continue;
    for (const n of buildAstSymbolNodes(r.relPath, extraction, r.lang, now)) {
      if (seenNode.has(n.id)) continue;
      seenNode.add(n.id);
      nodes.push({ ...n, origin: VENDOR_PACK_ORIGIN });
    }
  }
  report(`Extracted ${nodes.length} vendor symbol node(s).`);

  // 4. Syntactic edges — reuse AstStructuralResolver over the shared extractions.
  report('Resolving within-vendor syntactic edges (AST)...');
  const resolver = new AstStructuralResolver();
  const relEdges: StructuralRelationEdge[] = await resolver.resolve({
    rootPath: projectRoot,
    nodes: [],
    entries: records.map((r) => ({ filePath: r.absPath, metadata: { content: r.content } })),
    dirtyFiles: [],
    sharedExtractions: shared,
  });
  report(`Resolved ${relEdges.length} syntactic edge(s).`);

  // 5. Within-vendor typed-receiver LSP depth (ADR-4, default full-lsp).
  if (depth === 'full-lsp') {
    report('Resolving within-vendor typed-receiver calls (LSP)...');
    const registry = buildPhpRegistry(projectRoot);
    try {
      await initRegistry(registry, projectRoot);
      // Warm, bounded pass: one document open per file (Lever B) via the
      // registry's resolveDefinitionsInFile, with per-position resolveDefinition
      // as the fallback the pass uses when a file has no warm-batch primitive.
      // Reuses the single parse (Lever D) so this pass never re-parses.
      const lspEdges = await resolveTypedReceiverEdges(
        records.map((r) => ({ filePath: r.absPath, content: r.content })),
        projectRoot,
        (fp, line, char) => registry.resolveDefinition(fp, line, char),
        now,
        {
          resolveInFile: (fp, positions) => registry.resolveDefinitionsInFile(fp, positions),
          sharedExtractions: shared,
          concurrency: PACK_LSP_CONCURRENCY,
        }
      );
      relEdges.push(...lspEdges); // targets outside vendor already dropped by lsp-resolve
      report(`Resolved ${lspEdges.length} typed-receiver edge(s).`);
    } finally {
      try {
        await registry.shutdownAll();
      } catch {
        // lux-intentional-swallow: best-effort cleanup; the error that matters is already thrown or returned.
        /* shutdown errors are non-fatal for a completed build */
      }
    }
  } else {
    report('Depth=ast-only — skipping within-vendor LSP pass.');
  }

  // 6. Lower relation edges → pack edges (no evidence — see module doc) + persist.
  const edges = lowerEdges(relEdges, now);
  report(`Writing pack (${nodes.length} nodes, ${edges.length} edges) → ${packPath}`);
  const writer = new VendorPackWriter(packPath);
  writer.write(nodes, edges);
  const manifest: VendorPackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    keyScheme: key.scheme,
    key: key.digest,
    framework: key.framework,
    depth,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    buildDurationMs: Date.now() - startedAt,
    builtAt: now,
    luxVersion: options.luxVersion,
  };
  writer.finalize(manifest);
  report(`Pack build complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);

  return { packPath, manifest };
}

export interface EnsureVendorPackResult {
  packPath: string;
  manifest: VendorPackManifest;
  /** false = served from cache (REQ-6 reuse); true = built this call. */
  built: boolean;
}

/**
 * Return a usable vendor pack for the project, building only on a cache miss
 * (REQ-6 reuse). `force` rebuilds even on a hit. This is the single entry point
 * the merge/rebuild path calls — it never calls buildVendorPack directly.
 */
export async function ensureVendorPack(
  projectRoot: string,
  options: BuildVendorPackOptions & { force?: boolean }
): Promise<EnsureVendorPackResult> {
  const lookup = lookupPack(projectRoot, {
    scheme: options.scheme,
    packCache: options.packCache,
  });
  if (lookup.hit && !options.force) {
    const reader = new VendorPackReader(lookup.packPath);
    const manifest = reader.manifest();
    reader.close();
    return { packPath: lookup.packPath, manifest, built: false };
  }
  const { packPath, manifest } = await buildVendorPack(projectRoot, options);
  return { packPath, manifest, built: true };
}

/** Build a PHP-only enricher registry from lux.yaml (or defaults) for the LSP pass. */
function buildPhpRegistry(projectRoot: string): EnricherRegistry {
  const config = loadLspConfig(projectRoot);
  const entry = config.lsp.enrichers.find((e) => e.languageId === 'php');
  const registry = new EnricherRegistry();
  registry.register(
    new PhpLspEnricher({
      serverCommand: entry?.serverCommand,
      serverArgs: entry?.serverArgs,
      requestTimeoutMs: entry?.requestTimeoutMs,
      initTimeoutMs: entry?.initTimeoutMs,
    })
  );
  return registry;
}

/** Initialize every enricher against the project root so vendor autoload resolves. */
async function initRegistry(registry: EnricherRegistry, projectRoot: string): Promise<void> {
  for (const enricher of registry.getAll()) {
    await enricher.initialize(projectRoot);
  }
}

/**
 * Lower in-memory relation edges to pack rows (freshness 'fresh'; edges carry no
 * origin column). Mirrors AssociationEngine.persistEdges' edge mapping but skips
 * evidence — vendor edges carry their provenance inline in provenance_summary.
 * Edge ids are deduped across the AST + LSP passes (first row wins).
 */
function lowerEdges(relEdges: StructuralRelationEdge[], now: number): StructuralEdge[] {
  const edges: StructuralEdge[] = [];
  const seen = new Set<string>();
  for (const rel of relEdges) {
    if (seen.has(rel.id)) continue;
    seen.add(rel.id);
    edges.push({
      id: rel.id,
      source_node_id: rel.sourceNodeId,
      target_node_id: rel.targetNodeId,
      edge_type: rel.edgeType,
      confidence: rel.confidence,
      confidence_class: rel.confidenceClass,
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: `${rel.provenance.resolver} [${rel.provenance.evidenceKind}]`,
      updated_at: now,
    });
  }
  return edges;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
