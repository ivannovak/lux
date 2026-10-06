// One place where an enricher's per-request outcomes are decided, so that no request failure can
// turn into "this file has no symbols" without a record.
//
//   - A capability the server did not declare is not asked for: not asking is not a failure.
//   - A timeout or a dead transport (LspTransientError) propagates and fails the file.
//   - MethodNotFound for a declared capability is a capability gap: recorded once per language and
//     method by the caller (`kind: 'capability'`).
//   - An error on the allowlist below is the server's way of saying "nothing here": an empty result.
//   - Every other error answer is recorded for the file, with its method and code
//     (`kind: 'response'`), and the item is left without that data.
// Anything else thrown while handling a result is a Lux defect and propagates.

import { LspResponseError, type LspClient } from './client.js';

/** JSON-RPC MethodNotFound. */
const METHOD_NOT_FOUND = -32601;

/** What a recorded request is missing data for: a file's enrichment, or its call resolution. */
export type LspRequestStage = 'symbols' | 'calls';

export interface LspRequestIssue {
  /** Absolute path of the file the request was about. */
  filePath: string;
  stage: LspRequestStage;
  kind: 'response' | 'capability';
  method: string;
  code: number;
}

/**
 * An error answer that a named server gives when there is simply nothing at the asked position.
 * Each entry needs a citation (the server's source or documentation) showing it means "nothing
 * here" rather than "failed", and a test.
 */
export interface KnownEmptyError {
  /** Matched against the server's `serverInfo.name`. */
  server: RegExp;
  method: string;
  code: number;
  message?: RegExp;
  citation: string;
}

/**
 * Empty until a server is observed returning such an error on a healthy corpus: an entry is added
 * from evidence, never in anticipation.
 */
const KNOWN_EMPTY_ERRORS: readonly KnownEmptyError[] = [];

export function isKnownEmptyError(
  entries: readonly KnownEmptyError[],
  serverName: string,
  method: string,
  error: LspResponseError
): boolean {
  return entries.some(
    (entry) =>
      entry.method === method &&
      entry.code === error.code &&
      entry.server.test(serverName) &&
      (entry.message === undefined || entry.message.test(error.message))
  );
}

export class LspRequester {
  private issues: LspRequestIssue[] = [];

  constructor(
    private readonly client: LspClient,
    private readonly knownEmpty: readonly KnownEmptyError[] = KNOWN_EMPTY_ERRORS
  ) {}

  /**
   * Send `method` for `filePath` if the server declared `capability`.
   * @returns the result; `undefined` when there is nothing to use (not asked, a known "nothing
   *   here" error, or an error answer that has been recorded).
   */
  async ask<T>(
    context: { filePath: string; stage: LspRequestStage },
    method: string,
    capability: string,
    params: unknown
  ): Promise<T | undefined> {
    if (!this.declares(capability)) return undefined;
    try {
      return await this.client.request<T>(method, params);
    } catch (error) {
      if (!(error instanceof LspResponseError)) throw error;
      if (error.code === METHOD_NOT_FOUND) {
        this.issues.push({ ...context, kind: 'capability', method, code: error.code });
      } else if (!isKnownEmptyError(this.knownEmpty, this.serverName, method, error)) {
        this.issues.push({ ...context, kind: 'response', method, code: error.code });
      }
      return undefined;
    }
  }

  /** The issues recorded since the last drain. */
  drain(): LspRequestIssue[] {
    const drained = this.issues;
    this.issues = [];
    return drained;
  }

  private declares(capability: string): boolean {
    const declared = this.client.serverCapabilities?.capabilities as
      Record<string, unknown> | undefined;
    const value = declared?.[capability];
    return value !== undefined && value !== null && value !== false;
  }

  private get serverName(): string {
    return this.client.serverCapabilities?.serverInfo?.name ?? '';
  }
}
