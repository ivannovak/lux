// Generic LSP client wrapper with concurrency limiting and timeout handling.
//
// Communicates with language servers over stdio using the JSON-RPC protocol
// defined by the Language Server Protocol. Manages the full server lifecycle:
// spawn -> initialize -> requests -> shutdown -> exit.

import { spawn, type ChildProcess } from 'child_process';
import {
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  ExitNotification,
  type InitializeParams,
  type InitializeResult,
  type RequestMessage,
  type ResponseMessage,
  type NotificationMessage,
} from 'vscode-languageserver-protocol';

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
  /** Maximum number of concurrent in-flight requests (default: 4). */
  maxConcurrency?: number;
  /** Timeout in milliseconds for individual requests (default: 30000). */
  requestTimeoutMs?: number;
  /** Timeout in milliseconds for server initialization (default: 60000). */
  initTimeoutMs?: number;
  /** Max distinct documents open in the server at once (the didOpen cap). Default: 12. */
  maxOpenDocuments?: number;
}

/** Internal representation of a pending JSON-RPC request. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Refcounted open-document lease state, keyed by URI. */
interface OpenDoc {
  refCount: number;
  /** Resolves once the didOpen for this URI has been sent (guards the open race). */
  opened: Promise<void>;
}

/** How long a server has to exit after SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 2_000;

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
 * - Concurrency limiting for outbound requests
 * - Per-request timeout handling
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
    Pick<
      LspClientOptions,
      'maxConcurrency' | 'requestTimeoutMs' | 'initTimeoutMs' | 'maxOpenDocuments'
    >
  > &
    LspClientOptions;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly semaphore: Semaphore;
  private readonly openDocSemaphore: Semaphore;
  private readonly openDocs = new Map<string, OpenDoc>();
  private inputBuffer = '';
  private contentLength = -1;
  private _initialized = false;
  private _serverCapabilities: InitializeResult | null = null;
  private _shutdownRequested = false;

  constructor(options: LspClientOptions) {
    this.options = {
      maxConcurrency: 4,
      requestTimeoutMs: 30_000,
      initTimeoutMs: 60_000,
      maxOpenDocuments: 12,
      ...options,
    };
    this.semaphore = new Semaphore(this.options.maxConcurrency);
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
      result = (await this.sendRequest(
        InitializeRequest.method,
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

    this.sendNotification(InitializedNotification.method, {});
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

    try {
      await this.sendRequest(ShutdownRequest.method, null, this.options.requestTimeoutMs);
    } catch {
      // Best-effort — server may already be dead
    }

    this.sendNotification(ExitNotification.method, undefined);
    this._initialized = false;

    this.cleanup();
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request and wait for the response.
   *
   * Respects the concurrency semaphore — if maxConcurrency requests are
   * already in flight, this call will wait until a slot opens.
   *
   * @param method - The LSP method (e.g. "textDocument/documentSymbol").
   * @param params - Method parameters.
   * @param timeoutMs - Override timeout for this request.
   * @returns The result from the server response.
   * @throws On timeout, server error, or transport failure.
   */
  async request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    this.assertReady();
    return this.sendRequest(method, params, timeoutMs) as Promise<T>;
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
    const env = this.options.env ? { ...process.env, ...this.options.env } : process.env;

    this.process = spawn(this.options.serverCommand, this.options.serverArgs ?? [], {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout!.on('data', (data: Buffer) => {
      this.handleData(data.toString('utf-8'));
    });

    this.process.on('error', (err) => {
      this.rejectAll(new Error(`Language server process error: ${err.message}`));
      this.cleanup();
    });

    this.process.on('exit', (code) => {
      if (!this._shutdownRequested) {
        this.rejectAll(
          new Error(`Language server exited unexpectedly with code ${code ?? 'null'}`)
        );
      }
      this.cleanup();
    });
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
    this.rejectAll(new Error('Client shut down'));
  }

  // -------------------------------------------------------------------------
  // Private: JSON-RPC framing
  // -------------------------------------------------------------------------

  private handleData(chunk: string): void {
    this.inputBuffer += chunk;

    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.inputBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = this.inputBuffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Malformed header — skip past it
          this.inputBuffer = this.inputBuffer.slice(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.inputBuffer = this.inputBuffer.slice(headerEnd + 4);
      }

      if (this.inputBuffer.length < this.contentLength) break;

      const body = this.inputBuffer.slice(0, this.contentLength);
      this.inputBuffer = this.inputBuffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body) as ResponseMessage;
        this.handleMessage(message);
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  private handleMessage(message: ResponseMessage): void {
    if (message.id === undefined || message.id === null) return;

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

    const id = typeof message.id === 'string' ? parseInt(message.id, 10) : message.id;
    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (message.error) {
      pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  // -------------------------------------------------------------------------
  // Private: request/notification sending
  // -------------------------------------------------------------------------

  private async sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    await this.semaphore.acquire();

    try {
      return await this.sendRequestRaw(method, params, timeoutMs);
    } finally {
      this.semaphore.release();
    }
  }

  private sendRequestRaw(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Language server stdin is not writable'));
        return;
      }

      const id = this.nextId++;
      const timeout = timeoutMs ?? this.options.requestTimeoutMs;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" (id=${id}) timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

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
   * Answer a server-initiated request.
   *
   * We hold no user configuration, so `workspace/configuration` is answered
   * with one null per requested item — the shape the protocol requires, meaning
   * "no value set, use your default". Every other server request is answered
   * with a null result rather than an error: an enrichment pass wants the
   * server to proceed with defaults, not to surface a failure the caller cannot
   * act on.
   */
  private answerServerRequest(message: RequestMessage): void {
    if (!this.process?.stdin?.writable) return;

    let result: unknown = null;
    if (message.method === 'workspace/configuration') {
      const params = message.params as { items?: unknown[] } | undefined;
      result = new Array(params?.items?.length ?? 0).fill(null);
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
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.process!.stdin!.write(header + body, 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private assertReady(): void {
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
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
