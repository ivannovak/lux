import { describe, it, expect } from 'vitest';
import {
  resolveTypedReceiverEdges,
  memberLeafName,
  type ResolveDefinition,
  type ResolveDefinitionsInFile,
} from '../lsp-resolve.js';
import { buildSharedExtractions } from '../extraction-cache.js';
import { LspTransientError } from '../../lsp/client.js';
import type { ScanResult } from '../../types.js';

describe('memberLeafName', () => {
  it('extracts the called member leaf from a receiver expression', () => {
    expect(memberLeafName('$x->save')).toBe('save');
    expect(memberLeafName('$this->app->make')).toBe('make');
    expect(memberLeafName('Foo::bar')).toBe('bar');
    expect(memberLeafName('count')).toBe('count');
  });
});

describe('resolveTypedReceiverEdges', () => {
  it('resolves a typed-receiver call to another file via LSP and emits a proven edge', async () => {
    // go() calls svc.doThing() — `svc` is a local value (not imported), so the
    // call is a typed-receiver AST cannot settle. b.ts defines doThing.
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: ['function go() {', '  svc.doThing();', '}'].join('\n'),
      },
      { filePath: '/repo/b.ts', content: 'export function doThing() {}' },
    ];

    // Mock LSP: the doThing token in a.ts resolves to b.ts line 0 (0-based).
    const resolveDefinition: ResolveDefinition = (file) =>
      Promise.resolve(file === '/repo/a.ts' ? { filePath: '/repo/b.ts', line: 0 } : null);

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000);
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call).toBeDefined();
    expect(call?.sourceNodeId).toBe('symbol:ts:a.ts#go');
    expect(call?.targetNodeId).toBe('symbol:ts:b.ts#doThing');
    expect(call?.confidenceClass).toBe('proven');
    expect(call?.provenance.evidenceKind).toBe('ast-lsp-typed-receiver');
  });

  it("emits none of a file's edges, and reports the file, when its definitions time out", async () => {
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: ['function go() {', '  svc.doThing();', '}'].join('\n'),
      },
      {
        filePath: '/repo/c.ts',
        content: ['function run() {', '  svc.doThing();', '}'].join('\n'),
      },
      { filePath: '/repo/b.ts', content: 'export function doThing() {}' },
    ];
    const resolveDefinition: ResolveDefinition = (file) =>
      file === '/repo/c.ts'
        ? Promise.reject(new LspTransientError('timeout', 'timed out after 5ms'))
        : Promise.resolve({ filePath: '/repo/b.ts', line: 0 });
    const failed: string[] = [];

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000, {
      onTransientFailure: (filePath) => failed.push(filePath),
    });
    expect(edges.map((edge) => edge.sourceNodeId)).toEqual(['symbol:ts:a.ts#go']);
    expect(failed).toEqual(['/repo/c.ts']);
  });

  it('skips import-bound calls and does not emit for unresolved targets', async () => {
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: [
          "import { helper } from './b.js';",
          'function go() {',
          '  helper();', // import-bound -> handled by the syntactic resolver, not here
          '  mystery.foo();', // typed-receiver but LSP returns nothing
          '}',
        ].join('\n'),
      },
      { filePath: '/repo/b.ts', content: 'export function helper() {}' },
    ];
    const resolveDefinition: ResolveDefinition = () => Promise.resolve(null);

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000);
    expect(edges).toHaveLength(0);
  });

  it('does not emit an edge when the target resolves outside the scanned corpus', async () => {
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: ['function go() {', '  client.send();', '}'].join('\n'),
      },
    ];
    // Resolves to a vendored file that was never scanned.
    const resolveDefinition: ResolveDefinition = () =>
      Promise.resolve({ filePath: '/repo/node_modules/dep/index.ts', line: 3 });

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000);
    expect(edges).toHaveLength(0);
  });

  it('emits a proven boundary edge when an out-of-corpus target resolves to a merged vendor node', async () => {
    // ADR-3 / REQ-1: with a vendor pack merged, an app→vendor call that formerly
    // dropped now resolves to the merged vendor node and emits a proven edge.
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: ['function go() {', '  client.send();', '}'].join('\n'),
      },
    ];
    const resolveDefinition: ResolveDefinition = () =>
      Promise.resolve({ filePath: '/repo/vendor/dep/src/Client.php', line: 10 });
    // The boundary resolver maps the vendor location to its merged pack node id.
    const resolveExternalTarget = () =>
      Promise.resolve<string | null>('symbol:php:Vendor\\Client::send');

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000, {
      resolveExternalTarget,
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].targetNodeId).toBe('symbol:php:Vendor\\Client::send');
    expect(edges[0].confidenceClass).toBe('proven');
  });

  it('still drops the out-of-corpus target when the boundary resolver finds no merged node', async () => {
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: ['function go() {', '  client.send();', '}'].join('\n'),
      },
    ];
    const resolveDefinition: ResolveDefinition = () =>
      Promise.resolve({ filePath: '/repo/vendor/dep/src/Client.php', line: 10 });
    const resolveExternalTarget = () => Promise.resolve<string | null>(null); // not present in the pack

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000, {
      resolveExternalTarget,
    });
    expect(edges).toHaveLength(0);
  });

  it('hands LSP the exact 0-based token position and never collapses distinct scopes', async () => {
    // Two functions each write `svc.run()`, but the two `svc` values resolve to
    // DIFFERENT classes. A relPath+text cache collapses them onto one target;
    // a scope-keyed cache must resolve each independently.
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: [
          'function f1() {', // line 0
          '  svc.run();', // line 1 -> A.run
          '}',
          'function f2() {', // line 3
          '  svc.run();', // line 4 -> B.run
          '}',
        ].join('\n'),
      },
      {
        filePath: '/repo/t.ts',
        content: ['class A { run() {} }', 'class B { run() {} }'].join('\n'),
      },
    ];

    const calls: Array<{ line: number; character: number }> = [];
    const resolveDefinition: ResolveDefinition = (file, line, character) => {
      if (file !== '/repo/a.ts') return Promise.resolve(null);
      calls.push({ line, character });
      // The `run` token sits on 0-based line 1 (f1) and line 4 (f2).
      if (line === 1) return Promise.resolve({ filePath: '/repo/t.ts', line: 0 }); // A.run
      if (line === 4) return Promise.resolve({ filePath: '/repo/t.ts', line: 1 }); // B.run
      return Promise.resolve(null);
    };

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000);

    // Coordinate math: 0-based lines, and the column of `run` in `  svc.run();`.
    expect(calls).toContainEqual({ line: 1, character: 6 });
    expect(calls).toContainEqual({ line: 4, character: 6 });

    const f1 = edges.find((e) => e.sourceNodeId === 'symbol:ts:a.ts#f1');
    const f2 = edges.find((e) => e.sourceNodeId === 'symbol:ts:a.ts#f2');
    expect(f1?.targetNodeId).toBe('symbol:ts:t.ts#A.run');
    expect(f2?.targetNodeId).toBe('symbol:ts:t.ts#B.run'); // NOT collapsed to A.run
  });

  it('resolves a PHP typed-receiver call now that PHP calls carry a nameRange', async () => {
    const entries = [
      {
        filePath: '/repo/Svc.php',
        content: [
          '<?php',
          'namespace App;',
          'class Svc {',
          '  function run() { $this->repo->find(); }', // $this->repo is a typed receiver
          '}',
        ].join('\n'),
      },
      {
        filePath: '/repo/Repo.php',
        content: ['<?php', 'namespace App;', 'class Repo {', '  function find() {} ', '}'].join(
          '\n'
        ),
      },
    ];
    // Resolve the `find` token to Repo::find's line (0-based line 3).
    const resolveDefinition: ResolveDefinition = (file) =>
      Promise.resolve(file === '/repo/Svc.php' ? { filePath: '/repo/Repo.php', line: 3 } : null);

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000);
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call?.sourceNodeId).toBe('symbol:php:App\\Svc::run');
    expect(call?.targetNodeId).toBe('symbol:php:App\\Repo::find');
    expect(call?.confidenceClass).toBe('proven');
  });
});

describe('resolveTypedReceiverEdges — Lever B/D upgrades', () => {
  it('opens each file once via resolveInFile and resolves all call-sites warm', async () => {
    // f1 and f2 both write `svc.run()`; the pass must resolve BOTH under a single
    // per-file open (one resolveInFile call), not one open per call-site.
    const entries = [
      {
        filePath: '/repo/a.ts',
        content: [
          'function f1() {', // line 0
          '  svc.run();', // line 1 -> A.run
          '}',
          'function f2() {', // line 3
          '  svc.run();', // line 4 -> B.run
          '}',
        ].join('\n'),
      },
      {
        filePath: '/repo/t.ts',
        content: ['class A { run() {} }', 'class B { run() {} }'].join('\n'),
      },
    ];

    const perFileCalls = new Map<string, number>();
    const resolveInFile: ResolveDefinitionsInFile = (filePath, positions) => {
      perFileCalls.set(filePath, (perFileCalls.get(filePath) ?? 0) + 1);
      return Promise.resolve(
        positions.map((p) => {
          if (filePath !== '/repo/a.ts') return null;
          if (p.line === 1) return { filePath: '/repo/t.ts', line: 0 }; // A.run
          if (p.line === 4) return { filePath: '/repo/t.ts', line: 1 }; // B.run
          return null;
        })
      );
    };

    const edges = await resolveTypedReceiverEdges(
      entries,
      '/repo',
      () => Promise.resolve(null), // per-position path must NOT be used
      1000,
      { resolveInFile, concurrency: 4 }
    );

    expect(perFileCalls.get('/repo/a.ts')).toBe(1); // opened once for BOTH call-sites
    expect(perFileCalls.has('/repo/t.ts')).toBe(false); // no member calls → no open
    const f1 = edges.find((e) => e.sourceNodeId === 'symbol:ts:a.ts#f1');
    const f2 = edges.find((e) => e.sourceNodeId === 'symbol:ts:a.ts#f2');
    expect(f1?.targetNodeId).toBe('symbol:ts:t.ts#A.run');
    expect(f2?.targetNodeId).toBe('symbol:ts:t.ts#B.run');
  });

  it('consumes sharedExtractions instead of re-parsing entry content', async () => {
    const aSrc = ['function go() {', '  svc.doThing();', '}'].join('\n');
    const bSrc = 'export function doThing() {}';
    const scan: ScanResult = {
      knowledge: [
        {
          type: 'source-code',
          title: 'a.ts',
          filePath: '/repo/a.ts',
          frontmatter: { language: 'typescript' },
          content: aSrc,
        },
        {
          type: 'source-code',
          title: 'b.ts',
          filePath: '/repo/b.ts',
          frontmatter: { language: 'typescript' },
          content: bSrc,
        },
      ],
    };
    const shared = await buildSharedExtractions(scan, '/repo');

    // Entry content is EMPTY — a re-parse would find no call-sites; only the
    // shared cache carries the real extraction.
    const entries = [
      { filePath: '/repo/a.ts', content: '' },
      { filePath: '/repo/b.ts', content: '' },
    ];
    const resolveDefinition: ResolveDefinition = (file) =>
      Promise.resolve(file === '/repo/a.ts' ? { filePath: '/repo/b.ts', line: 0 } : null);

    const edges = await resolveTypedReceiverEdges(entries, '/repo', resolveDefinition, 1000, {
      sharedExtractions: shared,
    });

    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call?.sourceNodeId).toBe('symbol:ts:a.ts#go');
    expect(call?.targetNodeId).toBe('symbol:ts:b.ts#doThing');
    expect(call?.confidenceClass).toBe('proven');
  });
});
