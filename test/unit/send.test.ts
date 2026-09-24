import { describe, it, expect, vi } from 'vitest';
import { send } from '../../src/internal/send.js';
import { PrestoPayTransportError } from '../../src/errors.js';

const FAST_RETRY = { maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 5, jitter: false };

function req(overrides: Partial<Parameters<typeof send>[0]> = {}) {
  return {
    operation: 'query' as const,
    resendSafe: true,
    url: 'https://gateway.example/v1/ext/payment/query',
    headers: {},
    buildBody: async () => new TextEncoder().encode('{}'),
    ...overrides,
  };
}

function connectRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED'), {
    cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
}

function socketReset(): Error {
  return Object.assign(new Error('socket hang up'), {
    cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

describe('send: happy path', () => {
  it('returns the response as-is on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const result = await send(req(), { fetch: fetchImpl, retryReads: FAST_RETRY });
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('calls buildBody fresh for every attempt', async () => {
    let calls = 0;
    const buildBody = vi.fn(async () => {
      calls += 1;
      return new TextEncoder().encode(`attempt-${calls}`);
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(connectRefused())
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await send(req({ buildBody }), { fetch: fetchImpl, retryReads: FAST_RETRY });
    expect(buildBody).toHaveBeenCalledTimes(2);
  });
});

describe('send: query retries', () => {
  it('retries a transport error and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(connectRefused())
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await send(req(), { fetch: fetchImpl, retryReads: FAST_RETRY });
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await send(req(), { fetch: fetchImpl, retryReads: FAST_RETRY });
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and returns the last 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('err', { status: 503 }));
    const result = await send(req(), { fetch: fetchImpl, retryReads: { ...FAST_RETRY, maxRetries: 2 } });
    expect(result.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry a 4xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('err', { status: 400 }));
    const result = await send(req(), { fetch: fetchImpl, retryReads: FAST_RETRY });
    expect(result.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After over the computed backoff', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 503, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const start = Date.now();
    const result = await send(req(), { fetch: fetchImpl, retryReads: FAST_RETRY });
    expect(result.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('send: init/reverse/refund never resend once bytes may have left', () => {
  it('does not retry a 500 for init', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    const result = await send(req({ operation: 'init', resendSafe: false }), {
      fetch: fetchImpl,
      retryReads: FAST_RETRY,
    });
    expect(result.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a connect-phase failure (request certainly never left)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(connectRefused())
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await send(req({ operation: 'init', resendSafe: false }), {
      fetch: fetchImpl,
      retryReads: FAST_RETRY,
    });
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry ECONNRESET, and stamps mayHaveTakenEffect + reconcileBy', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(socketReset());
    const promise = send(
      req({ operation: 'init', resendSafe: false, reconcileBy: { txnRefNum: 'order-1' } }),
      { fetch: fetchImpl, retryReads: FAST_RETRY },
    );
    await expect(promise).rejects.toBeInstanceOf(PrestoPayTransportError);
    await promise.catch((err: PrestoPayTransportError) => {
      expect(err.requestNotSent).toBe(false);
      expect(err.mayHaveTakenEffect).toBe(true);
      expect(err.reconcileBy).toEqual({ txnRefNum: 'order-1' });
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a fully connect-phase failure is requestNotSent: true with no reconcileBy needed', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(connectRefused());
    const promise = send(
      req({ operation: 'reverse', resendSafe: false, reconcileBy: { paymentRefNum: 'pp-1' } }),
      { fetch: fetchImpl, retryReads: { ...FAST_RETRY, maxRetries: 0 } },
    );
    await promise.catch((err: PrestoPayTransportError) => {
      expect(err.requestNotSent).toBe(true);
      expect(err.mayHaveTakenEffect).toBe(false);
      expect(err.reconcileBy).toBeUndefined();
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayTransportError);
  });
});

describe('send: deadline and abort', () => {
  it('throws requestNotSent: true when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by caller'));
    const fetchImpl = vi.fn();
    const promise = send(req({ operation: 'init', resendSafe: false }), {
      fetch: fetchImpl,
      signal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ requestNotSent: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an abort mid-flight is requestNotSent: false (the request may have reached the server)', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const controller = new AbortController();
    const promise = send(req({ operation: 'refund', resendSafe: false }), {
      fetch: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
      retryReads: { ...FAST_RETRY, maxRetries: 0 },
    });
    setTimeout(() => controller.abort(new Error('caller cancelled mid-flight')), 5);
    await promise.catch((err: PrestoPayTransportError) => {
      expect(err.requestNotSent).toBe(false);
      expect(err.mayHaveTakenEffect).toBe(true);
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayTransportError);
  });

  it('a short deadline aborts a slow gateway', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          reject(new DOMException('aborted', 'TimeoutError'));
        });
      });
    });
    const promise = send(req(), {
      fetch: fetchImpl as unknown as typeof fetch,
      deadlineMs: 10,
      retryReads: { ...FAST_RETRY, maxRetries: 0 },
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayTransportError);
  });
});
