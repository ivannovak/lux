import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { materializeNodes, buildFileNode, buildSymbolNodes } from '../materializer.js';
import type { ScanResult, ScannedKnowledge } from '../../types.js';
import type { EnrichmentResult } from '../../lsp/index.js';
import type { EnrichmentMap } from '../../general.js';

const testDir = join(import.meta.dirname, 'fixtures', 'materializer-test');
const ROOT = '/app';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function sourceEntry(relPath: string, language: string): ScannedKnowledge {
  return {
    type: 'source-code',
    title: relPath,
    filePath: join(ROOT, relPath),
    frontmatter: { language, extension: `.${language === 'typescript' ? 'ts' : 'php'}` },
    content: `// ${relPath}`,
  };
}

function enrichment(filePath: string, languageId: string): EnrichmentResult {
  return {
    filePath,
    languageId,
    symbols: [
      { name: 'MyClass', kind: 5, kindLabel: 'Class', startLine: 1, endLine: 50 },
      { name: 'myMethod', kind: 6, kindLabel: 'Method', startLine: 10, endLine: 20 },
    ],
    diagnostics: [],
    definitions: [],
    enrichedAt: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// buildFileNode tests
// ---------------------------------------------------------------------------

describe('buildFileNode', () => {
  it('should produce a file node with relative path as ID', () => {
    const entry = sourceEntry('src/app.ts', 'typescript');
    const node = buildFileNode(entry, ROOT);

    expect(node.id).toBe('file:src/app.ts');
    expect(node.node_type).toBe('file');
    expect(node.file_path).toBe('src/app.ts');
    expect(node.language_id).toBe('typescript');
  });

  it('should handle PHP files', () => {
    const entry = sourceEntry('app/Services/InvoiceService.php', 'php');
    const node = buildFileNode(entry, ROOT);

    expect(node.id).toBe('file:app/Services/InvoiceService.php');
    expect(node.language_id).toBe('php');
    expect(node.node_type).toBe('file');
  });

  it('should produce stable IDs across calls with identical inputs', () => {
    const entry = sourceEntry('src/app.ts', 'typescript');
    const n1 = buildFileNode(entry, ROOT);
    const n2 = buildFileNode(entry, ROOT);
    expect(n1.id).toBe(n2.id);
  });
});

// ---------------------------------------------------------------------------
// buildSymbolNodes tests
// ---------------------------------------------------------------------------

describe('buildSymbolNodes', () => {
  it('should build TS symbol nodes with file#name format', () => {
    const filePath = join(ROOT, 'src/app.ts');
    const enrich = enrichment(filePath, 'typescript');

    const nodes = buildSymbolNodes(filePath, enrich, ROOT);

    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe('symbol:ts:src/app.ts#MyClass');
    expect(nodes[0].node_type).toBe('symbol');
    expect(nodes[0].symbol_name).toBe('MyClass');
    expect(nodes[0].symbol_kind).toBe('Class');
    expect(nodes[0].language_id).toBe('typescript');
    expect(nodes[0].file_path).toBe('src/app.ts');
  });

  it('should build PHP symbol nodes', () => {
    const filePath = join(ROOT, 'app/Services/InvoiceService.php');
    const enrich = enrichment(filePath, 'php');

    const nodes = buildSymbolNodes(filePath, enrich, ROOT);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].language_id).toBe('php');
    expect(nodes[0].node_type).toBe('symbol');
  });

  it('derives qualified PHP symbol IDs from namespace declarations', () => {
    const filePath = join(ROOT, 'app/Http/Controllers/InvoiceController.php');
    const enrich = enrichment(filePath, 'php');

    const nodes = buildSymbolNodes(
      filePath,
      enrich,
      ROOT,
      ['<?php', 'namespace App\\Http\\Controllers;', '', 'class MyClass {}'].join('\n')
    );

    expect(nodes[0].id).toBe('symbol:php:App\\Http\\Controllers\\MyClass');
    expect(nodes[0].qualified_name).toBe('App\\Http\\Controllers\\MyClass');
  });

  it('materializes no node for a PHP namespace statement and never doubles the namespace', () => {
    const filePath = join(ROOT, 'app/Models/Invoice.php');
    const nodes = buildSymbolNodes(
      filePath,
      {
        ...enrichment(filePath, 'php'),
        // The list as intelephense reports it: the statement is a sibling of what follows.
        symbols: [
          { name: 'App\\Models', kind: 3, kindLabel: 'Namespace', startLine: 2, endLine: 2 },
          { name: 'Invoice', kind: 5, kindLabel: 'Class', startLine: 4, endLine: 9 },
        ],
      },
      ROOT,
      '<?php\n\nnamespace App\\Models;\n\nclass Invoice {}\n'
    );

    expect(nodes.map((node) => [node.id, node.symbol_kind, node.qualified_name])).toEqual([
      ['symbol:php:App\\Models\\Invoice', 'Class', 'App\\Models\\Invoice'],
    ]);
  });

  it('qualifies each PHP declaration by its own namespace, not the first one in the file', () => {
    const filePath = join(ROOT, 'app/TwoBlocks.php');
    const source = '<?php\n\nnamespace App\\A;\n\nclass X {}\n\nnamespace App\\B;\n\nclass Y {}\n';
    const reported = buildSymbolNodes(
      filePath,
      {
        ...enrichment(filePath, 'php'),
        symbols: [
          { name: 'App\\A', kind: 3, kindLabel: 'Namespace', startLine: 2, endLine: 2 },
          { name: 'X', kind: 5, kindLabel: 'Class', startLine: 4, endLine: 4 },
          { name: 'App\\B', kind: 3, kindLabel: 'Namespace', startLine: 6, endLine: 6 },
          { name: 'Y', kind: 5, kindLabel: 'Class', startLine: 8, endLine: 8 },
        ],
      },
      ROOT,
      source
    );
    // The same file as the PHP enricher hands it over: namespaces already on the declarations.
    const enriched = buildSymbolNodes(
      filePath,
      {
        ...enrichment(filePath, 'php'),
        symbols: [
          { name: 'X', kind: 5, kindLabel: 'Class', startLine: 4, endLine: 4, namespace: 'App\\A' },
          { name: 'Y', kind: 5, kindLabel: 'Class', startLine: 8, endLine: 8, namespace: 'App\\B' },
        ],
      },
      ROOT,
      source
    );

    const expected = ['symbol:php:App\\A\\X', 'symbol:php:App\\B\\Y'];
    expect(reported.map((node) => node.id)).toEqual(expected);
    expect(enriched.map((node) => node.id)).toEqual(expected);
  });

  it('leaves a PHP declaration of a global block unqualified beside a namespaced one', () => {
    const filePath = join(ROOT, 'app/Bracketed.php');
    const nodes = buildSymbolNodes(
      filePath,
      {
        ...enrichment(filePath, 'php'),
        symbols: [
          {
            name: 'Z',
            kind: 5,
            kindLabel: 'Class',
            startLine: 3,
            endLine: 3,
            namespace: 'App\\Br',
          },
          { name: 'in_global', kind: 12, kindLabel: 'Function', startLine: 7, endLine: 7 },
        ],
      },
      ROOT,
      '<?php\n\nnamespace App\\Br {\n    class Z {}\n}\n\nnamespace {\n    function in_global() {}\n}\n'
    );

    expect(nodes.map((node) => [node.id, node.qualified_name])).toEqual([
      ['symbol:php:App\\Br\\Z', 'App\\Br\\Z'],
      ['symbol:php:in_global', undefined],
    ]);
  });

  it('materializes only the PHP variables of a Blade template', () => {
    const filePath = join(ROOT, 'resources/views/report.blade.php');
    const nodes = buildSymbolNodes(
      filePath,
      {
        ...enrichment(filePath, 'php'),
        symbols: [
          { name: 'html', kind: 8, kindLabel: 'Field', startLine: 0, endLine: 9 },
          { name: 'position', kind: 5, kindLabel: 'Class', startLine: 3, endLine: 3 },
          { name: '$total', kind: 13, kindLabel: 'Variable', startLine: 7, endLine: 7 },
        ],
      },
      ROOT
    );

    expect(nodes.map((node) => node.id)).toEqual(['symbol:php:$total']);
  });

  it('should produce distinct IDs for different files with same symbol names', () => {
    const p1 = join(ROOT, 'src/a.ts');
    const p2 = join(ROOT, 'src/b.ts');
    const e1 = enrichment(p1, 'typescript');
    const e2 = enrichment(p2, 'typescript');

    const n1 = buildSymbolNodes(p1, e1, ROOT);
    const n2 = buildSymbolNodes(p2, e2, ROOT);

    expect(n1[0].id).not.toBe(n2[0].id);
  });
});

// ---------------------------------------------------------------------------
// materializeNodes integration tests
// ---------------------------------------------------------------------------

describe('materializeNodes', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should persist file nodes for all source code entries', () => {
    const scan: ScanResult = {
      knowledge: [
        sourceEntry('src/app.ts', 'typescript'),
        sourceEntry('src/utils.ts', 'typescript'),
        { type: 'general', title: 'README', filePath: '/app/README.md' }, // non-source: should be skipped
      ],
    };

    const result = materializeNodes(db, scan, new Map(), ROOT);

    expect(result.fileNodes).toBe(2);
    expect(result.symbolNodes).toBe(0);

    const node1 = db.getStructuralNode('file:src/app.ts');
    expect(node1).not.toBeNull();
    expect(node1!.node_type).toBe('file');

    const node2 = db.getStructuralNode('file:src/utils.ts');
    expect(node2).not.toBeNull();
  });

  it('should skip markdown and non-source entries', () => {
    const scan: ScanResult = {
      knowledge: [
        { type: 'spec', title: 'Spec', filePath: '/app/SPEC.md' },
        { type: 'general', title: 'README', filePath: '/app/README.md' },
      ],
    };

    const result = materializeNodes(db, scan, new Map(), ROOT);
    expect(result.fileNodes).toBe(0);
    expect(result.symbolNodes).toBe(0);
  });

  it('should persist symbol nodes from enrichment results', () => {
    const filePath = join(ROOT, 'src/app.ts');
    const scan: ScanResult = {
      knowledge: [sourceEntry('src/app.ts', 'typescript')],
    };

    const enrichments: EnrichmentMap = new Map([[filePath, enrichment(filePath, 'typescript')]]);

    const result = materializeNodes(db, scan, enrichments, ROOT);

    expect(result.fileNodes).toBe(1);
    expect(result.symbolNodes).toBe(2);

    const symbolNode = db.getStructuralNode('symbol:ts:src/app.ts#MyClass');
    expect(symbolNode).not.toBeNull();
    expect(symbolNode!.symbol_kind).toBe('Class');
  });

  it('should be idempotent — re-running does not create duplicates', () => {
    const scan: ScanResult = {
      knowledge: [sourceEntry('src/app.ts', 'typescript')],
    };
    const filePath = join(ROOT, 'src/app.ts');
    const enrichments: EnrichmentMap = new Map([[filePath, enrichment(filePath, 'typescript')]]);

    materializeNodes(db, scan, enrichments, ROOT);
    materializeNodes(db, scan, enrichments, ROOT); // second run

    const node = db.getStructuralNode('file:src/app.ts');
    expect(node).not.toBeNull();
    // DB should still have exactly one node for this file (upsert)
    const symbolNode = db.getStructuralNode('symbol:ts:src/app.ts#MyClass');
    expect(symbolNode).not.toBeNull();
  });

  it('counts unique symbol node IDs when enrichment emits duplicate symbol names in one file', () => {
    const filePath = join(ROOT, 'src/app.ts');
    const scan: ScanResult = {
      knowledge: [sourceEntry('src/app.ts', 'typescript')],
    };

    const duplicateEnrichment: EnrichmentResult = {
      filePath,
      languageId: 'typescript',
      symbols: [
        { name: 'action() callback', kind: 12, kindLabel: 'Function', startLine: 1, endLine: 5 },
        { name: 'action() callback', kind: 12, kindLabel: 'Function', startLine: 10, endLine: 20 },
        { name: 'uniqueFunction', kind: 12, kindLabel: 'Function', startLine: 30, endLine: 40 },
      ],
      diagnostics: [],
      definitions: [],
      enrichedAt: Math.floor(Date.now() / 1000),
    };

    const enrichments: EnrichmentMap = new Map([[filePath, duplicateEnrichment]]);

    const result = materializeNodes(db, scan, enrichments, ROOT);
    expect(result.fileNodes).toBe(1);
    expect(result.symbolNodes).toBe(2);
    expect(db.getStructuralNode('symbol:ts:src/app.ts#action() callback')).not.toBeNull();
    expect(db.getStructuralNode('symbol:ts:src/app.ts#uniqueFunction')).not.toBeNull();
  });

  it('should work with an empty enrichment map', () => {
    const scan: ScanResult = {
      knowledge: [sourceEntry('src/a.ts', 'typescript'), sourceEntry('src/b.ts', 'typescript')],
    };

    const result = materializeNodes(db, scan, new Map(), ROOT);
    expect(result.fileNodes).toBe(2);
    expect(result.symbolNodes).toBe(0);
  });
});
