// The set of files Lux may read into an index: its file universe.
//
// In a git repository the universe is git's: the files `git ls-files` lists (tracked files,
// including those of submodules), under the paths git prints. Paths come from git and not from a
// directory walk because a case-insensitive filesystem keeps a directory's old case on disk after a
// case-only rename lands from elsewhere, and a walk would index those files under paths that match
// nothing git, `lux delta` or a path trigger knows. Untracked and ignored files are not in it.
//
// A directory that is not a git repository, or that its enclosing repository ignores, has no git
// universe: Lux walks the filesystem there, as it always has (a vendored first-party package copy
// is one such directory).
//
// The include and exclude globs then select from the universe, with the semantics `glob` gives them
// on a walk, so a repository's indexable set does not change because its listing came from git.
//
// A built-in deny list of credential file names applies on top, to tracked files too and whatever
// the include globs say. lux.yaml `scan.deny_patterns` extends it; nothing narrows it.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { glob, globSync } from 'glob';
import { Minimatch } from 'minimatch';
import { loadLspConfig, type ScanConfig } from './config.js';

/**
 * Credential files Lux never indexes, tracked or not. Matched against corpus-relative paths with
 * dotfiles included, so `**\/.env` reaches every `.env`.
 */
const BUILTIN_DENY_PATTERNS: readonly string[] = [
  '**/auth.json',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
];

/** Files a deny pattern would catch that are templates without secrets in them. */
const DENY_EXCEPTIONS: readonly string[] = ['**/.env.example'];

/** The deny list in force: the built-ins plus lux.yaml `scan.deny_patterns`. Never fewer. */
export function resolveDenyPatterns(scan?: ScanConfig): string[] {
  return [...BUILTIN_DENY_PATTERNS, ...(scan?.denyPatterns ?? [])];
}

// glob matches case-insensitively where the filesystem usually is; selecting from a git listing
// with the same rule keeps a repository's indexable set the same on every path to it.
const NOCASE = process.platform === 'darwin' || process.platform === 'win32';

function matchers(patterns: readonly string[], dot: boolean): Minimatch[] {
  return patterns.map((pattern) => new Minimatch(pattern, { dot, nocase: NOCASE }));
}

const exceptionMatchers = matchers(DENY_EXCEPTIONS, true);

/**
 * The deny list in force for `rootPath`. A lux.yaml that cannot be read leaves the built-ins, which
 * are never weaker than the configured list.
 */
export function denyPatternsFor(rootPath: string): string[] {
  try {
    return resolveDenyPatterns(loadLspConfig(rootPath).scan);
  } catch {
    // lux-intentional-swallow: the built-in list still applies; the command that reads lux.yaml for its own settings reports the parse failure.
    return resolveDenyPatterns();
  }
}

/** True when `relPath` (corpus-relative, `/`-separated) is on the deny list. */
export function isDeniedPath(relPath: string, denyPatterns: readonly string[]): boolean {
  if (exceptionMatchers.some((m) => m.match(relPath))) return false;
  return matchers(denyPatterns, true).some((m) => m.match(relPath));
}

/** Split a path list into what may be read and what the deny list keeps out. */
export function partitionDenied(
  paths: readonly string[],
  denyPatterns: readonly string[]
): { allowed: string[]; denied: string[] } {
  const deny = matchers(denyPatterns, true);
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const path of paths) {
    const isDenied =
      !exceptionMatchers.some((m) => m.match(path)) && deny.some((m) => m.match(path));
    (isDenied ? denied : allowed).push(path);
  }
  return { allowed, denied };
}

/** The one warning a run prints for the files its deny list skipped. */
export function denyListWarning(denied: readonly string[]): string {
  const names = [...new Set(denied)].sort();
  return (
    `skipped ${names.length} file(s) on the credential deny list, which are never indexed: ` +
    `${names.join(', ')} (see docs/SECURITY.md)`
  );
}

/**
 * Where a corpus's files come from: git's listing, or — outside a git repository — a filesystem
 * walk.
 */
export type FileUniverse =
  | { readonly kind: 'git'; readonly files: readonly string[]; has(relPath: string): boolean }
  | { readonly kind: 'filesystem' };

function gitOutput(rootPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: rootPath,
    encoding: 'utf-8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** True when `rootPath` lies inside a git work tree that does not ignore it. */
function isGitWorkTree(rootPath: string): boolean {
  try {
    if (gitOutput(rootPath, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      return false;
    }
  } catch {
    // lux-intentional-swallow: a probe; not a git work tree (or no git) is the answer.
    return false;
  }
  try {
    // Exit 0 means the enclosing repository ignores this directory: it is not part of that
    // repository, and the user pointed Lux at it deliberately.
    execFileSync('git', ['check-ignore', '-q', '.'], { cwd: rootPath, stdio: 'ignore' });
    return false;
  } catch {
    // lux-intentional-swallow: exit 1 means not ignored, which is the ordinary case.
    return true;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // lux-intentional-swallow: a tracked file deleted from the working tree is simply not there.
    return false;
  }
}

/**
 * The file universe of `rootPath`. In a git work tree: every tracked file under `rootPath` (paths
 * relative to it, in git's case) that exists as a regular file in the working tree — a tracked
 * file deleted from disk has nothing to read, and a submodule's gitlink is a directory.
 */
export function resolveFileUniverse(rootPath: string): FileUniverse {
  if (!isGitWorkTree(rootPath)) return { kind: 'filesystem' };
  const listed = gitOutput(rootPath, ['ls-files', '-z', '--cached', '--recurse-submodules'])
    .split('\0')
    .filter((path) => path.length > 0);
  const files = [...new Set(listed)].filter((path) => isFile(join(rootPath, path)));
  const set = new Set(files);
  return { kind: 'git', files, has: (relPath) => set.has(relPath) };
}

/**
 * A predicate for one corpus-relative path: true when it matches `patterns` and no `ignore`
 * pattern, with `glob`'s semantics — include patterns skip dotfiles and dot-directories, ignore
 * patterns do not.
 */
export function fileSelector(
  patterns: readonly string[],
  ignore: readonly string[]
): (relPath: string) => boolean {
  const include = matchers(patterns, false);
  const exclude = matchers(ignore, true);
  return (path) => include.some((m) => m.match(path)) && !exclude.some((m) => m.match(path));
}

/** The files of a git universe that {@link fileSelector} selects. */
function selectFromUniverse(
  universe: Extract<FileUniverse, { kind: 'git' }>,
  patterns: readonly string[],
  ignore: readonly string[]
): string[] {
  return universe.files.filter(fileSelector(patterns, ignore));
}

/** {@link selectFromUniverse}, walking the filesystem when the universe is not git's. */
export async function selectFiles(
  rootPath: string,
  universe: FileUniverse,
  patterns: string[],
  ignore: string[]
): Promise<string[]> {
  if (universe.kind === 'git') return selectFromUniverse(universe, patterns, ignore);
  return glob(patterns, { cwd: rootPath, ignore, nodir: true });
}

/** The synchronous form of {@link selectFiles}. */
export function selectFilesSync(
  rootPath: string,
  universe: FileUniverse,
  patterns: string[],
  ignore: string[]
): string[] {
  if (universe.kind === 'git') return selectFromUniverse(universe, patterns, ignore);
  return globSync(patterns, { cwd: rootPath, ignore, nodir: true });
}

/**
 * Whether one corpus-relative path is in the universe and readable: listed by git (or, outside
 * git, present and not under an ignore pattern) and not on the deny list. For readers handed a path
 * rather than enumerating one, such as `lux_get_file`.
 */
export function isReadableInUniverse(
  rootPath: string,
  relPath: string,
  ignore: readonly string[],
  denyPatterns: readonly string[]
): boolean {
  if (isAbsolute(relPath) || relPath === '..' || relPath.startsWith('../')) return false;
  if (isDeniedPath(relPath, denyPatterns)) return false;
  const universe = resolveFileUniverse(rootPath);
  if (universe.kind === 'git') return universe.has(relPath);
  if (matchers(ignore, true).some((m) => m.match(relPath))) return false;
  return isFile(join(rootPath, relPath));
}

/**
 * Whether a file a directory walk found, by absolute path, is in the universe. For readers that
 * look for a few named files (project configs, workspace manifests) rather than select by glob:
 * outside git every file found is in it.
 */
export function universeIncludes(
  universe: FileUniverse,
  rootPath: string,
  absolutePath: string
): boolean {
  if (universe.kind === 'filesystem') return true;
  return universe.has(relative(rootPath, absolutePath).split(sep).join('/'));
}
