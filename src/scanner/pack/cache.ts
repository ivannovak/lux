// Vendor pack cache: keying, cache-dir resolution, and hit/miss lookup (ADR-1,
// REQ-6). A pack is a per-machine artifact shared across every project on the box
// that pins the same dependency set — that sharing IS the reuse in REQ-6.
//
// Invalidation is key-based, which sidesteps the fact that vendor/ changes are
// invisible to the incremental sync path (it keys off git diffs of authored
// source; vendor/ is git-ignored). A lockfile change → different digest →
// different pack directory → cache miss → rebuild.

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { PACK_FORMAT_VERSION, VendorPackReader } from './pack-format.js';

/** Metadata key under which `vendor-pack build` records the pack key the project is aligned to. */
export const VENDOR_PACK_KEY_META = 'vendor_pack_key';

/**
 * Metadata key under which a rebuild records the identity of the pack it merged into the overlay
 * (see vendorPackIdentity). Cleared with the overlay, so an absent key means nothing was merged
 * since the overlay was last cleared — unless vendor-pack nodes predate the key.
 */
export const VENDOR_PACK_MERGED_META = 'vendor_pack_merged';

/** The identity a merged pack is recorded under: its key directory and versioned file name. */
export function vendorPackIdentity(packPath: string | null): string {
  if (!packPath) return 'none';
  return `${basename(dirname(packPath))}/${basename(packPath)}`;
}

export type PackKeyScheme = 'composer-lock' | 'per-package';

export interface PackKey {
  scheme: PackKeyScheme;
  /** Full hex digest identifying the dependency set. */
  digest: string;
  /** Human-readable framework label, best-effort. */
  framework?: string;
}

export interface PackCacheOptions {
  /** Explicit cache root (CLI --pack-cache). Points at the packs ROOT dir. */
  packCache?: string;
  /** Environment source (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Default keying: sha256 of the raw composer.lock bytes. One content-addressed
 * key per dependency set; any dependency bump rebuilds the whole pack (simple,
 * matches ADR-1).
 */
export function deriveComposerLockKey(projectRoot: string): PackKey {
  const raw = readFileSync(join(projectRoot, 'composer.lock'));
  const digest = createHash('sha256').update(raw).digest('hex');
  return { scheme: 'composer-lock', digest, framework: readFrameworkLabel(raw) };
}

/**
 * Documented alternative (ADR-1 fork): hash the sorted set of installed runtime
 * packages (name@version#dist.reference) from composer.lock's `packages` array.
 * Two projects sharing the exact runtime dependency set — even with different dev
 * deps or lock formatting — get the same key. More bookkeeping; not the default.
 */
export function derivePerPackageKey(projectRoot: string): PackKey {
  const raw = readFileSync(join(projectRoot, 'composer.lock'));
  const lock = JSON.parse(raw.toString('utf-8')) as {
    packages?: Array<{ name: string; version: string; dist?: { reference?: string } }>;
  };
  const parts = (lock.packages ?? [])
    .map((p) => `${p.name}@${p.version}#${p.dist?.reference ?? ''}`)
    .sort();
  const digest = createHash('sha256').update(parts.join('\n')).digest('hex');
  return { scheme: 'per-package', digest, framework: readFrameworkLabel(raw) };
}

/** Best-effort human framework label from composer.lock (laravel/framework version). */
function readFrameworkLabel(rawLock: Buffer): string | undefined {
  try {
    const lock = JSON.parse(rawLock.toString('utf-8')) as {
      packages?: Array<{ name: string; version: string }>;
    };
    const fw = lock.packages?.find((p) => p.name === 'laravel/framework');
    return fw ? `${fw.name}@${fw.version}` : undefined;
  } catch {
    // lux-intentional-swallow: the framework label is cosmetic; it is omitted when the lock cannot be read.
    return undefined;
  }
}

/** Derive the key for a project under the chosen scheme (default composer-lock). */
export function derivePackKey(projectRoot: string, scheme?: PackKeyScheme): PackKey {
  return scheme === 'per-package'
    ? derivePerPackageKey(projectRoot)
    : deriveComposerLockKey(projectRoot);
}

/**
 * Resolve the vendor-pack cache ROOT directory:
 *   --pack-cache  →  LUX_PACK_CACHE  →  ~/.lux/packs
 */
export function resolvePackCacheDir(options: PackCacheOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.packCache) return resolve(options.packCache);
  if (env.LUX_PACK_CACHE) return resolve(env.LUX_PACK_CACHE);
  return resolve(homedir(), '.lux', 'packs');
}

/**
 * Deterministic pack file path for a key:
 *   <packsRoot>/<lockhash>/pack-v<PACK_FORMAT_VERSION>.db
 *
 * The lockhash directory is the full sha256 digest; the filename embeds the
 * format version so a PACK_FORMAT_VERSION bump is a clean miss (never a
 * silently-incompatible hit).
 */
export function packPathForKey(key: PackKey, options: PackCacheOptions = {}): string {
  return resolve(resolvePackCacheDir(options), key.digest, `pack-v${PACK_FORMAT_VERSION}.db`);
}

export interface CacheLookup {
  key: PackKey;
  packPath: string;
  /** A usable, format-current, key-matching pack already exists on disk. */
  hit: boolean;
}

/** Resolve the key + expected path and report whether a usable pack is cached. */
export function lookupPack(
  projectRoot: string,
  options: PackCacheOptions & { scheme?: PackKeyScheme } = {}
): CacheLookup {
  const key = derivePackKey(projectRoot, options.scheme);
  const packPath = packPathForKey(key, options);
  let hit = false;
  if (existsSync(packPath)) {
    try {
      const reader = new VendorPackReader(packPath);
      const m = reader.manifest();
      reader.close();
      hit = m.formatVersion === PACK_FORMAT_VERSION && m.key === key.digest;
    } catch {
      // lux-intentional-swallow: a corrupt or partial pack is a cache miss; the builder overwrites it.
      hit = false; // corrupt/partial file → treat as miss; the builder overwrites it
    }
  }
  return { key, packPath, hit };
}
