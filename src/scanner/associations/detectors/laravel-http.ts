// LaravelHttpSurfaceDetector — HTTP capability declaration detector.
//
// Detects HTTP capability surfaces from Laravel route declarations.
//
// Emits:
//   - capability-surface nodes for each detected HTTP route
//   - declares_surface edge from the declaring file to each surface
//   - handled_by edge from surface to controller symbol ONLY when the
//     declaration explicitly names the controller and method
//
// Handles route groups:
//   - Route::prefix('api')->group(function () { ... })
//   - Route::group(['prefix' => 'admin'], function () { ... })
//   - Arbitrarily nested groups, composing canonical external paths
//
// Does NOT:
//   - infer controllers through naming conventions
//   - resolve consumer-side chains
//   - attach contracts or artifacts (those belong to propagation)

import { posix as pathPosix } from 'node:path';
import type {
  AssociationContext,
  CapabilitySurfaceNode,
  StructuralRelationEdge,
} from '../types.js';
import { httpSurfaceNodeId, fileNodeId, phpSymbolNodeId } from '../types.js';
import type { CapabilitySurfaceDetector, DetectedSurfaceBatch } from './types.js';

// ---------------------------------------------------------------------------
// Regex patterns — route declarations (applied to already-scoped content)
// ---------------------------------------------------------------------------

/**
 * Matches: Route::get('/path', [Controller::class, 'method'])
 * Capture groups: 1=method, 2=path, 3=controller, 4=action
 */
const ROUTE_CONTROLLER_ARRAY =
  /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*([A-Za-z_\\]+)::class\s*,\s*['"]([^'"]+)['"]\s*\]/gi;

/**
 * Matches: Route::get('/path', InvokableController::class)
 * Capture groups: 1=method, 2=path, 3=controller
 */
const ROUTE_INVOKABLE =
  /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_\\]+)::class\s*\)/gi;

/**
 * Matches: Route::get('/path', 'Api\\InvoiceController@index')
 * Capture groups: 1=method, 2=path, 3=controller, 4=action
 */
const ROUTE_CONTROLLER_STRING =
  /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([A-Za-z_\\]+)@([^'"]+)['"]\s*\)/gi;

/**
 * Matches: Route::get('/path', function()
 * Capture groups: 1=method, 2=path
 */
const ROUTE_CLOSURE =
  /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\(/gi;

/**
 * Matches: ->name('route.name')
 */
const ROUTE_NAME = /->name\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Allowlist of helper function names that may wrap literal route path arguments. */
const PATH_HELPER_ALLOWLIST = new Set(['pathLookup']);

/**
 * Matches: Route::get(pathLookup('/path'), [Controller::class, 'method'])
 * Capture groups: 1=method, 2=helper, 3=path, 4=controller, 5=action
 */
const ROUTE_CONTROLLER_ARRAY_WRAPPED =
  /Route::(get|post|put|patch|delete|any)\(\s*([A-Za-z_][A-Za-z0-9_]*)\(\s*['"]([^'"]+)['"]\s*\)\s*,\s*\[\s*([A-Za-z_\\]+)::class\s*,\s*['"]([^'"]+)['"]\s*\]/gi;

/**
 * Matches: Route::get(pathLookup('/path'), InvokableController::class)
 * Capture groups: 1=method, 2=helper, 3=path, 4=controller
 */
const ROUTE_INVOKABLE_WRAPPED =
  /Route::(get|post|put|patch|delete|any)\(\s*([A-Za-z_][A-Za-z0-9_]*)\(\s*['"]([^'"]+)['"]\s*\)\s*,\s*([A-Za-z_\\]+)::class\s*\)/gi;

/**
 * Matches: Route::get(pathLookup('/path'), 'Api\\InvoiceController@index')
 * Capture groups: 1=method, 2=helper, 3=path, 4=controller, 5=action
 */
const ROUTE_CONTROLLER_STRING_WRAPPED =
  /Route::(get|post|put|patch|delete|any)\(\s*([A-Za-z_][A-Za-z0-9_]*)\(\s*['"]([^'"]+)['"]\s*\)\s*,\s*['"]([A-Za-z_\\]+)@([^'"]+)['"]\s*\)/gi;

/**
 * Matches: Route::get(pathLookup('/path'), function()
 * Capture groups: 1=method, 2=helper, 3=path
 */
const ROUTE_CLOSURE_WRAPPED =
  /Route::(get|post|put|patch|delete|any)\(\s*([A-Za-z_][A-Za-z0-9_]*)\(\s*['"]([^'"]+)['"]\s*\)\s*,\s*function\s*\(/gi;

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector
// ---------------------------------------------------------------------------

export class LaravelHttpSurfaceDetector implements CapabilitySurfaceDetector {
  readonly name = 'laravel-http-surfaces';

  supports(context: AssociationContext): boolean {
    return context.entries.some((e) => isEligibleRouteSource(e));
  }

  // A failure rejects rather than returning an empty batch: runDetectors reports a detector that
  // threw as a warning, while an empty batch would read as "this repository has no routes".
  detect(context: AssociationContext): Promise<DetectedSurfaceBatch> {
    return new Promise((resolve) => resolve(this.detectSync(context)));
  }

  private detectSync(context: AssociationContext): DetectedSurfaceBatch {
    const surfaces: CapabilitySurfaceNode[] = [];
    const edges: StructuralRelationEdge[] = [];
    const now = Math.floor(Date.now() / 1000);

    const routeEntries = context.entries.filter((e) => isEligibleRouteSource(e));
    const routeRegistrations = collectRouteFileRegistrations(context);

    for (const entry of routeEntries) {
      const content = (entry.metadata?.content as string | undefined) ?? '';
      if (!content) continue;

      const fileId = fileNodeId(entry.filePath);
      const detectedRoutes = parseRouteDeclarations(
        content,
        entry.filePath,
        routeRegistrations.get(entry.filePath)
      );

      for (const route of detectedRoutes) {
        const surfaceId = httpSurfaceNodeId(route.method, route.path);
        const handle = `${route.method.toUpperCase()} ${route.path}`;

        const surfaceNode: CapabilitySurfaceNode = {
          id: surfaceId,
          handle,
          transport: 'http',
          file_path: entry.filePath,
          metadata: {
            transport: 'http',
            method: route.method.toUpperCase(),
            path: route.path,
            localFragment: route.localFragment,
            pathWrapper: route.pathWrapper,
            routeName: route.routeName,
            aliases: route.routeName ? [route.routeName] : undefined,
            explicitProvider: route.controllerQualifiedName,
            controllerMethod: route.controllerMethod,
            providerKind: route.providerKind,
            declarationLineage:
              route.declarationLineage.length > 0 ? route.declarationLineage : undefined,
            alternateProviders: route.alternateProviders,
          },
          updated_at: now,
        };
        surfaces.push(surfaceNode);

        // declares_surface: route file → surface
        const declEdgeId = `${fileId}→${surfaceId}:declares_surface`;
        edges.push({
          id: declEdgeId,
          edgeType: 'declares_surface',
          sourceNodeId: fileId,
          targetNodeId: surfaceId,
          sourceLanguage: 'php',
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: this.name,
            evidenceKind: 'route-declaration',
            evidenceLocations: [
              {
                filePath: entry.filePath,
                line: route.line,
                note: route.pathWrapper
                  ? `Route::${route.method}(${route.pathWrapper}('${route.localFragment}'))${
                      route.declarationLineage.length > 0
                        ? ` [group: ${route.declarationLineage.join(' / ')}]`
                        : ''
                    }`
                  : `Route::${route.method}('${route.localFragment}')${
                      route.declarationLineage.length > 0
                        ? ` [group: ${route.declarationLineage.join(' / ')}]`
                        : ''
                    }`,
              },
            ],
            extractedAt: now,
          },
        });

        // handled_by: surface → controller symbol (only when explicitly declared)
        if (route.controllerQualifiedName) {
          const providerSymbolId = buildProviderSymbolId(route.controllerQualifiedName);
          const handledEdgeId = `${surfaceId}→${providerSymbolId}:handled_by`;
          edges.push({
            id: handledEdgeId,
            edgeType: 'handled_by',
            sourceNodeId: surfaceId,
            targetNodeId: providerSymbolId,
            targetLanguage: 'php',
            confidence: 0.95,
            confidenceClass: 'framework-inferred',
            provenance: {
              resolver: this.name,
              evidenceKind: 'explicit-controller-reference',
              evidenceLocations: [
                {
                  filePath: entry.filePath,
                  line: route.line,
                  note: route.controllerMethod
                    ? `[${route.controllerQualifiedName}::class, '${route.controllerMethod}']`
                    : `${route.controllerQualifiedName}::class`,
                },
              ],
              extractedAt: now,
            },
          });
        }
      }
    }

    return { surfaces, edges };
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedRoute {
  method: string;
  /** Fully composed canonical external path (includes group prefixes). */
  path: string;
  /** Local path fragment as written in the declaration. */
  localFragment: string;
  line: number;
  /** Fully-qualified controller class name, if explicit. */
  controllerQualifiedName?: string;
  /** Raw controller reference as written in the route declaration. */
  rawControllerReference?: string;
  /** Controller method name (e.g. 'index'), if explicit. */
  controllerMethod?: string;
  /**
   * How the route supplies its handler. `controller` = named class/action,
   * `closure` = inline anonymous function. Always set by the parser.
   */
  providerKind: 'controller' | 'closure';
  /** Named route, if declared. */
  routeName?: string;
  /** Ancestor group prefixes, outermost first. */
  declarationLineage: string[];
  /** Helper function name wrapping the path argument (e.g. 'pathLookup'), if any. */
  pathWrapper?: string;
  /**
   * Alternate provider candidates from duplicate branch declarations (e.g. app-vs-core fallbacks).
   * Populated when consolidation arbitrated between multiple declarations for the same (method, path).
   */
  alternateProviders?: Array<{
    rawControllerReference?: string;
    controllerQualifiedName?: string;
    controllerMethod?: string;
  }>;
}

interface GroupBlock {
  /** The prefix contributed by this group (may be empty string). */
  prefix: string;
  /** Character index of first char inside the callback body or arrow expression. */
  innerStart: number;
  /** Character index just before the callback body/expression terminator. */
  innerEnd: number;
}

interface RouteFileRegistration {
  prefix?: string;
  namespace?: string;
}

interface PhpMethodBlock {
  name: string;
  bodyStart: number;
  bodyEnd: number;
  body: string;
}

function collectRouteFileRegistrations(
  context: AssociationContext
): Map<string, RouteFileRegistration> {
  const registrations = new Map<string, RouteFileRegistration>();

  for (const entry of context.entries) {
    if (entry.languageId !== 'php') continue;
    const rawContent = (entry.metadata?.content as string | undefined) ?? '';
    // Mask comments so commented-out ->group/loadRoutesFrom calls don't
    // register spurious (and potentially mis-prefixed) route files.
    const content = rawContent ? maskPhpComments(rawContent) : '';

    // Pattern A: ->group(__DIR__ . '/path/to/routes.php')
    // Used by root and module service providers that pass a file path directly.
    if (content.includes('->group(__DIR__')) {
      const groupRe = /->group\(\s*__DIR__\s*\.\s*['"]([^'"]+)['"]\s*\)/g;
      let match: RegExpExecArray | null;

      while ((match = groupRe.exec(content)) !== null) {
        const relativeRef = match[1];
        const routeFilePath = pathPosix.normalize(
          pathPosix.join(pathPosix.dirname(entry.filePath), relativeRef)
        );
        if (!routeFilePath.endsWith('.php')) continue;
        if (registrations.has(routeFilePath)) continue;
        const chainChunk = content.slice(Math.max(0, match.index - 500), match.index);
        const routeIdx = chainChunk.lastIndexOf('Route::');
        const chainText = routeIdx >= 0 ? chainChunk.slice(routeIdx) : chainChunk;
        const prefix = extractLastChainValue(
          chainText,
          /(?:^|->|::)prefix\(\s*['"]([^'"]+)['"]\s*\)/g
        );
        const namespace = extractLastChainValue(
          chainText,
          /(?:^|->|::)namespace\(\s*['"]([^'"]+)['"]\s*\)/g
        );
        registrations.set(routeFilePath, {
          ...(prefix ? { prefix: normalizePathFragment(prefix) } : {}),
          ...(namespace ? { namespace: namespace.replace(/^\\/, '') } : {}),
        });
      }
    }

    // Pattern B: $this->loadRoutesFrom(__DIR__ . '/path/to/routes.php')
    // Used by module service providers that call loadRoutesFrom inside boot().
    // Scan backward from the loadRoutesFrom call to find a Route:: chain that
    // supplies prefix/namespace context (e.g. from a wrapping ->group(function())).
    if (content.includes('loadRoutesFrom(__DIR__')) {
      const loadRe = /\bloadRoutesFrom\(\s*__DIR__\s*\.\s*['"]([^'"]+)['"]\s*\)/g;
      let match: RegExpExecArray | null;

      while ((match = loadRe.exec(content)) !== null) {
        const relativeRef = match[1];
        const routeFilePath = pathPosix.normalize(
          pathPosix.join(pathPosix.dirname(entry.filePath), relativeRef)
        );
        if (!routeFilePath.endsWith('.php')) continue;
        if (registrations.has(routeFilePath)) continue;
        const chainChunk = content.slice(Math.max(0, match.index - 500), match.index);
        const routeIdx = chainChunk.lastIndexOf('Route::');
        const chainText = routeIdx >= 0 ? chainChunk.slice(routeIdx) : chainChunk;
        const prefix = extractLastChainValue(
          chainText,
          /(?:^|->|::)prefix\(\s*['"]([^'"]+)['"]\s*\)/g
        );
        const namespace = extractLastChainValue(
          chainText,
          /(?:^|->|::)namespace\(\s*['"]([^'"]+)['"]\s*\)/g
        );
        registrations.set(routeFilePath, {
          ...(prefix ? { prefix: normalizePathFragment(prefix) } : {}),
          ...(namespace ? { namespace: namespace.replace(/^\\/, '') } : {}),
        });
      }
    }
  }

  return registrations;
}

function extractLastChainValue(content: string, re: RegExp): string | undefined {
  let result: string | undefined;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(content)) !== null) {
    result = match[1];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public parser entry point
// ---------------------------------------------------------------------------

/**
 * Parse all route declarations from PHP file content, handling nested route groups.
 *
 * Comments (single-line `//`, hash `#`, and multi-line `/* ... *\/`) are masked
 * out with spaces before parsing so commented-out route declarations are never
 * emitted as surfaces. Character positions are preserved so line numbers in
 * evidence remain accurate.
 */
function parseRouteDeclarations(
  content: string,
  filePath: string,
  registration?: RouteFileRegistration
): ParsedRoute[] {
  // Build the import map from the original content so `use` statements
  // inside /* */ comments are ignored (maskPhpComments strips them).
  const commentStripped = maskPhpComments(content);
  const importMap = extractPhpImportMap(commentStripped);
  const controllerNamespace = inferRouteControllerNamespace(
    filePath,
    commentStripped,
    registration?.namespace
  );
  const rootPrefix = registration?.prefix;

  if (isProviderStyleRouteSource(filePath, content)) {
    const methodBlocks = extractPhpMethodBlocks(commentStripped);
    const bootBlock = methodBlocks.get('boot');

    if (bootBlock) {
      const raw = parseBlockContent(
        bootBlock.body,
        rootPrefix ? [rootPrefix] : [],
        bootBlock.bodyStart,
        commentStripped,
        importMap,
        controllerNamespace,
        methodBlocks,
        ['boot']
      );
      return consolidateLogicalSurfaces(raw);
    }
  }

  const raw = parseBlockContent(
    commentStripped,
    rootPrefix ? [rootPrefix] : [],
    0,
    commentStripped,
    importMap,
    controllerNamespace
  );
  return consolidateLogicalSurfaces(raw);
}

/**
 * Replace PHP comment bodies with spaces, preserving character positions and
 * newlines. Handles `//`, `#`, and `/* ... *\/` comments, and skips past
 * single- and double-quoted string literals so a `//` appearing inside a
 * string (e.g. `'http://...'`) is not mistaken for the start of a comment.
 *
 * Note: `#[` (PHP 8 attribute syntax) is preserved — only bare `#` comments
 * are masked.
 *
 * Heredoc and nowdoc syntax is not specifically handled; these are rare in
 * route files and would at worst cause a trailing `//` inside them to be
 * stripped, which does not produce spurious route declarations.
 */
function maskPhpComments(content: string): string {
  const chars = content.split('');
  const len = content.length;
  let i = 0;

  while (i < len) {
    const ch = content[i];
    const next = i + 1 < len ? content[i + 1] : '';

    // Multi-line /* ... */ comment
    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < len) {
        if (content[i] === '*' && i + 1 < len && content[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          break;
        }
        if (content[i] !== '\n') chars[i] = ' ';
        i++;
      }
      continue;
    }

    // Single-line // comment
    if (ch === '/' && next === '/') {
      while (i < len && content[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    // Shell-style # comment (skip PHP 8 attribute syntax #[...])
    if (ch === '#' && next !== '[') {
      while (i < len && content[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    // Single-quoted string — skip over without masking
    if (ch === "'") {
      i++;
      while (i < len && content[i] !== "'") {
        if (content[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      if (i < len) i++; // consume closing quote
      continue;
    }

    // Double-quoted string — skip over without masking
    if (ch === '"') {
      i++;
      while (i < len && content[i] !== '"') {
        if (content[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      if (i < len) i++; // consume closing quote
      continue;
    }

    i++;
  }

  return chars.join('');
}

/**
 * Collapse route declarations that share the same logical surface identity
 * (HTTP method + canonical external path) into a single entry, applying
 * provider arbitration when multiple candidate controllers compete.
 *
 * This handles conditional app-vs-core override branches where the same route
 * is declared twice — once for the app override controller and once for the
 * core fallback — and both appear as static text in the route file.
 */
function consolidateLogicalSurfaces(routes: ParsedRoute[]): ParsedRoute[] {
  const grouped = new Map<string, ParsedRoute[]>();
  for (const route of routes) {
    const key = `${route.method.toLowerCase()}:${route.path}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(route);
    } else {
      grouped.set(key, [route]);
    }
  }

  const consolidated: ParsedRoute[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      consolidated.push(group[0]);
    } else {
      consolidated.push(arbitrateRouteProvider(group));
    }
  }

  return consolidated;
}

/**
 * Select the most structurally defensible provider from a set of competing
 * declarations for the same logical surface.
 *
 * Priority:
 *   1. Namespace-qualified controller (contains '\\') — most specific
 *   2. Any named controller target
 *   3. First candidate when all are equivalent or unresolved
 *
 * The losing candidates are preserved as `alternateProviders` on the winner.
 */
function arbitrateRouteProvider(candidates: ParsedRoute[]): ParsedRoute {
  // Priority 1: namespace-qualified controller
  const nsQualified = candidates.filter(
    (r) => r.controllerQualifiedName && r.controllerQualifiedName.includes('\\')
  );
  if (nsQualified.length > 0) {
    return attachAlternateProviders(nsQualified[0], candidates);
  }

  // Priority 2: any named controller
  const named = candidates.filter((r) => r.controllerQualifiedName);
  if (named.length > 0) {
    return attachAlternateProviders(named[0], candidates);
  }

  // Priority 3: first candidate — preserve all provenance conservatively
  return attachAlternateProviders(candidates[0], candidates);
}

function attachAlternateProviders(winner: ParsedRoute, all: ParsedRoute[]): ParsedRoute {
  const alternates = all
    .filter((r) => r !== winner)
    .map((r) => ({
      rawControllerReference: r.rawControllerReference,
      controllerQualifiedName: r.controllerQualifiedName,
      controllerMethod: r.controllerMethod,
    }));
  if (alternates.length === 0) return winner;
  return { ...winner, alternateProviders: alternates };
}

// ---------------------------------------------------------------------------
// Recursive block parser
// ---------------------------------------------------------------------------

/**
 * Recursively parse a block of PHP content for route declarations.
 *
 * @param block - The content of this block (may be a group interior).
 * @param prefixStack - Accumulated group prefixes from ancestor groups.
 * @param blockOffset - Character offset of `block` within the root content.
 * @param rootContent - The full file content (used for line number calculation).
 */
function parseBlockContent(
  block: string,
  prefixStack: string[],
  blockOffset: number,
  rootContent: string,
  importMap: Map<string, string>,
  controllerNamespace?: string,
  helperMethods?: Map<string, PhpMethodBlock>,
  helperCallStack: string[] = []
): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  // 1. Find top-level group blocks within this block
  const topLevelGroups = findTopLevelGroupBlocks(block);

  // 2. Mask group interiors so route regexes don't match inside them
  const masked = maskGroupInteriors(block, topLevelGroups);

  // 3. Parse direct routes from masked content
  routes.push(
    ...parseDirectRoutes(
      masked,
      prefixStack,
      blockOffset,
      rootContent,
      importMap,
      controllerNamespace
    )
  );

  if (helperMethods && helperMethods.size > 0) {
    for (const helperCall of findHelperMethodCalls(masked)) {
      const helper = helperMethods.get(helperCall);
      if (!helper) continue;
      if (helperCallStack.includes(helperCall)) continue;

      routes.push(
        ...parseBlockContent(
          helper.body,
          prefixStack,
          helper.bodyStart,
          rootContent,
          importMap,
          controllerNamespace,
          helperMethods,
          [...helperCallStack, helperCall]
        )
      );
    }
  }

  // 4. Recurse into each group block with the composed prefix stack
  for (const group of topLevelGroups) {
    const innerBlock = block.slice(group.innerStart, group.innerEnd);
    const newPrefixStack = group.prefix ? [...prefixStack, group.prefix] : [...prefixStack];
    const innerRoutes = parseBlockContent(
      innerBlock,
      newPrefixStack,
      blockOffset + group.innerStart,
      rootContent,
      importMap,
      controllerNamespace,
      helperMethods,
      helperCallStack
    );
    routes.push(...innerRoutes);
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Group block detection
// ---------------------------------------------------------------------------

/**
 * Find all top-level group blocks in a content string.
 * "Top-level" means not inside another group block found in this call.
 * Nested groups are returned when `parseBlockContent` recurses.
 */
function findTopLevelGroupBlocks(content: string): GroupBlock[] {
  const blocks: GroupBlock[] = [];
  let pos = 0;

  while (pos < content.length) {
    const opener = findNextGroupOpener(content, pos);
    if (!opener) break;

    blocks.push({
      prefix: opener.prefix,
      innerStart: opener.contentStart,
      innerEnd: opener.contentEnd,
    });

    // Skip past the entire group block/expression to avoid re-matching inner groups
    pos = opener.contentEnd + 1;
  }

  return blocks;
}

interface GroupOpenerResult {
  /** Start position of the Route:: chain (or the ->group for chain openers). */
  openerPos: number;
  /** Character index of first char inside the callback body or arrow expression. */
  contentStart: number;
  /** Character index just before the callback body/expression terminator. */
  contentEnd: number;
  /** The prefix string extracted from the group declaration. */
  prefix: string;
}

/**
 * Find the next group opener starting at `fromPos`.
 * Handles two patterns:
 *   A) Route::...->prefix('x')->...->group(function () { ... })
 *      Route::...->prefix('x')->...->group(fn() => ...)
 *   B) Route::group(['prefix' => 'x'], function () { ... })
 *      Route::group(['prefix' => 'x'], fn() => ...)
 */
function findNextGroupOpener(content: string, fromPos: number): GroupOpenerResult | null {
  // Pattern A: any ->group(...callback...)
  const CHAIN_GROUP_RE = /->group\s*\(/g;
  CHAIN_GROUP_RE.lastIndex = fromPos;

  const chainMatch = CHAIN_GROUP_RE.exec(content);
  const directMatch = findDirectArrayGroupOpener(content, fromPos);

  const useChain =
    chainMatch !== null && (directMatch === null || chainMatch.index <= directMatch.openerPos);

  if (useChain && chainMatch) {
    const parenStart = content.indexOf('(', chainMatch.index);
    if (parenStart < 0) return directMatch;
    const callback = parseGroupCallback(content, parenStart + 1, parenStart);
    if (!callback) return directMatch;

    const prefix = extractPrefixFromChainBefore(content, chainMatch.index);
    return {
      openerPos: chainMatch.index,
      contentStart: callback.contentStart,
      contentEnd: callback.contentEnd,
      prefix,
    };
  }

  if (directMatch) {
    return directMatch;
  }

  return null;
}

function findDirectArrayGroupOpener(content: string, fromPos: number): GroupOpenerResult | null {
  const routeIdx = content.indexOf('Route::group', fromPos);
  if (routeIdx < 0) return null;

  const parenStart = content.indexOf('(', routeIdx + 'Route::group'.length);
  if (parenStart < 0) return null;

  const optionsStart = skipWhitespace(content, parenStart + 1);
  if (optionsStart >= content.length || content[optionsStart] !== '[') return null;

  const optionsEnd = findMatchingBracket(content, optionsStart, '[', ']');
  if (optionsEnd < 0) return null;

  const afterOptions = skipWhitespace(content, optionsEnd + 1);
  if (afterOptions >= content.length || content[afterOptions] !== ',') return null;

  const callback = parseGroupCallback(content, afterOptions + 1, parenStart);
  if (!callback) return null;

  const optionsText = content.slice(optionsStart + 1, optionsEnd);
  const prefix = extractPrefixFromArrayOptions(optionsText);

  return {
    openerPos: routeIdx,
    contentStart: callback.contentStart,
    contentEnd: callback.contentEnd,
    prefix,
  };
}

function parseGroupCallback(
  content: string,
  callbackPos: number,
  groupParenStart: number
): { contentStart: number; contentEnd: number } | null {
  const callbackSlice = content.slice(callbackPos);

  const functionMatch = /^\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?/.exec(callbackSlice);
  if (functionMatch) {
    const bracePos = content.indexOf('{', callbackPos + functionMatch[0].length);
    if (bracePos < 0) return null;
    const closePos = findMatchingBrace(content, bracePos);
    if (closePos < 0) return null;
    return {
      contentStart: bracePos + 1,
      contentEnd: closePos,
    };
  }

  const arrowMatch = /^\s*fn\s*\([^)]*\)\s*=>/.exec(callbackSlice);
  if (arrowMatch) {
    const groupClosePos = findMatchingBracket(content, groupParenStart, '(', ')');
    if (groupClosePos < 0) return null;
    return {
      contentStart: callbackPos + arrowMatch[0].length,
      contentEnd: groupClosePos,
    };
  }

  return null;
}

/**
 * Scan backward from `beforePos` in `content` to find a ->prefix('...')
 * in the Route:: chain that precedes a ->group( call.
 *
 * Scans back up to 500 characters to find the relevant Route:: chain.
 */
function extractPrefixFromChainBefore(content: string, beforePos: number): string {
  const SCAN_BACK = 500;
  const start = Math.max(0, beforePos - SCAN_BACK);
  const chunk = content.slice(start, beforePos);

  // Find the last Route:: in the chunk — that starts the chain
  const routeIdx = chunk.lastIndexOf('Route::');
  const chainText = routeIdx >= 0 ? chunk.slice(routeIdx) : chunk;

  // Look for ::prefix('...') or ->prefix('...') in the chain
  const prefixMatch = /(?:^|->|::)prefix\s*\(\s*['"]([^'"]*)['"]\s*\)/.exec(chainText);
  if (prefixMatch) return normalizePathFragment(prefixMatch[1]);

  return '';
}

/**
 * Extract a 'prefix' value from a Route::group options array string.
 * Input example: `'prefix' => 'admin', 'middleware' => ['auth']`
 */
function extractPrefixFromArrayOptions(optionsText: string): string {
  const match = /['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/.exec(optionsText);
  return match ? normalizePathFragment(match[1]) : '';
}

function skipWhitespace(content: string, pos: number): number {
  let i = pos;
  while (i < content.length && /\s/.test(content[i])) i++;
  return i;
}

function findMatchingBracket(
  content: string,
  openPos: number,
  openChar: string,
  closeChar: string
): number {
  let depth = 1;
  let i = openPos + 1;

  while (i < content.length && depth > 0) {
    const ch = content[i];

    if (ch === "'") {
      i++;
      while (i < content.length && content[i] !== "'") {
        if (content[i] === '\\' && i + 1 < content.length) i += 2;
        else i++;
      }
      if (i < content.length) i++;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\' && i + 1 < content.length) i += 2;
        else i++;
      }
      if (i < content.length) i++;
      continue;
    }

    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Find the position of the closing brace matching the '{' at `openPos`.
 * Returns -1 if no match is found.
 */
function findMatchingBrace(content: string, openPos: number): number {
  return findMatchingBracket(content, openPos, '{', '}');
}

/**
 * Replace the interior of each group block with spaces, preserving character positions.
 * This prevents route regexes from matching routes inside nested groups at the
 * current level (they will be handled by the recursive pass instead).
 */
function maskGroupInteriors(content: string, groups: GroupBlock[]): string {
  if (groups.length === 0) return content;

  const chars = content.split('');
  for (const g of groups) {
    for (let i = g.innerStart; i < g.innerEnd && i < chars.length; i++) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Direct route extraction
// ---------------------------------------------------------------------------

/**
 * Apply the three route declaration regexes to already-scoped/masked content.
 *
 * @param masked - Content with group interiors blanked out.
 * @param prefixStack - Current group prefix stack (outermost first).
 * @param blockOffset - Character offset of `masked` within root content.
 * @param rootContent - Full file content (for line calculation).
 */
function parseDirectRoutes(
  masked: string,
  prefixStack: string[],
  blockOffset: number,
  rootContent: string,
  importMap: Map<string, string>,
  controllerNamespace?: string
): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  function lineFor(localCharIndex: number): number {
    const absIndex = blockOffset + localCharIndex;
    return rootContent.slice(0, absIndex).split('\n').length - 1;
  }

  function routeNameFor(localIndex: number): string | undefined {
    const lineText = rootContent.split('\n')[lineFor(localIndex)] ?? '';
    ROUTE_NAME.lastIndex = 0;
    const m = ROUTE_NAME.exec(lineText);
    return m ? m[1] : undefined;
  }

  function composedPath(localFragment: string): string {
    return composeCanonicalPath(prefixStack, localFragment);
  }

  // Controller array routes
  ROUTE_CONTROLLER_ARRAY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_CONTROLLER_ARRAY.exec(masked)) !== null) {
    const fragment = m[2];
    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineFor(m.index),
      controllerQualifiedName: resolvePhpClassReference(m[3], importMap),
      rawControllerReference: m[3],
      controllerMethod: m[4],
      providerKind: 'controller',
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
    });
  }

  // Invokable controller routes
  ROUTE_INVOKABLE.lastIndex = 0;
  while ((m = ROUTE_INVOKABLE.exec(masked)) !== null) {
    const fragment = m[2];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      controllerQualifiedName: resolvePhpClassReference(m[3], importMap),
      rawControllerReference: m[3],
      controllerMethod: undefined,
      providerKind: 'controller',
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
    });
  }

  // Legacy string controller routes
  ROUTE_CONTROLLER_STRING.lastIndex = 0;
  while ((m = ROUTE_CONTROLLER_STRING.exec(masked)) !== null) {
    const fragment = m[2];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      controllerQualifiedName: resolvePhpClassReference(m[3], importMap, controllerNamespace, true),
      rawControllerReference: m[3],
      controllerMethod: m[4],
      providerKind: 'controller',
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
    });
  }

  // Closure routes
  ROUTE_CLOSURE.lastIndex = 0;
  while ((m = ROUTE_CLOSURE.exec(masked)) !== null) {
    const fragment = m[2];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      providerKind: 'closure',
      declarationLineage: [...prefixStack],
    });
  }

  // Helper-wrapped controller array routes (e.g. Route::get(pathLookup('/path'), [...]))
  ROUTE_CONTROLLER_ARRAY_WRAPPED.lastIndex = 0;
  while ((m = ROUTE_CONTROLLER_ARRAY_WRAPPED.exec(masked)) !== null) {
    const wrapperName = m[2];
    if (!PATH_HELPER_ALLOWLIST.has(wrapperName)) continue;
    const fragment = m[3];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      controllerQualifiedName: resolvePhpClassReference(m[4], importMap),
      rawControllerReference: m[4],
      controllerMethod: m[5],
      providerKind: 'controller',
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
      pathWrapper: wrapperName,
    });
  }

  // Helper-wrapped invokable controller routes (e.g. Route::get(pathLookup('/path'), Ctrl::class))
  ROUTE_INVOKABLE_WRAPPED.lastIndex = 0;
  while ((m = ROUTE_INVOKABLE_WRAPPED.exec(masked)) !== null) {
    const wrapperName = m[2];
    if (!PATH_HELPER_ALLOWLIST.has(wrapperName)) continue;
    const fragment = m[3];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      controllerQualifiedName: resolvePhpClassReference(m[4], importMap),
      rawControllerReference: m[4],
      controllerMethod: undefined,
      providerKind: 'controller',
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
      pathWrapper: wrapperName,
    });
  }

  // Helper-wrapped legacy string controller routes (e.g. Route::get(pathLookup('/path'), 'Ctrl@method'))
  ROUTE_CONTROLLER_STRING_WRAPPED.lastIndex = 0;
  while ((m = ROUTE_CONTROLLER_STRING_WRAPPED.exec(masked)) !== null) {
    const wrapperName = m[2];
    if (!PATH_HELPER_ALLOWLIST.has(wrapperName)) continue;
    const fragment = m[3];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      controllerQualifiedName: resolvePhpClassReference(m[4], importMap, controllerNamespace, true),
      rawControllerReference: m[4],
      controllerMethod: m[5],
      providerKind: 'controller',
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
      pathWrapper: wrapperName,
    });
  }

  // Helper-wrapped closure routes (e.g. Route::get(pathLookup('/path'), function() { ... }))
  ROUTE_CLOSURE_WRAPPED.lastIndex = 0;
  while ((m = ROUTE_CLOSURE_WRAPPED.exec(masked)) !== null) {
    const wrapperName = m[2];
    if (!PATH_HELPER_ALLOWLIST.has(wrapperName)) continue;
    const fragment = m[3];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      providerKind: 'closure',
      declarationLineage: [...prefixStack],
      pathWrapper: wrapperName,
    });
  }

  return routes;
}

function extractPhpImportMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const useRe = /^use\s+([A-Za-z_\\][A-Za-z0-9_\\]*)(?:\s+as\s+(\w+))?\s*;/gm;

  let match: RegExpExecArray | null;
  while ((match = useRe.exec(content)) !== null) {
    const qualified = match[1];
    const alias = match[2] ?? qualified.split('\\').pop();
    if (alias) map.set(alias, qualified);
  }

  return map;
}

function extractPhpMethodBlocks(content: string): Map<string, PhpMethodBlock> {
  const blocks = new Map<string, PhpMethodBlock>();
  const methodRe =
    /\b(?:public|protected|private)\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[^ {][^{]*)?\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(content)) !== null) {
    const bracePos = content.indexOf('{', match.index);
    if (bracePos < 0) continue;
    const closePos = findMatchingBrace(content, bracePos);
    if (closePos < 0) continue;

    const name = match[1];
    const bodyStart = bracePos + 1;
    const bodyEnd = closePos;
    blocks.set(name, {
      name,
      bodyStart,
      bodyEnd,
      body: content.slice(bodyStart, bodyEnd),
    });
  }

  return blocks;
}

function findHelperMethodCalls(content: string): string[] {
  const calls: string[] = [];
  const callRe = /\$this->([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = callRe.exec(content)) !== null) {
    calls.push(match[1]);
  }

  return calls;
}

function resolvePhpClassReference(
  reference: string,
  importMap: Map<string, string>,
  controllerNamespace?: string,
  prefixLegacyRelativeNamespace = false
): string {
  if (reference.startsWith('\\')) return reference.slice(1);
  if (importMap.has(reference)) return importMap.get(reference)!;

  if (reference.includes('\\')) {
    if (prefixLegacyRelativeNamespace) {
      // Legacy string controller ('Foo\Bar@method'): Laravel prepends the route
      // group's namespace — EXCEPT when the reference is already fully-qualified
      // under that namespace, which Laravel would mechanically double-prefix into
      // a broken class. Resolve to the intended class instead (E2). Laravel does
      // not apply `use` imports to string controllers, so no alias expansion here.
      if (controllerNamespace && !reference.startsWith(`${controllerNamespace}\\`)) {
        return `${controllerNamespace}\\${reference}`;
      }
      return reference;
    }
    // `::class` reference: resolve a namespace-alias `use` import on the first
    // segment, matching PHP's own name resolution (E3). e.g. a file with
    // `use App\Http\Controllers\Api;` resolves `Api\FooController::class` to
    // `App\Http\Controllers\Api\FooController`.
    const sep = reference.indexOf('\\');
    const head = reference.slice(0, sep);
    if (importMap.has(head)) return `${importMap.get(head)}${reference.slice(sep)}`;
    return reference;
  }

  if (prefixLegacyRelativeNamespace && controllerNamespace)
    return `${controllerNamespace}\\${reference}`;
  return reference;
}

function inferRouteControllerNamespace(
  filePath: string,
  content: string,
  registrationNamespace?: string
): string | undefined {
  const explicit = extractRouteNamespaceOverride(content);
  if (explicit) return explicit;
  if (registrationNamespace) return registrationNamespace;

  if (/^routes\/(api|admin|web|json)\.php$/i.test(filePath)) {
    // Laravel's conventional default controller namespace for legacy
    // relative string-controller references when the route file declares
    // no explicit ->namespace() and no registration namespace was resolved.
    return 'App\\Http\\Controllers';
  }

  return undefined;
}

function extractRouteNamespaceOverride(content: string): string | undefined {
  const namespaceChain = /->namespace\(\s*['"]([^'"]+)['"]\s*\)/.exec(content);
  if (namespaceChain) return namespaceChain[1].replace(/^\\/, '');

  const namespaceArray = /['"]namespace['"]\s*=>\s*['"]([^'"]+)['"]/.exec(content);
  if (namespaceArray) return namespaceArray[1].replace(/^\\/, '');

  return undefined;
}

// ---------------------------------------------------------------------------
// Path composition helpers
// ---------------------------------------------------------------------------

/**
 * Compose a canonical external path from a group prefix stack and a local fragment.
 *
 * Rules:
 *   - Prefixes are joined in order, each separated by '/'
 *   - Leading slashes are normalized (exactly one at the start of the full path)
 *   - Trailing slashes are stripped unless the path is just '/'
 */
function composeCanonicalPath(prefixStack: string[], localFragment: string): string {
  const normalizedPrefixes = prefixStack
    .map((s) => normalizePathFragment(s))
    .filter((s) => s.length > 0);
  const normalizedLocal = normalizePathFragment(localFragment);

  if (normalizedPrefixes.length === 0 && !normalizedLocal) return '/';

  const prefixPath = normalizedPrefixes.join('/');
  let localPath = normalizedLocal;

  if (prefixPath && localPath) {
    if (localPath === prefixPath) {
      localPath = '';
    } else if (localPath.startsWith(`${prefixPath}/`)) {
      localPath = localPath.slice(prefixPath.length + 1);
    }
  }

  const segments = [...normalizedPrefixes, localPath].filter((s) => s.length > 0);
  const joined = segments.join('/').replace(/\/+/g, '/');
  const withLeading = joined.startsWith('/') ? joined : '/' + joined;
  return withLeading.length > 1 && withLeading.endsWith('/')
    ? withLeading.slice(0, -1)
    : withLeading;
}

/**
 * Strip leading and trailing slashes from a path fragment for consistent joining.
 */
function normalizePathFragment(fragment: string): string {
  return fragment.replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// Existing helpers
// ---------------------------------------------------------------------------

/**
 * Build a PHP symbol node ID for a controller.
 *
 * Targets the class-level qualified node when a namespace is present so shared
 * short controller names do not collapse across modules. Method identity is
 * still preserved separately in surface metadata (`controllerMethod`).
 */
function buildProviderSymbolId(qualifiedName: string): string {
  return phpSymbolNodeId(qualifiedName);
}

/**
 * Heuristic to identify Laravel route files by path alone.
 *
 * Matches files under a `routes/` directory or any PHP file named `routes.php`.
 */
function isRouteFile(filePath: string): boolean {
  return /(^|\/)routes\/.+\.php$/i.test(filePath) || /routes\.php$/i.test(filePath);
}

/**
 * Regex used to detect whether a PHP file body contains at least one direct
 * Laravel HTTP route declaration. Matches `Route::get(` / `::post(` / etc.
 *
 * Deliberately narrow — does NOT match bare `Route::group(` or `Route::prefix(`,
 * since those appear in plain file-registration providers that should continue
 * to be handled only as `loadRoutesFrom` / `->group(__DIR__)` registrations
 * against an external route file, not as inline route declarations.
 */
const INLINE_ROUTE_DECLARATION_RE = /\bRoute::(?:get|post|put|patch|delete|any)\s*\(/i;

/**
 * Conservative content-based heuristic: does this PHP file contain at least
 * one direct Laravel HTTP route declaration (after stripping comments)?
 */
function hasInlineRouteDeclaration(content: string): boolean {
  if (!content) return false;
  return INLINE_ROUTE_DECLARATION_RE.test(maskPhpComments(content));
}

/**
 * Heuristic for RouteServiceProvider-style files: PHP files whose name ends
 * in `Provider.php` and whose body clearly contains Laravel route declarations
 * (not merely `loadRoutesFrom` pointing at an external route file).
 *
 * This lets us pick up module providers that declare routes inline — e.g.
 * `src/Module/ExternalApi/RouteServiceProvider.php` with
 * `Route::prefix('api')->group(function () { Route::get(...); })` — without
 * broadening detection to arbitrary PHP files that happen to mention Route.
 */
function isProviderStyleRouteSource(filePath: string, content: string | undefined): boolean {
  if (!/(?:^|\/)[A-Za-z0-9_]*Provider\.php$/i.test(filePath)) return false;
  // Avoid re-classifying files already covered by the routes/* heuristic.
  if (isRouteFile(filePath)) return false;
  return hasInlineRouteDeclaration(content ?? '');
}

/**
 * Unified eligibility check for the detector: a PHP entry qualifies as a route
 * source if it either lives in a conventional route-file location, or is a
 * provider-style file whose content contains inline route declarations.
 */
function isEligibleRouteSource(entry: {
  filePath: string;
  languageId?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  if (entry.languageId !== 'php') return false;
  if (isRouteFile(entry.filePath)) return true;
  const content = (entry.metadata?.content as string | undefined) ?? '';
  return isProviderStyleRouteSource(entry.filePath, content);
}
