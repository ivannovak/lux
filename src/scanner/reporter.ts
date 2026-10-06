// A pipeline stage's two output channels. Progress lines say what the stage is doing; warnings are
// problems it absorbed and carried on past, which degrade the run that hit them. They are separate
// calls so that no formatting of a progress line (a timestamp in front, a missing prefix) can turn a
// warning into an ordinary log line.

declare const progressBrand: unique symbol;
declare const warnBrand: unique symbol;

/**
 * A progress-line sink. Branded, as WarnFn is, so neither can be passed where the other is expected:
 * handing a progress logger to a parameter that wants a warning sink is a compile error.
 */
export type ProgressFn = ((message: string) => void) & { readonly [progressBrand]: 'progress' };

/**
 * A warning sink. `component` names what failed (`detector:<name>`, `ast-file:<path>`, …) so a later
 * run that re-runs that component cleanly can retire a warning carried from an earlier one.
 */
export type WarnFn = ((message: string, component?: string) => void) & {
  readonly [warnBrand]: 'warn';
};

export function progressSink(fn: (message: string) => void): ProgressFn {
  return fn as ProgressFn;
}

export function warnSink(fn: (message: string, component?: string) => void): WarnFn {
  return fn as WarnFn;
}

// Function-valued properties, not methods, so a caller can hand `reporter.warn` on as a callback.
export interface Reporter {
  progress: ProgressFn;
  warn: WarnFn;
  /** Records that `component` ran (whether or not it warned), for retiring carried warnings. */
  ran: (component: string) => void;
}

export const silentReporter: Reporter = {
  progress: progressSink(() => {}),
  warn: warnSink(() => {}),
  ran: () => {},
};

/**
 * A Reporter for an entry point that takes plain callbacks. Without `onWarning`, a warning reaches
 * `onProgress` as `Warning: <message>`, the form such callers have always received.
 */
export function reporterFrom(
  onProgress?: (message: string) => void,
  onWarning?: (message: string) => void
): Reporter {
  const progress = onProgress ?? (() => {});
  return {
    progress: progressSink(progress),
    warn: warnSink(onWarning ?? ((message) => progress(`Warning: ${message}`))),
    ran: () => {},
  };
}

/**
 * Collects the warnings a run absorbed, which component raised each, and which components ran, so
 * the run can report them and a later run can tell which carried warnings it has retired.
 */
export class WarningLog {
  readonly messages: string[] = [];
  readonly components: Record<string, string> = {};
  readonly ran = new Set<string>();
  readonly reporter: Reporter;

  constructor(onProgress?: (message: string) => void) {
    this.reporter = {
      progress: progressSink(onProgress ?? (() => {})),
      warn: warnSink((message, component) => {
        if (!this.messages.includes(message)) this.messages.push(message);
        if (component) this.components[message] = component;
      }),
      ran: (component) => {
        this.ran.add(component);
      },
    };
  }
}

/**
 * Summarise per-item failures (one file's enrichment, say) as a single warning, so a run that loses
 * hundreds of items reports one line, with enough examples to start from.
 */
export function failureSummary(
  what: string,
  failures: ReadonlyArray<{ item: string; error: string }>
): string {
  const examples = failures
    .slice(0, 3)
    .map((f) => `${f.item}: ${f.error}`)
    .join('; ');
  const more = failures.length > 3 ? `; and ${failures.length - 3} more` : '';
  return `${what} failed for ${failures.length} item(s) — ${examples}${more}`;
}
