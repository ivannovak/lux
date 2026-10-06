import { isAbsolute, join, relative, sep, win32 } from 'node:path';

// ── Paths as the index stores them ─────────────────────────────────────────────────────────────
// A path written into the index is relative to the corpus root and uses `/`, whatever the
// platform: `src/Module/Users/readme.md`. The index then holds nothing about where the repository
// is checked out, so two checkouts of one commit store the same rows and an index can be moved or
// shipped. A reader that needs the file itself resolves the stored path against the corpus root it
// is running with (`resolveStoredPath`).

/**
 * The corpus root in stored form. An index describes one repository, so a column that names "the
 * repository" (`operational_boundaries.repo_root`) holds this, not the directory it was indexed in.
 */
export const STORED_CORPUS_ROOT = '.';

/** True for a path this process, or Windows, would treat as absolute. */
function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

/**
 * The stored form of `path`. An absolute path is made relative to `corpusRoot`; a relative one is
 * taken to be corpus-relative already. A file outside the corpus keeps its `../` segments, which
 * still say nothing about where the corpus itself lives.
 */
export function toStoredPath(corpusRoot: string, path: string): string {
  const rel = isAbsolute(path) ? relative(corpusRoot, path) : path;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/** The file a stored path names, for the corpus root this process is running with. */
export function resolveStoredPath(corpusRoot: string, storedPath: string): string {
  return isAbsolutePath(storedPath) ? storedPath : join(corpusRoot, storedPath);
}

/**
 * Refuse an absolute path at the database boundary. A writer that passes one would store a
 * machine-specific row, and a lookup or delete keyed by one would match nothing and say nothing.
 */
export function assertStoredPath(path: string, what: string): void {
  if (isAbsolutePath(path)) {
    throw new Error(
      `${what} must be a corpus-relative path, got the absolute path ${path}. ` +
        `Convert it with toStoredPath(corpusRoot, path) before it reaches the index.`
    );
  }
}
