// A timestamped record of what went to and came from the language servers, for diagnosing answers
// that differ between runs. Off unless LUX_LSP_TRACE names a file (`lux --lsp-trace <file>` sets
// it). One JSON object per line; a line is short — it says what was asked and how much came back,
// not the payload. An error answer carries its message; each line a server writes to stderr, and
// its exit, are recorded too, so a server that died can be seen dying.

import { appendFileSync } from 'node:fs';

export const LSP_TRACE_ENV = 'LUX_LSP_TRACE';

interface TraceMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A line the server wrote to stderr. */
interface TraceStderr {
  text: string;
}

/** The server process ended. */
interface TraceExit {
  exitCode: number | null;
  signal: string | null;
}

export type LspTrace = {
  (direction: 'send' | 'receive', message: TraceMessage): void;
  (direction: 'stderr', line: TraceStderr): void;
  (direction: 'exit', exit: TraceExit): void;
};

/** The trace writer for one server, or undefined when tracing is off. */
export function lspTrace(server: string): LspTrace | undefined {
  const file = process.env[LSP_TRACE_ENV];
  if (!file) return undefined;
  const write = (record: Record<string, unknown>): void =>
    appendFileSync(file, JSON.stringify({ t: Date.now(), server, ...record }) + '\n');
  return (
    direction: 'send' | 'receive' | 'stderr' | 'exit',
    item: TraceMessage | TraceStderr | TraceExit
  ) => {
    if (direction === 'stderr' || direction === 'exit') {
      write({ direction, ...item });
      return;
    }
    const message = item as TraceMessage;
    const params = message.params as
      | { textDocument?: { uri?: string }; position?: { line: number; character: number } }
      | undefined;
    write({
      direction,
      ...(message.id !== undefined && message.id !== null ? { id: message.id } : {}),
      ...(message.method ? { method: message.method } : {}),
      ...(params?.textDocument?.uri ? { uri: params.textDocument.uri } : {}),
      ...(params?.position ? { at: `${params.position.line}:${params.position.character}` } : {}),
      ...(message.error ? { error: message.error.code, message: message.error.message } : {}),
      ...(direction === 'receive' && !message.method && !message.error
        ? { result: resultSize(message.result) }
        : {}),
    });
  };
}

/** `null`, an array's length, or the kind of thing it is: enough to tell empty from absent. */
function resultSize(result: unknown): string | number {
  if (result === null || result === undefined) return 'null';
  if (Array.isArray(result)) return result.length;
  return typeof result;
}
