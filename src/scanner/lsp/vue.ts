// Vue Single-File Component LSP Enricher using @vue/language-server (Volar).
//
// Provides document symbol extraction and definition lookups for Vue SFC (.vue)
// files. Without this enricher a repository's .vue files are indexed as file
// nodes carrying zero symbols, so structural queries over a Vue frontend return
// empty rather than wrong — a silent gap that looks identical to a clean result.
//
// Enrichment results are structured for storage in metadata.lsp fields on
// indexed entities, identically to the TypeScript and PHP enrichers.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { DocumentSymbol, Location } from 'vscode-languageserver-protocol';
import { LspClient } from './client.js';
import { LspRequester, type LspRequestIssue } from './requester.js';
import type {
  LspEnricher,
  LspEnricherConfig,
  EnrichmentResult,
  EnrichedDefinition,
} from './index.js';
import { stableLocationUri, symbolPosition, toEnrichedSymbol } from './index.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Optional overrides for VueLspEnricher behavior. */
export interface VueLspEnricherOptions {
  /** Override the vue-language-server command (default: "vue-language-server"). */
  serverCommand?: string;
  /** Override server arguments (default: ["--stdio"]). */
  serverArgs?: string[];
  /** Per-request timeout in ms (default: 15000). */
  requestTimeoutMs?: number;
  /**
   * Path to the TypeScript `lib` directory Volar should load.
   *
   * Defaults to `<workspaceRoot>/node_modules/typescript/lib`. Volar returns an
   * EMPTY document-symbol result — not an error — when it cannot load a
   * TypeScript program, so a wrong or missing path degrades to silence.
   */
  tsdk?: string;
  /**
   * Initialization timeout in ms (default: 120000).
   *
   * Higher than the TypeScript enricher's default on purpose: Volar loads a
   * TypeScript program for the whole workspace before it answers `initialize`,
   * which on a large repository takes appreciably longer than tsserver's own
   * startup.
   */
  initTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// VueLspEnricher
// ---------------------------------------------------------------------------

/**
 * LSP enricher for Vue Single-File Components using @vue/language-server.
 *
 * Performs two categories of enrichment:
 * 1. **Document symbols** — full symbol tree via textDocument/documentSymbol
 * 2. **Definitions** — definition locations for top-level symbols
 *
 * Symbols are emitted with `languageId: 'vue'`, which is the language id the
 * association propagation pass already filters on when it walks script-bearing
 * entries, so materialized nodes are picked up without further routing.
 */
export class VueLspEnricher implements LspEnricher {
  readonly languageId = 'vue';
  readonly fileExtensions = ['.vue'];
  readonly config: LspEnricherConfig;

  private client: LspClient | null = null;
  private requester: LspRequester | null = null;
  /** Root the server was started on; locations outside it are stored in a stable form. */
  private workspaceRoot: string | undefined;
  private _isReady = false;
  private readonly tsdkOverride?: string;

  constructor(options?: VueLspEnricherOptions) {
    this.tsdkOverride = options?.tsdk;
    this.config = {
      serverCommand: options?.serverCommand ?? 'vue-language-server',
      serverArgs: options?.serverArgs ?? ['--stdio'],
      requestTimeoutMs: options?.requestTimeoutMs ?? 15_000,
      initTimeoutMs: options?.initTimeoutMs ?? 120_000,
    };
  }

  /** False once the server process has died, so callers stop treating it as available. */
  get isReady(): boolean {
    return this._isReady && this.client?.initialized === true;
  }

  /** Why the server can no longer be asked anything, or null while it can (see LspEnricher). */
  get lostReason(): string | null {
    return this.client?.lostReason ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(workspaceRoot: string): Promise<void> {
    if (this._isReady) return;

    this.workspaceRoot = workspaceRoot;
    const rootUri = pathToFileURL(workspaceRoot).toString();

    this.client = new LspClient({
      serverCommand: this.config.serverCommand,
      serverLabel: this.languageId,
      serverArgs: this.config.serverArgs,
      cwd: workspaceRoot,
      requestTimeoutMs: this.config.requestTimeoutMs,
      initTimeoutMs: this.config.initTimeoutMs,
    });
    this.requester = new LspRequester(this.client);

    await this.client.initialize({
      processId: process.pid,
      rootUri,
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          definition: {},
          references: {},
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
      },
      // Volar resolves its TypeScript program from the workspace folders. It
      // will answer `initialize` without them, but returns no symbols for a
      // component whose script block imports across the project.
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      initializationOptions: {
        // REQUIRED. Without a tsdk Volar answers `initialize` normally and then
        // returns an empty result for every documentSymbol request — a silent
        // zero rather than a failure.
        typescript: { tsdk: this.resolveTsdk(workspaceRoot) },
        // Volar's default is hybrid mode, where it delegates to a companion
        // tsserver process driven by @vue/typescript-plugin. We run it
        // standalone, so hybrid mode must be off.
        vue: { hybridMode: false },
      },
    });

    this._isReady = true;
  }

  /** Error answers recorded since the last call (see lsp/requester.ts). */
  drainRequestIssues(): LspRequestIssue[] {
    return this.requester?.drain() ?? [];
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.shutdown();
    } finally {
      this.client = null;
      this.requester = null;
      this._isReady = false;
    }
  }

  // -------------------------------------------------------------------------
  // Enrichment
  // -------------------------------------------------------------------------

  async enrich(filePath: string): Promise<EnrichmentResult | null> {
    if (!this._isReady || !this.client) {
      throw new Error('VueLspEnricher is not initialized. Call initialize() first.');
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
    // enrichment never double-opens or closes a mid-request document.
    return this.client.withDocument(uri, this.languageId, fileContent, () =>
      this.enrichOpen(uri, filePath)
    );
  }

  /** Enrich a document that is ALREADY open (no didOpen/didClose). */
  async enrichOpen(uri: string, filePath: string): Promise<EnrichmentResult | null> {
    const rawSymbols = liftScriptSymbols(await this.getDocumentSymbols(uri, filePath));
    const symbols = rawSymbols.map(toEnrichedSymbol);
    const definitions = await this.getDefinitions(uri, filePath, rawSymbols);

    return {
      filePath,
      languageId: this.languageId,
      symbols,
      // Volar pushes diagnostics asynchronously via publishDiagnostics; nothing
      // is collected synchronously here.
      diagnostics: [],
      definitions,
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
    return this.client.withDocument(uri, this.languageId, content, () =>
      this.resolveDefinitionOpen(uri, line, character)
    );
  }

  /** Resolve a definition against an ALREADY-open document. */
  async resolveDefinitionOpen(
    uri: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null> {
    const result = await this.requester!.ask<Location | Location[] | null>(
      { filePath: fileURLToPath(uri), stage: 'calls' },
      'textDocument/definition',
      'definitionProvider',
      { textDocument: { uri }, position: { line, character } }
    );
    const loc = Array.isArray(result) ? result[0] : result;
    if (!loc) return null;
    return { filePath: fileURLToPath(loc.uri), line: loc.range.start.line };
  }

  /**
   * Resolve every call-site position in one file under a SINGLE warm document
   * open, so a file with K member-calls opens once instead of K times.
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
    return this.client.withDocument(uri, this.languageId, content, async () => {
      const out: Array<{ filePath: string; line: number } | null> = [];
      for (const p of positions) {
        out.push(await this.resolveDefinitionOpen(uri, p.line, p.character));
      }
      return out;
    });
  }

  async enrichBatch(filePaths: string[]): Promise<EnrichmentResult[]> {
    const results: EnrichmentResult[] = [];

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

  private async getDocumentSymbols(uri: string, filePath: string): Promise<DocumentSymbol[]> {
    const result = await this.requester!.ask<DocumentSymbol[] | null>(
      { filePath, stage: 'symbols' },
      'textDocument/documentSymbol',
      'documentSymbolProvider',
      { textDocument: { uri } }
    );
    return result ?? [];
  }

  private async getDefinitions(
    uri: string,
    filePath: string,
    symbols: DocumentSymbol[]
  ): Promise<EnrichedDefinition[]> {
    const definitions: EnrichedDefinition[] = [];

    // Only query definitions for top-level symbols to limit request volume.
    const topLevel = symbols.slice(0, 20);

    for (const symbol of topLevel) {
      const position = symbolPosition(symbol);
      if (!position) continue; // a symbol the server placed nowhere cannot be asked about

      const result = await this.requester!.ask<Location | Location[] | null>(
        { filePath, stage: 'symbols' },
        'textDocument/definition',
        'definitionProvider',
        {
          textDocument: { uri },
          position: { line: position.line, character: position.character },
        }
      );
      if (!result) continue;

      const locations = Array.isArray(result) ? result : [result];
      for (const loc of locations.slice(0, 5)) {
        definitions.push({
          symbolName: symbol.name,
          targetUri: stableLocationUri(loc.uri, this.workspaceRoot),
          targetStartLine: loc.range.start.line,
        });
      }
    }

    return definitions;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the TypeScript `lib` directory to hand Volar.
   *
   * An explicit override wins. Otherwise the workspace's own installation is
   * used, which is the correct one to load: it is the version the project's
   * own tooling type-checks against.
   */
  private resolveTsdk(workspaceRoot: string): string {
    if (this.tsdkOverride) return this.tsdkOverride;

    const local = join(workspaceRoot, 'node_modules', 'typescript', 'lib');
    if (existsSync(local)) return local;

    // Fall back to the bare path rather than throwing. Volar degrades to empty
    // results, and an enrichment pass that skips Vue is preferable to one that
    // aborts a whole index rebuild.
    return local;
  }

  /**
   * Build stable node IDs for Vue SFC symbols.
   * Format: `symbol:vue:<relativeFilePath>#<symbolName>`
   *
   * This is one of the identifiers the association propagation pass probes when
   * it resolves a consumer symbol, so the scheme is fixed by that lookup.
   */
  static buildSymbolNodeId(relativeFilePath: string, symbolName: string): string {
    return `symbol:vue:${relativeFilePath}#${symbolName}`;
  }

  /**
   * Build a stable file node ID for a relative path.
   */
  static buildFileNodeId(relativeFilePath: string): string {
    return `file:${relativeFilePath}`;
  }
}

// ---------------------------------------------------------------------------
// SFC block flattening
// ---------------------------------------------------------------------------

/** SFC blocks whose children are real script identifiers. */
const SCRIPT_BLOCKS = new Set(['script', 'script setup']);

/**
 * Lift script identifiers out of their SFC block wrapper.
 *
 * Volar reports a Single-File Component as its blocks — `template`,
 * `script setup`, `style scoped` — with everything a caller actually wants
 * nested one level below. Symbol materialization takes only top-level symbols,
 * so passing Volar's tree through verbatim indexes three block wrappers per
 * file and discards every identifier in them.
 *
 * Only the script blocks are lifted. `template` children are DOM elements and
 * `style` children are CSS selectors; neither is a code symbol, and admitting
 * them would put entries like `div.user-details` in the symbol table.
 *
 * A file whose blocks are absent (no recognised wrapper) is returned unchanged,
 * so a future Volar that reports a flat tree keeps working.
 */
export function liftScriptSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const hasBlocks = symbols.some(
    (s) => SCRIPT_BLOCKS.has(s.name) || s.name === 'template' || s.name.startsWith('style')
  );
  if (!hasBlocks) return symbols;

  const lifted: DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (SCRIPT_BLOCKS.has(symbol.name)) {
      lifted.push(...(symbol.children ?? []));
    }
  }
  return lifted;
}
