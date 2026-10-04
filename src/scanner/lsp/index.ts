// LSP Enrichment: interfaces, types, and enricher registry
//
// LspEnricher is the contract that language-specific enrichers implement.
// The EnricherRegistry manages enricher discovery and lookup by language ID.

import type { DocumentSymbol, Diagnostic, Location } from 'vscode-languageserver-protocol';

// ---------------------------------------------------------------------------
// Core enrichment result types
// ---------------------------------------------------------------------------

/** A symbol extracted from a document via LSP textDocument/documentSymbol. */
export interface EnrichedSymbol {
  /** Symbol name (e.g. function name, class name). */
  name: string;
  /** LSP SymbolKind numeric value. */
  kind: number;
  /** Human-readable kind label (e.g. "Function", "Class"). */
  kindLabel: string;
  /** Zero-based start line in the source file. */
  startLine: number;
  /** Zero-based end line in the source file. */
  endLine: number;
  /** Nested child symbols, if any. */
  children?: EnrichedSymbol[];
}

/** A diagnostic reported by the language server. */
export interface EnrichedDiagnostic {
  /** Zero-based line number. */
  line: number;
  /** Severity: 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity: number;
  /** Human-readable severity label. */
  severityLabel: string;
  /** Diagnostic message text. */
  message: string;
  /** Optional diagnostic source (e.g. "typescript", "eslint"). */
  source?: string;
  /** Optional diagnostic code. */
  code?: string | number;
}

/** A definition location resolved via LSP textDocument/definition. */
export interface EnrichedDefinition {
  /** The symbol name that was resolved. */
  symbolName: string;
  /** URI of the file containing the definition. */
  targetUri: string;
  /** Zero-based start line of the definition. */
  targetStartLine: number;
}

/** The full enrichment result for a single document. */
export interface EnrichmentResult {
  /** Absolute file path of the enriched document. */
  filePath: string;
  /** Language identifier (e.g. "typescript", "python"). */
  languageId: string;
  /** Document symbols extracted via textDocument/documentSymbol. */
  symbols: EnrichedSymbol[];
  /** Diagnostics reported by the language server. */
  diagnostics: EnrichedDiagnostic[];
  /** Definition locations resolved for key symbols. */
  definitions: EnrichedDefinition[];
  /** Timestamp (unix epoch seconds) when enrichment was performed. */
  enrichedAt: number;
}

/** Enrichment results indexed by absolute file path. */
export type EnrichmentMap = Map<string, EnrichmentResult>;

// ---------------------------------------------------------------------------
// LspEnricher interface
// ---------------------------------------------------------------------------

/** Configuration for an LSP enricher. */
export interface LspEnricherConfig {
  /** Command to spawn the language server (e.g. "typescript-language-server"). */
  serverCommand: string;
  /** Arguments to pass to the language server. */
  serverArgs: string[];
  /** Maximum concurrent LSP requests. */
  maxConcurrency?: number;
  /** Timeout in milliseconds for individual LSP requests. */
  requestTimeoutMs?: number;
  /** Timeout in milliseconds for server initialization. */
  initTimeoutMs?: number;
}

/**
 * Contract for language-specific LSP enrichers.
 *
 * Each enricher knows how to start a specific language server, send it
 * documents, and extract structured enrichment data. The enricher lifecycle
 * is: initialize() -> enrich() (one or many) -> shutdown().
 */
export interface LspEnricher {
  /** Unique language identifier (e.g. "typescript", "python", "go"). */
  readonly languageId: string;

  /** File extensions this enricher handles (e.g. [".ts", ".tsx"]). */
  readonly fileExtensions: string[];

  /** Configuration for the underlying language server. */
  readonly config: LspEnricherConfig;

  /**
   * Initialize the enricher and its underlying language server.
   * Must be called before enrich(). Idempotent — calling on an already
   * initialized enricher is a no-op.
   *
   * @param workspaceRoot - Root directory of the workspace to analyze.
   */
  initialize(workspaceRoot: string): Promise<void>;

  /**
   * Enrich a single document with LSP-derived data.
   *
   * @param filePath - Absolute path to the file to enrich.
   * @returns Enrichment result, or null if the file could not be enriched.
   */
  enrich(filePath: string): Promise<EnrichmentResult | null>;

  /**
   * Enrich multiple documents. Implementations should respect concurrency
   * limits defined in config.maxConcurrency.
   *
   * @param filePaths - Absolute paths to the files to enrich.
   * @returns Array of enrichment results (nulls filtered out).
   */
  enrichBatch(filePaths: string[]): Promise<EnrichmentResult[]>;

  /**
   * Gracefully shut down the language server. After shutdown, the enricher
   * must be re-initialized before further use. Must be safe to call on an
   * enricher that was never initialized or whose initialize() failed.
   */
  shutdown(): Promise<void>;

  /** Whether the enricher is currently initialized and ready. */
  readonly isReady: boolean;

  /**
   * Resolve the definition location of the token at a 0-based (line, character).
   * Optional — enrichers that support on-demand definition queries implement it.
   *
   * @returns The target file path and 0-based start line, or null.
   */
  resolveDefinition?(
    filePath: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null>;

  /**
   * Resolve a definition against a document that is ALREADY open in the server
   * (no didOpen/didClose). Optional — the enrich/resolveDefinition wrappers use
   * it under a refcounted document lease (Lever B).
   */
  resolveDefinitionOpen?(
    uri: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null>;

  /**
   * Resolve many call-site positions within ONE file under a single warm
   * document open (Lever B). Result order matches the input positions. Optional —
   * the typed-receiver pass prefers this over per-position resolveDefinition so a
   * file opens once instead of once per call-site.
   */
  resolveDefinitionsInFile?(
    filePath: string,
    positions: Array<{ line: number; character: number }>
  ): Promise<Array<{ filePath: string; line: number } | null>>;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** Map LSP SymbolKind numeric values to human-readable labels. */
const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
};

/** Map LSP DiagnosticSeverity numeric values to labels. */
const SEVERITY_LABELS: Record<number, string> = {
  1: 'Error',
  2: 'Warning',
  3: 'Information',
  4: 'Hint',
};

/** Convert an LSP DocumentSymbol to an EnrichedSymbol. */
export function toEnrichedSymbol(symbol: DocumentSymbol): EnrichedSymbol {
  // Some servers (e.g. intelephense on Blade `.blade.php` templates) return
  // symbols without a `range`; fall back to `selectionRange`, then to 0, so a
  // range-less symbol degrades gracefully instead of throwing and failing the
  // whole file's enrichment.
  const range = symbol.range ?? symbol.selectionRange;
  return {
    name: symbol.name,
    kind: symbol.kind,
    kindLabel: SYMBOL_KIND_LABELS[symbol.kind] ?? `Unknown(${symbol.kind})`,
    startLine: range?.start.line ?? 0,
    endLine: range?.end.line ?? 0,
    children: symbol.children?.map(toEnrichedSymbol),
  };
}

/** Convert an LSP Diagnostic to an EnrichedDiagnostic. */
export function toEnrichedDiagnostic(diagnostic: Diagnostic): EnrichedDiagnostic {
  const severity = diagnostic.severity ?? 1;
  return {
    line: diagnostic.range.start.line,
    severity,
    severityLabel: SEVERITY_LABELS[severity] ?? `Unknown(${severity})`,
    message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
    source: diagnostic.source,
    code:
      diagnostic.code !== undefined
        ? typeof diagnostic.code === 'object'
          ? String(diagnostic.code)
          : diagnostic.code
        : undefined,
  };
}

/** Convert an LSP Location to an EnrichedDefinition. */
export function toEnrichedDefinition(symbolName: string, location: Location): EnrichedDefinition {
  return {
    symbolName,
    targetUri: location.uri,
    targetStartLine: location.range.start.line,
  };
}

// ---------------------------------------------------------------------------
// EnricherRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for managing LspEnricher instances.
 *
 * Enrichers are registered by language ID and can be looked up by language ID
 * or file extension. The registry does not own the enricher lifecycle — callers
 * are responsible for calling initialize() and shutdown().
 */
export class EnricherRegistry {
  private readonly enrichers = new Map<string, LspEnricher>();
  private readonly extensionIndex = new Map<string, string>();

  /**
   * Register an enricher. Throws if an enricher for the same language ID
   * is already registered.
   */
  register(enricher: LspEnricher): void {
    if (this.enrichers.has(enricher.languageId)) {
      throw new Error(
        `Enricher already registered for language "${enricher.languageId}". ` +
          'Unregister the existing enricher first.'
      );
    }

    this.enrichers.set(enricher.languageId, enricher);

    for (const ext of enricher.fileExtensions) {
      const normalized = ext.startsWith('.') ? ext : `.${ext}`;
      this.extensionIndex.set(normalized, enricher.languageId);
    }
  }

  /** Route an on-demand definition query to the enricher for the file's language. */
  async resolveDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null> {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const languageId = this.extensionIndex.get(ext);
    if (!languageId) return null;
    const enricher = this.enrichers.get(languageId);
    if (!enricher?.isReady || !enricher.resolveDefinition) return null;
    return enricher.resolveDefinition(filePath, line, character);
  }

  /**
   * Route a batch of call-site positions for one file to its enricher, opening
   * the document once (Lever B). Falls back to per-position resolveDefinition
   * when the enricher does not implement the warm batch primitive. Result order
   * matches the input positions.
   */
  async resolveDefinitionsInFile(
    filePath: string,
    positions: Array<{ line: number; character: number }>
  ): Promise<Array<{ filePath: string; line: number } | null>> {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const languageId = this.extensionIndex.get(ext);
    if (!languageId) return positions.map(() => null);
    const enricher = this.enrichers.get(languageId);
    if (!enricher?.isReady) return positions.map(() => null);
    if (enricher.resolveDefinitionsInFile) {
      return enricher.resolveDefinitionsInFile(filePath, positions);
    }
    if (enricher.resolveDefinition) {
      const resolve = enricher.resolveDefinition.bind(enricher);
      const out: Array<{ filePath: string; line: number } | null> = [];
      for (const p of positions) {
        out.push(await resolve(filePath, p.line, p.character));
      }
      return out;
    }
    return positions.map(() => null);
  }

  /** Unregister an enricher by language ID. Returns true if it was present. */
  unregister(languageId: string): boolean {
    const enricher = this.enrichers.get(languageId);
    if (!enricher) return false;

    for (const ext of enricher.fileExtensions) {
      const normalized = ext.startsWith('.') ? ext : `.${ext}`;
      if (this.extensionIndex.get(normalized) === languageId) {
        this.extensionIndex.delete(normalized);
      }
    }

    this.enrichers.delete(languageId);
    return true;
  }

  /** Get an enricher by language ID, or undefined if not registered. */
  get(languageId: string): LspEnricher | undefined {
    return this.enrichers.get(languageId);
  }

  /**
   * Find the enricher that handles the given file extension.
   *
   * @param extension - File extension including the dot (e.g. ".ts").
   * @returns The matching enricher, or undefined.
   */
  getByExtension(extension: string): LspEnricher | undefined {
    const normalized = extension.startsWith('.') ? extension : `.${extension}`;
    const languageId = this.extensionIndex.get(normalized);
    return languageId ? this.enrichers.get(languageId) : undefined;
  }

  /** Get all registered language IDs. */
  getLanguageIds(): string[] {
    return Array.from(this.enrichers.keys());
  }

  /** Get all registered enrichers. */
  getAll(): LspEnricher[] {
    return Array.from(this.enrichers.values());
  }

  /** Get all file extensions that have registered enrichers. */
  getSupportedExtensions(): string[] {
    return Array.from(this.extensionIndex.keys());
  }

  /** Number of registered enrichers. */
  get size(): number {
    return this.enrichers.size;
  }

  /**
   * Shut down every registered enricher, ready or not: one whose initialize()
   * failed part-way is not ready but may still hold resources, and shutdown()
   * is a no-op for an enricher that holds none.
   * Errors during individual shutdowns are collected and thrown as an
   * aggregate error after all enrichers have been attempted.
   */
  async shutdownAll(): Promise<void> {
    const errors: Array<{ languageId: string; error: unknown }> = [];

    for (const enricher of this.enrichers.values()) {
      try {
        await enricher.shutdown();
      } catch (error) {
        errors.push({ languageId: enricher.languageId, error });
      }
    }

    if (errors.length > 0) {
      const messages = errors.map(
        (e) => `${e.languageId}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
      );
      throw new Error(`Failed to shut down enrichers:\n  ${messages.join('\n  ')}`);
    }
  }
}
