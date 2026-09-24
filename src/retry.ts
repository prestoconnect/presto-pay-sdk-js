/**
 * The `retryReads` policy. Named for what it governs — only `query` — so that a top-level
 * `retry: { maxRetries: 2 }` never reads as "the SDK retries my payments twice."
 */

import { PrestoPayTransportError } from './errors.js';

export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitter: boolean;
}

export const DEFAULT_RETRY_READS: RetryOptions = {
  maxRetries: 2,
  initialBackoffMs: 200,
  maxBackoffMs: 5_000,
  jitter: true,
};

export function resolveRetryOptions(overrides?: Partial<RetryOptions>): RetryOptions {
  return { ...DEFAULT_RETRY_READS, ...overrides };
}

/**
 * Exponential backoff capped at `maxBackoffMs`, with full jitter (a uniform draw between 0 and the cap) on by
 * default so a fleet does not retry a gateway blip in lockstep. `attempt` is 0 for the delay before the first
 * retry.
 */
export function backoffDelayMs(attempt: number, options: RetryOptions): number {
  const exponential = options.initialBackoffMs * 2 ** attempt;
  const capped = Math.min(exponential, options.maxBackoffMs);
  return options.jitter ? Math.random() * capped : capped;
}

/**
 * `Retry-After` (seconds, or an HTTP-date) is honoured over the computed delay when present, still subject to
 * the remaining deadline — the caller clamps the result.
 */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * Sleeps, but is interrupted by `signal`: an abort during backoff throws immediately rather than waiting out the
 * delay, and always as `requestNotSent: false` — the previous attempt already had its outcome decided, and this
 * sleep is just the space between attempts, not a decision about whether the next one would count.
 */
export async function interruptibleDelay(
  ms: number,
  signal: AbortSignal,
  operation: import('./errors.js').Operation,
): Promise<void> {
  if (signal.aborted) {
    throw new PrestoPayTransportError('the call was aborted while waiting to retry', {
      operation,
      requestNotSent: false,
      cause: signal.reason,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new PrestoPayTransportError('the call was aborted while waiting to retry', {
          operation,
          requestNotSent: false,
          cause: signal.reason,
        }),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
