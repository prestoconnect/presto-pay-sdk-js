import { describe, it, expect, vi } from 'vitest';
import { backoffDelayMs, interruptibleDelay, resolveRetryOptions, retryAfterMs } from '../../src/retry.js';
import { PrestoPayTransportError } from '../../src/errors.js';

describe('resolveRetryOptions', () => {
  it('applies defaults and lets overrides through', () => {
    expect(resolveRetryOptions()).toEqual({
      maxRetries: 2,
      initialBackoffMs: 200,
      maxBackoffMs: 5_000,
      jitter: true,
    });
    expect(resolveRetryOptions({ maxRetries: 5 }).maxRetries).toBe(5);
    expect(resolveRetryOptions({ maxRetries: 5 }).initialBackoffMs).toBe(200);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially and caps at maxBackoffMs, without jitter', () => {
    const options = { maxRetries: 5, initialBackoffMs: 100, maxBackoffMs: 1000, jitter: false };
    expect(backoffDelayMs(0, options)).toBe(100);
    expect(backoffDelayMs(1, options)).toBe(200);
    expect(backoffDelayMs(2, options)).toBe(400);
    expect(backoffDelayMs(5, options)).toBe(1000); // capped
  });

  it('with jitter, stays within [0, cap]', () => {
    const options = { maxRetries: 5, initialBackoffMs: 100, maxBackoffMs: 1000, jitter: true };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const delay = backoffDelayMs(attempt, options);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(Math.min(100 * 2 ** attempt, 1000));
    }
  });
});

describe('retryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(retryAfterMs('5', 1_000)).toBe(5_000);
    expect(retryAfterMs('0', 1_000)).toBe(0);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const future = new Date(now + 10_000).toUTCString();
    expect(retryAfterMs(future, now)).toBe(10_000);
  });

  it('returns undefined for no header or garbage', () => {
    expect(retryAfterMs(null, 0)).toBeUndefined();
    expect(retryAfterMs('not-a-date-or-number', 0)).toBeUndefined();
  });

  it('never returns negative for a past HTTP-date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const past = new Date(now - 10_000).toUTCString();
    expect(retryAfterMs(past, now)).toBe(0);
  });
});

describe('interruptibleDelay', () => {
  it('resolves after the delay when not aborted', async () => {
    const controller = new AbortController();
    await expect(interruptibleDelay(5, controller.signal, 'query')).resolves.toBeUndefined();
  });

  it('rejects immediately if already aborted, as requestNotSent: false', async () => {
    const controller = new AbortController();
    controller.abort(new Error('boom'));
    await expect(interruptibleDelay(1000, controller.signal, 'init')).rejects.toMatchObject({
      requestNotSent: false,
    });
  });

  it('rejects as soon as the signal aborts mid-delay', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = interruptibleDelay(10_000, controller.signal, 'refund');
      const assertion = expect(pending).rejects.toBeInstanceOf(PrestoPayTransportError);
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
