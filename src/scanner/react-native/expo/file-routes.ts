import { posix } from 'node:path';

import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import { expoRouteId } from '../../identity/program-identity.js';
import type { ExpoRouteV1, ExpoRouterInputV1 } from './types.js';

const ROUTE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const GROUP_SEGMENT = /^\([^)]+\)$/u;
const PARAM_SEGMENT = /^\[([^.[\]]+)\]$/u;
const REST_SEGMENT = /^\[\.\.\.([^\]]+)\]$/u;
const OPTIONAL_REST_SEGMENT = /^\[\[\.\.\.([^\]]+)\]\]$/u;

export interface ExpoRouteDiscoveryV1 {
  routes: ExpoRouteV1[];
  diagnostics: SourceDiagnosticV1[];
}

/** Normalize one physical Expo file. Default-export and ambiguity checks happen in discovery. */
export function canonicalExpoRoute(appRoot: string, filePath: string): ExpoRouteV1 {
  const root = normalizeRepoPath(appRoot).replace(/\/$/u, '');
  const file = normalizeRepoPath(filePath);
  if (!root || (file !== root && !file.startsWith(`${root}/`))) {
    throw new Error(`Expo route ${filePath} is outside app root ${appRoot}`);
  }
  if (!ROUTE_EXTENSION.test(file)) throw new Error(`Expo route has unsupported extension: ${file}`);

  const relative = file.slice(root.length + 1).replace(ROUTE_EXTENSION, '');
  const physicalSegments = relative.split('/').filter(Boolean);
  const leaf = physicalSegments.at(-1) ?? '';
  const kind: ExpoRouteV1['kind'] =
    leaf === '_layout' ? 'layout' : leaf === '+not-found' ? 'not-found' : 'route';
  const routeSegments = [...physicalSegments];
  if (kind === 'route' && routeSegments.at(-1) === 'index') routeSegments.pop();

  const groups = routeSegments.filter((segment) => GROUP_SEGMENT.test(segment));
  const publicSegments = routeSegments.filter((segment) => !GROUP_SEGMENT.test(segment));
  const canonicalPath = normalizePublicPath(`/${publicSegments.join('/')}`);
  const identityPath =
    kind === 'route'
      ? canonicalPath
      : normalizePublicPath(
          `/${physicalSegments.filter((segment) => !GROUP_SEGMENT.test(segment)).join('/')}`
        );

  return {
    id: expoRouteId(identityPath),
    filePath: file,
    canonicalPath,
    segmentPath: routeSegments,
    groups,
    params: publicSegments.flatMap(parameterForSegment),
    layouts: [],
    kind,
    componentExport: 'default',
    location: { filePath: file, line: 1, column: 0 },
  };
}

export function discoverExpoRoutes(input: ExpoRouterInputV1): ExpoRouteDiscoveryV1 {
  const diagnostics: SourceDiagnosticV1[] = [];
  const candidates: ExpoRouteV1[] = [];
  const roots = [...new Set(input.appRoots.map(normalizeRepoPath))].sort();

  for (const filePath of [...new Set(input.files.map(normalizeRepoPath))].sort()) {
    const root = roots.find((candidate) => isBelowRoot(candidate, filePath));
    if (!root || excludedRouteFile(filePath)) continue;
    if (!hasExactDefaultExport(filePath, input)) continue;
    try {
      candidates.push(canonicalExpoRoute(root, filePath));
    } catch {
      // lux-intentional-swallow: only unsupported extensions fail here, and those are excluded.
      // Files selected by isBelowRoot can only fail for unsupported extensions, which are excluded.
    }
  }

  const publicRoutes = new Map<string, ExpoRouteV1[]>();
  for (const route of candidates) {
    if (route.kind !== 'route') continue;
    const group = publicRoutes.get(route.canonicalPath) ?? [];
    group.push(route);
    publicRoutes.set(route.canonicalPath, group);
  }
  const ambiguous = new Set<string>();
  for (const [canonicalPath, routes] of [...publicRoutes].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (routes.length < 2) continue;
    ambiguous.add(canonicalPath);
    diagnostics.push({
      code: 'EXPO_ROUTE_AMBIGUOUS',
      message: `Multiple Expo files normalize to ${canonicalPath}: ${routes
        .map((route) => route.filePath)
        .sort()
        .join(', ')}`,
      location: routes.sort(compareRoute)[0].location,
    });
  }

  const routes = candidates.filter(
    (route) => route.kind !== 'route' || !ambiguous.has(route.canonicalPath)
  );
  const layouts = routes.filter((route) => route.kind === 'layout');
  for (const route of routes) {
    route.layouts = layouts
      .filter((layout) => isLayoutAncestor(layout, route))
      .sort(
        (left, right) =>
          left.segmentPath.length - right.segmentPath.length || compareRoute(left, right)
      )
      .map((layout) => layout.filePath);
  }

  return { routes: routes.sort(compareRoute), diagnostics };
}

export function normalizePublicPath(pathname: string): string {
  const slashPath = pathname.replaceAll('\\', '/').split(/[?#]/u, 1)[0];
  const normalized = posix.normalize(`/${slashPath}`).replace(/\/$/u, '');
  return normalized === '' || normalized === '/.' ? '/' : normalized;
}

function normalizeRepoPath(filePath: string): string {
  return posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//u, '');
}

function hasExactDefaultExport(filePath: string, input: ExpoRouterInputV1): boolean {
  const index = input.project.exportsByFile.get(filePath);
  if (!index?.default) return false;
  return !(index.conflicts?.default && index.conflicts.default.length > 0);
}

function excludedRouteFile(filePath: string): boolean {
  if (!ROUTE_EXTENSION.test(filePath) || /\.d\.(?:[cm]?[jt]s)$/u.test(filePath)) return true;
  if (/(?:^|\/)(?:__tests__|__mocks__|fixtures?)(?:\/|$)/u.test(filePath)) return true;
  if (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u.test(filePath)) return true;
  return /(?:^|\/)\+html\.(?:[cm]?[jt]sx?)$/u.test(filePath);
}

function isBelowRoot(root: string, filePath: string): boolean {
  return root.length > 0 && filePath.startsWith(`${root.replace(/\/$/u, '')}/`);
}

function parameterForSegment(
  segment: string
): Array<{ name: string; rest: boolean; optional: boolean }> {
  const optional = OPTIONAL_REST_SEGMENT.exec(segment);
  if (optional) return [{ name: optional[1], rest: true, optional: true }];
  const rest = REST_SEGMENT.exec(segment);
  if (rest) return [{ name: rest[1], rest: true, optional: false }];
  const dynamic = PARAM_SEGMENT.exec(segment);
  return dynamic ? [{ name: dynamic[1], rest: false, optional: false }] : [];
}

function isLayoutAncestor(layout: ExpoRouteV1, child: ExpoRouteV1): boolean {
  if (layout.filePath === child.filePath) return false;
  const parent = layout.segmentPath.slice(0, -1);
  const childSegments = child.segmentPath;
  if (parent.length > childSegments.length) return false;
  return parent.every((segment, index) => segment === childSegments[index]);
}

function compareRoute(left: ExpoRouteV1, right: ExpoRouteV1): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.canonicalPath.localeCompare(right.canonicalPath)
  );
}
