import { describe, expect, it } from 'vitest';
import {
  bladeDeclarations,
  hasNamespaceSymbols,
  namespaceOpensBlock,
  phpDeclarations,
} from '../php-declarations.js';

interface Sym {
  name: string;
  kind: number;
  children?: Sym[];
}

const NS = 3;
const CLASS = 5;
const FUNCTION = 12;

function owners(symbols: Sym[], isBlock?: (namespace: Sym) => boolean): string[] {
  return phpDeclarations(symbols, isBlock).map(
    ({ symbol, namespace }) => `${namespace ?? '(global)'} :: ${symbol.name}`
  );
}

describe('phpDeclarations', () => {
  it('gives the declarations after `namespace X;` that namespace, and drops the statement', () => {
    expect(
      owners([
        { name: 'App\\Shared', kind: NS },
        { name: 'One', kind: CLASS },
        { name: 'helper', kind: FUNCTION },
      ])
    ).toEqual(['App\\Shared :: One', 'App\\Shared :: helper']);
  });

  it('switches namespace at each later statement', () => {
    expect(
      owners([
        { name: 'App\\A', kind: NS },
        { name: 'X', kind: CLASS },
        { name: 'App\\B', kind: NS },
        { name: 'Y', kind: CLASS },
      ])
    ).toEqual(['App\\A :: X', 'App\\B :: Y']);
  });

  it('leaves a file without a namespace statement in the global namespace', () => {
    expect(owners([{ name: 'global_helper', kind: FUNCTION }])).toEqual([
      '(global) :: global_helper',
    ]);
  });

  it('lifts the declarations of a block, and leaves what follows it global', () => {
    expect(
      owners([
        { name: 'App\\Br', kind: NS, children: [{ name: 'Z', kind: CLASS }] },
        { name: 'in_global', kind: FUNCTION },
      ])
    ).toEqual(['App\\Br :: Z', '(global) :: in_global']);
  });

  it('claims nothing for an empty block beside a block that has declarations', () => {
    expect(
      owners([
        { name: 'App\\Empty', kind: NS },
        { name: 'in_global', kind: FUNCTION },
        { name: 'App\\Br', kind: NS, children: [{ name: 'Z', kind: CLASS }] },
      ])
    ).toEqual(['(global) :: in_global', 'App\\Br :: Z']);
  });

  it('asks the source whether a childless namespace is an empty block', () => {
    const symbols = [
      { name: 'App\\Empty', kind: NS },
      { name: 'after', kind: FUNCTION },
    ];
    expect(owners(symbols, () => true)).toEqual(['(global) :: after']);
    expect(owners(symbols, () => false)).toEqual(['App\\Empty :: after']);
  });

  it('keeps the nested children of a declaration on it', () => {
    const one = { name: 'One', kind: CLASS, children: [{ name: 'run', kind: 6 }] };
    expect(phpDeclarations([{ name: 'App', kind: NS }, one])).toEqual([
      { symbol: one, namespace: 'App' },
    ]);
  });
});

describe('hasNamespaceSymbols', () => {
  it('is true only for a list that still holds a namespace statement', () => {
    expect(hasNamespaceSymbols([{ kind: CLASS }, { kind: NS }])).toBe(true);
    expect(hasNamespaceSymbols([{ kind: CLASS }])).toBe(false);
  });
});

describe('namespaceOpensBlock', () => {
  const source = '<?php\n\nnamespace App\\A {\n}\n\nnamespace App\\B;\n\nclass Y { }\n';

  it('tells a block from a statement by the line the namespace is on', () => {
    expect(namespaceOpensBlock(source, 2)).toBe(true);
    expect(namespaceOpensBlock(source, 5)).toBe(false);
  });

  it('is false without a source, and for a line past its end', () => {
    expect(namespaceOpensBlock(undefined, 2)).toBe(false);
    expect(namespaceOpensBlock(source, 99)).toBe(false);
  });
});

describe('bladeDeclarations', () => {
  const reported = [
    { name: 'html', kind: 8 },
    { name: '.page-break', kind: CLASS },
    { name: 'position', kind: CLASS },
    { name: 'toggleCollapse', kind: FUNCTION },
    { name: '$total', kind: 13 },
  ];

  it('keeps only the PHP variables of a Blade template', () => {
    expect(bladeDeclarations('resources/views/report.blade.php', reported)).toEqual([
      { name: '$total', kind: 13 },
    ]);
  });

  it('leaves every other PHP file as the server reported it', () => {
    expect(bladeDeclarations('app/Models/Invoice.php', reported)).toBe(reported);
  });
});
