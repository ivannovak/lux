// Generic LSP client wrapper: one request in flight at a time, with timeout handling.
//
// Communicates with language servers over stdio using the JSON-RPC protocol
// defined by the Language Server Protocol. Manages the full server lifecycle:
// spawn -> initialize -> requests -> shutdown -> exit.

import { spawn, type ChildProcess } from 'child_process';
import type {
  InitializeParams,
  InitializeResult,
  RequestMessage,
  ResponseMessage,
  NotificationMessage,
} from 'vscode-languageserver-protocol';
import { lspTrace, type LspTrace } from './trace.js';

// The lifecycle methods by their names in the protocol. Importing them from
// vscode-languageserver-protocol would load that package (about 35 ms) on every `lux` command.
const LSP_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  shutdown: 'shutdown',
  exit: 'exit',
} as const;
import { describeServerExit, StderrTail } from './server-exit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating an LspClient. */
export interface LspClientOptions {
  /** Command to spawn the language server (e.g. "typescript-language-server"). */
  serverCommand: string;
  /** Arguments to pass to the server command. */
  serverArgs?: string[];
  /** Working directory for the server process. */
  cwd?: string;
  /** Environment variables for the server process. Merged with process.env. */
  env?: Record<string, string>;
  /**
   * Timeout in milliseconds for individual requests (default: 30000). The clock runs from the
   * moment the request is written, and nothing else of this client's is in flight then, so it
   * measures the server's work on that request.
   */
  requestTimeoutMs?: number;
  /** Timeout in milliseconds for server initialization (default: 60000). */
  initTimeoutMs?: number;
  /** Max distinct documents open in the server at once (the didOpen cap). Default: 12. */
  maxOpenDocuments?: number;
  /**
   * Settings returned for a `workspace/configuration` item, by section. Undefined (or no
   * provider) answers null for that item: "no value set, use your default".
   */
  configuration?: (section: string | undefined) => unknown;
  /** What to call the server in an error (e.g. "php"). */
  serverLabel?: string;
}

/** Internal representation of a pending JSON-RPC request. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Frees the request slot. */
  settle: () => void;
}

/** A request that timed out and was cancelled, and that the server has not yet answered. */
interface AbandonedRequest {
  timer: ReturnType<typeof setTimeout>;
  settle: () => void;
}

/** Refcounted open-document lease state, keyed by URI. */
interface OpenDoc {
  refCount: number;
  /** Resolves once the didOpen for this URI has been sent (guards the open race). */
  opened: Promise<void>;
}

/** The server answered a request with an error. */
export class LspResponseError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(`LSP error ${code}: ${message}`);
    this.name = 'LspResponseError';
  }
}

/**
 * A request got no answer: it timed out, the transport died under it, or it was not sent because
 * the server had stopped answering. Unlike an error answer or a malformed result, this says
 * nothing about the file and depends on load, so it must not be read as "this item has no data".
 */
export class LspTransientError extends Error {
  constructor(
    readonly kind: 'timeout' | 'transport' | 'unresponsive' | 'empty',
    message: string
  ) {
    super(message);
    this.name = 'LspTransientError';
  }
}

/**
 * A timed-out request is sent again this many times before the timeout is reported. Timeouts
 * come from load, not from the request, so one more attempt recovers most of them; a file whose
 * request still times out is recorded as not enriched.
 */
const REQUEST_TIMEOUT_RETRIES = 1;

/**
 * Requests in flight at once. intelephense, tsserver and the Vue language server each answer one
 * request at a time, so a second request sent early only waits in the server's queue with its
 * timeout running: measured on a 9.6k-file repository, 8 in flight took the same total time as 1
 * and made a 1.5 s `references` request take 10 s. This is a property of the servers, not a
 * tuning knob; see README "Language-server requests".
 */
const REQUESTS_IN_FLIGHT = 1;

/**
 * A server that leaves this many request attempts in a row without a response of any kind — no
 * answer within the timeout, and none to the cancellation within the wait that follows — has
 * stopped answering, and nothing more is sent to it. Without this, every remaining file would
 * wait out two attempts of two timeout periods each: hours on a large repository.
 *
 * The number is two requests with their retries. One request alone must not be enough: a single
 * file can be pathological for a server that is otherwise fine. Two is enough because the evidence
 * is already strong by then — eight timeout periods with not one message answered — and in about
 * 250,000 requests measured against intelephense, tsserver and the Vue language server (load
 * average 10 to 45) no attempt went that way even once: every timeout seen was a request that the
 * server answered late. Any response, including a late or an error one, starts the count again.
 */
const UNANSWERED_ATTEMPTS_BEFORE_LOST = 2 * (1 + REQUEST_TIMEOUT_RETRIES);

/** How long a server has to exit after SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * How long, after a server died, its stderr is read for the lines it wrote as it went (an
 * out-of-memory report, a stack) before its death is reported. The exit can be seen before the
 * last of the pipe has been read; a worker the server forked can hold the pipe open indefinitely.
 */
const STDERR_DRAIN_MS = 500;

// ---------------------------------------------------------------------------
// Semaphore for concurrency limiting
// ---------------------------------------------------------------------------

/**
 * Simple counting semaphore for limiting concurrent async operations.
 */
class Semaphore {
  private permits: number;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxPermits: number) {
    this.permits = maxPermits;
  }

  /** Acquire a permit, waiting if none are available. */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /** Release a permit, unblocking the next waiter if any. */
  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

/**
 * Generic LSP client that communicates with a language server over stdio.
 *
 * Handles:
 * - Spawning the server process
 * - JSON-RPC message framing (Content-Length headers)
 * - Request/response correlation via message IDs
 * - Sending one request at a time, so a request's timeout measures the server's work on it
 * - Per-request timeout handling, with `$/cancelRequest` for a request that timed out
 * - Graceful shutdown (shutdown request + exit notification)
 *
 * Usage:
 *   const client = new LspClient({ serverCommand: "ts-ls", serverArgs: ["--stdio"] });
 *   const caps = await client.initialize({ rootUri: "file:///project", ... });
 *   const result = await client.request("textDocument/documentSymbol", params);
 *   await client.shutdown();
 */
export class LspClient {
  private readonly options: Required<
    Pick<LspClientOptions, 'requestTimeoutMs' | 'initTimeoutMs' | 'maxOpenDocuments'>
  > &
    LspClientOptions;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private trace: LspTrace | undefined;
  private readonly abandoned = new Map<number, AbandonedRequest>();
  private readonly semaphore: Semaphore;
  private readonly openDocSemaphore: Semaphore;
  private readonly openDocs = new Map<string, OpenDoc>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  /** Unparsed stdout bytes. Content-Length counts bytes, so framing never sees decoded text. */
  private inputBuffer: Buffer = Buffer.alloc(0);
  private contentLength = -1;
  private _initialized = false;
  /** Whether a request has been sent since `initialize`. */
  private _firstRequestSent = false;
  private _serverCapabilities: InitializeResult | null = null;
  private _shutdownRequested = false;
  /** Set when the server process died or errored without a shutdown having been requested. */
  private _transportLost: string | null = null;
  /**
   * Set while a server that died has its stderr read to the end; requests wait for it, so each
   * reports the death with the server's last words.
   */
  private exitSettling: Promise<void> | null = null;
  /** The last lines the server wrote to stderr. Read always: an unread pipe fills and blocks it. */
  private stderrTail = new StderrTail();
  /** Attempts in a row that got no response within their timeout or the wait after it. */
  private unansweredAttempts = 0;
  /** Set when the server stopped answering; nothing is sent to it after that. */
  private _stoppedAnswering: string | null = null;

  constructor(options: LspClientOptions) {
    this.options = {
      requestTimeoutMs: 30_000,
      initTimeoutMs: 60_000,
      maxOpenDocuments: 12,
      ...options,
    };
    this.semaphore = new Semaphore(REQUESTS_IN_FLIGHT);
    this.openDocSemaphore = new Semaphore(this.options.maxOpenDocuments);
  }

  /** Whether the client has been initialized and is ready for requests. */
  get initialized(): boolean {
    return this._initialized;
  }

  /** The server's capabilities, available after initialization. */
  get serverCapabilities(): InitializeResult | null {
    return this._serverCapabilities;
  }

  /**
   * Why the server can no longer be asked anything — it died (with its exit status and last stderr
   * lines) or stopped answering — or null while it can.
   */
  get lostReason(): string | null {
    return this._transportLost ?? this._stoppedAnswering;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn the language server and perform the LSP initialization handshake.
   *
   * @param params - LSP InitializeParams (rootUri, capabilities, etc.).
   * @returns The server's InitializeResult including its capabilities.
   * @throws If the server fails to start or initialization times out.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this._initialized) {
      throw new Error('Client is already initialized. Call shutdown() first.');
    }

    this.spawnServer();

    let result: InitializeResult;
    try {
      result = (await this.sendRequestRaw(
        LSP_METHODS.initialize,
        params,
        this.options.initTimeoutMs
      )) as InitializeResult;
    } catch (error) {
      // A server that refuses `initialize` does not exit on its own — it keeps
      // reading stdin. Left running, it and its stdio pipes hold the caller's
      // event loop open after everything else has finished.
      this.cleanup();
      throw error;
    }

    this._serverCapabilities = result;
    this._firstRequestSent = false;

    this.sendNotification(LSP_METHODS.initialized, {});
    this._initialized = true;

    return result;
  }

  /**
   * Gracefully shut down the language server.
   *
   * Sends a shutdown request followed by an exit notification, then
   * terminates the server process. Safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    if (!this.process || this._shutdownRequested) {
      return;
    }

    this._shutdownRequested = true;

    // A server that stopped answering is not asked to shut down, only told to exit and killed.
    if (this._stoppedAnswering) {
      this.sendNotification(LSP_METHODS.exit, undefined);
      this._initialized = false;
      this.cleanup();
      return;
    }

    try {
      // Not queued behind the request slot: a slot still held for a cancelled request must not
      // delay the exit.
      await this.sendRequestRaw(LSP_METHODS.shutdown, null, this.options.requestTimeoutMs);
    } catch {
      // lux-intentional-swallow: shutting down a server that may already have exited.
      // Best-effort — server may already be dead
    }

    this.sendNotification(LSP_METHODS.exit, undefined);
    this._initialized = false;

    this.cleanup();
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * Requests are sent one at a time: this call waits until the server has answered the previous
   * one. A request that times out is cancelled (`$/cancelRequest`) and sent once more under a new
   * id; an answer that later arrives for the cancelled id is dropped.
   *
   * @param method - The LSP method (e.g. "textDocument/documentSymbol").
   * @param params - Method parameters.
   * @param timeoutMs - Override timeout for this request.
   * @returns The result from the server response.
   * @throws On timeout, server error, or transport failure.
   */
  async request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.exitSettling;
    this.assertReady();
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.sendRequest(method, params, timeoutMs)) as T;
      } catch (error) {
        const timedOut = error instanceof LspTransientError && error.kind === 'timeout';
        if (!timedOut || attempt >= REQUEST_TIMEOUT_RETRIES) throw error;
      }
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   *
   * @param method - The LSP method.
   * @param params - Method parameters.
   */
  notify(method: string, params: unknown): void {
    this.assertReady();
    this.sendNotification(method, params);
  }

  /** Call `handler` for each notification the server sends with `method` (one handler per method). */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Run `fn` with `uri` open in the server, refcounted per URI. The FIRST holder
   * sends didOpen (after acquiring an open-document permit — this is the didOpen
   * cap that the request semaphore does not provide); the LAST releaser sends
   * didClose and frees the permit. Concurrent holders of the same URI share a
   * single open, so a parallel pass never closes a document another operation is
   * mid-request on.
   *
   * The open-map entry is reserved SYNCHRONOUSLY (before the first await) so a
   * second caller for the same URI observes it and takes the refCount++ branch
   * rather than issuing a duplicate didOpen (a protocol violation on a v1 doc).
   */
  async withDocument<T>(
    uri: string,
    languageId: string,
    text: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.exitSettling;
    this.assertReady();
    let doc = this.openDocs.get(uri);
    if (doc) {
      doc.refCount++;
      await doc.opened; // an already-registered open may still be in flight
    } else {
      doc = { refCount: 1, opened: Promise.resolve() };
      this.openDocs.set(uri, doc); // reserve SYNCHRONOUSLY — before any await — to win the race
      doc.opened = (async () => {
        await this.openDocSemaphore.acquire();
        this.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId, version: 1, text },
        });
      })();
      await doc.opened;
    }
    try {
      return await fn();
    } finally {
      doc.refCount--;
      if (doc.refCount <= 0) {
        this.openDocs.delete(uri);
        this.sendNotification('textDocument/didClose', { textDocument: { uri } });
        this.openDocSemaphore.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: process management
  // -------------------------------------------------------------------------

  private spawnServer(): void {
    this.trace = lspTrace(this.options.serverLabel ?? this.options.serverCommand);
    const env = this.options.env ? { ...process.env, ...this.options.env } : process.env;

    this.process = spawn(this.options.serverCommand, this.options.serverArgs ?? [], {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.stderrTail = new StderrTail();
    const child = this.process;

    child.stdout!.on('data', (data: Buffer) => {
      this.handleData(data);
    });

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (text: string) => {
      for (const line of this.stderrTail.push(text)) this.trace?.('stderr', { text: line });
    });

    child.on('error', (err) => {
      this._transportLost = `${this.label} language server process error: ${err.message}`;
      this.rejectAll(new LspTransientError('transport', this._transportLost));
      this.cleanup();
    });

    child.on('exit', (code, signal) => {
      this.trace?.('exit', { exitCode: code, signal });
      if (this._shutdownRequested) {
        this.cleanup();
        return;
      }
      // Nothing more can be written to it; requests from here on wait for the report below.
      child.stdin?.destroy();
      const describe = (): string =>
        describeServerExit({
          languageId: this.label,
          exitCode: code,
          signal,
          stderr: this.stderrTail.snapshot(),
        });
      this._transportLost = describe();
      this.exitSettling = new Promise<void>((resolve) => {
        const settle = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(settle, STDERR_DRAIN_MS);
        if (!child.stderr || child.stderr.readableEnded || child.stderr.destroyed) settle();
        else child.stderr.once('close', settle).once('end', settle);
      }).then(() => {
        this._transportLost = describe();
        this.exitSettling = null;
        this.rejectAll(new LspTransientError('transport', this._transportLost));
        this.cleanup();
      });
    });
  }

  /** What to call the server in a message: its language, or failing that its command. */
  private get label(): string {
    return this.options.serverLabel ?? this.options.serverCommand;
  }

  private cleanup(): void {
    if (this.process) {
      const child = this.process;
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();

      // Closing stdin lets a server that exits on EOF shut down (and reap its own
      // workers) before any signal reaches it. stdout/stderr must be closed from
      // this end: a worker the server forked can hold them open after it dies.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();

      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        // A server that ignores SIGTERM would keep its process handle, and so
        // the caller's event loop, alive indefinitely.
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        child.once('exit', () => clearTimeout(forceKill));
      }

      this.process = null;
    }

    this._initialized = false;
    this.rejectAll(new LspTransientError('transport', this._transportLost ?? 'Client shut down'));
  }

  // -------------------------------------------------------------------------
  // Private: JSON-RPC framing
  // -------------------------------------------------------------------------

  /**
   * Frame JSON-RPC messages out of raw stdout bytes. Bodies are cut by byte count and decoded only
   * once complete: a multi-byte character can straddle two chunks, and its UTF-16 length differs
   * from its byte length, so framing decoded text cuts a body too long and corrupts the next one.
   */
  private handleData(chunk: Buffer): void {
    this.inputBuffer =
      this.inputBuffer.length === 0 ? chunk : Buffer.concat([this.inputBuffer, chunk]);

    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.inputBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = this.inputBuffer.subarray(0, headerEnd).toString('ascii');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Malformed header — skip past it
          this.inputBuffer = this.inputBuffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.inputBuffer = this.inputBuffer.subarray(headerEnd + 4);
      }

      if (this.inputBuffer.length < this.contentLength) break;

      const body = this.inputBuffer.subarray(0, this.contentLength).toString('utf-8');
      this.inputBuffer = this.inputBuffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body) as ResponseMessage;
        this.handleMessage(message);
      } catch {
        // lux-intentional-swallow: a malformed frame from the server is dropped; its request times out and is handled there.
        // Malformed JSON — skip
      }
    }
  }

  private handleMessage(message: ResponseMessage): void {
    this.trace?.('receive', message);
    if (message.id === undefined || message.id === null) {
      const notification = message as unknown as NotificationMessage;
      if (typeof notification.method === 'string') {
        this.notificationHandlers.get(notification.method)?.(notification.params);
      }
      return;
    }

    // A message carrying BOTH an id and a method is a server->client REQUEST,
    // not a response to one of ours. The protocol requires an answer, and a
    // server that does not get one blocks: Volar issues workspace/configuration
    // immediately after `initialized` and will not serve a single
    // textDocument/documentSymbol until it is answered. Dropping these on the
    // floor is indistinguishable from a hung server.
    if (typeof (message as { method?: unknown }).method === 'string') {
      this.answerServerRequest(message as unknown as RequestMessage);
      return;
    }

    // Any response shows the server is answering.
    this.unansweredAttempts = 0;

    const id = typeof message.id === 'string' ? parseInt(message.id, 10) : message.id;
    const pending = this.pending.get(id);
    if (!pending) {
      // An answer to a request that was cancelled after timing out. Its caller has already been
      // told, and a retry has its own id, so the answer is dropped; it only shows the server is
      // free again.
      this.settleAbandoned(id);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.settle();

    if (message.error) {
      pending.reject(new LspResponseError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  // -------------------------------------------------------------------------
  // Private: request/notification sending
  // -------------------------------------------------------------------------

  private async sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    await this.semaphore.acquire();
    // A server answers `initialize` before it has finished starting: tsserver is spawned and the
    // project loaded on the first request, which then takes seconds that say nothing about that
    // request. The first request sent is given the initialization timeout — only the first, so a
    // server that never answers costs one such wait and not one per file.
    const timeout =
      timeoutMs ??
      (this._firstRequestSent
        ? this.options.requestTimeoutMs
        : Math.max(this.options.requestTimeoutMs, this.options.initTimeoutMs));
    this._firstRequestSent = true;
    if (this._stoppedAnswering) {
      this.semaphore.release();
      throw new LspTransientError('unresponsive', this._stoppedAnswering);
    }
    // The slot is freed when the server is done with the request, which for a timed-out request
    // is later than when the caller is told: see `abandon`.
    return this.sendRequestRaw(method, params, timeout, () => this.semaphore.release());
  }

  private sendRequestRaw(
    method: string,
    params: unknown,
    timeoutMs?: number,
    settle: () => void = () => {}
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        settle();
        reject(
          new LspTransientError(
            'transport',
            this._transportLost ?? `${this.label} language server stdin is not writable`
          )
        );
        return;
      }

      const id = this.nextId++;
      const timeout = timeoutMs ?? this.options.requestTimeoutMs;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.abandon(id, timeout, settle);
        reject(
          new LspTransientError(
            'timeout',
            `LSP request "${method}" (id=${id}) timed out after ${timeout}ms`
          )
        );
      }, timeout);

      this.pending.set(id, { resolve, reject, timer, settle });

      const message: RequestMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params: params as Record<string, unknown>,
      };

      this.writeMessage(message);
    });
  }

  /**
   * Cancel a request that timed out, and keep its slot until the server answers it (with the late
   * result or a "cancelled" error) or `graceMs` passes. A server that answers one request at a
   * time may still be computing the cancelled one; a request sent before it finishes would have
   * that remainder charged to its own timeout.
   */
  private abandon(id: number, graceMs: number, settle: () => void): void {
    this.sendNotification('$/cancelRequest', { id });
    const timer = setTimeout(() => {
      // Neither an answer nor an acknowledgement of the cancellation.
      this.unansweredAttempts++;
      if (this.unansweredAttempts >= UNANSWERED_ATTEMPTS_BEFORE_LOST && !this._stoppedAnswering) {
        this._stoppedAnswering =
          `${this.options.serverLabel ?? 'the'} language server stopped answering: ` +
          `no response to ${this.unansweredAttempts} request attempts in a row`;
      }
      this.settleAbandoned(id);
    }, graceMs);
    this.abandoned.set(id, { timer, settle });
  }

  private settleAbandoned(id: number): void {
    const abandoned = this.abandoned.get(id);
    if (!abandoned) return;
    clearTimeout(abandoned.timer);
    this.abandoned.delete(id);
    abandoned.settle();
  }

  /**
   * Answer a server-initiated request.
   *
   * `workspace/configuration` is answered with one value per requested item:
   * the `configuration` option's settings for that section, or null — "no
   * value set, use your default". Every other server request is answered
   * with a null result rather than an error: an enrichment pass wants the
   * server to proceed with defaults, not to surface a failure the caller cannot
   * act on.
   */
  private answerServerRequest(message: RequestMessage): void {
    if (!this.process?.stdin?.writable) return;

    let result: unknown = null;
    if (message.method === 'workspace/configuration') {
      const params = message.params as { items?: Array<{ section?: string }> } | undefined;
      result = (params?.items ?? []).map(
        (item) => this.options.configuration?.(item?.section) ?? null
      );
    }

    const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.process.stdin.write(header + body, 'utf-8');
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin?.writable) return;

    const message: NotificationMessage = {
      jsonrpc: '2.0',
      method,
      params: params as Record<string, unknown>,
    };

    this.writeMessage(message);
  }

  private writeMessage(message: RequestMessage | NotificationMessage): void {
    this.trace?.('send', message);
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.process!.stdin!.write(header + body, 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private assertReady(): void {
    // A server that died mid-run is a transport failure, like a request it never answered — not
    // a caller's mistake — so the caller records what it could not ask.
    if (this._transportLost) throw new LspTransientError('transport', this._transportLost);
    if (this._stoppedAnswering) throw new LspTransientError('unresponsive', this._stoppedAnswering);
    if (!this._initialized) {
      throw new Error('Client is not initialized. Call initialize() first.');
    }
    if (this._shutdownRequested) {
      throw new Error('Client is shutting down.');
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.settle();
      pending.reject(error);
    }
    for (const id of [...this.abandoned.keys()]) this.settleAbandoned(id);
  }
}
