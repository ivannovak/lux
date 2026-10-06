// The files a language server failed on in the last run, persisted so the gap is named instead of
// silent. A file whose enrichment request (documentSymbol, references, ...) timed out or lost its
// transport has no LSP symbols in the index (stage `symbols`); a file whose definition requests did
// in the typed-receiver pass has none of its LSP-resolved call edges (stage `calls`). A server that
// was still indexing the workspace when its wait bound ran out is recorded once, with `filePath`
// "." (stage `index`): every answer it gave may reflect a partial index. A server that failed to
// start is recorded the same way at stage `init`: its language has no LSP data at all. A server
// that stopped answering part-way is recorded once per stage it was needed for, with the number of
// files that stage could not complete (reason `unresponsive`), not once per file.
// `lux index status --json` lists them; an empty list means the run's LSP output is complete.

import type { LuxDatabase } from '../../db/index.js';
import type { LspRequestIssue } from './requester.js';

const LSP_ENRICHMENT_FAILURES_KEY = 'lsp_enrichment_failures_v1';
/** `filePath` of an entry about a whole language rather than one file. */
const WORKSPACE = '.';
const STAGES: ReadonlyArray<LspEnrichmentFailure['stage']> = [
  'init',
  'index',
  'capability',
  'symbols',
  'calls',
];

/** Why a file was not enriched. The raw message is not kept: it carries per-run request ids. */
export type LspEnrichmentFailureReason =
  'timeout' | 'transport' | 'error' | 'response' | 'unresponsive';

const REASONS: readonly LspEnrichmentFailureReason[] = [
  'timeout',
  'transport',
  'error',
  'response',
  'unresponsive',
];

/** How the client words a server that stopped answering; the language is its first word. */
const STOPPED_ANSWERING = /^(\S+) language server stopped answering/;

export interface LspEnrichmentFailure {
  /** Repo-relative path of the affected file; "." for a whole-workspace `index` entry. */
  filePath: string;
  /**
   * What is missing: the file's LSP enrichment (`symbols`), its LSP-resolved call edges (`calls`),
   * a complete index (`index`), or the whole language because its server did not start (`init`).
   */
  stage: 'symbols' | 'calls' | 'index' | 'init' | 'capability';
  /** The language server an `index`, `init` or `capability` entry is about. */
  languageId?: string;
  /** For a `response` reason: the request the server answered with an error, and its code. */
  method?: string;
  code?: number;
  /** For an `error` reason: what was thrown, since no other field says. */
  message?: string;
  /**
   * For an `unresponsive` reason with `filePath` ".": how many files the stage could not complete
   * because the server had stopped answering.
   */
  fileCount?: number;
  reason: LspEnrichmentFailureReason;
}

export function classifyLspEnrichmentError(message: string): LspEnrichmentFailureReason {
  if (STOPPED_ANSWERING.test(message)) return 'unresponsive';
  if (/timed out/i.test(message)) return 'timeout';
  if (/exited unexpectedly|shut down|not writable|process error|is not running/i.test(message)) {
    return 'transport';
  }
  return 'error';
}

/** Replace the recorded failures with this full run's, sorted by path. */
export function persistLspEnrichmentFailures(
  db: LuxDatabase,
  failures: LspEnrichmentFailure[]
): void {
  db.setIndexMetadata(LSP_ENRICHMENT_FAILURES_KEY, JSON.stringify(sortFailures(failures)));
}

/**
 * A scoped run re-enriches only `refreshedPaths`: their old entries are replaced by the new run's,
 * every other file keeps its recorded outcome.
 */
export function mergeLspEnrichmentFailures(
  db: LuxDatabase,
  refreshedPaths: readonly string[],
  failures: LspEnrichmentFailure[]
): void {
  const refreshed = new Set(refreshedPaths);
  // A scoped run restarts the servers, so its workspace-wide outcomes replace the recorded ones —
  // except a count of files an unresponsive server left behind, which stands for those files and
  // is only made good by a run that asks about all of them again.
  const kept = loadLspEnrichmentFailures(db).filter((failure) =>
    failure.filePath === WORKSPACE
      ? failure.reason === 'unresponsive'
      : !refreshed.has(failure.filePath)
  );
  persistLspEnrichmentFailures(db, [...kept, ...failures]);
}

/**
 * The recorded failures. A record that cannot be read is an error, never an empty list: an empty
 * list is the claim that the LSP output is complete.
 */
export function loadLspEnrichmentFailures(db: LuxDatabase): LspEnrichmentFailure[] {
  const raw = db.getIndexMetadata(LSP_ENRICHMENT_FAILURES_KEY);
  if (!raw) return [];
  const unreadable = new Error(
    `index metadata "${LSP_ENRICHMENT_FAILURES_KEY}" is unreadable; run \`lux index rebuild\`.`
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(unreadable, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(isFailure)) throw unreadable;
  return parsed;
}

function isFailure(item: unknown): item is LspEnrichmentFailure {
  const failure = item as LspEnrichmentFailure | null;
  return (
    !!failure &&
    typeof failure.filePath === 'string' &&
    STAGES.includes(failure.stage) &&
    REASONS.includes(failure.reason)
  );
}

/**
 * One entry per stage and language for the files a server that stopped answering left behind:
 * thousands of identical per-file entries would say no more than their count.
 */
function collapseUnresponsive(failures: readonly LspEnrichmentFailure[]): LspEnrichmentFailure[] {
  const collapsed = new Map<string, LspEnrichmentFailure>();
  const counted = new Set<string>();
  const rest: LspEnrichmentFailure[] = [];
  for (const failure of failures) {
    if (failure.reason !== 'unresponsive') {
      rest.push(failure);
      continue;
    }
    const key = `${failure.stage}\0${failure.languageId ?? ''}`;
    // A file reported twice is one file. An entry that is already a count is added as it stands.
    if (failure.filePath !== WORKSPACE) {
      if (counted.has(`${key}\0${failure.filePath}`)) continue;
      counted.add(`${key}\0${failure.filePath}`);
    }
    const entry = collapsed.get(key) ?? {
      filePath: WORKSPACE,
      stage: failure.stage,
      reason: 'unresponsive' as const,
      languageId: failure.languageId,
      fileCount: 0,
    };
    entry.fileCount = (entry.fileCount ?? 0) + (failure.fileCount ?? 1);
    collapsed.set(key, entry);
  }
  return [...rest, ...collapsed.values()];
}

function sortFailures(input: readonly LspEnrichmentFailure[]): LspEnrichmentFailure[] {
  const failures = collapseUnresponsive(input);
  const key = (failure: LspEnrichmentFailure) =>
    [
      failure.filePath,
      failure.stage,
      failure.languageId ?? '',
      failure.method ?? '',
      failure.code ?? '',
    ].join('\0');
  const unique = new Map(failures.map((failure) => [key(failure), failure]));
  return [...unique.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The entry for a server whose workspace index was incomplete when enrichment started. */
export function incompleteIndexFailure(languageId: string): LspEnrichmentFailure {
  return { filePath: WORKSPACE, stage: 'index', reason: 'timeout', languageId };
}

/** The entry for a server that failed to start. */
export function failedStartFailure(languageId: string, message: string): LspEnrichmentFailure {
  return {
    filePath: WORKSPACE,
    stage: 'init',
    ...reasonOf(message),
    languageId,
  };
}

/**
 * The entries for the error answers the servers gave. An answer of MethodNotFound for a declared
 * capability is a gap in the server, not in a file: one entry per language and method. Every other
 * recorded answer is the file's, with the method and code.
 */
export function requestIssueFailures(
  issues: ReadonlyArray<LspRequestIssue & { languageId: string }>,
  toRelative: (absolutePath: string) => string
): LspEnrichmentFailure[] {
  return issues.map((issue) =>
    issue.kind === 'capability'
      ? {
          filePath: WORKSPACE,
          stage: 'capability' as const,
          reason: 'response' as const,
          languageId: issue.languageId,
          method: issue.method,
          code: issue.code,
        }
      : {
          filePath: toRelative(issue.filePath),
          stage: issue.stage,
          reason: 'response' as const,
          method: issue.method,
          code: issue.code,
        }
  );
}

/**
 * One warning line per stage that has entries, with counts: a run with any recorded failure must
 * not read as complete, and one line per file would bury everything else the run says.
 */
export function summarizeLspFailures(failures: readonly LspEnrichmentFailure[]): string[] {
  const lines: string[] = [];
  for (const stage of STAGES) {
    const all = sortFailures(failures.filter((failure) => failure.stage === stage));
    for (const lost of all.filter((entry) => entry.reason === 'unresponsive')) {
      lines.push(
        `LSP output incomplete — ${stage}: the ${lost.languageId} language server stopped ` +
          `answering and was not asked about ${lost.fileCount} file(s); ` +
          'see lspEnrichmentFailures in `lux index status --json`.'
      );
    }
    const entries = all.filter((entry) => entry.reason !== 'unresponsive');
    if (entries.length === 0) continue;
    const reasons = [...new Set(entries.map((entry) => entry.reason))].sort().join(', ');
    // Timeouts, lost transports and error answers explain themselves; anything else is shown.
    const thrown = entries.find((entry) => entry.reason === 'error' && entry.message)?.message;
    const detail =
      stage === 'symbols' || stage === 'calls'
        ? fileStageDetail(entries, reasons)
        : [
            ...new Set(
              entries.map((entry) =>
                entry.method ? `${entry.languageId} ${entry.method}` : `${entry.languageId}`
              )
            ),
          ]
            .sort()
            .join(', ') + ` (${reasons})`;
    lines.push(
      `LSP output incomplete — ${stage}: ${detail}${thrown ? ` — first error: ${thrown}` : ''}; ` +
        'see lspEnrichmentFailures in `lux index status --json`.'
    );
  }
  return lines;
}

/** `N file(s) (reasons), e.g. a.php, b.php, c.php` — a count, and enough paths to start looking. */
function fileStageDetail(entries: readonly LspEnrichmentFailure[], reasons: string): string {
  const files = [...new Set(entries.map((entry) => entry.filePath))];
  const more = files.length > 3 ? ', …' : '';
  return `${files.length} file(s) (${reasons}), e.g. ${files.slice(0, 3).join(', ')}${more}`;
}

/**
 * The entry for a server that started and has since died, found when its language's files come up
 * for enrichment: none of them is asked about, so the language is recorded, once. `started` is the
 * set of languages whose server started; the language is taken out of it so it is recorded once.
 */
export function lostServerFailure(
  enricher: { languageId: string; isReady: boolean },
  started: Set<string>
): LspEnrichmentFailure | undefined {
  if (enricher.isReady || !started.delete(enricher.languageId)) return undefined;
  return failedStartFailure(
    enricher.languageId,
    `${enricher.languageId} language server is not running`
  );
}

/** The reason a failure message classifies as, with the message itself kept for an `error`. */
function reasonOf(
  message: string
): Pick<LspEnrichmentFailure, 'reason' | 'message' | 'languageId'> {
  const reason = classifyLspEnrichmentError(message);
  if (reason === 'unresponsive')
    return { reason, languageId: STOPPED_ANSWERING.exec(message)?.[1] };
  return reason === 'error' ? { reason, message } : { reason };
}

/** The entry for one file a stage could not complete, from the message of what went wrong. */
export function fileFailure(
  filePath: string,
  stage: 'symbols' | 'calls',
  message: string
): LspEnrichmentFailure {
  return { filePath, stage, ...reasonOf(message) };
}
