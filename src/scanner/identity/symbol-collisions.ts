// Symbol node ids that two or more files declare.
//
// PHP symbol ids are not file-qualified: `symbol:php:<FQCN>::<member>`, or a bare name for a
// declaration outside any namespace (a global function, a script-level variable the language
// server reports). Two files can therefore declare the same id: two `config/aliases.php` files
// each holding `$aliases`, two `helpers.php` files each defining `helper()`, a class declared twice
// under one FQCN. Written into one `structural_nodes` row, such a pair keeps whichever file was
// processed last, so the index depended on processing order.
//
// The rule (identity/file-qualified-id.ts), decided before any node is written:
//   - an id declared by exactly one file keeps its form unchanged;
//   - an id declared by two or more files is file-qualified for every one of them — none keeps
//     the bare id — as `<bare id>#file:<repo-relative path>`, e.g.
//     `symbol:php:$aliases#file:src/Module/Users/config/aliases.php`.
// `#` cannot occur in a PHP name, so the qualified form never collides with a bare id, and the
// path is the declaring file's, so the result does not depend on processing order. A reference
// that names the bare id (`use App\Shared\Duplicate;`) is ambiguous and resolves to no node.

import type { AstLang, Extraction } from '../ast/extract.js';
import { astSymbolIdentity } from '../ast/symbols.js';
import {
  bareId,
  fileQualifiedId,
  idsDeclaredByManyFiles,
  type IdDeclaration,
} from './file-qualified-id.js';

/** One file's claim on a symbol id. */
export type SymbolDeclaration = IdDeclaration;

/** The set of symbol ids declared by more than one file in one index. */
export class SymbolIdCollisions {
  static readonly NONE = new SymbolIdCollisions(new Set());

  private droppedReferences = 0;

  private constructor(private readonly colliding: ReadonlySet<string>) {}

  /** Count a reference that named a shared id and so resolved to no node. */
  noteAmbiguousReference(): void {
    this.droppedReferences++;
  }

  /** References this rebuild dropped because they named a shared id. */
  get ambiguousReferences(): number {
    return this.droppedReferences;
  }

  /** Collect the ids that more than one distinct file declares. */
  static fromDeclarations(declarations: Iterable<SymbolDeclaration>): SymbolIdCollisions {
    const colliding = new Set(idsDeclaredByManyFiles(declarations).keys());
    return colliding.size === 0 ? SymbolIdCollisions.NONE : new SymbolIdCollisions(colliding);
  }

  /** The id a symbol declared in `relPath` is stored under. */
  qualify(id: string, relPath: string): string {
    return this.colliding.has(id) ? fileQualifiedId(id, relPath) : id;
  }

  has(id: string): boolean {
    return this.colliding.has(id);
  }

  get size(): number {
    return this.colliding.size;
  }
}

/** The id without its file qualifier (unchanged when it has none). */
export function bareSymbolId(id: string): string {
  return bareId(id);
}

/** The bare ids every AST definition in one file declares (the AST materializer's ids). */
export function astDeclarations(
  relPath: string,
  extraction: Extraction,
  lang: AstLang
): SymbolDeclaration[] {
  return extraction.nodes.map((def) => ({
    id: astSymbolIdentity(relPath, def, lang, extraction.namespace).id,
    relPath,
  }));
}
