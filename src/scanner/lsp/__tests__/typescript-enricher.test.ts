import { describe, it, expect, vi } from 'vitest';
import { TypeScriptLspEnricher } from '../typescript.js';

// ---------------------------------------------------------------------------
// Unit tests for TypeScriptLspEnricher (lifecycle, config, node IDs)
// ---------------------------------------------------------------------------
// Note: tests that require a live typescript-language-server are integration
// tests and are excluded from this suite. These tests cover the enricher
// contract, configuration defaults, and helper utilities.

describe('TypeScriptLspEnricher', () => {
  describe('construction and config defaults', () => {
    it('should set languageId to typescript', () => {
      const enricher = new TypeScriptLspEnricher();
      expect(enricher.languageId).toBe('typescript');
    });

    it('should handle ts, tsx, js, jsx extensions', () => {
      const enricher = new TypeScriptLspEnricher();
      expect(enricher.fileExtensions).toContain('.ts');
      expect(enricher.fileExtensions).toContain('.tsx');
      expect(enricher.fileExtensions).toContain('.js');
      expect(enricher.fileExtensions).toContain('.jsx');
    });

    it('should default to typescript-language-server command', () => {
      const enricher = new TypeScriptLspEnricher();
      expect(enricher.config.serverCommand).toBe('typescript-language-server');
      expect(enricher.config.serverArgs).toEqual(['--stdio']);
    });

    it('should accept custom server command and args', () => {
      const enricher = new TypeScriptLspEnricher({
        serverCommand: '/usr/local/bin/typescript-language-server',
        serverArgs: ['--stdio', '--log-level', '3'],
        requestTimeoutMs: 5000,
        initTimeoutMs: 30000,
      });
      expect(enricher.config.serverCommand).toBe('/usr/local/bin/typescript-language-server');
      expect(enricher.config.serverArgs).toEqual(['--stdio', '--log-level', '3']);
      expect(enricher.config.requestTimeoutMs).toBe(5000);
      expect(enricher.config.initTimeoutMs).toBe(30000);
    });

    it('should start not ready', () => {
      const enricher = new TypeScriptLspEnricher();
      expect(enricher.isReady).toBe(false);
    });
  });

  describe('node ID helpers', () => {
    it('should build a stable file node ID', () => {
      const id = TypeScriptLspEnricher.buildFileNodeId('resources/js/pages/Invoice.tsx');
      expect(id).toBe('file:resources/js/pages/Invoice.tsx');
    });

    it('should build a stable symbol node ID', () => {
      const id = TypeScriptLspEnricher.buildSymbolNodeId(
        'resources/js/pages/Invoice.tsx',
        'default'
      );
      expect(id).toBe('symbol:ts:resources/js/pages/Invoice.tsx#default');
    });

    it('should include full path in symbol ID to prevent collisions', () => {
      const id1 = TypeScriptLspEnricher.buildSymbolNodeId('src/components/Button.tsx', 'Button');
      const id2 = TypeScriptLspEnricher.buildSymbolNodeId('src/ui/Button.tsx', 'Button');
      expect(id1).not.toBe(id2);
    });
  });

  describe('enrich() before initialize()', () => {
    it('should throw if enrich is called before initialize', async () => {
      const enricher = new TypeScriptLspEnricher();
      await expect(enricher.enrich('/some/file.ts')).rejects.toThrow(
        'TypeScriptLspEnricher is not initialized'
      );
    });
  });

  describe('enrichBatch() delegates to enrich()', () => {
    it('should return results for each file that enriches successfully', async () => {
      const enricher = new TypeScriptLspEnricher();
      const enrichResult = {
        filePath: '/app/index.ts',
        languageId: 'typescript',
        symbols: [],
        diagnostics: [],
        definitions: [],
        enrichedAt: 1700000000,
      };

      vi.spyOn(enricher, 'enrich').mockResolvedValue(enrichResult);

      const results = await enricher.enrichBatch(['/app/index.ts', '/app/utils.ts']);
      expect(results).toHaveLength(2);
    });

    it('should filter out null results from enrichBatch', async () => {
      const enricher = new TypeScriptLspEnricher();
      vi.spyOn(enricher, 'enrich').mockResolvedValueOnce(null).mockResolvedValueOnce({
        filePath: '/app/utils.ts',
        languageId: 'typescript',
        symbols: [],
        diagnostics: [],
        definitions: [],
        enrichedAt: 1700000000,
      });

      const results = await enricher.enrichBatch(['/app/index.ts', '/app/utils.ts']);
      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe('/app/utils.ts');
    });
  });

  describe('shutdown() when not initialized', () => {
    it('should be a no-op if not initialized', async () => {
      const enricher = new TypeScriptLspEnricher();
      await expect(enricher.shutdown()).resolves.toBeUndefined();
      expect(enricher.isReady).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Registry integration: TypeScript enricher handles .ts/.js/.tsx/.jsx
// ---------------------------------------------------------------------------

describe('TypeScriptLspEnricher registry integration', () => {
  it('should be usable with EnricherRegistry for all supported extensions', async () => {
    const { EnricherRegistry } = await import('../index.js');
    const registry = new EnricherRegistry();
    const enricher = new TypeScriptLspEnricher();
    registry.register(enricher);

    expect(registry.getByExtension('.ts')).toBe(enricher);
    expect(registry.getByExtension('.tsx')).toBe(enricher);
    expect(registry.getByExtension('.js')).toBe(enricher);
    expect(registry.getByExtension('.jsx')).toBe(enricher);
    expect(registry.getByExtension('.php')).toBeUndefined();
  });
});
