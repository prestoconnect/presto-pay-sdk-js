/**
 * js-plan.md §6: "a Node suite drives real sockets for each case ... on every Node version in CI. A Node or
 * undici upgrade that changes codes fails these tests instead of silently changing retry behavior."
 *
 * This exercises the real `fetch`/undici stack against real listeners, not an injected fake, so what is proven
 * here is that Node's actual error codes land where `isRequestNotSentError` (src/internal/http.ts) expects them.
 */
import { createServer, type Server } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { send } from '../../src/internal/send.js';

const FAST_RETRY = { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 1, jitter: false };

function req(url: string, overrides: Partial<Parameters<typeof send>[0]> = {}) {
  return {
    operation: 'init' as const,
    resendSafe: false,
    url,
    headers: {},
    buildBody: async () => new TextEncoder().encode('{}'),
    ...overrides,
  };
}

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('requestNotSent against real sockets', () => {
  it('a closed port (ECONNREFUSED) is requestNotSent: true', async () => {
    // Bind then immediately close, so the port is (almost certainly) free but nothing is listening.
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const promise = send(req(`http://127.0.0.1:${port}/v1/ext/payment/init`), { retryReads: FAST_RETRY });
    await promise.catch((err) => {
      expect(err.requestNotSent).toBe(true);
      expect(err.mayHaveTakenEffect).toBe(false);
    });
    await expect(promise).rejects.toThrow();
  }, 10_000);

  it('an unresolvable host (ENOTFOUND/EAI_AGAIN) is requestNotSent: true', async () => {
    // RFC 2606 reserves .invalid as guaranteed never to resolve.
    const promise = send(req('https://presto-pay-sdk-js-test.invalid/v1/ext/payment/init'), {
      retryReads: FAST_RETRY,
      deadlineMs: 10_000,
    });
    await promise.catch((err) => {
      expect(err.requestNotSent).toBe(true);
      expect(err.mayHaveTakenEffect).toBe(false);
    });
    await expect(promise).rejects.toThrow();
  }, 15_000);

  it('a connection reset after the body was sent is requestNotSent: false', async () => {
    server = createServer((socket) => {
      // Read whatever the client sends, then reset the connection instead of answering — the request
      // reached the server, so this is exactly the ambiguous case §6 calls out by name.
      socket.on('data', () => {
        socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    const promise = send(req(`http://127.0.0.1:${port}/v1/ext/payment/init`), { retryReads: FAST_RETRY });
    await promise.catch((err) => {
      expect(err.requestNotSent).toBe(false);
      expect(err.mayHaveTakenEffect).toBe(true);
    });
    await expect(promise).rejects.toThrow();
  }, 10_000);

  it('slow headers past the deadline is requestNotSent: false (already in flight)', async () => {
    server = createServer((socket) => {
      // Accept the connection and read the request, but never write a response.
      socket.on('data', () => {
        /* deliberately never responds */
      });
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });

    const promise = send(req(`http://127.0.0.1:${port}/v1/ext/payment/init`), {
      retryReads: FAST_RETRY,
      deadlineMs: 100,
    });
    await promise.catch((err) => {
      expect(err.requestNotSent).toBe(false);
      expect(err.mayHaveTakenEffect).toBe(true);
    });
    await expect(promise).rejects.toThrow();
  }, 10_000);
});
