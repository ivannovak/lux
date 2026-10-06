import { describe, expect, it } from 'vitest';
import { bareSymbolId, SymbolIdCollisions } from '../symbol-collisions.js';
import { isFileQualifiedId } from '../file-qualified-id.js';
import { idPortability } from '../../associations/federation.js';

describe('SymbolIdCollisions', () => {
  const declarations = [
    { id: 'symbol:php:$aliases', relPath: 'src/Module/B/config/aliases.php' },
    { id: 'symbol:php:App\\Unique', relPath: 'src/Unique.php' },
    { id: 'symbol:php:$aliases', relPath: 'src/Module/A/config/aliases.php' },
    // AST and LSP declare the same id for one file: that is not a collision.
    { id: 'symbol:php:App\\Unique', relPath: 'src/Unique.php' },
  ];

  it('file-qualifies every declarer of a shared id and leaves unique ids alone', () => {
    const collisions = SymbolIdCollisions.fromDeclarations(declarations);
    expect(collisions.size).toBe(1);
    expect(collisions.qualify('symbol:php:$aliases', 'src/Module/A/config/aliases.php')).toBe(
      'symbol:php:$aliases#file:src/Module/A/config/aliases.php'
    );
    expect(collisions.qualify('symbol:php:$aliases', 'src/Module/B/config/aliases.php')).toBe(
      'symbol:php:$aliases#file:src/Module/B/config/aliases.php'
    );
    expect(collisions.qualify('symbol:php:App\\Unique', 'src/Unique.php')).toBe(
      'symbol:php:App\\Unique'
    );
  });

  it('does not depend on the order declarations arrive in', () => {
    const forward = SymbolIdCollisions.fromDeclarations(declarations);
    const reverse = SymbolIdCollisions.fromDeclarations([...declarations].reverse());
    for (const { id, relPath } of declarations) {
      expect(reverse.qualify(id, relPath)).toBe(forward.qualify(id, relPath));
    }
  });

  it('reads persisted qualified ids back to their bare form', () => {
    const collisions = SymbolIdCollisions.fromDeclarations([
      { id: 'symbol:php:helper#file:a.php', relPath: 'a.php' },
      { id: 'symbol:php:helper', relPath: 'b.php' },
    ]);
    expect(collisions.has('symbol:php:helper')).toBe(true);
    expect(bareSymbolId('symbol:php:helper#file:a.php')).toBe('symbol:php:helper');
    expect(bareSymbolId('symbol:php:helper')).toBe('symbol:php:helper');
  });

  it('marks qualified ids repo-local for federation, even for a namespaced name', () => {
    const qualified = 'symbol:php:App\\Shared\\Duplicate#file:src/Gamma/Duplicate.php';
    expect(isFileQualifiedId(qualified)).toBe(true);
    expect(idPortability(qualified)).toBe('repo-local');
    expect(idPortability('symbol:php:App\\Shared\\Duplicate')).toBe('portable');
  });
});
