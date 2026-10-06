// A language server can answer a request successfully and still say nothing: intelephense answers
// `null` to documentSymbol for a document it does not hold open, and `[]` for one that is closed
// under the request. Read as "this file has no symbols", such an answer leaves the file's LSP data
// out of the index with nothing recorded. The source says whether an empty answer is believable.

import { extractSource, getGrammars } from '../ast/extract.js';
import { LspTransientError } from './client.js';

/**
 * The server said nothing about a file that has something in it, and said so again when asked a
 * second time with the document re-opened. Like a timeout it says nothing about the file, so it
 * is a transient failure: every pass that records those records this too.
 */
export class LspEmptyAnswerError extends LspTransientError {
  constructor(
    readonly method: string,
    readonly answered: 'null' | 'empty'
  ) {
    super(
      'empty',
      answered === 'null'
        ? `${method} answered null: the server did not have the document open`
        : `${method} answered empty for a file that declares symbols`
    );
    this.name = 'LspEmptyAnswerError';
  }
}

/** Whether the PHP source declares a class, interface, trait, enum, function or method. */
export async function phpSourceDeclaresSymbols(filePath: string, source: string): Promise<boolean> {
  const grammars = await getGrammars();
  return extractSource(grammars, source, filePath, 'php').extraction.nodes.length > 0;
}
