import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { globSync } from 'glob';
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
 * realpaths of resolved first-party roots (Decision 7). A cosmetic YAML edit costs one full
 * rebuild; a missed input would silently under-escalate (the dangerous direction), so the whole
 * file is hashed.
 */
export function computeStructuralConfigFingerprint(rootPath: string, db: LuxDatabase): string {
  const h = createHash('sha256');

  h.update('lux.yaml\0');
  const luxYaml = join(rootPath, 'lux.yaml');
  h.update(existsSync(luxYaml) ? readFileSync(luxYaml) : Buffer.from('<absent>'));

  h.update('\0composer.lock\0');
  const composerLock = join(rootPath, 'composer.lock');
  h.update(existsSync(composerLock) ? readFileSync(composerLock) : Buffer.from('<absent>'));

  h.update('\0schema_version\0');
  h.update(String(db.getAppliedSchemaVersion()));

  h.update('\0firstPartyRoots\0');
  const config = loadLspConfig(rootPath);
  const roots = (
    config.firstParty ? resolveFirstPartyRoots(rootPath, config.firstParty.packages) : []
  )
    .map((r) => {
      try {
        return realpathSync(r.sourceRoot);
      } catch {
        // lux-intentional-swallow: a path that cannot be canonicalized is used as written.
        return r.sourceRoot;
      }
    })
    .sort();
  h.update(roots.join('|'));

  h.update('\0projectResolutionInputs\0');
  const knownInputs = projectResolutionInputs.get(rootPath);
  const inputs =
    knownInputs ??
    globSync(PROJECT_CONFIG_PATTERNS, {
      cwd: rootPath,
      nodir: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**'],
    })
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
