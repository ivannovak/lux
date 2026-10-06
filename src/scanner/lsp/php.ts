// PHP LSP Enricher using intelephense.
//
// Provides document symbol extraction, reference lookups, and type hierarchy
// queries for PHP files. Enrichment results are structured for storage in
// metadata.lsp fields on indexed entities.

import { readFileSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import type { DocumentSymbol, Location, TypeHierarchyItem } from 'vscode-languageserver-protocol';
import { LspClient } from './client.js';
import type {
  LspEnricher,
  LspEnricherConfig,
  EnrichmentResult,
  EnrichedDefinition,
} from './index.js';
import { toEnrichedSymbol } from './index.js';

// ---------------------------------------------------------------------------
// PHP-specific enrichment types (stored in metadata.lsp)
// ---------------------------------------------------------------------------

/** Reference information for a symbol, gathered via textDocument/references. */
export interface SymbolReferences {
  /** The symbol being referenced. */
  symbolName: string;
  /** LSP SymbolKind numeric value. */
  symbolKind: number;
  /** Number of references found across the workspace. */
  referenceCount: number;
  /** Reference locations (capped to avoid bloat). */
  referenceLocations: Array<{ uri: string; line: number }>;
}

/** A type hierarchy entry with resolved supertypes and subtypes. */
export interface TypeHierarchyEntry {
  /** Class/interface name. */
  name: string;
  /** LSP SymbolKind numeric value. */
  kind: number;
  /** File URI where this type is defined. */
  uri: string;
  /** Zero-based start line. */
  startLine: number;
  /** Resolved supertypes (parent classes, implemented interfaces). */
  supertypes: Array<{ name: string; uri: string; kind: number }>;
  /** Resolved subtypes (child classes, implementors). */
  subtypes: Array<{ name: string; uri: string; kind: number }>;
}

/** Extended enrichment result with PHP-specific fields for metadata.lsp. */
export interface PhpEnrichmentResult extends EnrichmentResult {
  /** Reference data for top-level symbols. */
  references: SymbolReferences[];
  /** Type hierarchy for classes and interfaces. */
  typeHierarchy: TypeHierarchyEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of reference locations to store per symbol. */
const MAX_REFERENCE_LOCATIONS = 50;

/** SymbolKind values for types that participate in type hierarchy. */
const TYPE_HIERARCHY_KINDS: Set<number> = new Set([
  5, // Class
  11, // Interface
]);

/** SymbolKind values for symbols worth gathering references for. */
const REFERENCEABLE_KINDS: Set<number> = new Set([
  5, // Class
  6, // Method
  11, // Interface
  12, // Function
  14, // Constant
]);

// ---------------------------------------------------------------------------
// PhpLspEnricher
// ---------------------------------------------------------------------------

/** Optional overrides for PhpLspEnricher behavior. */
export interface PhpLspEnricherOptions {
  /** Override the intelephense command (default: "intelephense"). */
  serverCommand?: string;
  /** Override server arguments (default: ["--stdio"]). */
  serverArgs?: string[];
  /** Maximum concurrent LSP requests (default: 4). */
  maxConcurrency?: number;
  /** Per-request timeout in ms (default: 15000). */
  requestTimeoutMs?: number;
  /** Initialization timeout in ms (default: 60000). */
  initTimeoutMs?: number;
  /** Maximum reference locations to store per symbol (default: 50). */
  maxReferenceLocations?: number;
}

/**
 * LSP enricher for PHP files using the intelephense language server.
 *
 * Performs three categories of enrichment:
 * 1. **Document symbols** — full symbol tree via textDocument/documentSymbol
 * 2. **References** — reference counts and locations for top-level symbols
 *    via textDocument/references
 * 3. **Type hierarchy** — supertype/subtype relationships for classes and
 *    interfaces via textDocument/prepareTypeHierarchy + typeHierarchy/*
 *
 * The enrichment results are structured for storage in `metadata.lsp` fields
 * on indexed database entities.
 */
export class PhpLspEnricher implements LspEnricher {
  readonly languageId = 'php';
  readonly fileExtensions = ['.php', '.phtml'];
  readonly config: LspEnricherConfig;

  private client: LspClient | null = null;
  private _isReady = false;
  private readonly maxRefLocations: number;

  constructor(options?: PhpLspEnricherOptions) {
    this.config = {
      serverCommand: options?.serverCommand ?? 'intelephense',
      serverArgs: options?.serverArgs ?? ['--stdio'],
      maxConcurrency: options?.maxConcurrency ?? 4,
      requestTimeoutMs: options?.requestTimeoutMs ?? 15_000,
      initTimeoutMs: options?.initTimeoutMs ?? 60_000,
    };
    this.maxRefLocations = options?.maxReferenceLocations ?? MAX_REFERENCE_LOCATIONS;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(workspaceRoot: string): Promise<void> {
    if (this._isReady) return;

    const rootUri = pathToFileURL(workspaceRoot).toString();

    this.client = new LspClient({
      serverCommand: this.config.serverCommand,
      serverArgs: this.config.serverArgs,
      cwd: workspaceRoot,
      maxConcurrency: this.config.maxConcurrency,
      requestTimeoutMs: this.config.requestTimeoutMs,
      initTimeoutMs: this.config.initTimeoutMs,
    });

    await this.client.initialize({
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          references: {},
          typeHierarchy: {
            dynamicRegistration: false,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    });

    this._isReady = true;
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.shutdown();
    } finally {
      this.client = null;
      this._isReady = false;
    }
  }

  // -------------------------------------------------------------------------
  // Enrichment
  // -------------------------------------------------------------------------

  async enrich(filePath: string): Promise<PhpEnrichmentResult | null> {
    if (!this._isReady || !this.client) {
      throw new Error('PhpLspEnricher is not initialized. Call initialize() first.');
    }

    const uri = pathToFileURL(filePath).toString();
    let fileContent: string;

    try {
      fileContent = readFileSync(filePath, 'utf-8');
    } catch {
      // lux-intentional-swallow: an unreadable file yields no LSP data; the scan reports unreadable files itself.
      return null;
    }

    // Route open/close through the refcounted lease so bounded-parallel
    // enrichment (Lever B) never double-opens or closes a mid-request document.
    return this.client.withDocument(uri, 'php', fileContent, () =>
      this.enrichOpen(uri, filePath, fileContent)
    );
  }

  /** Enrich a document that is ALREADY open (no didOpen/didClose). */
  async enrichOpen(
    uri: string,
    filePath: string,
    fileContent: string
  ): Promise<PhpEnrichmentResult | null> {
    // 1. Get document symbols
    const symbols = await this.getDocumentSymbols(uri);
    const enrichedSymbols = symbols.map(toEnrichedSymbol);

    // 2. Get references for top-level referenceable symbols (REQ-5: KEPT)
    const references = await this.getSymbolReferences(uri, fileContent, symbols);

    // 3. Get type hierarchy for classes and interfaces (REQ-5: KEPT)
    const typeHierarchy = await this.getTypeHierarchy(uri, fileContent, symbols);

    // 4. Collect definitions from reference data
    const definitions = this.extractDefinitions(references);

    return {
      filePath,
      languageId: 'php',
      symbols: enrichedSymbols,
      diagnostics: [],
      definitions,
      references,
      typeHierarchy,
      enrichedAt: Math.floor(Date.now() / 1000),
    };
  }

  async resolveDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null> {
    if (!this._isReady || !this.client) return null;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      // lux-intentional-swallow: an unreadable file yields no LSP data; the scan reports unreadable files itself.
      return null;
    }
    const uri = pathToFileURL(filePath).toString();
    return this.client.withDocument(uri, 'php', content, () =>
      this.resolveDefinitionOpen(uri, line, character)
    );
  }

  /** Resolve a definition against an ALREADY-open document. */
  async resolveDefinitionOpen(
    uri: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null> {
    try {
      const result = await this.client!.request<Location | Location[] | null>(
        'textDocument/definition',
        { textDocument: { uri }, position: { line, character } }
      );
      const loc = Array.isArray(result) ? result[0] : result;
      if (!loc) return null;
      return { filePath: fileURLToPath(loc.uri), line: loc.range.start.line };
    } catch {
      // lux-intentional-swallow: a failed LSP request leaves this file or symbol without that data; failures are not reported per request.
      return null;
    }
  }

  /**
   * Resolve every call-site position in one file under a SINGLE warm document
   * open (Lever B). The typed-receiver pass (general.ts step 8b) calls this so a
   * file with K member-calls opens once instead of K times.
   */
  async resolveDefinitionsInFile(
    filePath: string,
    positions: Array<{ line: number; character: number }>
  ): Promise<Array<{ filePath: string; line: number } | null>> {
    if (!this._isReady || !this.client) return positions.map(() => null);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      // lux-intentional-swallow: an unreadable file yields no LSP data; the scan reports unreadable files itself.
      return positions.map(() => null);
    }
    const uri = pathToFileURL(filePath).toString();
    return this.client.withDocument(uri, 'php', content, async () => {
      const out: Array<{ filePath: string; line: number } | null> = [];
      for (const p of positions) {
        out.push(await this.resolveDefinitionOpen(uri, p.line, p.character));
      }
      return out;
    });
  }

  async enrichBatch(filePaths: string[]): Promise<PhpEnrichmentResult[]> {
    const results: PhpEnrichmentResult[] = [];

    // Process sequentially — the LspClient's internal semaphore handles
    // concurrency for individual LSP requests within each enrichment.
    // Sequential file processing avoids overwhelming intelephense with
    // too many open documents.
    for (const filePath of filePaths) {
      const result = await this.enrich(filePath);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // LSP queries
  // -------------------------------------------------------------------------

  private async getDocumentSymbols(uri: string): Promise<DocumentSymbol[]> {
    try {
      const result = await this.client!.request<DocumentSymbol[] | null>(
        'textDocument/documentSymbol',
        { textDocument: { uri } }
      );
      return result ?? [];
    } catch {
      // lux-intentional-swallow: a failed LSP request leaves this file or symbol without that data; failures are not reported per request.
      return [];
    }
  }

  private async getSymbolReferences(
    uri: string,
    _fileContent: string,
    symbols: DocumentSymbol[]
  ): Promise<SymbolReferences[]> {
    const results: SymbolReferences[] = [];
    const topLevelSymbols = symbols.filter((s) => REFERENCEABLE_KINDS.has(s.kind));

    for (const symbol of topLevelSymbols) {
      try {
        const position = symbol.selectionRange.start;

        const locations = await this.client!.request<Location[] | null>('textDocument/references', {
          textDocument: { uri },
          position: { line: position.line, character: position.character },
          context: { includeDeclaration: false },
        });

        if (locations && locations.length > 0) {
          results.push({
            symbolName: symbol.name,
            symbolKind: symbol.kind,
            referenceCount: locations.length,
            referenceLocations: locations.slice(0, this.maxRefLocations).map((loc) => ({
              uri: loc.uri,
              line: loc.range.start.line,
            })),
          });
        }
      } catch {
        // lux-intentional-swallow: a failed LSP request leaves this file or symbol without that data; failures are not reported per request.
        // Skip symbols that fail reference lookup
      }
    }

    return results;
  }

  private async getTypeHierarchy(
    uri: string,
    _fileContent: string,
    symbols: DocumentSymbol[]
  ): Promise<TypeHierarchyEntry[]> {
    const results: TypeHierarchyEntry[] = [];
    const typeSymbols = symbols.filter((s) => TYPE_HIERARCHY_KINDS.has(s.kind));

    for (const symbol of typeSymbols) {
      try {
        const position = symbol.selectionRange.start;

        // Prepare type hierarchy at the symbol's position
        const items = await this.client!.request<TypeHierarchyItem[] | null>(
          'textDocument/prepareTypeHierarchy',
          {
            textDocument: { uri },
            position: { line: position.line, character: position.character },
          }
        );

        if (!items || items.length === 0) continue;

        const item = items[0];

        // Resolve supertypes
        const supertypes = await this.resolveSupertypes(item);

        // Resolve subtypes
        const subtypes = await this.resolveSubtypes(item);

        results.push({
          name: item.name,
          kind: item.kind,
          uri: item.uri,
          startLine: item.range.start.line,
          supertypes,
          subtypes,
        });
      } catch {
        // lux-intentional-swallow: a failed LSP request leaves this file or symbol without that data; failures are not reported per request.
        // Skip symbols that fail type hierarchy resolution
      }
    }

    return results;
  }

  private async resolveSupertypes(
    item: TypeHierarchyItem
  ): Promise<Array<{ name: string; uri: string; kind: number }>> {
    try {
      const supertypes = await this.client!.request<TypeHierarchyItem[] | null>(
        'typeHierarchy/supertypes',
        { item }
      );

      return (supertypes ?? []).map((st) => ({
        name: st.name,
        uri: st.uri,
        kind: st.kind,
      }));
    } catch {
      // lux-intentional-swallow: a failed LSP request leaves this file or symbol without that data; failures are not reported per request.
      return [];
    }
  }

  private async resolveSubtypes(
    item: TypeHierarchyItem
  ): Promise<Array<{ name: string; uri: string; kind: number }>> {
    try {
      const subtypes = await this.client!.request<TypeHierarchyItem[] | null>(
        'typeHierarchy/subtypes',
        { item }
      );

      return (subtypes ?? []).map((st) => ({
        name: st.name,
        uri: st.uri,
        kind: st.kind,
      }));
    } catch {
      // lux-intentional-swallow: a failed LSP request leaves this file or symbol without that data; failures are not reported per request.
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Extract definition-style entries from reference data.
   * When a symbol has references outside its own file, we treat the
   * symbol's own location as a "definition" that other files reference.
   */
  private extractDefinitions(references: SymbolReferences[]): EnrichedDefinition[] {
    const definitions: EnrichedDefinition[] = [];

    for (const ref of references) {
      const firstRef = ref.referenceLocations[0];
      if (firstRef) {
        definitions.push({
          symbolName: ref.symbolName,
          targetUri: firstRef.uri,
          targetStartLine: firstRef.line,
        });
      }
    }

    return definitions;
  }
}
