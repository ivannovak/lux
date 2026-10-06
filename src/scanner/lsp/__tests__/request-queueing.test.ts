// The language servers Lux drives answer one request at a time. A request sent while the server
// is busy only waits in the server's queue with its timeout running, so the timeout measures the
// queue and not the work, and a slow-but-fine request is reported as timed out. The client
// therefore sends one request at a time, cancels a request that timed out before sending it
// again, and does not send the next request while the server is still on a cancelled one.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspClient } from '../client.js';

// A server that works on one request at a time, like intelephense.
//   test/work   costs COST ms; answers { tookMs } measured from the moment the request arrived
//   test/hang   is never answered — unless LATE is set, in which case it is answered "stale"
//               LATE ms after its cancellation arrives
//   test/flaky  is "test/hang" the first time and answers "fresh" after that, FRESH ms later
//   test/boot   costs BOOT ms the first time it is asked and nothing after that
//   test/quota  is answered for the first QUOTA requests and never after that; every arrival is
//               appended to the file ARRIVALS, since a silent server cannot be asked for its log
//   test/log    answers with every message received so far, as "method:id" strings, plus
//               "answered:<id>" for each late answer written
const SERIAL_SERVER = String.raw`
const [COST, LATE, FRESH, BOOT, QUOTA] = process.argv.slice(1, 6).map(Number);
const ARRIVALS = process.argv[6];
let quotaSeen = 0;
let buffer = Buffer.alloc(0);
const queue = [];
const log = [];
const unanswered = new Set();
let busy = false;
let flakySeen = false;
let booted = false;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
};
const next = () => {
  if (busy || queue.length === 0) return;
  busy = true;
  const { message, arrivedAt } = queue.shift();
  setTimeout(() => {
    send({ jsonrpc: '2.0', id: message.id, result: { tookMs: Date.now() - arrivedAt } });
    busy = false;
    next();
  }, COST);
};
const handle = (message) => {
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
  if (message.method === 'shutdown') return send({ jsonrpc: '2.0', id: message.id, result: null });
  if (message.method === 'exit') return process.exit(0);
  if (message.method === 'initialized') return;
  if (message.method === '$/cancelRequest') {
    const id = message.params.id;
    log.push('cancel:' + id);
    if (LATE >= 0 && unanswered.delete(id)) {
      setTimeout(() => {
        log.push('answered:' + id);
        send({ jsonrpc: '2.0', id, result: 'stale' });
      }, LATE);
    }
    return;
  }
  log.push(message.method + ':' + message.id);
  if (message.method === 'test/work') {
    queue.push({ message, arrivedAt: Date.now() });
    return next();
  }
  if (message.method === 'test/boot') {
    const delay = booted ? 0 : BOOT;
    booted = true;
    return void setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: 'up' }), delay);
  }
  if (message.method === 'test/quota') {
    require('fs').appendFileSync(ARRIVALS, message.params.n + '\n');
    if (quotaSeen++ < QUOTA) return send({ jsonrpc: '2.0', id: message.id, result: 'ok' });
    return;
  }
  if (message.method === 'test/log') return send({ jsonrpc: '2.0', id: message.id, result: log });
  if (message.method === 'test/flaky' && flakySeen) {
    return void setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: 'fresh' }), FRESH);
  }
  flakySeen = flakySeen || message.method === 'test/flaky';
  unanswered.add(message.id);
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf-8'));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
`;

const clients: LspClient[] = [];
const scratch: string[] = [];

afterEach(async () => {
  while (clients.length) await clients.pop()!.shutdown();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

async function startClient(options: {
  costMs?: number;
  lateMs?: number;
  freshMs?: number;
  bootMs?: number;
  initTimeoutMs?: number;
  quota?: number;
  arrivals?: string;
  requestTimeoutMs: number;
}): Promise<LspClient> {
  const client = new LspClient({
    serverCommand: process.execPath,
    serverArgs: [
      '-e',
      SERIAL_SERVER,
      String(options.costMs ?? 0),
      String(options.lateMs ?? -1),
      String(options.freshMs ?? 0),
      String(options.bootMs ?? 0),
      String(options.quota ?? 0),
      options.arrivals ?? '',
    ],
    requestTimeoutMs: options.requestTimeoutMs,
    initTimeoutMs: options.initTimeoutMs ?? options.requestTimeoutMs,
    serverLabel: 'stub',
  });
  clients.push(client);
  await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} });
  return client;
}

describe('requests to a server that answers one at a time', () => {
  it('are each answered in about their own cost, however many callers are waiting', async () => {
    const costMs = 60;
    const client = await startClient({ costMs, requestTimeoutMs: 10_000 });
    const answers = await Promise.all(
      Array.from({ length: 16 }, (_, n) => client.request<{ tookMs: number }>('test/work', { n }))
    );
    // Sent four at a time, the fourth of each group is answered 4 × cost after it arrived.
    const slowest = Math.max(...answers.map((answer) => answer.tookMs));
    expect(slowest).toBeLessThan(costMs + 45);
  });

  it('cancels a request that timed out before sending it again, under a new id', async () => {
    const client = await startClient({ requestTimeoutMs: 150 });
    await expect(client.request('test/flaky', {})).resolves.toBe('fresh');
    const log = await client.request<string[]>('test/log', {});
    const [first, cancel, retry] = log;
    const firstId = first.split(':')[1];
    expect(first).toBe(`test/flaky:${firstId}`);
    expect(cancel).toBe(`cancel:${firstId}`);
    expect(retry).toMatch(/^test\/flaky:\d+$/);
    expect(retry).not.toBe(first);
  });

  it('drops a late answer to a cancelled request', async () => {
    const client = await startClient({ lateMs: 20, requestTimeoutMs: 150 });
    await expect(client.request('test/flaky', {})).resolves.toBe('fresh');
  });

  it('does not give the retry an answer that arrives for the cancelled request', async () => {
    // Timeline: 0 sent; 200 timed out and cancelled; 400 the wait for the cancelled request ends
    // and the retry is sent; 500 the server answers the cancelled request "stale"; 550 it
    // answers the retry "fresh".
    const client = await startClient({ lateMs: 300, freshMs: 150, requestTimeoutMs: 200 });
    await expect(client.request('test/flaky', {})).resolves.toBe('fresh');
  });

  it('does not send the next request while the server is still on a cancelled one', async () => {
    // Both attempts of the hanging request time out; the server answers each 100 ms after its
    // cancellation. A request written before then would have that time charged to its timeout.
    const client = await startClient({ lateMs: 100, requestTimeoutMs: 150 });
    await expect(client.request('test/hang', {})).rejects.toThrow(/timed out/);
    const log = await client.request<string[]>('test/log', {});
    const abandoned = log.filter((entry) => entry.startsWith('test/hang:'));
    expect(abandoned).toHaveLength(2);
    const lastAnswered = `answered:${abandoned[1].split(':')[1]}`;
    expect(log).toContain(lastAnswered);
    expect(log.indexOf(lastAnswered)).toBeLessThan(log.findIndex((e) => e.startsWith('test/log')));
  });

  it('gives the first request the initialization timeout, and later ones their own', async () => {
    // The server's first answer takes 400 ms of start-up; a request costs nothing after that.
    const client = await startClient({ bootMs: 400, requestTimeoutMs: 100, initTimeoutMs: 5_000 });
    await expect(client.request('test/boot', {})).resolves.toBe('up');
    expect(await client.request<string[]>('test/log', {})).toEqual(['test/boot:2', 'test/log:3']);
    await expect(client.request('test/hang', {})).rejects.toThrow(/timed out after 100ms/);
  });

  it('gives that allowance to one request only, even if the server never answers it', async () => {
    const client = await startClient({ requestTimeoutMs: 100, initTimeoutMs: 400 });
    const started = Date.now();
    // 400 ms for the first attempt, then 100 ms for the retry and for every request after it.
    await expect(client.request('test/hang', {})).rejects.toThrow(/timed out after 100ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    await expect(client.request('test/hang', {})).rejects.toThrow(/timed out after 100ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('carries on after a cancelled request the server never answers', async () => {
    const client = await startClient({ requestTimeoutMs: 100 });
    await expect(client.request('test/hang', {})).rejects.toThrow(/timed out/);
    const started = Date.now();
    await expect(client.request<string[]>('test/log', {})).resolves.toContain('cancel:2');
    // The slot is held for one more timeout period, not indefinitely.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('a server that stops answering', () => {
  it('is given up on after two requests and their retries, however many files remain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lux-lsp-silent-'));
    scratch.push(dir);
    const arrivals = join(dir, 'arrivals');
    const timeoutMs = 100;
    const client = await startClient({ quota: 5, arrivals, requestTimeoutMs: timeoutMs });

    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, n) => client.request('test/quota', { n }))
    );
    const elapsed = Date.now() - started;

    expect(results.slice(0, 5).every((result) => result.status === 'fulfilled')).toBe(true);
    const reasons = results
      .slice(5)
      .map((result) => String((result as PromiseRejectedResult).reason));
    expect(new Set(reasons)).toEqual(
      new Set([
        'LspTransientError: stub language server stopped answering: no response to 4 request attempts in a row',
      ])
    );
    // Four attempts, each a timeout and the wait for the cancelled request: 8 timeout periods.
    // Left to run, the 55 unanswered files would take 55 × 4 periods = 22 s.
    expect(elapsed).toBeGreaterThanOrEqual(8 * timeoutMs);
    expect(elapsed).toBeLessThan(8 * timeoutMs + 700);
    // The server saw the five it answered and the four attempts that went unanswered; nothing else.
    expect(readFileSync(arrivals, 'utf-8').trim().split('\n')).toHaveLength(9);
    // Nothing more is sent, and the caller is told at once.
    const again = Date.now();
    await expect(client.request('test/quota', { n: 99 })).rejects.toThrow(/stopped answering/);
    expect(Date.now() - again).toBeLessThan(50);
    expect(readFileSync(arrivals, 'utf-8').trim().split('\n')).toHaveLength(9);
  });

  it('is not given up on for single requests it never answers between ones it does', async () => {
    const client = await startClient({ requestTimeoutMs: 60 });
    for (let round = 0; round < 3; round++) {
      await expect(client.request('test/hang', {})).rejects.toThrow(/timed out/);
      await expect(client.request('test/boot', {})).resolves.toBe('up');
    }
  });

  it('is not given up on while it still acknowledges what it could not answer in time', async () => {
    // Every attempt times out, and each is answered 20 ms after its cancellation.
    const client = await startClient({ lateMs: 20, requestTimeoutMs: 60 });
    for (let round = 0; round < 4; round++) {
      await expect(client.request('test/hang', {})).rejects.toThrow(/timed out/);
    }
  });
});
