/**
 * The one HTTP code path every runtime shares: `fetch` with `redirect: 'manual'`, a whole-call deadline, and
 * the retry policy — `query` retries on transport errors and on 5xx; `init`, `reverse` and `refund` retry only
 * when the request certainly never left the process.
 *
 * This module does not parse or verify response bodies — that needs the signing key and the field tables, which
 * belong to the payments and webhooks modules. It hands back whatever the gateway sent for any status, and
 * throws only when no response arrived at all.
 */

import type { Operation, ReconcileKey } from '../errors.js';
import { PrestoPayTransportError } from '../errors.js';
import { type RetryOptions, backoffDelayMs, interruptibleDelay, resolveRetryOptions, retryAfterMs } from '../retry.js';
import { combineSignals } from './abort.js';
import { isRequestNotSentError } from './http.js';

export interface SendRequest {
  readonly operation: Operation;
  /** Only `query` is safe to resend once a request may have reached the gateway. */
  readonly resendSafe: boolean;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Called fresh for every attempt: each one needs its own `ts` and signature. */
  readonly buildBody: () => Promise<Uint8Array>;
  /** Attached to a transport error on a non-resendable operation, so recovery is `query` by this key. */
  readonly reconcileBy?: ReconcileKey;
}

export interface SendConfig {
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly retryReads?: Partial<RetryOptions>;
}

export interface SendResult {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

const DEFAULT_DEADLINE_MS = 30_000;

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('deadline exceeded', 'TimeoutError')), ms);
  return controller.signal;
}

export async function send(request: SendRequest, config: SendConfig = {}): Promise<SendResult> {
  const fetchImpl = config.fetch ?? fetch;
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryOptions = resolveRetryOptions(config.retryReads);
  const deadlineSignal = timeoutSignal(deadlineMs);
  const combinedSignal = config.signal
    ? combineSignals([deadlineSignal, config.signal])
    : deadlineSignal;
  const deadlineAt = Date.now() + deadlineMs;

  for (let attempt = 0; ; attempt += 1) {
    if (combinedSignal.aborted) {
      throw new PrestoPayTransportError('the call was aborted or its deadline elapsed before a request was sent', {
        operation: request.operation,
        requestNotSent: true,
        cause: combinedSignal.reason,
      });
    }

    const body = await request.buildBody();
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: 'POST',
        redirect: 'manual',
        headers: request.headers,
        body: body as BodyInit,
        signal: combinedSignal,
      });
    } catch (cause) {
      const requestNotSent = isRequestNotSentError(cause);
      const canRetry = attempt < retryOptions.maxRetries && (request.resendSafe || requestNotSent);
      if (canRetry) {
        const delayMs = backoffDelayMs(attempt, retryOptions);
        await interruptibleDelay(remainingBudget(delayMs, deadlineAt), combinedSignal, request.operation);
        continue;
      }
      const indeterminate = !request.resendSafe && !requestNotSent;
      throw new PrestoPayTransportError(transportMessage(cause), {
        operation: request.operation,
        requestNotSent,
        cause,
        mayHaveTakenEffect: indeterminate,
        ...(indeterminate && request.reconcileBy ? { reconcileBy: request.reconcileBy } : {}),
      });
    }

    const canRetryStatus = request.resendSafe && response.status >= 500 && attempt < retryOptions.maxRetries;
    if (canRetryStatus) {
      const remaining = deadlineAt - Date.now();
      const delayMs = retryAfterMs(response.headers.get('retry-after'), Date.now()) ?? backoffDelayMs(attempt, retryOptions);
      if (delayMs < remaining) {
        await interruptibleDelay(delayMs, combinedSignal, request.operation);
        continue;
      }
    }

    const bodyText = await response.text();
    return { status: response.status, headers: response.headers, bodyText };
  }
}

/** Never sleeps past the whole-call deadline; a delay that would overrun it is clamped to what is left. */
function remainingBudget(delayMs: number, deadlineAt: number): number {
  return Math.max(0, Math.min(delayMs, deadlineAt - Date.now()));
}

function transportMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `request failed before a response was received: ${detail}`;
}
