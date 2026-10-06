// One way of reading a file into the index, shared by the full scan and the incremental and scoped
// entry builders, so a file reaches the index the same way whichever path indexes it.

import matter from 'gray-matter';
import type { Frontmatter } from './types.js';
import type { WarnFn } from './reporter.js';

/**
 * Split a markdown file into frontmatter and body. Malformed frontmatter is a warning, and the
 * file's whole text is indexed as its content, without frontmatter, rather than dropped.
 */
export function parseMarkdownSource(
  raw: string,
  relPath: string,
  warn?: WarnFn
): { frontmatter?: Frontmatter; content: string } {
  try {
    const parsed = matter(raw);
    return { frontmatter: parsed.data, content: parsed.content };
  } catch (error) {
    warn?.(
      `malformed frontmatter in ${relPath}; indexed its content without frontmatter — ` +
        (error instanceof Error ? error.message : String(error)),
      `frontmatter:${relPath}`
    );
    return { content: raw };
  }
}

/** The warning for a file the scan found but could not read. */
export function unreadableWarning(relPath: string, error: unknown): string {
  return `could not read ${relPath}, so it was left out of the index — ${error instanceof Error ? error.message : String(error)}`;
}
