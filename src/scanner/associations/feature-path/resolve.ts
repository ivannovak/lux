// Question -> route-surface target resolution for tranche-one feature-path
// retrieval.
//
// Mirrors the resolution pattern used by overlay operational ask: a tiered
// match (exact -> semantic-exact -> prefix -> contains), candidate
// deduplication, and ambiguity-aware classification. The match runs against
// persisted capability-surface nodes only; new persistence shapes are NOT
// introduced (R9).

import type { LuxDatabase } from '../../../db/index.js';
import type { StructuralNode } from '../../../db/types.js';
import type { FeaturePathResolution, FeaturePathTarget, ResolutionMatchType } from './contract.js';
import { declarationHandle } from '../../identity/file-qualified-id.js';

const MAX_CANDIDATES = 5;

interface SurfaceMeta {
  transport?: string;
  method?: string;
  path?: string;
  routeName?: string;
}

function parseSurfaceMeta(surface: StructuralNode): SurfaceMeta {
  try {
    return JSON.parse(surface.metadata ?? '{}') as SurfaceMeta;
  } catch {
    // lux-intentional-swallow: parses metadata Lux itself wrote; an unparsable value reads as none.
    return {};
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/\?$/, '').trim();
}

/**
 * Build the set of normalized strings that should match a question against
 * a capability-surface node. Examples for `surface:http:POST:/offers` named
 * `offers.store`:
 *   - `post /offers`
 *   - `/offers`
 *   - `offers.store`
 *   - `surface:http:post:/offers`
 */
function semanticForms(surface: StructuralNode): string[] {
  const forms = new Set<string>();
  const meta = parseSurfaceMeta(surface);

  forms.add(normalize(surface.id));
  if (surface.symbol_name) forms.add(normalize(surface.symbol_name));
  if (meta.routeName) forms.add(normalize(meta.routeName));
  if (meta.method && meta.path) {
    const handle = `${meta.method} ${meta.path}`;
    forms.add(normalize(handle));
    // One declaration of a route several files declare: `GET / @ routes/web.php`.
    forms.add(normalize(declarationHandle(surface.id, handle)));
  }
  if (meta.path) forms.add(normalize(meta.path));

  return [...forms].filter(Boolean);
}

function toTarget(surface: StructuralNode): FeaturePathTarget {
  const meta = parseSurfaceMeta(surface);
  const handle = surface.symbol_name ?? `${meta.method ?? ''} ${meta.path ?? ''}`.trim();
  // A route several files declare is labelled with its file, so candidates can be told apart
  // and the label asked for as written.
  const label = handle ? declarationHandle(surface.id, handle) : '';

  const target: FeaturePathTarget = {
    kind: 'route-surface',
    id: surface.id,
    label: label || surface.id,
    filePath: surface.file_path ?? null,
  };
  if (meta.method) target.surfaceMethod = meta.method;
  if (meta.path) target.surfacePath = meta.path;
  if (meta.routeName) target.routeName = meta.routeName;

  return target;
}

function dedupeSurfaces(surfaces: StructuralNode[]): StructuralNode[] {
  const seen = new Set<string>();
  const result: StructuralNode[] = [];
  for (const surface of surfaces) {
    if (seen.has(surface.id)) continue;
    seen.add(surface.id);
    result.push(surface);
  }
  return result;
}

/**
 * Whether a semantic form is specific enough to be safely substring-matched
 * inside an English-wrapped natural-language query. Forms without a slash
 * (route names, symbol names) are accepted; forms with a slash require at
 * least one alphanumeric or underscore character anywhere after a slash.
 *
 * Example accepts: `/offers`, `post /offers`, `offers.store`,
 * `surface:http:post:/x`.
 * Example rejects: `/`, `get /`, `post /`, `surface:http:get:/`.
 */
function hasSpecificPathContent(form: string): boolean {
  if (!form.includes('/')) return form.length > 0;
  return /\/[A-Za-z0-9_]/.test(form);
}

function classify(
  matchedBy: ResolutionMatchType,
  matches: StructuralNode[],
  query: string
): FeaturePathResolution | null {
  const candidates = dedupeSurfaces(matches);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    return {
      query,
      status: 'resolved',
      matchedBy,
      candidates: candidates.map(toTarget),
    };
  }

  return {
    query,
    status: 'ambiguous',
    matchedBy,
    candidates: candidates.slice(0, MAX_CANDIDATES).map(toTarget),
  };
}

/**
 * Resolve a question fragment to a tranche-one feature-path target. Returns
 * a FeaturePathResolution that callers can hand to the assembler verbatim.
 */
export function resolveFeaturePathTarget(db: LuxDatabase, query: string): FeaturePathResolution {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return { query, status: 'unresolved', candidates: [] };
  }

  const surfaces = db.getCapabilitySurfaces();

  const exact = classify(
    'exact',
    surfaces.filter((surface) =>
      semanticForms(surface).some(
        (form) => form === normalize(surface.id) && form === normalizedQuery
      )
    ),
    query
  );
  if (exact) return exact;

  const semanticExact = classify(
    'semantic-exact',
    surfaces.filter((surface) => semanticForms(surface).includes(normalizedQuery)),
    query
  );
  if (semanticExact) return semanticExact;

  const prefix = classify(
    'prefix',
    surfaces.filter((surface) =>
      semanticForms(surface).some((form) => form.startsWith(normalizedQuery))
    ),
    query
  );
  if (prefix) return prefix;

  // Contains tier: bidirectional substring match. The
  // `normalizedQuery.includes(form)` direction is the dangerous one — without
  // a specificity guard, forms whose path component is only `/` (e.g. the root
  // route's `/`, `get /`, `post /`) match any query that references some other
  // path, causing English-wrapped questions like "what handles POST
  // /private-offers?" to silently mis-target the root route. We require the
  // form to carry meaningful path content (a slash followed by an
  // alphanumeric segment) — or to have no slash at all (route names, symbols)
  // — for the query-includes-form direction to count.
  const contains = classify(
    'contains',
    surfaces.filter((surface) =>
      semanticForms(surface).some(
        (form) =>
          form.includes(normalizedQuery) ||
          (hasSpecificPathContent(form) && normalizedQuery.includes(form))
      )
    ),
    query
  );
  if (contains) return contains;

  // Suggestion list for unresolved queries: surface anything that shares
  // any meaningful token with the query, capped at MAX_CANDIDATES.
  const tokens = normalizedQuery.split(/[^a-z0-9_/.-]+/i).filter((token) => token.length >= 3);
  const suggestions = dedupeSurfaces(
    surfaces.filter((surface) => {
      const forms = semanticForms(surface);
      return tokens.some((token) => forms.some((form) => form.includes(token)));
    })
  ).slice(0, MAX_CANDIDATES);

  return {
    query,
    status: 'unresolved',
    candidates: suggestions.map(toTarget),
  };
}
