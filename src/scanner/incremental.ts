import { join, extname, basename } from 'path';
import { readFileSync } from 'fs';
import { parseMarkdownSource, unreadableWarning } from './markdown.js';
import type { Reporter } from './reporter.js';
import type { ScannedKnowledge, Frontmatter } from './types.js';
import type { GitDiffResult } from './git.js';
import {
  SOURCE_CODE_EXTENSIONS,
  SOURCE_CODE_IGNORE_PATTERNS,
  detectLanguage,
  inferTagsFromPath,
  resolveIgnorePatterns,
} from './general.js';
import { loadLspConfig, type ScanConfig } from './config.js';
import { fileSelector, isDeniedPath, resolveDenyPatterns } from './file-universe.js';

export interface IncrementalPlan {
  toDelete: string[]; // Absolute file paths to remove from index
  toIndex: ScannedKnowledge[]; // New/modified entries to add
  unchanged: number; // Count of files not affected
  /** Changed paths the credential deny list kept out (their old rows, if any, are deleted). */
  denied: string[];
}

/** True when a relative source path can invalidate the structural overlay
 *  (source-code extension, not an excluded/generated path). Single source of
 *  truth shared by the sync escalation check and the freshness assessment. */
export function isOverlayRelevantPath(filePath: string): boolean {
  const ext = extname(filePath);
  return SOURCE_CODE_EXTENSIONS.includes(ext) && !isExcludedPath(filePath);
}

/** Relative source-code paths whose changes can invalidate the structural overlay. */
export function collectOverlayRelevantPaths(diff: GitDiffResult): string[] {
  const allChanged = [...diff.added, ...diff.modified, ...diff.deleted];
  return allChanged.filter(isOverlayRelevantPath);
}

/** Whether a diff contains source changes that require canonical overlay rebuild. */
export function hasOverlayRelevantChanges(diff: GitDiffResult): boolean {
  return collectOverlayRelevantPaths(diff).length > 0;
}

/** The narrow LuxDatabase surface commitIncrementalSync writes through. Kept structural (not the
 *  full LuxDatabase) so the crash-atomicity ordering can be unit-tested against a spy. */
export interface IncrementalSyncWriter {
  transaction<T>(fn: () => T): T;
  markEdgesStaleForFiles(filePaths: string[]): number;
  markEdgesStaleByEvidencePaths(filePaths: string[]): number;
  setIndexMetadata(key: string, value: string): void;
}

export interface MarkOnlySyncCounts {
  edgesMarkedNodePath: number;
  edgesMarkedEvidence: number;
}

/**
 * Commit a content sync's writes as ONE transaction with the crash-atomic ordering (spec 11 Part B /
 * OQ4 / Decisions 3-4-11): first the content-index writes (via `writeContent`), then — for a
 * `--mark-only` structural sync — the two stale-mark dimensions, and LAST the `last_indexed_commit`
 * pointer advance.
 *
 * Marks-BEFORE-pointer is the crash-safe order: if the process dies after the marks but before the
 * pointer, the pointer stays BEHIND HEAD, so a later `lux delta base..HEAD` still sees the changed
 * files and re-marks them. Advancing the pointer first would strand a clean tree over an UNMARKED
 * overlay — the OQ4 empty-change-set hazard (pointer-at-HEAD + overlay-unmarked reads as "nothing
 * changed"). Wrapping the batch in one transaction is the braces to that ordering's belt: no crash
 * can observe a half-applied state, and the ordering keeps the invariant honest even if the
 * transaction guarantee is ever weakened on the underlying adapter.
 */
export function commitIncrementalSync(
  db: IncrementalSyncWriter,
  writeContent: () => void,
  opts: { overlayRelevantPaths: string[]; headCommit: string; markOnly: boolean }
): MarkOnlySyncCounts {
  let edgesMarkedNodePath = 0;
  let edgesMarkedEvidence = 0;
  db.transaction(() => {
    // 1. content index inserts (the matching deletes for toDelete are applied upstream).
    writeContent();
    // 2. structural stale-marks (both dimensions), BEFORE the pointer advance.
    if (opts.markOnly && opts.overlayRelevantPaths.length > 0) {
      edgesMarkedNodePath = db.markEdgesStaleForFiles(opts.overlayRelevantPaths);
      edgesMarkedEvidence = db.markEdgesStaleByEvidencePaths(opts.overlayRelevantPaths);
    }
    // 3. pointer advance LAST — a crash before here leaves the pointer behind (recoverable).
    db.setIndexMetadata('last_indexed_commit', opts.headCommit);
  });
  return { edgesMarkedNodePath, edgesMarkedEvidence };
}

/** The include globs of a full scan: markdown plus every source-code extension. */
const INDEXABLE_PATTERNS = ['**/*.md', ...SOURCE_CODE_EXTENSIONS.map((ext) => `**/*${ext}`)];

/**
 * Check whether a relative file path should be excluded based on ignore patterns.
 * Matches against SOURCE_CODE_IGNORE_PATTERNS using simple prefix/glob logic.
 */
function isExcludedPath(relativePath: string): boolean {
  const segments = relativePath.split('/');

  for (const pattern of SOURCE_CODE_IGNORE_PATTERNS) {
    // Handle directory-based patterns like 'node_modules/**'
    if (pattern.endsWith('/**')) {
      const dir = pattern.slice(0, -3);
      if (segments.includes(dir)) return true;
    }
    // Handle glob patterns like '**/*.min.js'
    if (pattern.startsWith('**/')) {
      const suffix = pattern.slice(3);
      if (relativePath.endsWith(suffix)) return true;
    }
  }

  return false;
}

/**
 * The scan configuration of `rootPath`. An unreadable lux.yaml leaves the defaults in force, with a
 * warning: the sync that calls this reports the same parse failure where it loads the config itself.
 */
function scanConfigFor(rootPath: string, reporter?: Reporter): ScanConfig | undefined {
  try {
    return loadLspConfig(rootPath).scan;
  } catch (error) {
    reporter?.warn(
      `lux.yaml could not be read, so this sync used the default include, ignore and deny lists — ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

/**
 * Build a ScannedKnowledge entry for a file, using the same logic as GeneralScanner.
 *
 * Exported (T3a.1) so the scoped overlay-refresh engine and its reverse-import closure
 * (spec 13 Parts E/F) reuse the exact per-file entry builder rather than re-reading files.
 */
export function buildEntry(
  rootPath: string,
  relativePath: string,
  reporter?: Reporter
): ScannedKnowledge | null {
  const warn = reporter?.warn;
  // Reading (and, for markdown, parsing) this file again retires a carried warning about it.
  reporter?.ran(`file:${relativePath}`);
  const filePath = join(rootPath, relativePath);
  const ext = extname(relativePath);

  if (ext === '.md') {
    // Markdown file — parse frontmatter
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (error) {
      warn?.(unreadableWarning(relativePath, error), `file:${relativePath}`);
      return null;
    }
    reporter?.ran(`frontmatter:${relativePath}`);
    const { frontmatter, content } = parseMarkdownSource(raw, relativePath, warn);
    return {
      type: inferMarkdownType(relativePath, frontmatter),
      title: frontmatter?.title ?? frontmatter?.name ?? extractTitleFromFilename(relativePath),
      filePath,
      tags: frontmatter?.tags,
      frontmatter,
      content,
    };
  } else {
    // Source code file
    const language = relativePath.endsWith('.blade.php') ? 'blade' : detectLanguage(ext);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error) {
      warn?.(unreadableWarning(relativePath, error), `file:${relativePath}`);
      return null;
    }

    return {
      type: 'source-code',
      title: relativePath,
      filePath,
      tags: inferTagsFromPath(relativePath),
      frontmatter: { language, extension: ext },
      content,
    };
  }
}

/**
 * Infer knowledge type from a markdown file path (mirrors GeneralScanner logic).
 */
function inferMarkdownType(filePath: string, frontmatter?: Frontmatter): string {
  if (frontmatter?.type) return String(frontmatter.type);

  if (filePath.includes('methodology')) return 'methodology';
  if (filePath.includes('specs')) return 'spec';
  if (filePath.includes('architecture')) return 'architecture';
  if (filePath.includes('explorations')) return 'exploration';
  if (filePath.includes('implementation-payloads')) return 'implementation-payload';
  if (filePath.includes('payloads')) return 'payload';

  return 'general';
}

/**
 * Extract a human-readable title from a markdown filename.
 */
function extractTitleFromFilename(filename: string): string {
  const base = basename(filename, '.md');
  const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  return withoutDate
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Build an incremental index plan from a git diff.
 *
 * Filters diff results to only indexable files (markdown + source code),
 * then builds ScannedKnowledge entries for new/modified files.
 *
 * Modified files appear in both toDelete (remove old) and toIndex (add new)
 * to keep FTS5 consistent.
 */
export function buildIncrementalPlan(
  rootPath: string,
  diff: GitDiffResult,
  reporter?: Reporter
): IncrementalPlan {
  const toDelete: string[] = [];
  const toIndex: ScannedKnowledge[] = [];
  const denied: string[] = [];
  let excluded = 0;

  // The diff lists files git tracks; a full scan's include, ignore and deny lists then select
  // from them exactly as a rebuild selects from `git ls-files` (file-universe.ts).
  const scan = scanConfigFor(rootPath, reporter);
  const isIndexableFile = fileSelector(INDEXABLE_PATTERNS, resolveIgnorePatterns(scan));
  const denyPatterns = resolveDenyPatterns(scan);

  // Process deleted files
  for (const file of diff.deleted) {
    if (isIndexableFile(file)) {
      toDelete.push(join(rootPath, file));
    } else {
      excluded++;
    }
  }

  // Process modified files — delete old, then re-index
  for (const file of diff.modified) {
    if (!isIndexableFile(file)) {
      excluded++;
      continue;
    }
    toDelete.push(join(rootPath, file));
    if (isDeniedPath(file, denyPatterns)) {
      denied.push(file);
      continue;
    }
    const entry = buildEntry(rootPath, file, reporter);
    if (entry) {
      toIndex.push(entry);
    }
  }

  // Process added files
  for (const file of diff.added) {
    if (!isIndexableFile(file)) {
      excluded++;
      continue;
    }
    if (isDeniedPath(file, denyPatterns)) {
      denied.push(file);
      continue;
    }
    const entry = buildEntry(rootPath, file, reporter);
    if (entry) {
      toIndex.push(entry);
    }
  }

  return {
    toDelete,
    toIndex,
    unchanged: excluded,
    denied: [...new Set(denied)].sort(),
  };
}
