import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveFileUniverse, selectFilesSync } from './file-universe.js';
import type { LuxDatabase } from '../db/index.js';
import { loadLspConfig } from './config.js';
import { resolveFirstPartyRoots } from './pack/first-party.js';

export const STRUCTURAL_CONFIG_FINGERPRINT_KEY = 'structural_config_fingerprint';
const projectResolutionInputs = new Map<string, readonly string[]>();
const PROJECT_CONFIG_PATTERNS = [
  '**/tsconfig.json',
  '**/jsconfig.json',
  '**/vite.config.js',
  '**/vite.config.ts',
  '**/vite.config.mjs',
  '**/vite.config.mts',
  '**/package.json',
  'pnpm-workspace.yaml',
];

/** Register the root-confined config/manifest inputs discovered by the current project analysis. */
export function rememberProjectResolutionFingerprintInputs(
  rootPath: string,
  inputs: readonly string[]
): void {
  projectResolutionInputs.set(rootPath, [...new Set(inputs)].sort());
}

/**
 * `sha256` over the raw bytes of `lux.yaml` (whole file — over-escalation is the safe direction),
 * the raw bytes of `composer.lock` when present, the applied `schema_version`, and the sorted
 * root-relative realpaths of resolved first-party roots (Decision 7). A cosmetic YAML edit costs
 * one full rebuild; a missed input would silently under-escalate (the dangerous direction), so the
 * whole file is hashed.
 *
 * The checkout's own location is not an input. `lux.yaml` commonly spells it out (an absolute
 * `lsp.workspace_root`), so every occurrence of the root path is replaced by a placeholder before
 * hashing, and first-party roots are hashed relative to the root: two checkouts of one commit with
 * the same config share a fingerprint.
 */
export function computeStructuralConfigFingerprint(rootPath: string, db: LuxDatabase): string {
  const h = createHash('sha256');

  h.update('lux.yaml\0');
  const luxYaml = join(rootPath, 'lux.yaml');
  h.update(
    existsSync(luxYaml)
      ? withoutCheckoutRoot(readFileSync(luxYaml, 'utf-8'), rootPath)
      : Buffer.from('<absent>')
  );

  h.update('\0composer.lock\0');
  const composerLock = join(rootPath, 'composer.lock');
  h.update(existsSync(composerLock) ? readFileSync(composerLock) : Buffer.from('<absent>'));

  h.update('\0schema_version\0');
  h.update(String(db.getAppliedSchemaVersion()));

  h.update('\0firstPartyRoots\0');
  const config = loadLspConfig(rootPath);
  const realRoot = realpathOr(rootPath);
  const roots = (
    config.firstParty ? resolveFirstPartyRoots(rootPath, config.firstParty.packages) : []
  )
    .map((r) => relative(realRoot, realpathOr(r.sourceRoot)).replaceAll('\\', '/'))
    .sort();
  h.update(roots.join('|'));

  h.update('\0projectResolutionInputs\0');
  const knownInputs = projectResolutionInputs.get(rootPath);
  const inputs =
    knownInputs ??
    selectFilesSync(rootPath, resolveFileUniverse(rootPath), PROJECT_CONFIG_PATTERNS, [
      '**/node_modules/**',
      '**/.git/**',
      '**/vendor/**',
    ])
      .map((path) => relative(rootPath, join(rootPath, path)).replaceAll('\\', '/'))
      .sort();
  for (const relativePath of inputs) {
    const absolutePath = join(rootPath, relativePath);
    h.update(relativePath);
    h.update('\0');
    h.update(existsSync(absolutePath) ? readFileSync(absolutePath) : Buffer.from('<absent>'));
    h.update('\0');
  }

  return h.digest('hex');
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // lux-intentional-swallow: a path that cannot be canonicalized is used as written.
    return path;
  }
}

/**
 * Replace the checkout root (as given, and resolved) with a placeholder, longest spelling first.
 * Only whole path prefixes match: `/src/app` is replaced in `/src/app/sub`, not in `/src/app-old`.
 */
function withoutCheckoutRoot(text: string, rootPath: string): string {
  const spellings = [...new Set([rootPath, realpathOr(rootPath)])].sort(
    (a, b) => b.length - a.length
  );
  let out = text;
  for (const spelling of spellings) {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?=$|[/\\s"',\\]}])`, 'gm'), '<ROOT>');
  }
  return out;
}

/** Persist the fingerprint — call after EVERY full rebuild (Decision 7). */
export function persistStructuralConfigFingerprint(rootPath: string, db: LuxDatabase): void {
  db.setIndexMetadata(
    STRUCTURAL_CONFIG_FINGERPRINT_KEY,
    computeStructuralConfigFingerprint(rootPath, db)
  );
}

/** True when the current config matches the fingerprint recorded at the last full rebuild. */
export function structuralConfigFingerprintMatches(rootPath: string, db: LuxDatabase): boolean {
  const stored = db.getIndexMetadata(STRUCTURAL_CONFIG_FINGERPRINT_KEY);
  if (!stored) return false; // never recorded ⇒ escalate (safe direction)
  return stored === computeStructuralConfigFingerprint(rootPath, db);
}
