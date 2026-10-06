// Server-initiated requests must be answered, not dropped.
//
// A JSON-RPC message carrying both an `id` and a `method` is a request FROM the
// server. Before this was handled, handleMessage() looked the id up in its
// pending-request map, missed, and returned — so the server waited forever for
// a reply that was never coming. Volar issues workspace/configuration
// immediately after `initialized` and serves no documentSymbol until it is
// answered, which presented as an enricher that ran and produced nothing.

import { describe, it, expect, vi } from 'vitest';
import { LspClient } from '../client.js';

interface JsonRpcReply {
  jsonrpc: string;
  id: number;
  result: unknown;
  error?: unknown;
}

/** An LspClient whose stdout frames can be fed in and whose writes are captured. */
function makeClient() {
  const client = new LspClient({ serverCommand: 'noop' });
  const written: string[] = [];

  // Stand in for the spawned process: only stdin.writable + write() are used
  // on the response path.
  (client as unknown as { process: unknown }).process = {
    stdin: {
      writable: true,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    },
  };

  const deliver = (message: unknown) =>
    (client as unknown as { handleMessage: (m: unknown) => void }).handleMessage(message);

  /** Parse the JSON bodies of everything the client wrote back. */
  const replies = (): JsonRpcReply[] =>
    written.map((frame) => JSON.parse(frame.slice(frame.indexOf('\r\n\r\n') + 4)) as JsonRpcReply);

  return { client, deliver, replies, written };
}

describe('LspClient — server-initiated requests', () => {
  it('answers workspace/configuration with one null per requested item', () => {
    const { deliver, replies } = makeClient();

    deliver({
      jsonrpc: '2.0',
      id: 7,
      method: 'workspace/configuration',
      params: { items: [{ section: 'css.customData' }, { section: 'vue.inlayHints' }] },
    });

    expect(replies()).toEqual([{ jsonrpc: '2.0', id: 7, result: [null, null] }]);
  });

  it('answers an empty configuration request with an empty array, not null', () => {
    const { deliver, replies } = makeClient();
    deliver({ jsonrpc: '2.0', id: 8, method: 'workspace/configuration', params: { items: [] } });
    expect(replies()[0].result).toEqual([]);
  });

  it('answers an unknown server request with a null result rather than an error', () => {
    const { deliver, replies } = makeClient();

    deliver({ jsonrpc: '2.0', id: 9, method: 'client/registerCapability', params: {} });

    const reply = replies()[0];
    expect(reply).toEqual({ jsonrpc: '2.0', id: 9, result: null });
    expect(reply.error).toBeUndefined();
  });

  it('emits a well-formed Content-Length frame', () => {
    const { deliver, written } = makeClient();
    deliver({ jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}] } });

    const frame = written[0];
    const body = frame.slice(frame.indexOf('\r\n\r\n') + 4);
    const declared = Number(/Content-Length: (\d+)/.exec(frame)![1]);
    expect(declared).toBe(Buffer.byteLength(body, 'utf-8'));
  });

  it('still resolves a genuine response, which has an id but no method', async () => {
    const { client, deliver, written } = makeClient();

    const pending = (
      client as unknown as {
        pending: Map<number, { resolve: (v: unknown) => void; timer: unknown; settle: () => void }>;
      }
    ).pending;
    const seen: unknown[] = [];
    pending.set(42, {
      resolve: (v: unknown) => seen.push(v),
      timer: setTimeout(() => {}, 0),
      settle: () => {},
    });

    deliver({ jsonrpc: '2.0', id: 42, result: { ok: true } });

    expect(seen).toEqual([{ ok: true }]);
    // A response is consumed, never answered.
    expect(written).toEqual([]);
    expect(pending.has(42)).toBe(false);
  });

  it('does not answer a notification, which has a method but no id', () => {
    const { deliver, written } = makeClient();
    deliver({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'hi' } });
    expect(written).toEqual([]);
  });

  it('drops a server request silently when stdin is not writable', () => {
    const { client, deliver, written } = makeClient();
    (client as unknown as { process: { stdin: { writable: boolean } } }).process.stdin.writable =
      false;

    expect(() =>
      deliver({ jsonrpc: '2.0', id: 3, method: 'workspace/configuration', params: { items: [{}] } })
    ).not.toThrow();
    expect(written).toEqual([]);
  });
});

describe('LspClient — regression guard', () => {
  it('answers rather than dropping, which is what made the enricher silent', () => {
    // Before the fix this produced zero writes: the id missed the pending map
    // and handleMessage returned. Asserting on the WRITE is the point — a test
    // that only checked "did not throw" passed against the broken version too.
    const { deliver, written } = makeClient();
    deliver({
      jsonrpc: '2.0',
      id: 100,
      method: 'workspace/configuration',
      params: { items: [{ section: 'vue' }] },
    });
    expect(written.length).toBe(1);
  });
});

// Guard against the mock drifting from the real signature.
describe('test harness fidelity', () => {
  it('uses the real handleMessage, not a stub', () => {
    const { client } = makeClient();
    const fn = (client as unknown as { handleMessage: unknown }).handleMessage;
    expect(typeof fn).toBe('function');
    expect(vi.isMockFunction(fn)).toBe(false);
  });
});
