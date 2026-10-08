// How a language server that died mid-run is described: its exit status and the last lines it wrote
// to stderr, in one message every request it can no longer answer fails with. The failure record
// reads the language, the status and the lines back out of that message (enrichment-failures.ts),
// so the files the server left behind collapse into one entry that says why.

/** Lines of a server's stderr kept for the record of its death. */
export const STDERR_TAIL_LINES = 20;

/** A line longer than this is cut: a minified stack or a dumped object says no more past it. */
const STDERR_LINE_CHARS = 400;

export interface ServerExit {
  /** The language the server was started for (its `serverLabel`). */
  languageId: string;
  /** The exit code, or null when a signal ended the process. */
  exitCode: number | null;
  /** The signal that ended the process, or null when it exited on its own. */
  signal: string | null;
  /** The last lines the server wrote to stderr, oldest first; empty when it wrote none. */
  stderr: string[];
}

const EXITED =
  /^(\S+) language server exited unexpectedly \(code (-?\d+|none), signal (\S+)\)(?:\nlast stderr:\n([\s\S]*))?$/;

export function describeServerExit(exit: ServerExit): string {
  const status =
    `${exit.languageId} language server exited unexpectedly ` +
    `(code ${exit.exitCode ?? 'none'}, signal ${exit.signal ?? 'none'})`;
  return exit.stderr.length > 0 ? `${status}\nlast stderr:\n${exit.stderr.join('\n')}` : status;
}

/** The exit a message from `describeServerExit` describes, or undefined for any other message. */
export function parseServerExit(message: string): ServerExit | undefined {
  const match = EXITED.exec(message);
  if (!match) return undefined;
  return {
    languageId: match[1],
    exitCode: match[2] === 'none' ? null : Number(match[2]),
    signal: match[3] === 'none' ? null : match[3],
    stderr: match[4] === undefined ? [] : match[4].split('\n'),
  };
}

/**
 * A frame of the native backtrace Node prints after a fatal error (` 12: 0x1033c8e18 v8::…`). It
 * runs to some ninety lines and never says why; kept, it would push the line that does out of the
 * tail.
 */
const NATIVE_FRAME = /^\s*\d+: 0x[0-9a-f]+ /;

/**
 * Keeps the last `STDERR_TAIL_LINES` complete lines of a stream, fed in arbitrary chunks, leaving
 * out native backtrace frames.
 */
export class StderrTail {
  private readonly lines: string[] = [];
  private partial = '';

  /** Takes a chunk; returns the complete lines it finished, frames included. */
  push(chunk: string): string[] {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    const complete = parts.filter((line) => line.trim() !== '').map(clip);
    this.lines.push(...complete.filter((line) => !NATIVE_FRAME.test(line)));
    if (this.lines.length > STDERR_TAIL_LINES) {
      this.lines.splice(0, this.lines.length - STDERR_TAIL_LINES);
    }
    return complete;
  }

  /** The kept lines, with an unterminated last line included. */
  snapshot(): string[] {
    const partial =
      this.partial.trim() === '' || NATIVE_FRAME.test(this.partial) ? [] : [clip(this.partial)];
    const lines = [...this.lines, ...partial];
    return lines.slice(-STDERR_TAIL_LINES);
  }
}

function clip(line: string): string {
  return line.length > STDERR_LINE_CHARS ? `${line.slice(0, STDERR_LINE_CHARS)}…` : line;
}
