import type { DeltaTouchSet, EntrySurfaceImpact, SpecTarget } from './types.js';
import { bareId, declarationHandle } from '../identity/file-qualified-id.js';

/**
 * The `route | handler | job | listener | command` targets whose evidence citations or
 * declaring/handler files intersect the change-set — what a downstream spec-derivation must
 * re-derive (Decision 8). Unions: downstream HTTP entry surfaces (→ route), operational entry
 * surfaces (→ job/command/listener), surfaces + operational boundaries DECLARED in changed files.
 */
export function resolveInvalidatedSpecTargets(
  touch: DeltaTouchSet,
  entrySurfaces: EntrySurfaceImpact[]
): SpecTarget[] {
  const out = new Map<string, SpecTarget>();
  const add = (t: SpecTarget): void => {
    out.set(`${t.kind}:${t.target}`, t);
  };

  for (const s of entrySurfaces) {
    if (s.kind === 'http') add({ kind: 'route', target: httpSurfaceLabel(s.id) });
    else add({ kind: opKindToSpecKind(s.kind), target: s.id });
  }
  for (const s of touch.surfacesDeclared) {
    add({ kind: 'route', target: httpSurfaceLabel(s.id) });
  }
  for (const b of touch.operationalBoundaries) {
    add({ kind: opKindToSpecKind(b.kind), target: b.name });
  }
  return [...out.values()];
}

/**
 * `surface:http:GET:/path` → `GET /path`; other ids pass through. One declaration of a route
 * several files declare (`…#file:<path>`) is `GET /path @ <path>`: the form `overlay
 * spec-evidence ask --kind route` resolves to that declaration, where the bare handle would be
 * ambiguous.
 */
function httpSurfaceLabel(id: string): string {
  const m = /^surface:http:([A-Z]+):(.+)$/.exec(bareId(id));
  return m ? declarationHandle(id, `${m[1]} ${m[2]}`) : id;
}

function opKindToSpecKind(kind: string): SpecTarget['kind'] {
  switch (kind) {
    case 'job':
      return 'job';
    case 'event':
      return 'listener';
    case 'command':
    case 'schedule':
      return 'command';
    default:
      return 'route';
  }
}
