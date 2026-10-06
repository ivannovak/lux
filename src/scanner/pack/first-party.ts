import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import type { WarnFn } from '../reporter.js';

/**
 * First-party package promotion (E1). A repo may declare `firstParty.packages`
 * (globs against composer package names) to have those packages scanned as
 * app-source and merged into the overlay, rather than treated as opaque vendor.
 * This makes a shared kernel's routes resolve to the consuming app's controllers.
 */
export interface FirstPartyRoot {
  /** Composer package name, e.g. "acme/core". */
  package: string;
  /** Absolute, symlink-resolved source root to scan as app-source. */
  sourceRoot: string;
}

/** Minimal package-name glob → RegExp ("acme/*" matches "acme/core"). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Resolve first-party globs to real source roots via composer's installed.json.
 * Follows path-repository symlinks (and normal installs) to the true source
 * root via realpath.
 *
 * Graceful when the app is not composer-installed: returns [] if installed.json
 * is absent or unparseable, so the caller falls back to single-root scanning.
 * Roots are de-duplicated (defensive against a glob matching aliased packages).
 */
export function resolveFirstPartyRoots(
  corpusPath: string,
  globs: string[],
  warn?: WarnFn
): FirstPartyRoot[] {
  if (!globs.length) return [];
  const installedPath = join(corpusPath, 'vendor/composer/installed.json');
  if (!existsSync(installedPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(installedPath, 'utf-8'));
  } catch (error) {
    warn?.(
      `vendor/composer/installed.json could not be read, so no first-party package was promoted — ` +
        (error instanceof Error ? error.message : String(error))
    );
    return [];
  }
  const packages = (parsed as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return [];

  const matchers = globs.map(globToRegExp);
  const composerDir = join(corpusPath, 'vendor/composer');
  const roots: FirstPartyRoot[] = [];
  const seen = new Set<string>();

  for (const entry of packages as Array<Record<string, unknown>>) {
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    const installPath =
      typeof entry['install-path'] === 'string' ? entry['install-path'] : undefined;
    if (!name || !installPath) continue;
    if (!matchers.some((m) => m.test(name))) continue;
    let sourceRoot: string;
    try {
      sourceRoot = realpathSync(resolve(composerDir, installPath));
    } catch {
      warn?.(`first-party package ${name} is configured but not installed at ${installPath}`);
      continue;
    }
    if (seen.has(sourceRoot)) continue;
    seen.add(sourceRoot);
    roots.push({ package: name, sourceRoot });
  }

  return roots;
}
