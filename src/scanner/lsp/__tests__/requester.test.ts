// How an enricher's request outcomes are classified (lsp/requester.ts): nothing a server says or
// fails to say may become "no data for this file" without a record.

import { describe, expect, it } from 'vitest';
import { LspResponseError, LspTransientError, type LspClient } from '../client.js';
import { isKnownEmptyError, LspRequester, type KnownEmptyError } from '../requester.js';

const CONTEXT = { filePath: '/repo/src/a.php', stage: 'symbols' as const };

function requesterFor(
  capabilities: Record<string, unknown>,
  answer: (method: string) => unknown,
  knownEmpty?: KnownEmptyError[]
) {
  const asked: string[] = [];
  const client = {
    serverCapabilities: { capabilities, serverInfo: { name: 'stub-server' } },
    request: (method: string) => {
      asked.push(method);
      try {
        return Promise.resolve(answer(method));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  } as unknown as LspClient;
  return { requester: new LspRequester(client, knownEmpty), asked };
}

describe('LspRequester', () => {
  it('does not ask for a capability the server did not declare, and records nothing', async () => {
    const { requester, asked } = requesterFor({ documentSymbolProvider: true }, () => []);
    const result = await requester.ask(
      CONTEXT,
      'textDocument/prepareTypeHierarchy',
      'typeHierarchyProvider',
      {}
    );
    expect(result).toBeUndefined();
    expect(asked).toEqual([]);
    expect(requester.drain()).toEqual([]);
  });

  it('returns the result of a declared capability', async () => {
    const { requester } = requesterFor({ documentSymbolProvider: {} }, () => [{ name: 'A' }]);
    expect(
      await requester.ask(CONTEXT, 'textDocument/documentSymbol', 'documentSymbolProvider', {})
    ).toEqual([{ name: 'A' }]);
  });

  it('records MethodNotFound for a declared capability as a capability gap', async () => {
    const { requester } = requesterFor({ typeHierarchyProvider: true }, () => {
      throw new LspResponseError(-32601, 'Unhandled method');
    });
    expect(
      await requester.ask(CONTEXT, 'typeHierarchy/supertypes', 'typeHierarchyProvider', {})
    ).toBeUndefined();
    expect(requester.drain()).toEqual([
      { ...CONTEXT, kind: 'capability', method: 'typeHierarchy/supertypes', code: -32601 },
    ]);
    expect(requester.drain()).toEqual([]);
  });

  it('records any other error answer for the file, with its method and code', async () => {
    const { requester } = requesterFor({ referencesProvider: true }, () => {
      throw new LspResponseError(-32603, 'Internal error');
    });
    await requester.ask(CONTEXT, 'textDocument/references', 'referencesProvider', {});
    expect(requester.drain()).toEqual([
      { ...CONTEXT, kind: 'response', method: 'textDocument/references', code: -32603 },
    ]);
  });

  it('treats an allowlisted error as an empty result and records nothing', async () => {
    const entry: KnownEmptyError = {
      server: /^stub-server$/,
      method: 'textDocument/references',
      code: -32001,
      message: /no symbol at position/,
      citation: 'test fixture',
    };
    const { requester } = requesterFor(
      { referencesProvider: true },
      () => {
        throw new LspResponseError(-32001, 'no symbol at position');
      },
      [entry]
    );
    expect(
      await requester.ask(CONTEXT, 'textDocument/references', 'referencesProvider', {})
    ).toBeUndefined();
    expect(requester.drain()).toEqual([]);
    // The same code from another server, or with another message, is not on the list.
    const other = new LspResponseError(-32001, 'something else');
    expect(isKnownEmptyError([entry], 'stub-server', 'textDocument/references', other)).toBe(false);
    expect(
      isKnownEmptyError(
        [entry],
        'another-server',
        'textDocument/references',
        new LspResponseError(-32001, 'no symbol at position')
      )
    ).toBe(false);
  });

  it('lets a timeout or a dead transport through, so the file fails', async () => {
    const { requester } = requesterFor({ referencesProvider: true }, () => {
      throw new LspTransientError('timeout', 'timed out');
    });
    await expect(
      requester.ask(CONTEXT, 'textDocument/references', 'referencesProvider', {})
    ).rejects.toBeInstanceOf(LspTransientError);
  });
});
