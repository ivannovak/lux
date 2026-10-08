// The files a language server failed on in the last run, persisted so the gap is named instead of
// silent. A file whose enrichment request (documentSymbol, references, ...) timed out or lost its
// transport has no LSP symbols in the index (stage `symbols`); a file whose definition requests did
// in the typed-receiver pass has none of its LSP-resolved call edges (stage `calls`). A server that
// was still indexing the workspace when its wait bound ran out is recorded once, with `filePath`
// "." (stage `index`): every answer it gave may reflect a partial index. A server that failed to
// start is recorded the same way at stage `init`: its language has no LSP data at all. A server
// that stopped answering part-way is recorded once per stage it was needed for, with the number of
// files that stage could not complete (reason `unresponsive`), not once per file. A server that died
// part-way is recorded the same way (reason `transport`), with its exit status and the last lines
// it wrote to stderr.
// `lux index status --json` lists them; an empty list means the run's LSP output is complete.

import type { LuxDatabase } from '../../db/index.js';
import type { LspRequestIssue } from './requester.js';
import { parseServerExit } from './server-exit.js';

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
  'timeout' | 'transport' | 'error' | 'response' | 'unresponsive' | 'empty';

const REASONS: readonly LspEnrichmentFailureReason[] = [
  'timeout',
  'transport',
  'error',
  'response',
  'unresponsive',
  'empty',
];

/** How an answer that said nothing where the source has something is worded; see empty-answer.ts. */
const EMPTY_ANSWER = /^(\S+) answered (?:null|empty)\b/;

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
  /**
   * For a `response` reason: the request the server answered with an error, and its code. For an
   * `empty` reason: the request it answered with nothing, twice, for a file that has something.
   */
  method?: string;
  code?: number;
  /** For an `error` reason: what was thrown, since no other field says. */
  message?: string;
  /**
   * For an `unresponsive` or `transport` reason with `filePath` ".": how many files the stage
   * could not complete because the server had stopped answering, or had died.
   */
  fileCount?: number;
  /** For a server that died: its exit code, or null when a signal ended it. */
  exitCode?: number | null;
  /** For a server that died: the signal that ended it, or null when it exited on its own. */
  signal?: string | null;
  /** For a server that died: the last lines it wrote to stderr. */
  stderr?: string[];
  reason: LspEnrichmentFailureReason;
}

export function classifyLspEnrichmentError(message: string): LspEnrichmentFailureReason {
  if (STOPPED_ANSWERING.test(message)) return 'unresponsive';
  if (EMPTY_ANSWER.test(message)) return 'empty';
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
  // except a count of files a server that stopped answering or died left behind, which stands for
  // those files and is only made good by a run that asks about all of them again.
  const kept = loadLspEnrichmentFailures(db).filter((failure) =>
    failure.filePath === WORKSPACE
      ? failure.fileCount !== undefined
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
 * One entry per stage and language for the files a server that stopped answering, or died, left
 * behind: thousands of identical per-file entries would say no more than their count.
 */
function collapseLostServers(failures: readonly LspEnrichmentFailure[]): LspEnrichmentFailure[] {
  const collapsed = new Map<string, LspEnrichmentFailure>();
  const counted = new Set<string>();
  const rest: LspEnrichmentFailure[] = [];
  for (const failure of failures) {
    if (!isLostServerEntry(failure)) {
      rest.push(failure);
      continue;
    }
    const key = `${failure.stage}\0${failure.reason}\0${failure.languageId ?? ''}`;
    // A file reported twice is one file. An entry that is already a count is added as it stands.
    if (failure.filePath !== WORKSPACE) {
      if (counted.has(`${key}\0${failure.filePath}`)) continue;
      counted.add(`${key}\0${failure.filePath}`);
    }
    const entry = collapsed.get(key) ?? {
      filePath: WORKSPACE,
      stage: failure.stage,
      reason: failure.reason,
      languageId: failure.languageId,
      fileCount: 0,
    };
    entry.fileCount = (entry.fileCount ?? 0) + (failure.fileCount ?? 1);
    if (failure.reason === 'transport') {
      entry.exitCode = failure.exitCode ?? null;
      entry.signal = failure.signal ?? null;
      // A request that failed while the server's stderr was still being read saw fewer lines.
      const stderr = failure.stderr ?? [];
      if (stderr.length >= (entry.stderr?.length ?? 0)) entry.stderr = stderr;
    }
    collapsed.set(key, entry);
  }
  return [...rest, ...collapsed.values()];
}

/** A file a stopped or dead server could not be asked about, or the count of such files. */
function isLostServerEntry(failure: LspEnrichmentFailure): boolean {
  if (failure.stage !== 'symbols' && failure.stage !== 'calls') return false;
  if (failure.reason === 'unresponsive') return true;
  return failure.reason === 'transport' && failure.exitCode !== undefined;
}

function sortFailures(input: readonly LspEnrichmentFailure[]): LspEnrichmentFailure[] {
  const failures = collapseLostServers(input);
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
    for (const lost of all.filter((entry) => entry.filePath === WORKSPACE && entry.fileCount)) {
      const what =
        lost.reason === 'unresponsive' ? 'stopped answering' : `exited (${exitStatus(lost)})`;
      lines.push(
        `LSP output incomplete — ${stage}: the ${lost.languageId} language server ${what} and ` +
          `was not asked about ${lost.fileCount} file(s)${lastStderr(lost)}; ` +
          'see lspEnrichmentFailures in `lux index status --json`.'
      );
    }
    const entries = all.filter((entry) => !(entry.filePath === WORKSPACE && entry.fileCount));
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

/** `code 1`, `signal SIGKILL`: how a server that died ended. */
function exitStatus(entry: LspEnrichmentFailure): string {
  return entry.signal ? `signal ${entry.signal}` : `code ${entry.exitCode ?? 'unknown'}`;
}

/** A stderr line that names a failure, as against a log line or a heading. */
const STDERR_FAILURE = /\b(error|fatal|exception|panic|abort(ed)?|killed)\b/i;

/**
 * `; stderr: <line>` — the line most likely to say why the server died: the last that names a
 * failure, or the last line, when the server wrote any.
 */
function lastStderr(entry: LspEnrichmentFailure): string {
  const lines = (entry.stderr ?? []).filter((text) => text.trim() !== '');
  const line = lines.filter((text) => STDERR_FAILURE.test(text)).at(-1) ?? lines.at(-1);
  return line ? `; stderr: ${line.trim()}` : '';
}

/** `N file(s) (reasons), e.g. a.php, b.php, c.php` — a count, and enough paths to start looking. */
function fileStageDetail(entries: readonly LspEnrichmentFailure[], reasons: string): string {
  const files = [...new Set(entries.map((entry) => entry.filePath))];
  const more = files.length > 3 ? ', …' : '';
  return `${files.length} file(s) (${reasons}), e.g. ${files.slice(0, 3).join(', ')}${more}`;
}

/**
 * The entry for a server that started and has since died, found when its language's files come up
 * for enrichment: none of them is asked about, so the language is recorded, once, with how it
 * ended when that is known. `started` is the set of languages whose server started; the language
 * is taken out of it so it is recorded once.
 */
export function lostServerFailure(
  enricher: { languageId: string; isReady: boolean; lostReason?: string | null },
  started: Set<string>
): LspEnrichmentFailure | undefined {
  if (enricher.isReady || !started.delete(enricher.languageId)) return undefined;
  return failedStartFailure(
    enricher.languageId,
    enricher.lostReason ?? `${enricher.languageId} language server is not running`
  );
}

/**
 * The reason a failure message classifies as, with the message itself kept for an `error`, and
 * the language, exit status and last stderr lines kept for a server that died.
 */
function reasonOf(
  message: string
): Pick<
  LspEnrichmentFailure,
  'reason' | 'message' | 'languageId' | 'method' | 'exitCode' | 'signal' | 'stderr'
> {
  const exit = parseServerExit(message);
  if (exit) {
    return {
      reason: 'transport',
      languageId: exit.languageId,
      exitCode: exit.exitCode,
      signal: exit.signal,
      stderr: exit.stderr,
    };
  }
  const reason = classifyLspEnrichmentError(message);
  if (reason === 'empty') return { reason, method: EMPTY_ANSWER.exec(message)?.[1] };
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
