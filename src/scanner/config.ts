// Scanner configuration: loads and validates lux.yaml LSP section from the content root.
//
// The lux.yaml file is optional. When present, it configures LSP enrichers
// and other scanner behavior. When absent, defaults are used (no enrichment).

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
// EmbeddingConfig lives in the NON-fenced scanner/anchors/ (spec 19 §Note, resolution 2): config.ts is
// forbidden by the path-fence from importing scanner/embeddings/ at all — even a type-only import
// resolves to the fenced prefix — so the type is defined outside the fence and the embeddings seam
// re-exports it. This keeps `lint:architecture` green without widening the fence allowlist to config.ts.
import type { EmbeddingConfig } from './anchors/embedding-config.js';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Configuration for a single LSP enricher in lux.yaml. */
export interface LspEnricherEntry {
  /** Language identifier (e.g. "php", "typescript"). */
  languageId: string;
  /** Whether this enricher is enabled (default: true). */
  enabled?: boolean;
  /** Command to spawn the language server. */
  serverCommand?: string;
  /** Arguments to pass to the language server. */
  serverArgs?: string[];
  /** Maximum concurrent LSP requests. */
  maxConcurrency?: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Initialization timeout in milliseconds. */
  initTimeoutMs?: number;
}

/** The lsp section of lux.yaml. */
export interface LspConfig {
  /** Whether LSP enrichment is enabled globally (default: false). */
  enabled: boolean;
  /** Workspace root override for LSP servers (default: content root path). */
  workspaceRoot?: string;
  /** Per-language enricher configurations. */
  enrichers: LspEnricherEntry[];
}

/** Dependency analysis configuration. */
export interface DepsConfig {
  /** Whether dependency analysis is enabled (default: true when boundaries detected). */
  enabled: boolean;
  /** Module boundary pattern, e.g. "src/Module/{name}". */
  moduleBoundary?: string;
}

/** Tree-sitter AST structural-tier configuration. */
export interface AstConfig {
  /** Whether the AST structural tier is enabled (default: true — zero-config). */
  enabled: boolean;
}

/** Content/source scanning configuration. */
export interface ScanConfig {
  /**
   * Exclude generated build artifacts (compiled/minified bundles under
   * public/, sourcemaps). Default: true — the biggest app-build lever, and
   * lossless for the call graph (the bundles are a derived copy of authored
   * source). Set false for apps that serve AUTHORED js from public/.
   */
  excludeGeneratedArtifacts: boolean;
  /** Extra ignore globs, unioned with the built-in defaults. */
  ignorePatterns: string[];
}

export interface InertiaFrameworkConfigV1 {
  pageRoots: string[];
  namespaces: Record<string, string[]>;
}

export interface LivewireFrameworkConfigV1 {
  classRoots: string[];
  viewRoots: string[];
  viewNamespaces: Record<string, string[]>;
}

export interface NovaFrameworkConfigV1 {
  enabled: boolean;
}

export interface FrontendFrameworkConfigV1 {
  inertia: InertiaFrameworkConfigV1;
  livewire: LivewireFrameworkConfigV1;
  nova: NovaFrameworkConfigV1;
}

const DEFAULT_FRONTEND_FRAMEWORK_CONFIG: FrontendFrameworkConfigV1 = {
  inertia: { pageRoots: [], namespaces: {} },
  livewire: {
    classRoots: ['app/Livewire', 'app/Http/Livewire'],
    viewRoots: ['resources/views/livewire'],
    viewNamespaces: {},
  },
  nova: { enabled: true },
};

/** Top-level lux.yaml configuration (LSP-specific fields). */
export interface LuxLspConfig {
  /** LSP enrichment configuration. */
  lsp: LspConfig;
  /** Dependency analysis configuration. */
  deps: DepsConfig;
  /** AST structural tier configuration. */
  ast?: AstConfig;
  /** Content/source scanning configuration. */
  scan?: ScanConfig;
  /** First-party package promotion (E1): globs against composer package names. */
  firstParty?: FirstPartyConfig;
  /** Overlay features (cross-area kernel ownership, #62). */
  overlay?: OverlayConfig;
  /** Delta gate policy (`lux delta --check`, #delta). */
  delta?: DeltaConfig;
  /** Scoped overlay refresh budgets (Decisions 7, 8). */
  refresh?: RefreshConfig;
  /** Static frontend-framework roots and namespaces. */
  frameworks?: FrontendFrameworkConfigV1;
  /** Named cross-repo sibling-index registry (federation, Decision 1). */
  siblings?: SiblingsConfig;
  /** Anchor-embedding provider/model (Phase 4, Decision 7/11). Absent ⇒ native-free local default,
   *  zero config. NO token here — the API key is env-only (LUX_EMBEDDING_TOKEN); an inline token
   *  fails the load (validateEmbeddingConfig). */
  embedding?: EmbeddingConfig;
  /** Vendor-pack merge control. Absent ⇒ merge a cached pack when one matches composer.lock. */
  vendorPack?: VendorPackConfig;
}

/**
 * The vendorPack section of lux.yaml. A rebuild merges a vendor pack from the machine-wide cache
 * (`~/.lux/packs`, keyed by composer.lock), so two machines with different caches build different
 * indexes from one commit. `merge: false` makes the index a function of the checkout alone.
 */
export interface VendorPackConfig {
  /** Merge the cached vendor pack into the overlay (default: true). */
  merge: boolean;
}

/** The delta section of lux.yaml — CI/local gate policy (Decision 7). */
export interface DeltaConfig {
  /** Gate categories evaluated under `lux delta --check` (overridable by --fail-on). */
  gates: string[];
}

/** The refresh section of lux.yaml — scoped overlay refresh budgets (Decisions 7, 8). */
export interface RefreshConfig {
  /** Changed-file ceiling; above ⇒ full rebuild (Decision 7). Default 100 (OQ1 placeholder). */
  maxScopedFiles: number;
  /** LSP-tier budget per scoped run in ms; exceeded ⇒ tier skipped + stale marks (Decision 8). Default 30000. */
  lspBudgetMs: number;
}

export const DEFAULT_REFRESH_CONFIG: RefreshConfig = { maxScopedFiles: 100, lspBudgetMs: 30000 };

/** The firstParty section of lux.yaml. */
export interface FirstPartyConfig {
  /** Composer package-name globs to promote to app-source, e.g. ["acme/*"]. */
  packages: string[];
}

/** The overlay section of lux.yaml. */
export interface OverlayConfig {
  /** Cross-area kernel: classify handler ownership against a sibling kernel's built .lux index (#62). */
  kernel?: KernelOverlayConfig;
}

/** overlay.kernel — the composer path-repo package the client vendors as the kernel. */
export interface KernelOverlayConfig {
  /** Composer package name, e.g. "acme/core". */
  package: string;
}

export type SiblingRole = 'kernel' | 'peer';

/** One entry in the top-level `siblings:` registry. Exactly one of package|path|db (validated). */
export interface SiblingEntry {
  /** composer path-repo mode: worktree = realpath(vendor/<package>). */
  package?: string;
  /** explicit worktree mode (relative to corpus or absolute; realpath-resolved). */
  path?: string;
  /** index-only mode (CI artifact) — no worktree ⇒ drift reported as unknown. */
  db?: string;
  /** kernel ⇒ surface-id bridging + ownership sugar; default peer. */
  role?: SiblingRole;
}

export interface SiblingsConfig {
  [name: string]: SiblingEntry;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: false,
  enrichers: [],
};

const DEFAULT_DEPS_CONFIG: DepsConfig = {
  enabled: true,
};

const DEFAULT_AST_CONFIG: AstConfig = {
  enabled: true,
};

const DEFAULT_SCAN_CONFIG: ScanConfig = {
  excludeGeneratedArtifacts: true,
  ignorePatterns: [],
};

const DEFAULT_CONFIG: LuxLspConfig = {
  lsp: DEFAULT_LSP_CONFIG,
  deps: DEFAULT_DEPS_CONFIG,
  ast: DEFAULT_AST_CONFIG,
  scan: DEFAULT_SCAN_CONFIG,
};

// ---------------------------------------------------------------------------
// Raw YAML shape (pre-validation)
// ---------------------------------------------------------------------------

interface RawLspEnricherEntry {
  language_id?: unknown;
  enabled?: unknown;
  server_command?: unknown;
  server_args?: unknown;
  max_concurrency?: unknown;
  request_timeout_ms?: unknown;
  init_timeout_ms?: unknown;
}

interface RawLspConfig {
  enabled?: unknown;
  workspace_root?: unknown;
  enrichers?: unknown;
}

interface RawDepsConfig {
  enabled?: unknown;
  module_boundary?: unknown;
}

interface RawLuxConfig {
  lsp?: unknown;
  deps?: unknown;
  ast?: unknown;
  scan?: unknown;
  firstParty?: unknown;
  overlay?: unknown;
  delta?: unknown;
  refresh?: unknown;
  siblings?: unknown;
  frameworks?: unknown;
  embedding?: unknown;
  vendorPack?: unknown;
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

/**
 * Load LSP configuration from a lux.yaml file in the given directory.
 *
 * @param rootPath - Root directory to look for lux.yaml.
 * @returns Parsed and validated configuration, with defaults applied.
 */
export function loadLspConfig(rootPath: string): LuxLspConfig {
  const configPath = join(rootPath, 'lux.yaml');

  let rawContent: string;
  try {
    rawContent = readFileSync(configPath, 'utf-8');
  } catch {
    // lux-intentional-swallow: no lux.yaml is the documented default configuration.
    // No config file — return defaults (LSP disabled)
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to parse lux.yaml: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_CONFIG;
  }

  return validateConfig(parsed);
}

/**
 * Validate and normalize a raw parsed YAML object into a LuxLspConfig.
 */
function validateConfig(raw: RawLuxConfig): LuxLspConfig {
  const overlay = validateOverlayConfig(raw.overlay); // hoisted so the sibling kernel-sugar cross-check can see it
  return {
    lsp: raw.lsp ? validateLspConfig(raw.lsp) : DEFAULT_LSP_CONFIG,
    deps: raw.deps ? validateDepsConfig(raw.deps) : DEFAULT_DEPS_CONFIG,
    ast: raw.ast ? validateAstConfig(raw.ast) : DEFAULT_AST_CONFIG,
    scan: raw.scan ? validateScanConfig(raw.scan) : DEFAULT_SCAN_CONFIG,
    firstParty: validateFirstPartyConfig(raw.firstParty),
    overlay,
    delta: validateDeltaConfig(raw.delta),
    refresh: validateRefreshConfig(raw.refresh),
    siblings: validateSiblingsConfig(raw.siblings, overlay),
    frameworks: validateFrameworksConfig(raw.frameworks),
    embedding: validateEmbeddingConfig(raw.embedding),
    vendorPack: validateVendorPackConfig(raw.vendorPack),
  };
}

function validateVendorPackConfig(raw: unknown): VendorPackConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lux.yaml "vendorPack" must be a mapping.');
  }
  const merge = (raw as { merge?: unknown }).merge ?? true;
  if (typeof merge !== 'boolean') {
    throw new Error('lux.yaml "vendorPack.merge" must be true or false.');
  }
  return { merge };
}

function validFrameworkPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('/')) return false;
  if ([...value].some((character) => character.charCodeAt(0) <= 0x1f)) return false;
  return !value.replaceAll('\\', '/').split('/').includes('..');
}

function frameworkPaths(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every(validFrameworkPath)) {
    throw new Error('lux.yaml framework paths must be non-empty repository-relative strings.');
  }
  return [...new Set(value)];
}

function frameworkNamespaces(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lux.yaml framework namespaces must be a mapping.');
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, paths]) => {
      if (!validFrameworkPath(name)) throw new Error('lux.yaml framework namespace is invalid.');
      return [name, frameworkPaths(paths, [])];
    })
  );
}

function validateFrameworksConfig(raw: unknown): FrontendFrameworkConfigV1 {
  if (raw === undefined || raw === null) return DEFAULT_FRONTEND_FRAMEWORK_CONFIG;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lux.yaml `frameworks` must be a mapping.');
  }
  const value = raw as Record<string, unknown>;
  const inertia = (value.inertia ?? {}) as Record<string, unknown>;
  const livewire = (value.livewire ?? {}) as Record<string, unknown>;
  const nova = (value.nova ?? {}) as Record<string, unknown>;
  return {
    inertia: {
      pageRoots: frameworkPaths(inertia.pageRoots, []),
      namespaces: frameworkNamespaces(inertia.namespaces),
    },
    livewire: {
      classRoots: frameworkPaths(
        livewire.classRoots,
        DEFAULT_FRONTEND_FRAMEWORK_CONFIG.livewire.classRoots
      ),
      viewRoots: frameworkPaths(
        livewire.viewRoots,
        DEFAULT_FRONTEND_FRAMEWORK_CONFIG.livewire.viewRoots
      ),
      viewNamespaces: frameworkNamespaces(livewire.viewNamespaces),
    },
    nova: { enabled: nova.enabled !== false },
  };
}

/**
 * Validate the optional `embedding` section (Phase 4, Decision 7/11).
 *  - provider = 'openai' (optional; the sole shipped provider — spec 19 §Part B on why not Voyage).
 *  - model: an optional non-empty string (provider default applies).
 *  - token: REJECTED. lux.yaml is a committed file and lux's history already carries a leaked key
 *    (the OSS-prep rotation is on record), so an inline `embedding.token` is a committed-secret
 *    footgun BY CONSTRUCTION. The API key is read from process.env.LUX_EMBEDDING_TOKEN only; finding a
 *    `token` under `embedding` FAILS THE LOAD (a loud error at the moment it is introduced) rather
 *    than silently ignoring it. This is Decision 11 promoted from an open question to a hard gate.
 */
function validateEmbeddingConfig(raw: unknown): EmbeddingConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lux.yaml: `embedding` must be a mapping (provider?/model?).');
  }
  const obj = raw as Record<string, unknown>;

  // Fail-closed (Decision 11): a token in yaml is a committed-secret footgun — refuse to load.
  if ('token' in obj) {
    throw new Error(
      'lux.yaml: `embedding.token` is not permitted — the API key is read from the ' +
        'LUX_EMBEDDING_TOKEN environment variable only. Remove the inline token (and rotate it — a ' +
        'key written to a committed file must be considered leaked).'
    );
  }
  // Reject any near-miss key that could be a mis-spelled / re-cased secret and route it to the SAME
  // rotate-the-key guidance as the exact `token` above — case-insensitively: token (catches Token /
  // TOKEN that slip past the case-sensitive `'token' in obj` check), api[_-]?key, key, secret, auth,
  // bearer, password, credential(s). Fail-closed already holds (the secret is never used), but a user
  // who typed one of these must be told to ROTATE, not just rename. Everything else is an unknown key.
  for (const k of Object.keys(obj)) {
    if (/^(token|api[_-]?key|key|secret|auth|bearer|password|credentials?)$/i.test(k)) {
      throw new Error(
        `lux.yaml: \`embedding.${k}\` is not permitted — the API key is env-only ` +
          '(LUX_EMBEDDING_TOKEN). Remove it and rotate the key.'
      );
    }
    if (k !== 'provider' && k !== 'model') {
      throw new Error(`lux.yaml: unknown key \`embedding.${k}\` (allowed: provider, model).`);
    }
  }

  const provider = obj.provider;
  if (provider !== undefined && provider !== 'openai') {
    // JSON.stringify (not String) so a non-string yaml value renders honestly, never '[object Object]'.
    throw new Error(
      `lux.yaml: \`embedding.provider\` must be 'openai' (the sole shipped provider; got ${JSON.stringify(provider)}).`
    );
  }
  const model = obj.model;
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new Error('lux.yaml: `embedding.model` must be a non-empty string.');
  }
  // Fix 7: trim the model before returning — a trailing space would 400 at the provider.
  const trimmedModel = typeof model === 'string' ? model.trim() : undefined;

  // provider is narrowed to 'openai' and model to string by the guards above.
  return {
    ...(provider ? { provider } : {}),
    ...(trimmedModel ? { model: trimmedModel } : {}),
  };
}

/**
 * Validate the `refresh` section (scoped overlay refresh budgets, Decisions 7/8). Absent ⇒ the
 * shipped defaults (`maxScopedFiles: 100`, `lspBudgetMs: 30000`). A non-positive `maxScopedFiles`
 * or negative `lspBudgetMs` is a hard error — a zero/negative budget silently disables a tier.
 */
function validateRefreshConfig(raw: unknown): RefreshConfig {
  if (raw === undefined || raw === null) return DEFAULT_REFRESH_CONFIG;
  if (typeof raw !== 'object') {
    throw new Error('lux.yaml "refresh" must be a mapping.');
  }
  const r = raw as { maxScopedFiles?: unknown; lspBudgetMs?: unknown };
  const maxScopedFiles = r.maxScopedFiles ?? DEFAULT_REFRESH_CONFIG.maxScopedFiles;
  const lspBudgetMs = r.lspBudgetMs ?? DEFAULT_REFRESH_CONFIG.lspBudgetMs;
  if (
    typeof maxScopedFiles !== 'number' ||
    !Number.isInteger(maxScopedFiles) ||
    maxScopedFiles < 1
  ) {
    throw new Error('lux.yaml "refresh.maxScopedFiles" must be a positive integer.');
  }
  if (typeof lspBudgetMs !== 'number' || lspBudgetMs < 0) {
    throw new Error('lux.yaml "refresh.lspBudgetMs" must be a non-negative number.');
  }
  return { maxScopedFiles, lspBudgetMs };
}

/**
 * Validate the `delta` section (CI/local gate policy, Decision 7). Category *names* are
 * deliberately NOT validated here — the unknown-category hard-error happens once, at
 * gate-resolution time (`resolveGateCategories`), so `--fail-on` and `delta.gates` hit the
 * identical check (no silent gate passes).
 */
function validateDeltaConfig(raw: unknown): DeltaConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const gates = (raw as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return undefined;
  const list = gates.filter((g): g is string => typeof g === 'string');
  return list.length ? { gates: list } : undefined;
}

function validateFirstPartyConfig(raw: unknown): FirstPartyConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const packages = (raw as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return undefined;
  const globs = packages.filter((p): p is string => typeof p === 'string');
  return globs.length ? { packages: globs } : undefined;
}

/** Composer package-name grammar. Structurally forbids `..`, absolute paths, and extra
 *  separators, so `join(corpus, 'vendor', package)` in resolveKernel can't escape the corpus. */
const COMPOSER_PACKAGE = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9]([_.-]?[a-z0-9]+)*$/;

function validateOverlayConfig(raw: unknown): OverlayConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const kernelRaw = (raw as { kernel?: unknown }).kernel;
  if (typeof kernelRaw !== 'object' || kernelRaw === null) return undefined;
  const pkg = (kernelRaw as { package?: unknown }).package;
  if (typeof pkg !== 'string' || !COMPOSER_PACKAGE.test(pkg)) return undefined;
  return { kernel: { package: pkg } };
}

/** Registry name grammar (the --with/--against handle). */
const SIBLING_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** OQ6: reserve the three names that map to hardcoded aliases (`sib_` prefix aside, `attachKernel`
 *  uses `kernel`, the baseline diff uses `baseline`, and `main` is the primary) — reject them as
 *  registry names for operator clarity. */
const RESERVED_SIBLING_NAMES = new Set(['kernel', 'baseline', 'main']);

/**
 * Validate the `siblings:` registry (Decision 1). Fail-loud: any structural violation throws
 * (surfaced to the operator at config load — the `config-invalid` refusal class). Enforces the
 * name grammar, reserved names, exactly-one-of package|path|db, role ∈ {kernel,peer}, the
 * single-kernel invariant, and the kernel-sugar non-conflict.
 */
function validateSiblingsConfig(
  raw: unknown,
  overlay: OverlayConfig | undefined
): SiblingsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('lux.yaml siblings: must be a map of name → { package|path|db, role? }.');
  }
  const out: SiblingsConfig = {};
  let kernelCount = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SIBLING_NAME.test(name)) {
      throw new Error(`lux.yaml siblings: invalid name '${name}' (must match ${SIBLING_NAME}).`);
    }
    if (RESERVED_SIBLING_NAMES.has(name)) {
      throw new Error(`lux.yaml siblings: '${name}' is a reserved name — choose another.`);
    }
    if (typeof value !== 'object' || value === null) {
      throw new Error(
        `lux.yaml siblings.${name}: must be an object with exactly one of package|path|db.`
      );
    }
    const v = value as Record<string, unknown>;
    const pkg = typeof v.package === 'string' ? v.package : undefined;
    const path = typeof v.path === 'string' ? v.path : undefined;
    const db = typeof v.db === 'string' ? v.db : undefined;
    const modes = [pkg, path, db].filter((m) => m !== undefined);
    if (modes.length !== 1) {
      throw new Error(
        `lux.yaml siblings.${name}: exactly one of package|path|db is required (got ${modes.length}).`
      );
    }
    if (pkg !== undefined && !COMPOSER_PACKAGE.test(pkg)) {
      throw new Error(
        `lux.yaml siblings.${name}.package '${pkg}' is not a valid composer package name.`
      );
    }
    let role: SiblingRole = 'peer';
    if (v.role !== undefined) {
      if (v.role !== 'kernel' && v.role !== 'peer') {
        throw new Error(`lux.yaml siblings.${name}.role must be 'kernel' or 'peer'.`);
      }
      role = v.role;
    }
    if (role === 'kernel') kernelCount++;
    out[name] = { package: pkg, path, db, role };
  }
  if (kernelCount > 1) {
    throw new Error(
      'lux.yaml siblings: at most one sibling may declare role: kernel (single-kernel invariant, Decision 1).'
    );
  }
  if (kernelCount === 1 && overlay?.kernel?.package) {
    throw new Error(
      'lux.yaml: declaring both overlay.kernel.package and a role: kernel sibling is ambiguous — ' +
        'use one (single-kernel invariant, Decision 1).'
    );
  }
  return Object.keys(out).length ? out : undefined;
}

function validateAstConfig(raw: unknown): AstConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_AST_CONFIG;
  const obj = raw as { enabled?: unknown };
  // On by default (zero-config); only an explicit `enabled: false` opts out.
  return { enabled: obj.enabled !== false };
}

function validateScanConfig(raw: unknown): ScanConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SCAN_CONFIG;
  const obj = raw as { exclude_generated_artifacts?: unknown; ignore_patterns?: unknown };
  return {
    // On by default; only an explicit `exclude_generated_artifacts: false` opts out.
    excludeGeneratedArtifacts: obj.exclude_generated_artifacts !== false,
    ignorePatterns: Array.isArray(obj.ignore_patterns)
      ? obj.ignore_patterns.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

function validateDepsConfig(raw: unknown): DepsConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_DEPS_CONFIG;
  }

  const config = raw as RawDepsConfig;

  return {
    enabled: config.enabled !== false,
    moduleBoundary: typeof config.module_boundary === 'string' ? config.module_boundary : undefined,
  };
}

function validateLspConfig(raw: unknown): LspConfig {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_LSP_CONFIG;
  }

  const config = raw as RawLspConfig;

  return {
    enabled: config.enabled === true,
    workspaceRoot: typeof config.workspace_root === 'string' ? config.workspace_root : undefined,
    enrichers: Array.isArray(config.enrichers)
      ? config.enrichers.map(validateEnricherEntry).filter(isValidEntry)
      : [],
  };
}

function validateEnricherEntry(raw: unknown): LspEnricherEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const entry = raw as RawLspEnricherEntry;

  if (typeof entry.language_id !== 'string' || !entry.language_id) {
    return null;
  }

  return {
    languageId: entry.language_id,
    enabled: entry.enabled !== false,
    serverCommand: typeof entry.server_command === 'string' ? entry.server_command : undefined,
    serverArgs: Array.isArray(entry.server_args)
      ? entry.server_args.filter((a): a is string => typeof a === 'string')
      : undefined,
    maxConcurrency:
      typeof entry.max_concurrency === 'number' && entry.max_concurrency > 0
        ? entry.max_concurrency
        : undefined,
    requestTimeoutMs:
      typeof entry.request_timeout_ms === 'number' && entry.request_timeout_ms > 0
        ? entry.request_timeout_ms
        : undefined,
    initTimeoutMs:
      typeof entry.init_timeout_ms === 'number' && entry.init_timeout_ms > 0
        ? entry.init_timeout_ms
        : undefined,
  };
}

function isValidEntry(entry: LspEnricherEntry | null): entry is LspEnricherEntry {
  return entry !== null;
}
