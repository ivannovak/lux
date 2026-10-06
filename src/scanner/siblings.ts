import { existsSync, realpathSync } from 'fs';
import { isAbsolute, join } from 'path';
import { LuxSqlite } from '../db/sqlite-adapter.js';
import { getHeadCommit } from './git.js';
import { resolveAppNamespace } from './associations/ownership.js';
import { loadLspConfig, type LuxLspConfig, type SiblingEntry, type SiblingRole } from './config.js';

export interface ResolvedSibling {
  name: string;
  /** sanitized SQL identifier for attachSibling: `sib_` + name with '-' → '_'. */
  alias: string;
  /** `<worktree>/.lux/lux.db`, or the db: entry verbatim. */
  dbPath: string;
  /** absent for db-only entries. */
  worktree?: string;
  role: SiblingRole;
  /** from the worktree's composer.json (kernel classification only). */
  namespace?: string;
  /** sibling index_metadata.last_indexed_commit. */
  indexedCommit?: string;
  /** worktree git HEAD; absent ⇒ drift unknown. */
  headCommit?: string;
  /** sibling MAX(schema_version); serialized as `dbSchemaVersion`. */
  schemaVersion?: number;
}

export type SiblingRefusalReason =
  | 'unregistered'
  | 'db-absent'
  | 'schema-skew'
  | 'worktree-missing'
  | 'config-invalid'
  // The path exists but the index is not a readable Lux DB — a corrupt/truncated SQLite file, a
  // non-lux file at that path, or a fault that only surfaces on (re-)open: a TOCTOU delete/re-index
  // or a cross-process busy-timeout (a sibling being `lux index rebuild`-written). One coherent
  // degrade path for every db open/read fault, whenever it occurs (resolve-time or post-resolve).
  | 'db-unreadable';

export interface SiblingRefusal {
  name: string;
  reason: SiblingRefusalReason;
  message: string;
  remediation: string;
}

/**
 * Convert a caught db open/read fault into the same structured refusal a resolve-time failure yields
 * (Decision 6). Used by every federated surface (delta cross-repo, trace, search, MCP) to degrade the
 * ONE sibling that faulted AFTER a clean resolve — a TOCTOU delete/re-index between resolve and open,
 * a cross-process busy-timeout, or a file that passed resolve but faults on re-open — instead of
 * aborting the whole federated call (and, on the long-lived MCP server, leaking the handles already
 * opened in the batch). Mirrors the resolve-time `db-unreadable` refusal, so the two windows share
 * one degrade path.
 */
export function siblingFaultRefusal(name: string, error: unknown): SiblingRefusal {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    name,
    reason: 'db-unreadable',
    message: `sibling '${name}': index became unreadable mid-federation (${detail}).`,
    remediation: `Re-index '${name}' (\`lux index rebuild\`), or check for a concurrent rebuild of it.`,
  };
}

/** Fail-loud resolve error carrying a structured reason; resolveSiblings catches + degrades. */
export class SiblingResolveError extends Error {
  constructor(
    readonly siblingName: string,
    readonly reason: SiblingRefusalReason,
    message: string,
    readonly remediation: string
  ) {
    super(message);
    this.name = 'SiblingResolveError';
  }
}

/** attachSibling alias: `sib_` + name with '-' → '_' (never `kernel`/`baseline`/`main`). */
export function siblingAlias(name: string): string {
  return 'sib_' + name.replace(/-/g, '_');
}

/** Derived registry name for the overlay.kernel.package sugar (`acme/core` → `acme-core`). */
export function packageToSiblingName(pkg: string): string {
  return pkg.replace(/\//g, '-');
}

/**
 * The full registry for a corpus: explicit `siblings:` plus the `overlay.kernel.package` sugar as
 * an implicit `role: kernel` entry (Decision 1). Validation has already guaranteed exactly-one-of,
 * the name grammar, ≤1 role:kernel, and the kernel/sugar non-conflict, so this merge is unambiguous.
 */
export function buildSiblingRegistry(cfg: LuxLspConfig): Record<string, SiblingEntry> {
  const registry: Record<string, SiblingEntry> = { ...(cfg.siblings ?? {}) };
  const kernelPkg = cfg.overlay?.kernel?.package;
  if (kernelPkg && !Object.values(registry).some((e) => e.role === 'kernel')) {
    registry[packageToSiblingName(kernelPkg)] = { package: kernelPkg, role: 'kernel' };
  }
  return registry;
}

/**
 * Resolve one registered sibling to its built `.lux` index + metadata. Fail-loud (throws
 * SiblingResolveError). Reads schemaVersion + indexedCommit up front via the raw read-only adapter
 * (the kernel-area.ts:82-90 metadata-read pattern) — so a skewed sibling is caught at resolve time
 * (Decision 7) and never reaches attachSibling / openSiblingReadOnly.
 */
export function resolveSibling(
  corpusPath: string,
  name: string,
  entry: SiblingEntry
): ResolvedSibling {
  const role: SiblingRole = entry.role ?? 'peer';
  const alias = siblingAlias(name);

  const modes = [entry.package, entry.path, entry.db].filter((v) => v !== undefined);
  if (modes.length !== 1) {
    throw new SiblingResolveError(
      name,
      'config-invalid',
      `sibling '${name}': exactly one of package | path | db is required (got ${modes.length}).`,
      `Declare exactly one resolution mode for '${name}' in lux.yaml siblings.`
    );
  }

  let dbPath: string;
  let worktree: string | undefined;
  if (entry.package !== undefined) {
    try {
      worktree = realpathSync(join(corpusPath, 'vendor', entry.package));
    } catch {
      throw new SiblingResolveError(
        name,
        'worktree-missing',
        `sibling '${name}': vendor/${entry.package} not found under ${corpusPath}.`,
        `Vendor the package (composer install), or use path:/db: mode.`
      );
    }
    dbPath = join(worktree, '.lux', 'lux.db');
  } else if (entry.path !== undefined) {
    const abs = isAbsolute(entry.path) ? entry.path : join(corpusPath, entry.path);
    try {
      worktree = realpathSync(abs);
    } catch {
      throw new SiblingResolveError(
        name,
        'worktree-missing',
        `sibling '${name}': path ${entry.path} does not resolve under ${corpusPath}.`,
        `Check the path, or use db: mode for an index with no worktree.`
      );
    }
    dbPath = join(worktree, '.lux', 'lux.db');
  } else {
    dbPath = isAbsolute(entry.db!) ? entry.db! : join(corpusPath, entry.db!);
    worktree = undefined; // db-only ⇒ drift unknown (Decision 8)
  }

  if (!existsSync(dbPath)) {
    throw new SiblingResolveError(
      name,
      'db-absent',
      `sibling '${name}': no Lux index at ${dbPath}.`,
      worktree
        ? `Run \`lux index rebuild\` in ${worktree}.`
        : `Build the index and point db: at it.`
    );
  }

  let namespace: string | undefined;
  let headCommit: string | undefined;
  if (worktree) {
    try {
      headCommit = getHeadCommit(worktree);
    } catch {
      // lux-intentional-swallow: a sibling with no HEAD is reported without a commit.
      headCommit = undefined;
    }
    if (role === 'kernel') {
      try {
        namespace = resolveAppNamespace(worktree);
      } catch {
        // lux-intentional-swallow: a kernel without a readable composer.json is reported without a namespace.
        namespace = undefined;
      }
    }
  }

  let schemaVersion: number | undefined;
  let indexedCommit: string | undefined;
  try {
    const raw = new LuxSqlite(dbPath, { readonly: true, fileMustExist: true });
    try {
      const sv = raw.get('SELECT MAX(version) AS v FROM schema_version') as
        { v: number | null } | undefined;
      schemaVersion = sv?.v ?? undefined;
      const ic = raw.get("SELECT value FROM index_metadata WHERE key = 'last_indexed_commit'") as
        { value?: string } | undefined;
      indexedCommit = ic?.value ?? undefined;
    } finally {
      raw.close();
    }
  } catch (error) {
    // FIX 1b (resolve-time hardening): the path passed existsSync but `new LuxSqlite` /
    // `SELECT … schema_version` threw — a corrupt/truncated SQLite, a non-lux file, or a
    // concurrent-rebuild busy-timeout. Fail as a structured `db-unreadable` refusal so
    // resolveSiblings degrades THIS sibling (Decision 6/7) instead of letting a raw throw abort
    // the whole federated call. Same reason class siblingFaultRefusal yields for a post-resolve
    // fault — one coherent degrade path.
    throw new SiblingResolveError(
      name,
      'db-unreadable',
      `sibling '${name}': index at ${dbPath} is not a readable Lux index ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
      worktree
        ? `Re-index '${name}' (\`lux index rebuild\` in ${worktree}).`
        : `Rebuild the index that db: points at.`
    );
  }

  return {
    name,
    alias,
    dbPath,
    worktree,
    role,
    namespace,
    indexedCommit,
    headCommit,
    schemaVersion,
  };
}

export type SiblingResolution =
  { name: string; sibling: ResolvedSibling } | { name: string; refusal: SiblingRefusal };

/**
 * Resolve named siblings (or 'all') against the registry, degrading each independently
 * (Decision 6). `primarySchemaVersion` is the primary index's MAX(schema_version); a mismatch is a
 * resolve-time `schema-skew` refusal (Decision 7) — a skewed sibling never reaches an ATTACH.
 */
export function resolveSiblings(
  corpusPath: string,
  names: string[] | 'all',
  primarySchemaVersion: number
): SiblingResolution[] {
  const registry = buildSiblingRegistry(loadLspConfig(corpusPath));
  // FIX 2: dedup requested names at the single resolution chokepoint, so `--with foo,foo` /
  // `--against foo,foo` produce ONE resolution (one read pass, one impact entry, one `repos` entry)
  // instead of double-counting. `all` already dedups via Object.keys (distinct registry keys).
  const wanted = names === 'all' ? Object.keys(registry) : [...new Set(names)];
  const out: SiblingResolution[] = [];
  for (const name of wanted) {
    const entry = registry[name];
    if (!entry) {
      out.push({
        name,
        refusal: {
          name,
          reason: 'unregistered',
          message: `sibling '${name}' is not registered in lux.yaml siblings.`,
          remediation: `Add it under siblings:, or check the --with/--against name.`,
        },
      });
      continue;
    }
    try {
      const sibling = resolveSibling(corpusPath, name, entry);
      if (sibling.schemaVersion !== undefined && sibling.schemaVersion !== primarySchemaVersion) {
        out.push({
          name,
          refusal: {
            name,
            reason: 'schema-skew',
            message: `sibling '${name}' index is schema v${sibling.schemaVersion}, primary is v${primarySchemaVersion}.`,
            remediation: `Re-index '${name}' at the current schema (\`lux index rebuild\` in its worktree).`,
          },
        });
        continue;
      }
      out.push({ name, sibling });
    } catch (error) {
      if (error instanceof SiblingResolveError) {
        out.push({
          name,
          refusal: {
            name,
            reason: error.reason,
            message: error.message,
            remediation: error.remediation,
          },
        });
        continue;
      }
      throw error;
    }
  }
  return out;
}

// ── Federation freshness block (carried by every federated output — Decision 8 / SC-9) ──

export interface SiblingFreshness {
  indexedCommit: string | null;
  /** null for db-only entries (no worktree HEAD ⇒ drift unknown). */
  headCommit: string | null;
  /** true/false when both commits known; null when drift is unknown. */
  stale: boolean | null;
  /** disambiguated from the delta envelope's `schemaVersion: 1`. */
  dbSchemaVersion: number | null;
}

export interface FederationSiblingRecord {
  name: string;
  role: SiblingRole;
  attached: boolean;
  worktree: string | null;
  freshness?: SiblingFreshness;
  refusal?: { reason: SiblingRefusalReason; message: string; remediation: string };
}

export interface FederationBlock {
  siblings: FederationSiblingRecord[];
}

export function siblingFreshness(s: ResolvedSibling): SiblingFreshness {
  const stale = s.indexedCommit && s.headCommit ? s.indexedCommit !== s.headCommit : null;
  return {
    indexedCommit: s.indexedCommit ?? null,
    headCommit: s.headCommit ?? null,
    stale,
    dbSchemaVersion: s.schemaVersion ?? null,
  };
}

/** The per-sibling `federation` block every federated `--json` output embeds (SC-9). */
export function buildFederationBlock(resolutions: SiblingResolution[]): FederationBlock {
  return {
    siblings: resolutions.map((r) =>
      'sibling' in r
        ? {
            name: r.sibling.name,
            role: r.sibling.role,
            attached: true,
            worktree: r.sibling.worktree ?? null,
            freshness: siblingFreshness(r.sibling),
          }
        : {
            name: r.name,
            role: 'peer' as SiblingRole,
            attached: false,
            worktree: null,
            refusal: {
              reason: r.refusal.reason,
              message: r.refusal.message,
              remediation: r.refusal.remediation,
            },
          }
    ),
  };
}
