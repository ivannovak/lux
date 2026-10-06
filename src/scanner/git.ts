import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join, posix } from 'path';

export interface GitDiffResult {
  added: string[]; // New files
  modified: string[]; // Changed files
  deleted: string[]; // Removed files
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepository(rootPath: string): boolean {
  return existsSync(join(rootPath, '.git'));
}

export function findLikelyNestedGitRoot(rootPath: string): string | null {
  const candidates = ['vcs', 'repo', 'repository'];

  for (const candidate of candidates) {
    const candidatePath = join(rootPath, candidate);
    if (existsSync(join(candidatePath, '.git'))) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Get the current HEAD commit hash.
 */
export function getHeadCommit(rootPath: string): string {
  return execSync('git rev-parse HEAD', { cwd: rootPath, encoding: 'utf-8' }).trim();
}

/**
 * Get the diff between two commits, filtered to relevant files.
 *
 * Uses --diff-filter=ACDMR:
 *   A = Added, C = Copied, D = Deleted, M = Modified, R = Renamed
 *
 * Returns categorized file paths (relative to rootPath).
 */
export function getGitDiff(
  rootPath: string,
  fromCommit: string,
  toCommit: string = 'HEAD'
): GitDiffResult {
  // --no-renames: a rename is its old path deleted and its new path added. With rename detection on
  // (git's default) only the new path is listed, and everything indexed under the old one survives.
  const list = (filter: string): string[] => {
    const output = execSync(
      `git diff --no-renames --name-only --diff-filter=${filter} ${fromCommit} ${toCommit}`,
      { cwd: rootPath, encoding: 'utf-8' }
    ).trim();
    return output ? output.split('\n') : [];
  };
  const added = list('A');
  const modified = list('CMT');
  const deleted = list('D');

  // A tracked symlink whose target changed has new content although git lists only the target.
  const changed = new Set([...added, ...modified, ...deleted]);
  for (const link of symlinksInto(rootPath, toCommit, changed)) {
    if (!changed.has(link)) modified.push(link);
  }

  return { added, modified, deleted };
}

/** Tracked symlinks at `commit` whose target (resolved against the link's directory) is in `paths`. */
function symlinksInto(rootPath: string, commit: string, paths: ReadonlySet<string>): string[] {
  if (paths.size === 0) return [];
  const tree = execSync(`git ls-tree -r ${commit}`, {
    cwd: rootPath,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const links: string[] = [];
  for (const line of tree.split('\n')) {
    const match = /^120000 blob ([0-9a-f]+)\t(.+)$/u.exec(line);
    if (!match) continue;
    const target = execSync(`git cat-file -p ${match[1]}`, { cwd: rootPath, encoding: 'utf-8' });
    const resolved = posix.normalize(posix.join(posix.dirname(match[2]), target.trim()));
    if (paths.has(resolved)) links.push(match[2]);
  }
  return links;
}

/**
 * Check if a commit hash exists in the repository.
 */
export function commitExists(rootPath: string, commitHash: string): boolean {
  try {
    execSync(`git cat-file -t ${commitHash}`, { cwd: rootPath, encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}

/**
 * Get the list of dirty (unstaged or staged but uncommitted) file paths
 * relative to the repository root.
 *
 * Uses `git status --porcelain` to detect any modified, added, deleted,
 * or renamed files in the working tree and index.
 */
export function getDirtyFiles(rootPath: string): string[] {
  return getDirtyFileEntries(rootPath).map((e) => e.path);
}

// ---------------------------------------------------------------------------
// Delta git-safety layer (argv-form, no shell — closes the injection surface
// the shell-interpolating getGitDiff/commitExists open). See spec 10 Part A.
// ---------------------------------------------------------------------------

/**
 * Strict ref/base grammar (Decision 17). Rejects a leading '-' (so an argv value can never be
 * read as a git flag) and every shell metacharacter. The escape hatch for an exotic ref is a
 * raw SHA. Applied before ANY git call that receives a caller-supplied ref.
 */
export const GIT_REF_GRAMMAR = /^[A-Za-z0-9._/@^~-]+$/;

export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && ref[0] !== '-' && GIT_REF_GRAMMAR.test(ref);
}

export function assertSafeGitRef(ref: string): void {
  if (!isSafeGitRef(ref)) {
    throw new Error(
      `Unsafe git ref ${JSON.stringify(ref)}: must match ${GIT_REF_GRAMMAR} and not start with '-'.`
    );
  }
}

export type NameStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffNameStatusEntry {
  status: NameStatus;
  /** Post-rename / current path. */
  path: string;
  /** Pre-rename path (rename entries only). */
  renamedFrom?: string;
}

/**
 * Committed-span diff, argv-form (no shell — closes the injection surface, Decision 17).
 * `-M --name-status` recovers rename old→new pairs (Decision 12); today's `getGitDiff`
 * `--name-only --diff-filter=CMR` emits only the post-rename path. `base` is asserted here as
 * defense-in-depth; `head` is a fixed literal.
 */
export function getDiffNameStatus(
  rootPath: string,
  base: string,
  head = 'HEAD'
): DiffNameStatusEntry[] {
  assertSafeGitRef(base);
  // `--end-of-options` (git 2.24+) makes the option/operand boundary explicit: even if `base`
  // slipped the ref grammar, git treats it as a revision, never a flag. Defense-in-depth on top of
  // assertSafeGitRef, future-proof against a grammar relaxation (Decision 17).
  const out = execFileSync('git', ['diff', '--name-status', '-M', '--end-of-options', base, head], {
    cwd: rootPath,
    encoding: 'utf-8',
  }).trim();
  if (!out) return [];
  const entries: DiffNameStatusEntry[] = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (code.startsWith('R') && parts.length >= 3) {
      entries.push({ status: 'renamed', path: parts[2], renamedFrom: parts[1] });
    } else if (code.startsWith('C') && parts.length >= 3) {
      entries.push({ status: 'added', path: parts[2] }); // a copy is a new file at the target
    } else if (code.startsWith('A') && parts[1]) {
      entries.push({ status: 'added', path: parts[1] });
    } else if (code.startsWith('D') && parts[1]) {
      entries.push({ status: 'deleted', path: parts[1] });
    } else if (parts[1]) {
      entries.push({ status: 'modified', path: parts[1] });
    }
  }
  return entries;
}

/** Injection-safe commit existence check (argv, no shell). */
export function commitExistsSafe(rootPath: string, ref: string): boolean {
  if (!isSafeGitRef(ref)) return false;
  try {
    execFileSync('git', ['cat-file', '-t', ref], { cwd: rootPath, stdio: 'pipe' });
    return true;
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return false;
  }
}

/** Resolve a ref to its full SHA (argv). Returns null when unresolvable. */
export function revParseSafe(rootPath: string, ref: string): string | null {
  if (!isSafeGitRef(ref)) return null;
  try {
    return execFileSync('git', ['rev-parse', ref], { cwd: rootPath, encoding: 'utf-8' }).trim();
  } catch {
    // lux-intentional-swallow: a probe; the negative result is the answer, not a failure.
    return null;
  }
}

export type WorkingTreeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface DirtyEntry {
  path: string;
  status: WorkingTreeStatus;
  /** Rename ORIGIN, recovered from the porcelain '->' arrow (nit b). */
  renamedFrom?: string;
}

/**
 * Working-tree change entries from `git status --porcelain`, recovering rename ORIGIN for
 * uncommitted renames (nit b) — the existing `getDirtyFiles` returns only the rename TARGET.
 * Untracked entries carry status 'untracked'. `.gitignore` is respected by porcelain, so
 * vendor/, node_modules/, and build output can never leak in (Decision 11).
 */
export function getDirtyFileEntries(rootPath: string): DirtyEntry[] {
  let output: string;
  try {
    // Strip only trailing newlines — NOT a full `.trim()`. Porcelain v1's first column (`X`) is a
    // significant space for an unstaged-only change (` M path`); a leading `.trim()` would eat it
    // and misalign the fixed `slice(0,2)`/`slice(3)` column parse, corrupting the first entry's
    // path (e.g. "a.php" → ".php").
    output = execFileSync('git', ['status', '--porcelain'], {
      cwd: rootPath,
      encoding: 'utf-8',
    }).replace(/\n+$/, '');
  } catch {
    // lux-intentional-swallow: not a git checkout: no dirty files to report.
    return [];
  }
  if (!output) return [];
  const entries: DirtyEntry[] = [];
  for (const line of output.split('\n')) {
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (xy === '??') {
      entries.push({ path: rest.trim(), status: 'untracked' });
      continue;
    }
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) {
      entries.push({
        status: 'renamed',
        renamedFrom: rest.slice(0, arrow).trim(),
        path: rest.slice(arrow + 4).trim(),
      });
      continue;
    }
    const code = xy.trim();
    const status: WorkingTreeStatus = code.includes('D')
      ? 'deleted'
      : code.includes('A')
        ? 'added'
        : 'modified';
    entries.push({ path: rest.trim(), status });
  }
  return entries.filter((e) => e.path.length > 0);
}

/** A file's content at a ref, or null when the ref does not hold it (or it is not a blob). */
export function readFileAtRef(rootPath: string, ref: string, relPath: string): string | null {
  assertSafeGitRef(ref);
  try {
    return execFileSync('git', ['show', '--end-of-options', `${ref}:${relPath}`], {
      cwd: rootPath,
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // lux-intentional-swallow: the path does not exist at this ref (added or deleted file); the caller treats that side as absent.
    return null;
  }
}
