import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';
import type { ResolvedKernel } from './kernel-area.js';
import type { WarnFn } from '../reporter.js';

/**
 * Ownership of an HTTP surface's handler relative to the app/kernel boundary
 * (E1 cross-repo shared-kernel resolution). Computed over a merged overlay where
 * a first-party shared kernel and the consuming app are both app-source.
 */
export type OwnershipLabel = 'kernel-owned' | 'client-override' | 'client-gap' | 'external';

/**
 * Derive the consuming app's root PHP namespace from `<corpus>/composer.json`
 * `autoload.psr-4` — the entry mapping to `app/`, else the first PSR-4 root, else
 * the Laravel default `App`. Trailing namespace separators are stripped
 * (`"App\\"` → `App`). Graceful (returns `App`) when composer.json is absent or
 * unparseable, so single-repo behavior is unchanged.
 */
export function resolveAppNamespace(corpusPath: string, warn?: WarnFn): string {
  const composerPath = join(corpusPath, 'composer.json');
  if (!existsSync(composerPath)) return 'App';
  try {
    const parsed = JSON.parse(readFileSync(composerPath, 'utf-8')) as {
      autoload?: { 'psr-4'?: Record<string, string> };
    };
    const psr4 = parsed.autoload?.['psr-4'];
    if (!psr4) return 'App';
    const entries = Object.entries(psr4);
    const appRoot = entries.find(([, path]) => path.replace(/\/+$/, '') === 'app') ?? entries[0];
    return appRoot ? appRoot[0].replace(/\\+$/, '') : 'App';
  } catch (error) {
    warn?.(
      `composer.json could not be read, so handlers were classified under the default App ` +
        `namespace — ${error instanceof Error ? error.message : String(error)}`
    );
    return 'App';
  }
}

/**
 * Classify a handler edge from its target FQCN node-id and the target node (or
 * null if absent). `appNamespace` is the consuming app's root namespace (Laravel
 * default `App`, or derived via {@link resolveAppNamespace}).
 *   - present `<app>\*`                         → client-override (the app handles it)
 *   - present non-`<app>\*`, project-local      → kernel-owned (promoted kernel source)
 *   - present non-`<app>\*`, vendor-pack origin → external (third-party controller,
 *                                                 e.g. Fortify/Jetstream/Nova)
 *   - absent `<app>\*`                          → client-gap (route the client doesn't implement)
 *   - absent non-`<app>\*`                      → external (unresolved third-party)
 */
export function classifyOwnership(
  targetNodeId: string,
  node: StructuralNode | null,
  appNamespace = 'App'
): OwnershipLabel {
  const isApp = targetNodeId.startsWith(`symbol:php:${appNamespace}\\`);
  if (node) {
    if (isApp) return 'client-override';
    // origin defaults to 'local'; a merged vendor-pack node is third-party.
    return (node.origin ?? 'local') === 'local' ? 'kernel-owned' : 'external';
  }
  return isApp ? 'client-gap' : 'external';
}

export interface OwnershipSummary {
  classified: number;
  counts: Record<OwnershipLabel, number>;
}

/**
 * Post-overlay pass: label every `handled_by` edge from an HTTP surface with its
 * {@link OwnershipLabel} and persist it to `structural_edges.ownership`. Runs after
 * the vendor-pack merge so third-party targets are correctly distinguished from
 * genuine client-gaps. Idempotent (a rebuild recomputes from current node state).
 */
export function classifyHandlerOwnership(db: LuxDatabase, appNamespace = 'App'): OwnershipSummary {
  const counts: Record<OwnershipLabel, number> = {
    'kernel-owned': 0,
    'client-override': 0,
    'client-gap': 0,
    external: 0,
  };
  const edges = db.getHandlerEdgesForOwnership();
  const updates: Array<{ id: string; ownership: string }> = [];
  for (const edge of edges) {
    const label = classifyOwnership(
      edge.target_node_id,
      db.getStructuralNode(edge.target_node_id),
      appNamespace
    );
    updates.push({ id: edge.id, ownership: label });
    counts[label]++;
  }
  db.setEdgeOwnershipBatch(updates);
  return { classified: edges.length, counts };
}

// ---------------------------------------------------------------------------
// Cross-area ownership (#62): classify the kernel's routes against a client index
// ---------------------------------------------------------------------------

export type CrossAreaLabel =
  'kernel-owned' | 'client-override' | 'client-gap' | 'external' | 'client-local';

export interface CrossAreaRoute {
  /** `surface:http:METHOD:/path`. */
  route: string;
  label: CrossAreaLabel;
  /** For `client-override`: `implements` (client provides an `App\` handler the kernel
   *  delegates) vs `route` (client serves a route the kernel handles with its own controller). */
  overrideKind: 'implements' | 'route' | null;
  /** The kernel's handler FQCN for this route (null for `client-local`). */
  kernelHandler: string | null;
  /** The client's handler FQCN (null when the client inherits or gaps the route). */
  clientHandler: string | null;
}

export interface CrossAreaOwnershipMap {
  summary: Record<CrossAreaLabel, number>;
  routes: CrossAreaRoute[];
}

/**
 * Cross-area coverage map (#62): iterate the kernel's HTTP `handled_by` routes and classify
 * each by the client's coverage — `kernel-owned` (client inherits), `client-override`
 * (`implements` a delegated `App\` handler, or `route`-overrides a Core handler), `client-gap`
 * (kernel delegates to `App\`, client absent), `external` (handler outside kernel/app
 * namespaces) — then sweep the client's own non-kernel routes as `client-local`. Classification
 * is by the handler FQCN's namespace (verified against the live indexes: 870/48/23/13 = 954).
 */
export function classifyCrossAreaOwnership(
  db: LuxDatabase,
  kernel: ResolvedKernel,
  appNamespace: string
): CrossAreaOwnershipMap {
  const { kernelRows, clientRoutes } = db.crossAreaOwnership(kernel.dbPath);
  const knsPrefix = `symbol:php:${kernel.namespace}\\`;
  const appPrefix = `symbol:php:${appNamespace}\\`;

  const summary: Record<CrossAreaLabel, number> = {
    'kernel-owned': 0,
    'client-override': 0,
    'client-gap': 0,
    external: 0,
    'client-local': 0,
  };
  const routes: CrossAreaRoute[] = [];
  const kernelRouteIds = new Set<string>();

  for (const r of kernelRows) {
    kernelRouteIds.add(r.route);
    const h = r.kernel_handler;
    let label: CrossAreaLabel;
    let overrideKind: 'implements' | 'route' | null = null;
    let clientHandler: string | null = null;
    if (h.startsWith(knsPrefix)) {
      if (r.client_handler) {
        label = 'client-override';
        overrideKind = 'route';
        clientHandler = r.client_handler;
      } else {
        label = 'kernel-owned';
      }
    } else if (h.startsWith(appPrefix)) {
      if (r.client_node) {
        label = 'client-override';
        overrideKind = 'implements';
        clientHandler = h; // the App\ handler the client provides
      } else {
        label = 'client-gap';
      }
    } else {
      label = 'external';
    }
    summary[label]++;
    routes.push({ route: r.route, label, overrideKind, kernelHandler: h, clientHandler });
  }

  // client-local: the client's own HTTP routes that the kernel does not declare.
  for (const c of clientRoutes) {
    if (kernelRouteIds.has(c.route)) continue;
    summary['client-local']++;
    routes.push({
      route: c.route,
      label: 'client-local',
      overrideKind: null,
      kernelHandler: null,
      clientHandler: c.handler,
    });
  }

  return { summary, routes };
}
