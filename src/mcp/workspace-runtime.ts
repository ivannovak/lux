import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../db/index.js';
import { openIndex, type IndexOpenMode } from '../db/open-policy.js';
import { resolveRuntimePaths, type RuntimePathResolution } from '../utils/runtime-paths.js';

export interface McpRoot {
  uri: string;
  name?: string;
}

export type ListRoots = () => Promise<{ roots: McpRoot[] }>;

export interface WorkspaceLease {
  runtime: RuntimePathResolution;
  db: LuxDatabase;
  release: () => void;
}

export interface WorkspaceRuntimeOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  openDatabase?: (dbPath: string, mode?: IndexOpenMode) => LuxDatabase;
}

export type WorkspaceUnavailableReason =
  | 'initializing'
  | 'roots-list-failed'
  | 'roots-empty'
  | 'roots-ambiguous'
  | 'root-uri-invalid'
  | 'root-not-directory'
  | 'database-open-failed';

export class WorkspaceUnavailableError extends Error {
  readonly code = 'workspace-unavailable';

  constructor(
    readonly reason: WorkspaceUnavailableReason,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkspaceUnavailableError';
  }
}

interface WorkspaceHandle {
  runtime: RuntimePathResolution;
  db: LuxDatabase;
  leases: number;
  retired: boolean;
}

/**
 * Owns the workspace selected by MCP Roots and lazily leases its index.
 *
 * Selection and opening are deliberately separate: a valid root may not have an index yet, and the
 * explicit rebuild tool must still be able to create it. Read calls open an existing current-schema
 * index strictly read-only. Mutating calls close an idle read handle, acquire their own writer, and
 * close it at request end; the next read lazily observes the new index.
 */
export class WorkspaceRuntime {
  private readonly env: Record<string, string | undefined>;
  private readonly cwd: string;
  private readonly openDatabase: (dbPath: string, mode?: IndexOpenMode) => LuxDatabase;
  private readonly fixedByEnvironment: boolean;
  private runtime: RuntimePathResolution | null = null;
  private active: WorkspaceHandle | null = null;
  private unavailable: WorkspaceUnavailableError | null;
  private listRoots: ListRoots | null = null;
  private refreshGeneration = 0;
  private pendingRefresh: Promise<void> | null = null;
  private writerActive = false;
  private activeWriter: LuxDatabase | null = null;
  private disposed = false;

  constructor(options: WorkspaceRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.openDatabase =
      options.openDatabase ??
      ((dbPath, mode = 'read-existing') => {
        const opened = openIndex(dbPath, mode);
        if (!opened.ok) throw new Error(`${opened.refusal}: ${opened.message}`);
        return opened.db;
      });
    this.fixedByEnvironment = Boolean(this.env.LUX_CORPUS_PATH || this.env.LUX_DB_PATH);
    this.unavailable = this.fixedByEnvironment
      ? null
      : new WorkspaceUnavailableError(
          'initializing',
          'The MCP workspace is still initializing. Retry after client initialization completes.'
        );

    if (this.fixedByEnvironment) {
      this.selectRuntime(resolveRuntimePaths({ env: this.env, cwd: this.cwd }));
    }
  }

  configureClient(listRoots: ListRoots | null): Promise<void> {
    this.assertNotDisposed();
    if (this.fixedByEnvironment) return Promise.resolve();
    if (this.listRoots) return this.pendingRefresh ?? Promise.resolve();

    this.listRoots = listRoots;
    if (!listRoots) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'roots-empty',
          'The MCP client does not provide an active workspace root. Set LUX_CORPUS_PATH explicitly or use a roots-capable client.'
        )
      );
      return Promise.resolve();
    }
    return this.refreshRoots();
  }

  refreshRoots(): Promise<void> {
    this.assertNotDisposed();
    if (this.fixedByEnvironment || !this.listRoots) return Promise.resolve();

    const generation = ++this.refreshGeneration;
    const refresh = this.listRoots()
      .then(({ roots }) => {
        if (generation !== this.refreshGeneration || this.disposed) return;
        this.applyRoots(roots);
      })
      .catch((error: unknown) => {
        if (generation !== this.refreshGeneration || this.disposed) return;
        this.setUnavailable(
          new WorkspaceUnavailableError(
            'roots-list-failed',
            `The MCP client failed to provide its active workspace root: ${String(error)}`
          )
        );
      })
      .finally(() => {
        if (this.pendingRefresh === refresh) this.pendingRefresh = null;
      });
    this.pendingRefresh = refresh;
    return refresh;
  }

  /** Resolve the active workspace without opening its index (used by absent-index diagnostics). */
  async resolveRuntime(): Promise<RuntimePathResolution> {
    this.assertNotDisposed();
    while (this.pendingRefresh) {
      const pending = this.pendingRefresh;
      await pending;
      if (this.pendingRefresh === pending) break;
    }

    if (this.unavailable) throw this.unavailable;
    if (!this.runtime) {
      throw new WorkspaceUnavailableError(
        'initializing',
        'No Lux MCP workspace is active. Retry after client initialization completes.'
      );
    }
    return this.runtime;
  }

  async acquire(mode: IndexOpenMode = 'read-existing'): Promise<WorkspaceLease> {
    const runtime = await this.resolveRuntime();

    if (mode !== 'read-existing') return this.acquireWriter(runtime, mode);
    if (this.writerActive) {
      throw new WorkspaceUnavailableError(
        'database-open-failed',
        'A read cannot start while a mutating MCP operation is active. Retry the operation.'
      );
    }

    let handle = this.active;
    if (!handle) {
      try {
        handle = {
          runtime,
          db: this.openDatabase(runtime.dbPath, 'read-existing'),
          leases: 0,
          retired: false,
        };
        this.active = handle;
      } catch (error) {
        throw this.databaseOpenError(runtime, error);
      }
    }

    handle.leases += 1;
    let released = false;
    return {
      runtime: handle.runtime,
      db: handle.db,
      release: () => {
        if (released) return;
        released = true;
        handle.leases -= 1;
        this.closeIfRetired(handle);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration += 1;
    this.pendingRefresh = null;
    this.runtime = null;
    if (this.active) {
      this.retire(this.active);
      this.active = null;
    }
  }

  private acquireWriter(runtime: RuntimePathResolution, mode: IndexOpenMode): WorkspaceLease {
    if (this.writerActive) {
      throw new WorkspaceUnavailableError(
        'database-open-failed',
        'A mutating MCP operation is already active. Retry the operation.'
      );
    }
    const readHandle = this.active;
    if (readHandle?.leases) {
      throw new WorkspaceUnavailableError(
        'database-open-failed',
        'A mutating MCP operation cannot start while read leases are active. Retry the operation.'
      );
    }
    if (readHandle) {
      this.retire(readHandle);
      this.active = null;
    }

    let writer: LuxDatabase;
    try {
      writer = this.openDatabase(runtime.dbPath, mode);
    } catch (error) {
      throw this.databaseOpenError(runtime, error);
    }

    this.writerActive = true;
    this.activeWriter = writer;
    let released = false;
    return {
      runtime,
      db: writer,
      release: () => {
        if (released) return;
        released = true;
        try {
          writer.close();
        } finally {
          if (this.activeWriter === writer) this.activeWriter = null;
          this.writerActive = false;
        }
      },
    };
  }

  private applyRoots(roots: McpRoot[]): void {
    if (roots.length === 0) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'roots-empty',
          'The MCP client did not provide an active workspace root. Select a repository and retry.'
        )
      );
      return;
    }
    if (roots.length !== 1) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'roots-ambiguous',
          `Lux requires exactly one active workspace root; the MCP client provided ${roots.length}.`,
          { roots: roots.map((root) => root.uri) }
        )
      );
      return;
    }

    let corpusPath: string;
    try {
      const url = new URL(roots[0].uri);
      if (url.protocol !== 'file:') throw new Error(`unsupported URI scheme ${url.protocol}`);
      corpusPath = fileURLToPath(url);
    } catch (error) {
      // lux-intentional-swallow: recorded as the workspace's unavailable state, which every tool call reports.
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'root-uri-invalid',
          `Lux requires a valid file:// workspace root: ${String(error)}`,
          { root: roots[0].uri }
        )
      );
      return;
    }

    try {
      if (!statSync(corpusPath).isDirectory()) {
        throw new Error('the workspace root is not a directory');
      }
    } catch (error) {
      // lux-intentional-swallow: recorded as the workspace's unavailable state, which every tool call reports.
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'root-not-directory',
          `Lux cannot use workspace root ${JSON.stringify(corpusPath)}: ${String(error)}`,
          { root: roots[0].uri, corpusPath }
        )
      );
      return;
    }

    this.selectRuntime(resolveRuntimePaths({ corpus: corpusPath, env: this.env, cwd: this.cwd }));
  }

  private selectRuntime(runtime: RuntimePathResolution): void {
    const unchanged =
      this.runtime?.corpusPath === runtime.corpusPath && this.runtime.dbPath === runtime.dbPath;
    this.runtime = runtime;
    this.unavailable = null;
    if (!unchanged && this.active) {
      this.retire(this.active);
      this.active = null;
    }
  }

  private setUnavailable(error: WorkspaceUnavailableError): void {
    this.runtime = null;
    this.unavailable = error;
    if (this.active) {
      this.retire(this.active);
      this.active = null;
    }
  }

  private retire(handle: WorkspaceHandle): void {
    handle.retired = true;
    this.closeIfRetired(handle);
  }

  private closeIfRetired(handle: WorkspaceHandle): void {
    if (handle.retired && handle.leases === 0) handle.db.close();
  }

  private databaseOpenError(
    runtime: RuntimePathResolution,
    error: unknown
  ): WorkspaceUnavailableError {
    return new WorkspaceUnavailableError(
      'database-open-failed',
      `Lux could not open the index for workspace ${JSON.stringify(runtime.corpusPath)}: ${String(error)}`,
      { corpusPath: runtime.corpusPath, dbPath: runtime.dbPath }
    );
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('WorkspaceRuntime has been disposed.');
  }
}

export function workspaceUnavailablePayload(error: WorkspaceUnavailableError): {
  error: string;
  reason: WorkspaceUnavailableReason;
  message: string;
  details: Record<string, unknown>;
} {
  return {
    error: error.code,
    reason: error.reason,
    message: error.message,
    details: error.details,
  };
}
