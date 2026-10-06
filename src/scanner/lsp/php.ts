// PHP LSP Enricher using intelephense.
//
// Provides document symbol extraction, reference lookups, and type hierarchy
// queries for PHP files. Enrichment results are structured for storage in
// metadata.lsp fields on indexed entities.

import { readFileSync } from 'fs';
import { createRunStorage, removeRunStorage } from './run-storage.js';
import { LspEmptyAnswerError, phpSourceDeclaresSymbols } from './empty-answer.js';
import { pathToFileURL, fileURLToPath } from 'url';
import type { DocumentSymbol, Location, TypeHierarchyItem } from 'vscode-languageserver-protocol';
import { LspClient } from './client.js';
import { LspRequester, type LspRequestIssue } from './requester.js';
import type {
  LspEnricher,
  LspEnricherConfig,
  EnrichmentResult,
  EnrichedDefinition,
} from './index.js';
import { stableLocationUri, symbolPosition, toEnrichedSymbol } from './index.js';
import {
  bladeDeclarations,
  namespaceOpensBlock,
  phpDeclarations,
} from '../identity/php-declarations.js';

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
/**
 * The settings intelephense asks for under `workspace/configuration`. Pinned rather than left to
 * the server's defaults, so the indexed file set is the same for every installed version.
 */
const INTELEPHENSE_SETTINGS = {
  files: {
    exclude: [
      '**/.git/**',
      '**/.svn/**',
      '**/.hg/**',
      '**/node_modules/**',
      '**/bower_components/**',
      '**/.lux/**',
      '**/vendor/**/{Tests,tests}/**',
      '**/vendor/**/vendor/**',
    ],
  },
} as const;

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
  private requester: LspRequester | null = null;
  /** Root the server was started on; locations outside it are stored in a stable form. */
  private workspaceRoot: string | undefined;
  private _isReady = false;
  private _indexIncomplete = false;
  /** This run's intelephense storage; removed at shutdown. */
  private storagePath: string | undefined;
  private readonly maxRefLocations: number;
  private readonly _emptyAnswers = { reasked: 0, recovered: 0 };

  constructor(options?: PhpLspEnricherOptions) {
    this.config = {
      serverCommand: options?.serverCommand ?? 'intelephense',
      serverArgs: options?.serverArgs ?? ['--stdio'],
      requestTimeoutMs: options?.requestTimeoutMs ?? 15_000,
      initTimeoutMs: options?.initTimeoutMs ?? 60_000,
    };
    this.maxRefLocations = options?.maxReferenceLocations ?? MAX_REFERENCE_LOCATIONS;
  }

  /** False once the server process has died, so callers stop treating it as available. */
  get isReady(): boolean {
    return this._isReady && this.client?.initialized === true;
  }

  get indexIncomplete(): boolean {
    return this._indexIncomplete;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(workspaceRoot: string): Promise<void> {
    if (this._isReady) return;

    this.workspaceRoot = workspaceRoot;
    const rootUri = pathToFileURL(workspaceRoot).toString();
    // intelephense keeps its workspace index in a storage directory (by default
    // $TMPDIR/intelephense/<workspace hash>) and starts from it on the next run, so answers depended
    // on what an earlier run left there; a stale state stalled indexing outright. Each run gets a
    // fresh directory, removed at shutdown or process exit (lsp/run-storage.ts): re-indexing costs
    // seconds, and the index is then a function of the workspace alone. A directory under .lux/ would persist across rebuilds, which
    // is the dependence being removed.
    this.storagePath = createRunStorage('lux-intelephense-');
    this._indexIncomplete = false;

    this.client = new LspClient({
      serverCommand: this.config.serverCommand,
      serverLabel: this.languageId,
      serverArgs: this.config.serverArgs,
      cwd: workspaceRoot,
      requestTimeoutMs: this.config.requestTimeoutMs,
      initTimeoutMs: this.config.initTimeoutMs,
      configuration: (section) => (section === 'intelephense' ? INTELEPHENSE_SETTINGS : undefined),
    });
    this.requester = new LspRequester(this.client);

    // intelephense indexes the workspace in the background after `initialized`. Definitions and
    // references asked for before it finishes see a partial index, so enrichment waits for
    // indexingEnded, bounded by the initialization timeout.
    let indexingEnded!: () => void;
    const indexed = new Promise<void>((resolve) => (indexingEnded = resolve));
    this.client.onNotification('indexingEnded', () => indexingEnded());

    try {
      await this.client.initialize({
        processId: process.pid,
        rootUri,
        capabilities: {
          workspace: { configuration: true },
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
        initializationOptions: { storagePath: this.storagePath, clearCache: true },
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
      });
    } catch (error) {
      this.removeStorage();
      throw error;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      indexed.then(() => 'indexed' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.config.initTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this._indexIncomplete = outcome === 'timeout';

    this._isReady = true;
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.shutdown();
    } finally {
      this.client = null;
      this.requester = null;
      this._isReady = false;
      this.removeStorage();
    }
  }

  /** Error answers recorded since the last call (see lsp/requester.ts). */
  drainRequestIssues(): LspRequestIssue[] {
    return this.requester?.drain() ?? [];
  }

  private removeStorage(): void {
    if (!this.storagePath) return;
    removeRunStorage(this.storagePath);
    this.storagePath = undefined;
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
    return this.withSecondVisit(() =>
      this.client!.withDocument(uri, 'php', fileContent, () =>
        this.enrichOpen(uri, filePath, fileContent)
      )
    );
  }

  /**
   * Run a visit of one document; if an answer in it was not believable, run it once more, with
   * the document opened afresh. A second unbelievable answer is thrown, and the caller records
   * the file: it is never stored as a file without symbols or a call without a target.
   */
  private async withSecondVisit<T>(visit: () => Promise<T>): Promise<T> {
    try {
      return await visit();
    } catch (error) {
      if (!(error instanceof LspEmptyAnswerError)) throw error;
      this._emptyAnswers.reasked++;
      const result = await visit();
      this._emptyAnswers.recovered++;
      return result;
    }
  }

  /**
   * Visits with an answer that was not believable (documentSymbol or definition), and how many a
   * second visit settled.
   */
  get emptyAnswers(): { reasked: number; recovered: number } {
    return { ...this._emptyAnswers };
  }

  /** Enrich a document that is ALREADY open (no didOpen/didClose). */
  async enrichOpen(
    uri: string,
    filePath: string,
    fileContent?: string
  ): Promise<PhpEnrichmentResult | null> {
    // 1. Get document symbols. A namespace statement is not a declaration: each declaration takes
    //    its namespace, and those of a `namespace X { … }` block are lifted to the top level, so
    //    references and type hierarchy below are asked for them like any other.
    //    In a Blade template only the PHP variables are declarations (identity/php-declarations.ts).
    const reported = bladeDeclarations(
      filePath,
      (await this.getDocumentSymbols(uri, filePath, fileContent)).map(withStableAnonymousNames)
    );
    const declarations = phpDeclarations(reported, (namespace) =>
      namespaceOpensBlock(fileContent, symbolPosition(namespace)?.line ?? 0)
    );
    const symbols = declarations.map((declaration) => declaration.symbol);
    const enrichedSymbols = declarations.map(({ symbol, namespace }) => ({
      ...toEnrichedSymbol(symbol),
      ...(namespace ? { namespace } : {}),
    }));

    // 2. Get references for top-level referenceable symbols (REQ-5: KEPT)
    const references = await this.getSymbolReferences(uri, filePath, symbols);

    // 3. Get type hierarchy for classes and interfaces (REQ-5: KEPT)
    const typeHierarchy = await this.getTypeHierarchy(uri, filePath, symbols);

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
    return this.withSecondVisit(() =>
      this.client!.withDocument(uri, 'php', content, () =>
        this.resolveDefinitionOpen(uri, line, character)
      )
    );
  }

  /** Resolve a definition against an ALREADY-open document. */
  async resolveDefinitionOpen(
    uri: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null> {
    const method = 'textDocument/definition';
    const result = await this.requester!.ask<Location | Location[] | null>(
      { filePath: fileURLToPath(uri), stage: 'calls' },
      method,
      'definitionProvider',
      { textDocument: { uri }, position: { line, character } }
    );
    // intelephense answers `[]` where an open document has no target, and `null` only for a
    // document it does not hold open.
    if (result === null) throw new LspEmptyAnswerError(method, 'null');
    const loc = Array.isArray(result) ? result[0] : result;
    if (!loc) return null;
    return { filePath: fileURLToPath(loc.uri), line: loc.range.start.line };
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
    return this.withSecondVisit(() =>
      this.client!.withDocument(uri, 'php', content, async () => {
        const out: Array<{ filePath: string; line: number } | null> = [];
        for (const p of positions) {
          out.push(await this.resolveDefinitionOpen(uri, p.line, p.character));
        }
        return out;
      })
    );
  }

  async enrichBatch(filePaths: string[]): Promise<PhpEnrichmentResult[]> {
    const results: PhpEnrichmentResult[] = [];

    // One file at a time, so no more than one document is open in intelephense.
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

  /**
   * The document's symbols. intelephense answers `[]` for an open document with no symbols and
   * `null` for a document it does not hold open, so `null` here is never "no symbols"; and `[]`
   * for a source that declares a class or function is the answer it gives when the document is
   * closed under the request. Both are thrown, not returned as an empty list.
   */
  private async getDocumentSymbols(
    uri: string,
    filePath: string,
    fileContent?: string
  ): Promise<DocumentSymbol[]> {
    const method = 'textDocument/documentSymbol';
    const result = await this.requester!.ask<DocumentSymbol[] | null>(
      { filePath, stage: 'symbols' },
      method,
      'documentSymbolProvider',
      { textDocument: { uri } }
    );
    // Not asked, or an error answer the requester has recorded.
    if (result === undefined) return [];
    if (result === null) throw new LspEmptyAnswerError(method, 'null');
    if (
      result.length === 0 &&
      fileContent !== undefined &&
      // A Blade template's markup is not PHP the AST can vouch for.
      !filePath.endsWith('.blade.php') &&
      (await phpSourceDeclaresSymbols(filePath, fileContent))
    ) {
      throw new LspEmptyAnswerError(method, 'empty');
    }
    return result;
  }

  private async getSymbolReferences(
    uri: string,
    filePath: string,
    symbols: DocumentSymbol[]
  ): Promise<SymbolReferences[]> {
    const results: SymbolReferences[] = [];
    const topLevelSymbols = symbols.filter((s) => REFERENCEABLE_KINDS.has(s.kind));

    for (const symbol of topLevelSymbols) {
      const position = symbolPosition(symbol);
      if (!position) continue; // a symbol the server placed nowhere cannot be asked about

      // intelephense answers [] for an unreferenced symbol and for a document it does not hold
      // open alike, so an empty answer here cannot be checked.
      const locations = await this.requester!.ask<Location[] | null>(
        { filePath, stage: 'symbols' },
        'textDocument/references',
        'referencesProvider',
        {
          textDocument: { uri },
          position: { line: position.line, character: position.character },
          context: { includeDeclaration: false },
        }
      );

      if (locations && locations.length > 0) {
        results.push({
          symbolName: symbol.name,
          symbolKind: symbol.kind,
          referenceCount: locations.length,
          // intelephense returns references in a different order from run to run; the kept
          // prefix is chosen from them in position order instead.
          referenceLocations: [...locations]
            .sort(compareLocations)
            .slice(0, this.maxRefLocations)
            .map((loc) => ({
              uri: stableLocationUri(loc.uri, this.workspaceRoot),
              line: loc.range.start.line,
            })),
        });
      }
    }

    return results;
  }

  private async getTypeHierarchy(
    uri: string,
    filePath: string,
    symbols: DocumentSymbol[]
  ): Promise<TypeHierarchyEntry[]> {
    const results: TypeHierarchyEntry[] = [];
    const typeSymbols = symbols.filter((s) => TYPE_HIERARCHY_KINDS.has(s.kind));

    for (const symbol of typeSymbols) {
      const position = symbolPosition(symbol);
      if (!position) continue; // a symbol the server placed nowhere cannot be asked about

      // Prepare type hierarchy at the symbol's position
      const items = await this.requester!.ask<TypeHierarchyItem[] | null>(
        { filePath, stage: 'symbols' },
        'textDocument/prepareTypeHierarchy',
        'typeHierarchyProvider',
        {
          textDocument: { uri },
          position: { line: position.line, character: position.character },
        }
      );

      if (!items || items.length === 0) continue;

      const item = items[0];
      const supertypes = await this.relatedTypes(filePath, 'typeHierarchy/supertypes', item);
      const subtypes = await this.relatedTypes(filePath, 'typeHierarchy/subtypes', item);

      results.push({
        name: item.name,
        kind: item.kind,
        uri: stableLocationUri(item.uri, this.workspaceRoot),
        startLine: item.range.start.line,
        supertypes,
        subtypes,
      });
    }

    return results;
  }

  private async relatedTypes(
    filePath: string,
    method: 'typeHierarchy/supertypes' | 'typeHierarchy/subtypes',
    item: TypeHierarchyItem
  ): Promise<Array<{ name: string; uri: string; kind: number }>> {
    const related = await this.requester!.ask<TypeHierarchyItem[] | null>(
      { filePath, stage: 'symbols' },
      method,
      'typeHierarchyProvider',
      { item }
    );
    return (related ?? []).map((type) => ({
      name: type.name,
      uri: stableLocationUri(type.uri, this.workspaceRoot),
      kind: type.kind,
    }));
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

function compareLocations(a: Location, b: Location): number {
  if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
  return (
    a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
  );
}

/**
 * intelephense's name for an anonymous class: `*` and a random number in hex, unpadded, so of any
 * length. No declared PHP name starts with `*`.
 */
const ANONYMOUS_CLASS_NAME = /^\*[0-9a-f]+$/;

/**
 * intelephense names an anonymous class `*<random hex>`, a new name every session. Name it by
 * where it starts instead, so the same file yields the same symbols and references.
 */
export function withStableAnonymousNames(symbol: DocumentSymbol): DocumentSymbol {
  const start = (symbol.range ?? symbol.selectionRange)?.start.line ?? 0;
  return {
    ...symbol,
    name: ANONYMOUS_CLASS_NAME.test(symbol.name) ? `*anonymous@${start}` : symbol.name,
    ...(symbol.children ? { children: symbol.children.map(withStableAnonymousNames) } : {}),
  };
}
