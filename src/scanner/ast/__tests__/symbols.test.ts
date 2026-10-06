import { describe, it, expect, beforeAll } from 'vitest';
import type Parser from 'web-tree-sitter';
import { initGrammars, extractSource, type AstLang } from '../extract.js';
import { astSymbolIdentity, buildAstSymbolNodes } from '../symbols.js';
import { phpSymbolNodeId, tsSymbolNodeId } from '../../associations/types.js';

let grammars: Map<AstLang, Parser.Language>;

beforeAll(async () => {
  grammars = await initGrammars();
});

describe('buildAstSymbolNodes — TypeScript', () => {
  it('uses relPath#name ids for top-level symbols and Container.name for methods', () => {
    const src = ['export function foo() {}', 'class Widget {', '  render() {}', '}'].join('\n');
    const { extraction } = extractSource(grammars, src, 'a/b.ts', 'typescript');
    const nodes = buildAstSymbolNodes('a/b.ts', extraction, 'typescript', 1000);

    const foo = nodes.find((n) => n.symbol_name === 'foo');
    expect(foo?.id).toBe('symbol:ts:a/b.ts#foo');
    expect(foo?.node_type).toBe('symbol');
    expect(foo?.symbol_kind).toBe('Function');
    expect(foo?.language_id).toBe('typescript');
    expect(foo?.updated_at).toBe(1000);
    expect(foo?.qualified_name).toBeUndefined();

    expect(nodes.find((n) => n.symbol_name === 'Widget')?.id).toBe('symbol:ts:a/b.ts#Widget');
    // method gets the container segment so it can't collide with a top-level `render`
    expect(nodes.find((n) => n.symbol_name === 'render')?.id).toBe(
      'symbol:ts:a/b.ts#Widget.render'
    );
  });

  it('gives class-expression methods a container id and does not drop the real export', () => {
    // `const Widget = class {...}` methods must get a `Widget.` container so they
    // do NOT collide with (and evict) a top-level function of the same name.
    const src = ['const Widget = class { render() {} };', 'export function render() {}'].join('\n');
    const { extraction } = extractSource(grammars, src, 'x.ts', 'typescript');
    const nodes = buildAstSymbolNodes('x.ts', extraction, 'typescript', 1000);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('symbol:ts:x.ts#render'); // the real exported function survives
    expect(ids).toContain('symbol:ts:x.ts#Widget'); // class expression surfaced as a class
    expect(ids).toContain('symbol:ts:x.ts#Widget.render'); // its method is container-qualified
  });

  it('does not surface object-literal shorthand methods as top-level symbols', () => {
    // `{ handle() {} }` is not a class method; surfacing it as `#handle` would
    // collide with real top-level symbols. It must simply be excluded.
    const src = ['const o = { handle() {} };', 'export function handle() {}'].join('\n');
    const { extraction } = extractSource(grammars, src, 'y.ts', 'typescript');
    const nodes = buildAstSymbolNodes('y.ts', extraction, 'typescript', 1000);
    const handleNodes = nodes.filter((n) => n.symbol_name === 'handle');
    expect(handleNodes).toHaveLength(1);
    expect(handleNodes[0]?.symbol_kind).toBe('Function'); // the export, not the object method
  });
});

describe('buildAstSymbolNodes — JavaScript', () => {
  it('keeps canonical symbol:ts ids while persisting JavaScript language rows', () => {
    const src = ['export function run() {}', 'class App { render() {} }'].join('\n');
    const { extraction } = extractSource(grammars, src, 'src/app.js', 'javascript');
    const nodes = buildAstSymbolNodes('src/app.js', extraction, 'javascript', 1000);

    expect(nodes.find((n) => n.symbol_name === 'run')?.id).toBe('symbol:ts:src/app.js#run');
    expect(nodes.find((n) => n.symbol_name === 'render')?.id).toBe(
      'symbol:ts:src/app.js#App.render'
    );
    expect(nodes.every((n) => n.language_id === 'javascript')).toBe(true);
    expect(astSymbolIdentity('src/app.js', extraction.nodes[0], 'javascript').id).toBe(
      tsSymbolNodeId('src/app.js', 'run')
    );
  });
});

describe('buildAstSymbolNodes — PHP', () => {
  it('qualifies ids with namespace and class', () => {
    const src = [
      '<?php',
      'namespace App\\Billing;',
      'class Ledger {',
      '  public function total() {}',
      '}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'Ledger.php', 'php');
    expect(extraction.namespace).toBe('App\\Billing');

    const nodes = buildAstSymbolNodes('Ledger.php', extraction, 'php', 1000);
    const ledger = nodes.find((n) => n.symbol_name === 'Ledger');
    expect(ledger?.id).toBe('symbol:php:App\\Billing\\Ledger');
    expect(ledger?.qualified_name).toBe('App\\Billing\\Ledger');

    const total = nodes.find((n) => n.symbol_name === 'total');
    expect(total?.id).toBe('symbol:php:App\\Billing\\Ledger::total');
    expect(total?.qualified_name).toBe('App\\Billing\\Ledger::total');
    expect(total?.language_id).toBe('php');
  });

  it('qualifies each definition with the namespace statement it follows', () => {
    const src = [
      '<?php',
      'namespace App\\A;',
      'class X { public function a() {} }',
      'namespace App\\B;',
      'class Y { public function b() {} }',
      'function helper() {}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'TwoBlocks.php', 'php');
    expect(extraction.namespace).toBe('App\\A');

    const ids = buildAstSymbolNodes('TwoBlocks.php', extraction, 'php', 1000).map((n) => n.id);
    expect(ids.sort()).toEqual([
      'symbol:php:App\\A\\X',
      'symbol:php:App\\A\\X::a',
      'symbol:php:App\\B\\Y',
      'symbol:php:App\\B\\Y::b',
      'symbol:php:App\\B\\helper',
    ]);
  });

  it('qualifies by namespace block, and leaves the global block unqualified', () => {
    const src = [
      '<?php',
      'namespace App\\Br {',
      '  class Z { public function z() {} }',
      '}',
      'namespace {',
      '  function in_global() {}',
      '  class Bare {}',
      '}',
      'namespace App\\Other {',
      '  class Q {}',
      '}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'Bracketed.php', 'php');

    const nodes = buildAstSymbolNodes('Bracketed.php', extraction, 'php', 1000);
    expect(nodes.map((n) => n.id).sort()).toEqual([
      'symbol:php:App\\Br\\Z',
      'symbol:php:App\\Br\\Z::z',
      'symbol:php:App\\Other\\Q',
      'symbol:php:Bare',
      'symbol:php:in_global',
    ]);
    expect(nodes.find((n) => n.id === 'symbol:php:in_global')?.qualified_name).toBeUndefined();
  });

  it('records a namespace on a definition only when it is not the first one in the file', () => {
    const one = extractSource(grammars, '<?php\nnamespace App;\nclass A {}\n', 'A.php', 'php');
    expect(one.extraction.nodes.map((n) => n.namespace)).toEqual([undefined]);

    const two = extractSource(
      grammars,
      '<?php\nnamespace App;\nclass A {}\nnamespace Lib;\nclass B {}\n',
      'AB.php',
      'php'
    );
    expect(two.extraction.nodes.map((n) => [n.name, n.namespace])).toEqual([
      ['A', undefined],
      ['B', 'Lib'],
    ]);
  });

  it('falls back to short names when there is no namespace', () => {
    const src = ['<?php', 'class Plain {}'].join('\n');
    const { extraction } = extractSource(grammars, src, 'Plain.php', 'php');
    const nodes = buildAstSymbolNodes('Plain.php', extraction, 'php', 1000);
    const plain = nodes.find((n) => n.symbol_name === 'Plain');
    expect(plain?.id).toBe('symbol:php:Plain');
    expect(plain?.qualified_name).toBeUndefined();
  });

  it('does not surface anonymous-class methods (Laravel migration idiom)', () => {
    // `return new class extends Migration { up(){} down(){} }` — the default
    // migration shape. Its methods have no stable FQN, so surfacing them as
    // `symbol:php:up` / `symbol:php:down` would collapse every migration onto
    // one node corpus-wide.
    const src = [
      '<?php',
      'use Illuminate\\Database\\Migrations\\Migration;',
      'return new class extends Migration {',
      '  public function up() {}',
      '  public function down() {}',
      '};',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'm.php', 'php');
    const nodes = buildAstSymbolNodes('m.php', extraction, 'php', 1000);
    expect(nodes.some((n) => n.symbol_name === 'up')).toBe(false);
    expect(nodes.some((n) => n.symbol_name === 'down')).toBe(false);
  });

  it('does not misattribute a nested anonymous-class method to the enclosing class', () => {
    const src = [
      '<?php',
      'namespace App;',
      'class Svc {',
      '  public function run() { return new class { public function foo() {} }; }',
      '}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'Svc.php', 'php');
    const ids = buildAstSymbolNodes('Svc.php', extraction, 'php', 1000).map((n) => n.id);
    expect(ids).not.toContain('symbol:php:App\\Svc::foo'); // NOT attributed to Svc
    expect(ids).toContain('symbol:php:App\\Svc::run'); // the real method survives
  });
});

describe('astSymbolIdentity — coincides with the LSP node-id builders', () => {
  // The no-dangling-edge / no-duplicate-node guarantee relies on AST- and
  // LSP-sourced top-level symbols sharing exactly one id. Pin that they route
  // through the SAME builders, so neither path can silently drift from the other.
  it('TS top-level function/class ids equal tsSymbolNodeId(relPath, name)', () => {
    const fn = astSymbolIdentity(
      'a/b.ts',
      { type: 'function', name: 'foo', file: 'a/b.ts', range: {} as never },
      'typescript'
    );
    expect(fn.id).toBe(tsSymbolNodeId('a/b.ts', 'foo'));
  });

  it('PHP namespaced top-level symbol id equals phpSymbolNodeId(FQN)', () => {
    const cls = astSymbolIdentity(
      'Ledger.php',
      { type: 'class', name: 'Ledger', file: 'Ledger.php', range: {} as never },
      'php',
      'App\\Billing'
    );
    expect(cls.id).toBe(phpSymbolNodeId('App\\Billing\\Ledger'));
  });
});
