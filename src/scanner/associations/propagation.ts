// Symbolic propagation: expand from known capability surfaces outward.
//
// Propagation runs after detectors have established surface nodes and
// explicit boundary edges. Each pass starts from a surface and uses
// structural and LSP evidence to link:
//
//   provider-side:  surface → controller class → request validator → response resource
//   consumer-side:  surface → wrapper function → hook → component
//   artifact-side:  surface → generated client artifact → callable symbol
//
// Propagation only emits edges when it can find supporting structural
// evidence (LSP symbol data, file naming, or import patterns). It does
// NOT infer by convention alone when symbol truth exists.

import { writeAllInChunks, type LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';
import type { AssociationContext, EdgeType, TransportContractMetadata } from './types.js';
import { AssociationEngine } from './engine.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PropagationResult {
  providerEdgesAdded: number;
  consumerEdgesAdded: number;
  artifactEdgesAdded: number;
}

/** Surfaces propagated per commit: on a large Laravel app one surface's passes take tens of ms. */
const SURFACES_PER_COMMIT = 32;

/**
 * Run all propagation passes for the detected surfaces in the given context.
 *
 * @param db - Database holding surfaces, nodes, and existing edges.
 * @param context - AssociationContext from the overlay rebuild.
 * @returns Counts of edges added per propagation type.
 */
export function propagateSurfaces(
  db: LuxDatabase,
  context: AssociationContext,
  options?: { surfaceIds?: Set<string> }
): Promise<PropagationResult> {
  const all = db.getCapabilitySurfaces();
  // Scoped refresh (Decision 13 step 6): re-propagate only surfaces touched by the victim set.
  // Full rebuild passes no options ⇒ all surfaces (unchanged).
  const surfaces = options?.surfaceIds ? all.filter((s) => options.surfaceIds!.has(s.id)) : all;
  if (surfaces.length === 0) {
    return Promise.resolve({ providerEdgesAdded: 0, consumerEdgesAdded: 0, artifactEdgesAdded: 0 });
  }

  let providerEdgesAdded = 0;
  let consumerEdgesAdded = 0;
  let artifactEdgesAdded = 0;

  // The passes write one node or edge at a time; enclosing transactions turn those into a few
  // commits (each persistEdges call becomes a savepoint), and later passes still read earlier
  // writes. A surface's passes do far more reading than writing, so commits are per run of
  // surfaces, to keep each transaction short.
  writeAllInChunks(db, surfaces, SURFACES_PER_COMMIT, (surface) => {
    providerEdgesAdded += runProviderPropagation(db, surface, context);
    consumerEdgesAdded += runConsumerPropagation(db, surface, context);
    consumerEdgesAdded += runBladeConsumerPropagation(db, surface, context);
    artifactEdgesAdded += runArtifactPropagation(db, surface, context);
  });

  return Promise.resolve({ providerEdgesAdded, consumerEdgesAdded, artifactEdgesAdded });
}

// ---------------------------------------------------------------------------
// Provider-side propagation
// ---------------------------------------------------------------------------

/**
 * Expand from a surface's explicit provider (via handled_by) to:
 *   - request validator symbols (FormRequest subtypes in method signatures)
 *   - response resource symbols (JsonResource / DTO in return expressions)
 *
 * Uses two evidence paths — LSP type hierarchy when available, PHP content
 * regex analysis otherwise — then resolves DB nodes by qualified name with
 * a short-name fallback to handle both indexed formats.
 */
function runProviderPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const surfaceCtx = db.getSurfaceCenteredContext(surface.id);
  if (!surfaceCtx) return 0;

  const handledByEdges = surfaceCtx.edges.filter((e) => e.edge.edge_type === 'handled_by');
  if (handledByEdges.length === 0) return 0;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceMeta = parseSurfaceMeta(surface);

  for (const { edge } of handledByEdges) {
    const controllerNodeId = edge.target_node_id;
    const controllerNode = db.getStructuralNode(controllerNodeId);
    if (!controllerNode) continue;

    const controllerFilePath = controllerNode.file_path;
    if (!controllerFilePath) continue;

    // Pass the controller method from surface metadata so PHP content
    // analysis can focus on the correct method body.
    const methodScope = inferControllerMethodScope(surfaceMeta.controllerMethod, controllerNodeId);
    const candidates = findSymbolsLinkedToController(controllerFilePath, context, methodScope);

    const filledRoles = new Set<'request' | 'response'>();

    for (const candidate of candidates) {
      let resolved: { nodeId: string; node: StructuralNode } | null;

      if (candidate.syntheticNode) {
        db.upsertStructuralNode(candidate.syntheticNode);
        resolved = {
          nodeId: candidate.syntheticNode.id,
          node: candidate.syntheticNode,
        };
      } else {
        // Resolve DB node: try qualified name first, then short name
        resolved = resolvePhpSymbolNode(db, candidate.qualifiedName);
      }
      if (!resolved) continue;

      const edgeType: EdgeType =
        candidate.role === 'request' ? 'validates_with' : 'returns_contract';
      const edgeId = `${controllerNodeId}→${resolved.nodeId}:${edgeType}:propagated${methodScope ? `:${methodScope}` : ''}`;
      const propEdge = {
        id: edgeId,
        edgeType,
        sourceNodeId: controllerNodeId,
        targetNodeId: resolved.nodeId,
        sourceLanguage: 'php',
        targetLanguage: 'php',
        confidence: 0.75,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:provider',
          evidenceKind: candidate.evidenceKind,
          evidenceLocations: [
            {
              filePath: controllerFilePath,
              note: `${candidate.role}: ${candidate.qualifiedName}${methodScope ? ` [method:${methodScope}]` : ''}`,
            },
          ],
          extractedAt: now,
        },
      };

      AssociationEngine.persistEdges(db, [propEdge]);
      filledRoles.add(candidate.role);
      added++;
    }

    // Run coarse contract inference for any roles not filled by explicit analysis.
    // Coarse inference is always method-scoped to prevent sibling-method smearing.
    if (methodScope) {
      const entry = context.entries.find((e) => e.filePath === controllerFilePath);
      const fullContent = (entry?.metadata?.content as string | undefined) ?? '';
      if (fullContent) {
        const methodBody = extractMethodBody(fullContent, methodScope);
        added += runCoarseContractInference(
          db,
          controllerNodeId,
          controllerFilePath,
          methodScope,
          methodBody,
          filledRoles,
          now
        );
      }
    }
  }

  return added;
}

// ---------------------------------------------------------------------------
// Consumer-side propagation
// ---------------------------------------------------------------------------

/**
 * Expand from a surface to TS/JS/Vue consumer symbols or files that reference
 * the surface's path or route name.
 *
 * Proof strategy:
 *   Stage A: find a transport-shaped call window that locally references either
 *            the canonical path skeleton or the route name.
 *   Stage B: anchor that evidence to the nearest symbol when one exists; fall
 *            back to the file node for Vue components or file-scoped helpers
 *            whose local callsite is transport-proven but not symbolized.
 *
 * Paths shorter than 4 non-slash characters are too generic to match reliably and
 * are skipped unless a route name is available. Dynamic segments like {id} are
 * stripped before searching so that the static skeleton of the path drives matching.
 */
function runConsumerPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const meta = parseSurfaceMeta(surface);
  if (!meta.path && !meta.routeName) return 0;

  // Guard: skip paths whose static skeleton is too short to be meaningful
  const staticSkeleton = (meta.path ?? '').replace(/\{[^}]+\}/g, '').replace(/\/+/g, '/');
  if (!meta.routeName && staticSkeleton.replace(/^\//, '').length < 4) return 0;

  // Use stripped path for content matching to avoid dynamic-segment false-positives
  const searchPath = staticSkeleton;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceId = surface.id;

  const scriptEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript' || e.languageId === 'vue'
  );

  for (const entry of scriptEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content) continue;
    if (
      searchPath &&
      !content.includes(searchPath) &&
      (!meta.routeName || !content.includes(meta.routeName))
    ) {
      continue;
    }

    const evidence = findScriptTransportEvidence(content, searchPath, meta.routeName, meta.method);
    if (!evidence) continue;

    const lines = content.split('\n');
    const candidates = extractConsumerCandidates(lines, evidence.line - 1);
    let emitted = false;

    for (const candidate of candidates) {
      const existingNode = resolveConsumerSymbolNode(db, entry.filePath, candidate.name);
      if (!existingNode) continue;

      const edgeId = `${existingNode.id}→${surfaceId}:calls_surface:propagated`;
      const propEdge = {
        id: edgeId,
        edgeType: 'calls_surface' as const,
        sourceNodeId: existingNode.id,
        targetNodeId: surfaceId,
        sourceLanguage: existingNode.language_id ?? entry.languageId ?? 'typescript',
        confidence: evidence.confidence,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:consumer',
          evidenceKind: evidence.evidenceKind,
          evidenceLocations: [
            { filePath: entry.filePath, line: evidence.line, note: evidence.note },
          ],
          extractedAt: now,
        },
      };

      AssociationEngine.persistEdges(db, [propEdge]);
      added++;
      emitted = true;
      break;
    }

    if (!emitted) {
      const consumerFileNodeId = `file:${entry.filePath}`;
      const existingNode = db.getStructuralNode(consumerFileNodeId);
      if (!existingNode) continue;

      const edgeId = `${consumerFileNodeId}→${surfaceId}:calls_surface:script-file`;
      const propEdge = {
        id: edgeId,
        edgeType: 'calls_surface' as const,
        sourceNodeId: consumerFileNodeId,
        targetNodeId: surfaceId,
        sourceLanguage: entry.languageId ?? 'typescript',
        confidence: evidence.confidence,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:consumer:file',
          evidenceKind: evidence.evidenceKind,
          evidenceLocations: [
            { filePath: entry.filePath, line: evidence.line, note: evidence.note },
          ],
          extractedAt: now,
        },
      };

      AssociationEngine.persistEdges(db, [propEdge]);
      added++;
    }
  }

  return added;
}

// ---------------------------------------------------------------------------
// Blade / inline-JS consumer propagation
// ---------------------------------------------------------------------------

/**
 * Scan PHP Blade templates and PHP view files for inline transport calls that
 * reference the surface's path or route name.
 *
 * Supported forms:
 *   $.get('/path', ...)        $.post('/path', ...)
 *   $.ajax('/path', ...)       $.ajax({ url: '/path' })
 *   fetch('/path', ...)
 *   url('/path')  and  route('name')  inside any of the above
 *
 * Emits `calls_surface` from the file node (not a symbol node) because Blade
 * templates do not have exported function symbols.
 *
 * Inline Blade consumers now support two tiers:
 *   - 0.65 candidate: transport + local path/route reference, but method unknown
 *   - 0.75 proven:    transport + local path/route reference + known method match
 *
 * Known method contradictions are rejected rather than kept as low-confidence
 * candidates. A GET transport call should not attach to a POST surface just
 * because the path matches.
 */

function runBladeConsumerPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const meta = parseSurfaceMeta(surface);
  if (!meta.path) return 0;

  // Skip very short paths, too likely to produce coincidental matches in view files
  const staticSkeleton = meta.path.replace(/\{[^}]+\}/g, '').replace(/\/+/g, '/');
  if (staticSkeleton.replace(/^\//, '').length < 4) return 0;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceId = surface.id;

  const bladeEntries = context.entries.filter((e) => isBladeOrPhpViewFile(e.filePath));

  for (const entry of bladeEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content) continue;

    const evidence = findBladeTransportEvidence(
      content,
      staticSkeleton,
      meta.routeName,
      meta.method
    );
    if (!evidence) continue;

    const consumerNodeId = `file:${entry.filePath}`;
    const existingNode = db.getStructuralNode(consumerNodeId);
    if (!existingNode) continue;

    const edgeId = `${consumerNodeId}→${surfaceId}:calls_surface:blade`;
    const propEdge = {
      id: edgeId,
      edgeType: 'calls_surface' as const,
      sourceNodeId: consumerNodeId,
      targetNodeId: surfaceId,
      sourceLanguage: 'php',
      confidence: evidence.confidence,
      confidenceClass: 'framework-inferred' as const,
      provenance: {
        resolver: 'propagation:consumer:blade',
        evidenceKind: evidence.evidenceKind,
        evidenceLocations: [
          {
            filePath: entry.filePath,
            ...(evidence.line ? { line: evidence.line } : {}),
            note: evidence.note,
          },
        ],
        extractedAt: now,
      },
    };

    AssociationEngine.persistEdges(db, [propEdge]);
    added++;
  }

  return added;
}

interface BladeTransportEvidence {
  confidence: number;
  evidenceKind: string;
  note: string;
  line?: number;
}

interface ScriptTransportEvidence {
  confidence: number;
  evidenceKind: string;
  note: string;
  line: number;
}

function findScriptTransportEvidence(
  content: string,
  path: string,
  routeName?: string,
  surfaceMethod?: string
): ScriptTransportEvidence | null {
  const surfaceSegments = path ? toComparablePathSegments(path) : [];
  const normalizedSurfaceMethod = normalizeHttpMethod(surfaceMethod);
  const matches: Array<ScriptTransportEvidence & { sortLine: number }> = [];

  const recordMatch = (
    transportLabel: string,
    transportMethod: string | null,
    methodExplicit: boolean,
    expr: string,
    matchIndex: number
  ): void => {
    const pathMatched = surfaceSegments.length > 0 && matchesPathExpression(expr, surfaceSegments);
    const routeMatched = routeName ? matchesRouteExpression(expr, routeName) : false;
    if (!pathMatched && !routeMatched) return;

    const methodKnown = normalizedSurfaceMethod !== null && transportMethod !== null;
    const methodContradicts = methodKnown && normalizedSurfaceMethod !== transportMethod;
    if (methodContradicts) return;

    const methodMatches = methodKnown;
    const confidence = methodMatches ? 0.75 : 0.65;
    const evidenceKind = routeMatched
      ? methodMatches
        ? 'script-transport-route-and-method-reference'
        : 'script-transport-route-reference'
      : methodMatches
        ? 'script-transport-path-and-method-reference'
        : 'script-transport-path-reference';

    const targetNote = routeMatched && routeName ? `route(${routeName})` : `path ${path}`;
    const line = lineNumberAt(content, matchIndex);

    matches.push({
      confidence,
      evidenceKind,
      line,
      sortLine: line,
      note: `${transportLabel} references ${targetNote}${transportMethod ? ` with ${transportMethod}${methodExplicit ? '' : ' default'}` : ''}`,
    });
  };

  let m: RegExpExecArray | null;

  const AXIOS_RE = /\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(/g;
  AXIOS_RE.lastIndex = 0;
  while ((m = AXIOS_RE.exec(content)) !== null) {
    const method = m[1].toUpperCase();
    const window = content.slice(m.index, m.index + 700);
    const enrichedWindow = enrichScriptTransportWindow(content, window, m.index);
    recordMatch(`axios.${m[1]}()`, method, true, enrichedWindow, m.index);
  }

  const DIRECT_JQUERY_RE = /\$\s*\.\s*(get|post|getJSON)\s*\(/g;
  DIRECT_JQUERY_RE.lastIndex = 0;
  while ((m = DIRECT_JQUERY_RE.exec(content)) !== null) {
    const fn = m[1].toLowerCase();
    const method = fn === 'post' ? 'POST' : 'GET';
    const window = content.slice(m.index, m.index + 500);
    const enrichedWindow = enrichScriptTransportWindow(content, window, m.index);
    recordMatch(`$.${fn}()`, method, true, enrichedWindow, m.index);
  }

  const FETCH_RE = /\bfetch\s*\(/g;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(content)) !== null) {
    const window = content.slice(m.index, m.index + 500);
    const enrichedWindow = enrichScriptTransportWindow(content, window, m.index);
    const explicitMethod = extractTransportMethod(enrichedWindow);
    recordMatch(
      'fetch()',
      explicitMethod ?? 'GET',
      explicitMethod !== null,
      enrichedWindow,
      m.index
    );
  }

  const AJAX_RE = /\$\s*\.\s*ajax\s*\(/g;
  AJAX_RE.lastIndex = 0;
  while ((m = AJAX_RE.exec(content)) !== null) {
    const window = content.slice(m.index, m.index + 900);
    const enrichedWindow = enrichScriptTransportWindow(content, window, m.index);
    const explicitMethod = extractTransportMethod(enrichedWindow);
    const urlExpr = extractAjaxUrlExpression(enrichedWindow) ?? enrichedWindow;
    recordMatch('$.ajax()', explicitMethod ?? 'GET', explicitMethod !== null, urlExpr, m.index);
  }

  matches.sort((a, b) => b.confidence - a.confidence || a.sortLine - b.sortLine);
  if (matches.length === 0) return null;

  const best = matches[0];
  return {
    confidence: best.confidence,
    evidenceKind: best.evidenceKind,
    note: best.note,
    line: best.line,
  };
}

/**
 * Return transport evidence when the content of a Blade / PHP view file
 * contains an inline transport call that references `path` or `routeName`.
 *
 * Matching is intentionally conservative: the transport call and the path
 * must appear in close proximity rather than anywhere in the file.
 */
function findBladeTransportEvidence(
  content: string,
  path: string,
  routeName?: string,
  surfaceMethod?: string
): BladeTransportEvidence | null {
  const surfaceSegments = toComparablePathSegments(path);
  const normalizedSurfaceMethod = normalizeHttpMethod(surfaceMethod);
  const matches: Array<BladeTransportEvidence & { sortLine: number }> = [];

  const recordMatch = (
    transportLabel: string,
    transportMethod: string | null,
    methodExplicit: boolean,
    expr: string,
    matchIndex: number
  ): void => {
    const pathMatched = matchesPathExpression(expr, surfaceSegments);
    const routeMatched = routeName ? matchesRouteExpression(expr, routeName) : false;
    if (!pathMatched && !routeMatched) return;

    const methodKnown = normalizedSurfaceMethod !== null && transportMethod !== null;
    const methodContradicts = methodKnown && normalizedSurfaceMethod !== transportMethod;
    if (methodContradicts) return;

    const methodMatches = methodKnown;
    const confidence = methodMatches ? 0.75 : 0.65;
    const evidenceKind = routeMatched
      ? methodMatches
        ? 'blade-transport-route-and-method-reference'
        : 'blade-transport-route-reference'
      : methodMatches
        ? 'blade-transport-path-and-method-reference'
        : 'blade-transport-path-reference';

    const targetNote = routeMatched && routeName ? `route(${routeName})` : `path ${path}`;
    const line = lineNumberAt(content, matchIndex);

    matches.push({
      confidence,
      evidenceKind,
      line,
      sortLine: line,
      note: `${transportLabel} references ${targetNote}${transportMethod ? ` with ${transportMethod}${methodExplicit ? '' : ' default'}` : ''}`,
    });
  };

  let m: RegExpExecArray | null;

  const DIRECT_JQUERY_RE = /\$\s*\.\s*(get|post|getJSON)\s*\(/g;
  DIRECT_JQUERY_RE.lastIndex = 0;
  while ((m = DIRECT_JQUERY_RE.exec(content)) !== null) {
    const fn = m[1].toLowerCase();
    const method = fn === 'post' ? 'POST' : 'GET';
    const window = content.slice(m.index, m.index + 500);
    recordMatch(`$.${fn}()`, method, true, window, m.index);
  }

  const FETCH_RE = /\bfetch\s*\(/g;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(content)) !== null) {
    const window = content.slice(m.index, m.index + 500);
    const explicitMethod = extractTransportMethod(window);
    recordMatch('fetch()', explicitMethod ?? 'GET', explicitMethod !== null, window, m.index);
  }

  const AJAX_RE = /\$\s*\.\s*ajax\s*\(/g;
  AJAX_RE.lastIndex = 0;
  while ((m = AJAX_RE.exec(content)) !== null) {
    const window = content.slice(m.index, m.index + 900);
    const explicitMethod = extractTransportMethod(window);
    const urlExpr = extractAjaxUrlExpression(window) ?? window;
    recordMatch('$.ajax()', explicitMethod ?? 'GET', explicitMethod !== null, urlExpr, m.index);
  }

  matches.sort((a, b) => b.confidence - a.confidence || a.sortLine - b.sortLine);
  if (matches.length === 0) return null;

  const best = matches[0];
  return {
    confidence: best.confidence,
    evidenceKind: best.evidenceKind,
    note: best.note,
    ...(best.line ? { line: best.line } : {}),
  };
}

function extractTransportMethod(expr: string): string | null {
  const methodMatch =
    /(?:['"`](?:method|type)['"`]|method|type)\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i.exec(
      expr
    );
  return methodMatch ? methodMatch[1].toUpperCase() : null;
}

function enrichScriptTransportWindow(content: string, window: string, matchIndex: number): string {
  const contextPrefix = content.slice(Math.max(0, matchIndex - 500), matchIndex);

  const firstArgMatch = /^[^(]*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(window);
  const targetVariable = firstArgMatch?.[1];
  if (!targetVariable) return window;

  const assignmentRe = new RegExp(
    `(?:const|let|var)\\s+${targetVariable}\\s*=\\s*([^;\\n]+);?`,
    'g'
  );

  let assignmentExpr: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = assignmentRe.exec(contextPrefix)) !== null) {
    assignmentExpr = m[1];
  }

  if (!assignmentExpr) return window;
  return `${assignmentExpr}\n${window}`;
}

function extractAjaxUrlExpression(expr: string): string | null {
  const urlMatch =
    /(?:['"`]url['"`]|url)\s*:\s*([\s\S]{0,300}?)(?=,\s*(?:['"`][A-Za-z_][A-Za-z0-9_]*['"`]|[A-Za-z_][A-Za-z0-9_]*)\s*:|}\s*\)|\)\s*;|$)/.exec(
      expr
    );
  return urlMatch ? urlMatch[1] : null;
}

function matchesRouteExpression(expr: string, routeName: string): boolean {
  const escaped = routeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const routeRe = new RegExp(`\\broute\\s*\\(\\s*['"\`]${escaped}['"\`]\\s*(?:,|\\))`);
  return routeRe.test(expr);
}

function matchesPathExpression(expr: string, surfaceSegments: string[]): boolean {
  const candidates = extractComparablePathCandidates(expr);
  return candidates.some((candidate) =>
    arraysEqual(toComparablePathSegments(candidate), surfaceSegments)
  );
}

function extractComparablePathCandidates(expr: string): string[] {
  const candidates = new Set<string>();

  const joinedFragments = joinQuotedPathFragments(expr);
  if (joinedFragments) candidates.add(joinedFragments);

  const directLiteralRe = /['"`]([^'"`\n]*\/[^'"`\n]*)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = directLiteralRe.exec(expr)) !== null) {
    candidates.add(m[1]);
  }

  const urlHelperRe = /\burl\s*\(\s*([^)]+)\)/g;
  while ((m = urlHelperRe.exec(expr)) !== null) {
    const helperPath = joinQuotedPathFragments(m[1]);
    if (helperPath) candidates.add(helperPath);
  }

  return [...candidates].filter(Boolean);
}

function joinQuotedPathFragments(expr: string): string {
  const fragments: string[] = [];
  const quotedFragmentRe = /['"`]([^'"`\n]*\/[^'"`\n]*)['"`]/g;
  let m: RegExpExecArray | null;

  while ((m = quotedFragmentRe.exec(expr)) !== null) {
    fragments.push(m[1]);
  }

  return fragments.join('');
}

function toComparablePathSegments(path: string): string[] {
  return path
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\{[^}]+\}/g, '/')
    .replace(/[?#].*$/, '')
    .replace(/[\\]/g, '')
    .replace(/['"`]/g, '')
    .replace(/\s+/g, '')
    .replace(/\/+/g, '/')
    .split('/')
    .map((segment) => segment.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase())
    .filter(Boolean);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeHttpMethod(method?: string): string | null {
  return method ? method.toUpperCase() : null;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/** True for Blade templates and PHP files under view directories. */
function isBladeOrPhpViewFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.blade.php') || /\/views?\//.test(lower);
}

// ---------------------------------------------------------------------------
// Artifact-side propagation
// ---------------------------------------------------------------------------

/**
 * Expand from a surface to generated client artifacts that reference the surface's path.
 *
 * Uses explicit role classification — only `generated-client` and `schema-derived`
 * files receive `derived_from` edges.  Handwritten wrappers and ordinary service
 * files are skipped here; real wrappers are captured by consumer propagation.
 */
function runArtifactPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const meta = parseSurfaceMeta(surface);
  if (!meta.path) return 0;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceId = surface.id;

  const tsEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
  );

  for (const entry of tsEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';

    const role = classifyArtifactRole(entry.filePath, content);
    if (role === 'handwritten-wrapper' || role === 'ordinary-service') continue;

    if (!content || !content.includes(meta.path)) continue;

    const artifactNodeId = `file:${entry.filePath}`;
    const existingNode = db.getStructuralNode(artifactNodeId);
    if (!existingNode) continue;

    const edgeId = `${artifactNodeId}→${surfaceId}:derived_from:propagated`;
    const propEdge = {
      id: edgeId,
      edgeType: 'derived_from' as const,
      sourceNodeId: artifactNodeId,
      targetNodeId: surfaceId,
      sourceLanguage: entry.languageId ?? 'typescript',
      confidence: 0.8,
      confidenceClass: 'artifact-backed' as const,
      provenance: {
        resolver: 'propagation:artifact',
        evidenceKind: `artifact-role:${role}`,
        evidenceLocations: [
          { filePath: entry.filePath, note: `${role} artifact references ${meta.path}` },
        ],
        extractedAt: now,
      },
    };

    AssociationEngine.persistEdges(db, [propEdge]);
    added++;
  }

  return added;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SurfaceMeta {
  transport: string;
  method?: string;
  path?: string;
  routeName?: string;
  explicitProvider?: string;
  controllerMethod?: string;
}

function parseSurfaceMeta(surface: StructuralNode): SurfaceMeta {
  try {
    return JSON.parse(surface.metadata ?? '{}') as SurfaceMeta;
  } catch {
    return { transport: 'http' };
  }
}

interface SymbolWithRole {
  qualifiedName: string;
  role: 'request' | 'response';
  evidenceKind: string;
  syntheticNode?: StructuralNode;
}

/**
 * Combine LSP type-hierarchy evidence with PHP content regex analysis to find
 * request-validator and response-resource symbols linked to a controller.
 *
 * LSP path: reads `typeHierarchy` from enrichment metadata.
 * PHP path: extracts typed parameters from method signatures and resource
 *           classes from return expressions; resolves short names via `use` imports.
 *           When `controllerMethod` is provided the regex pass focuses on the
 *           named method body to reduce false positives from sibling methods.
 */
function findSymbolsLinkedToController(
  controllerFilePath: string,
  context: AssociationContext,
  controllerMethod?: string
): SymbolWithRole[] {
  const results: SymbolWithRole[] = [];

  const entry = context.entries.find((e) => e.filePath === controllerFilePath);
  if (!entry) return results;

  const pushUnique = (candidate: SymbolWithRole): void => {
    const key = candidate.syntheticNode?.id ?? candidate.qualifiedName;
    const exists = results.some((r) => (r.syntheticNode?.id ?? r.qualifiedName) === key);
    if (!exists) results.push(candidate);
  };

  const lspCandidates: SymbolWithRole[] = [];

  // ── Path 1: LSP type hierarchy ──────────────────────────────────────────────
  const lsp = entry.metadata?.lsp as Record<string, unknown> | undefined;
  if (lsp) {
    const typeHierarchy = lsp.typeHierarchy as
      Array<{ name: string; supertypes?: Array<{ name: string }> }> | undefined;
    if (typeHierarchy) {
      for (const sym of typeHierarchy) {
        const supers = sym.supertypes?.map((s) => s.name) ?? [];
        if (supers.some((s) => s.includes('FormRequest'))) {
          lspCandidates.push({
            qualifiedName: sym.name,
            role: 'request',
            evidenceKind: 'lsp-type-hierarchy',
          });
        } else if (supers.some((s) => s.includes('JsonResource') || s.includes('Resource'))) {
          lspCandidates.push({
            qualifiedName: sym.name,
            role: 'response',
            evidenceKind: 'lsp-type-hierarchy',
          });
        }
      }
    }
  }

  // ── Path 2: PHP content analysis ────────────────────────────────────────────
  const content = (entry.metadata?.content as string | undefined) ?? '';
  if (content) {
    // Scope analysis to the named method body when known, to avoid picking up
    // typed parameters or return expressions from unrelated sibling methods.
    const scope = controllerMethod ? extractMethodBody(content, controllerMethod) : content;

    const phpCandidates = findSymbolsViaPhpContent(scope);
    for (const candidate of phpCandidates) {
      pushUnique(candidate);
    }

    const roleSet = new Set(phpCandidates.map((candidate) => candidate.role));
    const inlineCandidates = findInlineContractsViaPhpContent(
      scope,
      controllerFilePath,
      controllerMethod,
      roleSet
    );
    for (const candidate of inlineCandidates) {
      pushUnique(candidate);
    }

    // When we know the concrete controller method and have PHP source, treat
    // method-scoped PHP evidence as primary truth. File-level LSP hierarchy is
    // too broad for shared controllers and can smear sibling FormRequests or
    // resources onto the wrong route method. Only fall back to LSP when PHP
    // analysis yields nothing for that method.
    if (controllerMethod && (phpCandidates.length > 0 || inlineCandidates.length > 0)) {
      return results;
    }
  }

  for (const candidate of lspCandidates) {
    pushUnique(candidate);
  }

  return results;
}

/**
 * Extract the body text of a named PHP method from a class definition.
 *
 * Returns the content of the method (from the opening `{` to the matching
 * closing `}`) plus the `use` import block at the top of the file so that
 * import resolution still works.
 *
 * Falls back to the full content if the method cannot be found.
 */
function extractMethodBody(content: string, methodName: string): string {
  // Capture import block (lines before the class declaration)
  const classStart = content.search(/^\s*(?:abstract\s+)?class\s+/m);
  const importBlock = classStart > 0 ? content.slice(0, classStart) : '';

  // Find the method declaration
  const methodRe = new RegExp(
    `(?:public|protected|private)\\s+(?:static\\s+)?(?:async\\s+)?function\\s+${methodName}\\s*\\(`,
    'i'
  );
  const methodMatch = methodRe.exec(content);
  if (!methodMatch) return content; // fallback

  // Find the opening brace of the method body (after the signature/params)
  const openBrace = findNextUnquotedBrace(content, methodMatch.index + methodMatch[0].length - 1);
  if (openBrace < 0) return content;

  const closeBrace = findMatchingPhpBrace(content, openBrace);
  if (closeBrace < 0) return content;

  // Include the full method text (signature + body) so typed parameter
  // extraction works correctly — params are in the signature, not the body.
  const methodText = content.slice(methodMatch.index, closeBrace + 1);
  return importBlock + methodText;
}

function findNextUnquotedBrace(content: string, fromIndex: number): number {
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = fromIndex; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    const prev = content[i - 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '#') {
      inLineComment = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '{') return i;
  }

  return -1;
}

function findMatchingPhpBrace(content: string, openBrace: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBrace; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    const prev = content[i - 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '#') {
      inLineComment = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** PHP name segments → short name. */
function phpShortName(name: string): string {
  return name.split('\\').pop()!;
}

function inferControllerMethodScope(
  controllerMethod: string | undefined,
  controllerNodeId: string
): string | undefined {
  if (controllerMethod) return controllerMethod;

  const methodMatch = /@([A-Za-z_][A-Za-z0-9_]*)$/.exec(controllerNodeId);
  return methodMatch?.[1];
}

/**
 * Resolve a PHP symbol name to a DB node, trying the full qualified name first
 * then the trailing short-name segment (handles both indexed formats).
 */
function resolvePhpSymbolNode(
  db: LuxDatabase,
  qualifiedName: string
): { nodeId: string; node: StructuralNode } | null {
  const qualified = `symbol:php:${qualifiedName}`;
  const qNode = db.getStructuralNode(qualified);
  if (qNode) return { nodeId: qualified, node: qNode };

  const short = phpShortName(qualifiedName);
  if (short !== qualifiedName) {
    const shortId = `symbol:php:${short}`;
    const sNode = db.getStructuralNode(shortId);
    if (sNode) return { nodeId: shortId, node: sNode };
  }

  return null;
}

/**
 * Regex-based PHP content analysis.
 *
 * Finds request-validator and response-resource class references from:
 *  1. Method parameter type-hints (e.g. `StoreInvoiceRequest $request`)
 *  2. Return expressions with `new XResource(` or `XResource::collection(`
 *  3. `use` import statements to resolve short names to qualified names.
 *
 * Excludes bare base classes (Request, FormRequest) that are too generic.
 */
function findSymbolsViaPhpContent(content: string): SymbolWithRole[] {
  const results: SymbolWithRole[] = [];

  // Build import map: shortName → qualifiedName
  const importMap = new Map<string, string>();
  const useRe = /^use\s+((?:[A-Za-z][A-Za-z0-9_]*\\)*[A-Za-z][A-Za-z0-9_]*)(?:\s+as\s+(\w+))?;/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    const qualified = m[1];
    const alias = m[2];
    const short = alias ?? phpShortName(qualified);
    importMap.set(short, qualified);
  }

  const addCandidate = (
    shortName: string,
    role: SymbolWithRole['role'],
    evidenceKind: string
  ): void => {
    const qualifiedName = importMap.get(shortName) ?? shortName;
    if (!results.some((r) => r.qualifiedName === qualifiedName)) {
      results.push({ qualifiedName, role, evidenceKind });
    }
  };

  // Typed parameters in method signatures ending in Request, Validator, or FormRequest
  // Excludes bare base-class names.
  const paramRe = /([A-Z][A-Za-z0-9_]*(?:Request|Validator|FormRequest))\s+\$\w+/g;
  while ((m = paramRe.exec(content)) !== null) {
    const name = m[1];
    if (name === 'Request' || name === 'FormRequest') continue;
    addCandidate(name, 'request', 'php-typed-parameter');
  }

  // `new XResource(` / `new XResponse(` / `new XDto(` in any expression
  const newInstanceRe = /\bnew\s+([A-Z][A-Za-z0-9_]*(?:Resource|Response|DTO|Dto|Contract))\s*\(/g;
  while ((m = newInstanceRe.exec(content)) !== null) {
    addCandidate(m[1], 'response', 'php-return-constructor');
  }

  // Static factory calls: XResource::collection(...) / XResource::make(...) / XResource::from(...)
  const staticFactoryRe =
    /([A-Z][A-Za-z0-9_]*(?:Resource|Response|DTO|Dto|Contract))::(?:collection|make|from)\s*\(/g;
  while ((m = staticFactoryRe.exec(content)) !== null) {
    addCandidate(m[1], 'response', 'php-static-factory');
  }

  return results;
}

function findInlineContractsViaPhpContent(
  content: string,
  controllerFilePath: string,
  controllerMethod: string | undefined,
  explicitRoles: ReadonlySet<'request' | 'response'>
): SymbolWithRole[] {
  const results: SymbolWithRole[] = [];
  const methodLabel = controllerMethod ?? 'method';
  const now = Math.floor(Date.now() / 1000);

  if (!explicitRoles.has('request')) {
    const hasInlineValidator =
      /\$request->validate\s*\(\s*\[/.test(content) ||
      /\bValidator::make\s*\(/.test(content) ||
      // Laravel global helper: validator($data, [ ... ])
      /\bvalidator\s*\(\s*[\s\S]*?,\s*\[/.test(content);

    if (hasInlineValidator) {
      const node = buildInlineContractNode(
        controllerFilePath,
        methodLabel,
        'request',
        'inline-validator',
        `${methodLabel} inline validator`,
        now
      );
      results.push({
        qualifiedName: node.id,
        role: 'request',
        evidenceKind: 'php-inline-validator',
        syntheticNode: node,
      });
    }
  }

  if (!explicitRoles.has('response')) {
    const hasDirectJsonArray =
      /\breturn\s+response(?:\(\))?->json\s*\(\s*\[/.test(content) ||
      /\breturn\s+response\s*\(\s*\[/.test(content);
    const hasVariableJsonResponse =
      /\breturn\s+response(?:\(\))?->json\s*\(\s*\$[A-Za-z_][A-Za-z0-9_]*/.test(content) &&
      (/\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*\[/.test(content) ||
        /\$[A-Za-z_][A-Za-z0-9_]*\s*=.*->toArray\s*\(/s.test(content));

    if (hasDirectJsonArray || hasVariableJsonResponse) {
      const node = buildInlineContractNode(
        controllerFilePath,
        methodLabel,
        'response',
        'inline-json-response',
        `${methodLabel} inline json response`,
        now
      );
      results.push({
        qualifiedName: node.id,
        role: 'response',
        evidenceKind: 'php-inline-json-response',
        syntheticNode: node,
      });
    }
  }

  return results;
}

function buildInlineContractNode(
  controllerFilePath: string,
  controllerMethod: string,
  role: 'request' | 'response',
  kind: string,
  label: string,
  updatedAt: number
): StructuralNode {
  const meta: TransportContractMetadata = {
    transport: 'http',
    side: role,
    contractKind: kind === 'inline-validator' ? 'inline-validator' : 'inline-json',
    shapeConfidence: 'exact',
    method: controllerMethod,
    synthetic: true,
    role,
    // Keep legacy field for backwards compatibility during transition
    contractKindLegacy: kind,
  };
  return {
    id: `contract:php:${controllerFilePath}#${controllerMethod}:${kind}`,
    node_type: 'contract',
    file_path: controllerFilePath,
    language_id: 'php',
    symbol_name: label,
    qualified_name: `${controllerFilePath}#${controllerMethod}:${kind}`,
    metadata: JSON.stringify(meta),
    updated_at: updatedAt,
  };
}

/**
 * Build a synthetic coarse contract node for a controller method.
 *
 * Coarse contracts are first-class structural truth — they describe the
 * transport shape honestly when Lux cannot claim exact schema identity.
 */
function buildCoarseContractNode(
  controllerFilePath: string,
  controllerMethod: string,
  side: 'request' | 'response',
  contractKind: TransportContractMetadata['contractKind'],
  label: string,
  updatedAt: number,
  overrides: Partial<TransportContractMetadata> = {}
): StructuralNode {
  const meta: TransportContractMetadata = {
    transport: 'http',
    side,
    contractKind,
    shapeConfidence: 'coarse',
    method: controllerMethod,
    synthetic: true,
    role: side,
    ...overrides,
  };
  return {
    id: `contract:php:${controllerFilePath}#${controllerMethod}:${contractKind}`,
    node_type: 'contract',
    file_path: controllerFilePath,
    language_id: 'php',
    symbol_name: label,
    qualified_name: `${controllerFilePath}#${controllerMethod}:${contractKind}`,
    metadata: JSON.stringify(meta),
    updated_at: updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Coarse response and request inference
// ---------------------------------------------------------------------------

/**
 * Infer coarse response contract kind from PHP method body content.
 *
 * Detection order follows the provider-side preference from the spec:
 *   1. inline-json (explicit json() helper with literal data)
 *   2. scalar-response (text / string response helpers)
 *   3. redirect-response (redirect helpers)
 *   4. page-response (Inertia, view helpers)
 *   5. native-array-response (return [...] / return array(...))
 *   6. native-object-response (return $var; where var is computed object/model)
 *   7. empty-ack / explicit-empty-return (return;)
 *   8. empty-ack / framework-null-coercion (return null;)
 *   9. empty-ack / implicit-fallthrough (side effect, no return)
 *  10. null (no coarse response evidence found)
 *
 * This function intentionally does NOT emit serialized-model-response or
 * serialized-collection-response — those require adapter-backed evidence
 * and are handled in `inferAdapterBackedResponseKind`.
 */
function inferCoarseResponseKind(content: string): {
  contractKind: TransportContractMetadata['contractKind'];
  evidenceSubtype?: string;
  interactionKind?: TransportContractMetadata['interactionKind'];
  framework?: string;
  frameworkSignal?: string;
  responseSignals?: string[];
} | null {
  const signals: string[] = [];

  // 1. inline-json: response()->json([...]) or response()->json($var)
  if (
    /\breturn\s+response\s*\(\s*\)->json\s*\(/.test(content) ||
    /\breturn\s+response\s*\(\s*\)->json\s*\(/.test(content) ||
    /\breturn\s+response\s*\(\s*\)->json\s*\(/.test(content)
  ) {
    signals.push('response()->json()');
    return {
      contractKind: 'inline-json',
      interactionKind: 'query',
      frameworkSignal: 'response()->json()',
      responseSignals: signals,
    };
  }
  if (/\breturn\s+response\s*\(\s*\[/.test(content)) {
    signals.push('response([...])');
    return {
      contractKind: 'inline-json',
      interactionKind: 'query',
      frameworkSignal: 'response([...])',
      responseSignals: signals,
    };
  }

  // 2. scalar-response: response('string', ...) or text-like returns
  if (/\breturn\s+response\s*\(\s*['"]/.test(content)) {
    signals.push('response(string)');
    return {
      contractKind: 'scalar-response',
      interactionKind: 'command',
      frameworkSignal: 'response(string)',
      responseSignals: signals,
    };
  }

  // 3. redirect-response
  if (/\breturn\s+redirect\s*\(/.test(content) || /\breturn\s+redirect\s*\(\s*\)->/.test(content)) {
    signals.push('redirect()');
    return {
      contractKind: 'redirect-response',
      interactionKind: 'redirect',
      frameworkSignal: 'redirect()',
      responseSignals: signals,
    };
  }

  // 4. page-response: Inertia, view()
  if (/\bInertia\s*::\s*render\s*\(/.test(content)) {
    signals.push('Inertia::render()');
    return {
      contractKind: 'page-response',
      interactionKind: 'page',
      framework: 'inertia',
      frameworkSignal: 'Inertia::render()',
      responseSignals: signals,
    };
  }
  if (/\breturn\s+inertia\s*\(/.test(content)) {
    signals.push('inertia()');
    return {
      contractKind: 'page-response',
      interactionKind: 'page',
      framework: 'inertia',
      frameworkSignal: 'inertia()',
      responseSignals: signals,
    };
  }
  if (/\breturn\s+view\s*\(/.test(content)) {
    signals.push('view()');
    return {
      contractKind: 'page-response',
      interactionKind: 'page',
      framework: 'laravel',
      frameworkSignal: 'view()',
      responseSignals: signals,
    };
  }

  // 5. native-array-response: PHP array literal in return position.
  // Distinct from inline-json (which requires a framework response helper).
  // Ordered before empty-ack so `return [];` is classified as array, not empty.
  if (/\breturn\s+\[/.test(content) || /\breturn\s+array\s*\(/.test(content)) {
    return {
      contractKind: 'native-array-response',
      interactionKind: 'query',
      frameworkSignal: 'return-array-literal',
    };
  }

  // 6. native-object-response: return of a computed variable that is likely
  // an object or model, without adapter-backed serialization evidence.
  // Only fires when a non-trivial expression preceded the return — guard against
  // `return $request->something()` being picked up (that's a response helper path,
  // not a native object return), and against simple `return $bool;` chains.
  //
  // Pattern: `return $variable;` where $variable was built via a method chain
  // or constructor call in the same scope.
  if (
    /\breturn\s+\$[a-z][A-Za-z0-9_]*\s*;/.test(content) &&
    /\$[a-z][A-Za-z0-9_]*\s*=\s*(?:new\s+[A-Z]|\$[a-z][A-Za-z0-9_]*->|[A-Z][A-Za-z0-9_]*::)/.test(
      content
    )
  ) {
    return {
      contractKind: 'native-object-response',
      interactionKind: 'query',
      frameworkSignal: 'return-computed-variable',
    };
  }

  // 7. empty-ack / explicit-empty-return
  if (/\breturn\s*;/.test(content)) {
    return {
      contractKind: 'empty-ack',
      interactionKind: 'command',
      evidenceSubtype: 'explicit-empty-return',
      frameworkSignal: 'return;',
    };
  }

  // 8. empty-ack / framework-null-coercion: explicit `return null;`
  // Laravel and other frameworks coerce null returns to empty/204 responses.
  // This is distinct from implicit-fallthrough (which has side effects and no
  // return) and from explicit-empty-return (which is a bare `return;`).
  if (/\breturn\s+null\s*;/.test(content)) {
    return {
      contractKind: 'empty-ack',
      interactionKind: 'command',
      evidenceSubtype: 'framework-null-coercion',
      frameworkSignal: 'return null;',
    };
  }

  // 9. empty-ack / implicit-fallthrough: side-effecting pattern with no return
  const hasExplicitReturn = /\breturn\b/.test(content);
  const hasSideEffect =
    /\b(?:save|create|update|delete|dispatch|fire|event|push|store|attach|detach|sync)\s*\(/.test(
      content
    );
  if (!hasExplicitReturn && hasSideEffect) {
    return {
      contractKind: 'empty-ack',
      interactionKind: 'command',
      evidenceSubtype: 'implicit-fallthrough',
      frameworkSignal: 'no-return+side-effect',
    };
  }

  return null;
}

/**
 * Infer coarse request contract from PHP method body content.
 *
 * Returns route-bound-input when typed route model binding is present,
 * or implicit-input-shape when request fields are read via helpers or
 * Laravel's magic request-property access.
 */
function inferCoarseRequestKind(content: string): {
  contractKind: 'route-bound-input' | 'implicit-input-shape';
  boundParams?: Array<{ param: string; type: string }>;
  inputSignals?: string[];
} | null {
  // Route-bound input: typed method params that are not base Request types
  const routeBindingRe = /([A-Z][A-Za-z0-9_]+)\s+\$([a-z][A-Za-z0-9_]*)\b(?!\s*(?:=|->validate))/g;
  const boundParams: Array<{ param: string; type: string }> = [];
  const baseTypes = new Set(['Request', 'FormRequest', 'string', 'int', 'bool', 'array', 'float']);
  let m: RegExpExecArray | null;

  // Only look in function signature (before first {)
  const signatureEnd = content.indexOf('{');
  const signature = signatureEnd > 0 ? content.slice(0, signatureEnd) : content;

  while ((m = routeBindingRe.exec(signature)) !== null) {
    const typeName = m[1];
    const paramName = m[2];
    if (!baseTypes.has(typeName)) {
      boundParams.push({ param: paramName, type: typeName });
    }
  }

  if (boundParams.length > 0) {
    return { contractKind: 'route-bound-input', boundParams };
  }

  // Implicit input shape: request helpers plus Laravel's magic property access.
  const inputSignals = new Set<string>();
  const inputFieldRe =
    /\$request\s*->\s*(?:input|get|query|has|filled|missing|boolean)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = inputFieldRe.exec(content)) !== null) {
    inputSignals.add(m[1]);
  }

  const requestPropertyRe = /\$request\s*->\s*([a-z_][A-Za-z0-9_]*)\b(?!\s*\()/g;
  while ((m = requestPropertyRe.exec(content)) !== null) {
    inputSignals.add(m[1]);
  }

  if (inputSignals.size >= 1) {
    return { contractKind: 'implicit-input-shape', inputSignals: [...inputSignals].sort() };
  }

  return null;
}

/**
 * Adapter-gated serialized response inference.
 *
 * Only emits serialized-model-response or serialized-collection-response when
 * both adapter-backed runtime knowledge AND strong local shape evidence exist.
 *
 * Currently gates on Laravel's implicit API Resource serialization pattern:
 *   - `return new XResource(...)` with a known adapter context (handled_by a
 *     controller in app/Http/) — but that's the explicit path.
 *
 * For coarse detection, this emits only when there is:
 *   1. A native array or object return AND
 *   2. The controller lives under a well-known API controller path.
 *
 * Returns null otherwise to fall back to `native-array-response` or
 * `native-object-response`, which is the trust-preserving default.
 */
function inferAdapterBackedResponseKind(
  content: string,
  controllerFilePath: string
): {
  contractKind: 'serialized-model-response' | 'serialized-collection-response';
  frameworkSignal: string;
} | null {
  const isApiController = /app[/\\]Http[/\\]Controllers[/\\]Api[/\\]/i.test(controllerFilePath);
  if (!isApiController) return null;

  // Only emit when there is a direct return of a model or model collection.
  // Match both static class calls (Model::all()) and variable calls ($model->all()).
  const collectionPattern =
    /\breturn\s+(?:\$[a-z][A-Za-z0-9_]*|[A-Z][A-Za-z0-9_]*)(?:->|::)(?:all|paginate|get|latest|oldest)\s*\(/.test(
      content
    );
  if (collectionPattern) {
    return {
      contractKind: 'serialized-collection-response',
      frameworkSignal: 'eloquent-collection-return-in-api-controller',
    };
  }

  const modelPattern =
    /\breturn\s+\$[a-z][A-Za-z0-9_]*;/.test(content) &&
    /\b(?:find|firstOrFail|findOrFail|create|updateOrCreate|firstOrCreate)\s*\(/.test(content);
  if (modelPattern) {
    return {
      contractKind: 'serialized-model-response',
      frameworkSignal: 'eloquent-model-return-in-api-controller',
    };
  }

  return null;
}

/**
 * Infer interaction kind from coarse response kind when not already set.
 */
function interactionKindFromResponseKind(
  contractKind: TransportContractMetadata['contractKind']
): TransportContractMetadata['interactionKind'] | undefined {
  switch (contractKind) {
    case 'page-response':
      return 'page';
    case 'redirect-response':
      return 'redirect';
    case 'inline-json':
    case 'native-array-response':
    case 'native-object-response':
    case 'serialized-model-response':
    case 'serialized-collection-response':
      return 'query';
    case 'empty-ack':
    case 'scalar-response':
      return 'command';
    case 'file-response':
      return 'stream';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Coarse propagation integration
// ---------------------------------------------------------------------------

/**
 * Run coarse contract inference for a single controller method scope.
 *
 * Emits `validates_with` and `returns_contract` edges from the controller node
 * to synthetic coarse contract nodes. Only runs when the existing explicit
 * analysis did not already fill the given role.
 *
 * Method scope is mandatory — all coarse inference is confined to the extracted
 * method body to prevent sibling-method smearing.
 */
function runCoarseContractInference(
  db: LuxDatabase,
  controllerNodeId: string,
  controllerFilePath: string,
  methodScope: string,
  methodBody: string,
  existingRoles: ReadonlySet<'request' | 'response'>,
  now: number
): number {
  let added = 0;

  // --- Request side ---
  if (!existingRoles.has('request')) {
    const requestInference = inferCoarseRequestKind(methodBody);
    if (requestInference) {
      const { contractKind, boundParams, inputSignals } = requestInference;
      const label =
        contractKind === 'route-bound-input'
          ? `${methodScope} route-bound input`
          : `${methodScope} implicit input shape`;

      const node = buildCoarseContractNode(
        controllerFilePath,
        methodScope,
        'request',
        contractKind,
        label,
        now,
        {
          ...(boundParams ? { boundParams } : {}),
          ...(inputSignals ? { inputSignals } : {}),
        }
      );
      db.upsertStructuralNode(node);

      const edgeId = `${controllerNodeId}→${node.id}:validates_with:coarse`;
      AssociationEngine.persistEdges(db, [
        {
          id: edgeId,
          edgeType: 'validates_with',
          sourceNodeId: controllerNodeId,
          targetNodeId: node.id,
          sourceLanguage: 'php',
          targetLanguage: 'php',
          confidence: contractKind === 'route-bound-input' ? 0.7 : 0.6,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: 'propagation:provider:coarse',
            evidenceKind: `coarse-${contractKind}`,
            evidenceLocations: [
              {
                filePath: controllerFilePath,
                note: `${contractKind} [method:${methodScope}]`,
              },
            ],
            extractedAt: now,
          },
        },
      ]);
      added++;
    }
  }

  // --- Response side ---
  if (!existingRoles.has('response')) {
    // Try adapter-backed serialized inference first (conservative)
    const adapterBacked = inferAdapterBackedResponseKind(methodBody, controllerFilePath);
    const coarseKind = adapterBacked ?? inferCoarseResponseKind(methodBody);

    if (coarseKind) {
      const contractKind = 'contractKind' in coarseKind ? coarseKind.contractKind : null;
      if (!contractKind) return added;

      const label = `${methodScope} ${contractKind}`;
      const interactionKind =
        ('interactionKind' in coarseKind ? coarseKind.interactionKind : undefined) ??
        interactionKindFromResponseKind(contractKind);

      const node = buildCoarseContractNode(
        controllerFilePath,
        methodScope,
        'response',
        contractKind,
        label,
        now,
        {
          ...('evidenceSubtype' in coarseKind && coarseKind.evidenceSubtype
            ? { evidenceSubtype: coarseKind.evidenceSubtype }
            : {}),
          ...('frameworkSignal' in coarseKind && coarseKind.frameworkSignal
            ? { frameworkSignal: coarseKind.frameworkSignal }
            : {}),
          ...('framework' in coarseKind && (coarseKind as { framework?: string }).framework
            ? { framework: (coarseKind as { framework?: string }).framework }
            : {}),
          ...('responseSignals' in coarseKind && coarseKind.responseSignals
            ? { responseSignals: coarseKind.responseSignals }
            : {}),
          ...(interactionKind ? { interactionKind } : {}),
        }
      );
      db.upsertStructuralNode(node);

      const isAdapterBacked = adapterBacked !== null;
      const edgeId = `${controllerNodeId}→${node.id}:returns_contract:coarse`;
      AssociationEngine.persistEdges(db, [
        {
          id: edgeId,
          edgeType: 'returns_contract',
          sourceNodeId: controllerNodeId,
          targetNodeId: node.id,
          sourceLanguage: 'php',
          targetLanguage: 'php',
          confidence: isAdapterBacked ? 0.7 : 0.6,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: 'propagation:provider:coarse',
            evidenceKind: isAdapterBacked
              ? `adapter-backed-${contractKind}`
              : `coarse-${contractKind}`,
            evidenceLocations: [
              {
                filePath: controllerFilePath,
                note: `${contractKind} [method:${methodScope}]`,
              },
            ],
            extractedAt: now,
          },
        },
      ]);
      added++;
    }
  }

  return added;
}

interface ConsumerCandidate {
  name: string;
  /** Line index (0-based) of the function declaration. */
  startLine: number;
}

function resolveConsumerSymbolNode(
  db: LuxDatabase,
  filePath: string,
  candidateName: string
): StructuralNode | null {
  const directIds = [
    `symbol:ts:${filePath}#${candidateName}`,
    `symbol:tsx:${filePath}#${candidateName}`,
    `symbol:js:${filePath}#${candidateName}`,
    `symbol:jsx:${filePath}#${candidateName}`,
    `symbol:javascript:${filePath}#${candidateName}`,
    `symbol:typescript:${filePath}#${candidateName}`,
    `symbol:vue:${filePath}#${candidateName}`,
  ];

  for (const id of directIds) {
    const node = db.getStructuralNode(id);
    if (node) return node;
  }

  const fileNodes = db.getStructuralNodesByFilePath(filePath);
  const exactByName = fileNodes.find(
    (node) => node.node_type === 'symbol' && node.symbol_name === candidateName
  );
  if (exactByName) return exactByName;

  const exactByQualified = fileNodes.find(
    (node) => node.node_type === 'symbol' && node.qualified_name === candidateName
  );
  if (exactByQualified) return exactByQualified;

  const suffix = `#${candidateName}`;
  const byIdSuffix = fileNodes.find(
    (node) => node.node_type === 'symbol' && node.id.endsWith(suffix)
  );
  if (byIdSuffix) return byIdSuffix;

  return null;
}

/**
 * Find the nearest function-like anchors around a proven transport callsite.
 * Supports exported wrappers, file-scoped helpers, and object or class methods.
 */
function extractConsumerCandidates(lines: string[], evidenceLine: number): ConsumerCandidate[] {
  const results: ConsumerCandidate[] = [];
  const minLine = Math.max(0, evidenceLine - 40);
  const maxLine = Math.min(lines.length - 1, evidenceLine + 2);
  const seen = new Set<string>();

  const record = (name: string, startLine: number): void => {
    if (seen.has(name)) return;
    seen.add(name);
    results.push({ name, startLine });
  };

  for (let j = evidenceLine; j >= minLine; j--) {
    const line = lines[j];

    const fnMatch = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
    if (fnMatch) record(fnMatch[1], j);

    const arrowMatch =
      /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.exec(
        line
      );
    if (arrowMatch) record(arrowMatch[1], j);

    const methodMatch =
      /^\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{?\s*,?\s*$/.exec(line);
    if (methodMatch && !isControlKeyword(methodMatch[1])) record(methodMatch[1], j);

    if (results.length >= 4) break;
  }

  for (let j = evidenceLine + 1; j <= maxLine; j++) {
    const methodMatch =
      /^\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{?\s*,?\s*$/.exec(lines[j]);
    if (methodMatch && !isControlKeyword(methodMatch[1])) {
      record(methodMatch[1], j);
      break;
    }
  }

  return results;
}

function isControlKeyword(name: string): boolean {
  return new Set(['if', 'for', 'while', 'switch', 'catch']).has(name);
}

// ---------------------------------------------------------------------------
// Artifact role classification
// ---------------------------------------------------------------------------

/**
 * Explicit artifact roles for TS/JS files.
 *
 * - generated-client: strong code-generation evidence (header, /generated/ dir)
 * - schema-derived: structurally downstream of schema/contract generation
 * - handwritten-wrapper: manually written transport wrapper — consumer-side
 * - ordinary-service: general utility/service with no artifact evidence
 */
export type ArtifactRole =
  'generated-client' | 'schema-derived' | 'handwritten-wrapper' | 'ordinary-service';

/** Matches generation markers in file headers (first ~1 000 chars). */
const GENERATION_HEADER_RE =
  /(?:@generated|auto[\s-]?generated|generated by|do not edit|auto[\s-]?generated[\s\S]{0,40}do not edit)/i;

/**
 * True for checked-in distribution assets (vendored JS, Swagger UI bundles, etc.)
 * that must never receive `derived_from` edges regardless of their content.
 *
 * Covered trees:
 *  - `public/vendor/`  — bundled third-party JS distributed with the app
 *  - `public/swagger-ui/` — Swagger UI static distribution
 *  - `vendor/`         — PHP Composer vendor directory (usually filtered at scanner level)
 *  - `node_modules/`   — NPM dependencies (usually filtered at scanner level)
 */
function isVendoredPublicAsset(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    /(?:^|\/)public\/vendor\//.test(lower) ||
    /(?:^|\/)public\/swagger-ui\//.test(lower) ||
    /(?:^|\/)vendor\//.test(lower) ||
    /(?:^|\/)node_modules\//.test(lower)
  );
}

/**
 * Classify a TS/JS file into an artifact role using multi-signal evidence.
 *
 * Precedence (highest first):
 *  0. Vendored/distribution asset tree → ordinary-service (hard exclusion)
 *  1. Generation header in file content → generated-client
 *  2. Lives in /generated/ or /__generated__/ directory → generated-client
 *  3. OpenAPI/Swagger naming outside a wrapper directory → schema-derived
 *  4. Wrapper-directory location (api/, services/, hooks/, use-*) → handwritten-wrapper
 *  5. Otherwise → ordinary-service
 */
function classifyArtifactRole(filePath: string, content: string): ArtifactRole {
  const lower = filePath.toLowerCase();

  // Signal 0: hard exclusion for vendored/distribution asset trees
  if (isVendoredPublicAsset(filePath)) {
    return 'ordinary-service';
  }

  // Signal 1: explicit generation marker in the file header
  if (GENERATION_HEADER_RE.test(content.slice(0, 1000))) {
    return 'generated-client';
  }

  // Signal 2: canonical generated-output directory
  if (lower.includes('/generated/') || lower.includes('/__generated__/')) {
    return 'generated-client';
  }

  // Signal 3: OpenAPI / Swagger artifact — strong schema-derivation cue
  const isOpenApiNaming = lower.includes('openapi') || lower.includes('swagger');
  const isInWrapperDir = /\/api\/|\/services\/|\/hooks\//.test(lower) || lower.includes('use-');

  if (isOpenApiNaming && !isInWrapperDir) {
    return 'schema-derived';
  }

  // Signal 4: typical wrapper-directory patterns → treat as handwritten wrapper
  // (consumer-side; do NOT receive derived_from edges)
  const isClientSuffix = lower.endsWith('.client.ts') || lower.endsWith('.client.js');
  if (isInWrapperDir || isClientSuffix) {
    return 'handwritten-wrapper';
  }

  return 'ordinary-service';
}
