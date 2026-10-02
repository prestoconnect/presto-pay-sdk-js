/**
 * The merchant's reply to a webhook delivery: HTTP 200 with `{"resend":false}` (accepted)
 * or `{"resend":true}` (ask Presto to resend). Presto retries on its own backoff of 2, 4, 8, … 1024 minutes, so
 * `forError` matters: answering a permanent failure — bad signature, a foreign `mid`, a stale `ts` — with
 * `resend:true` buys ten redeliveries that fail identically. Those map to `ok`; a merchant's own transient
 * failure (the database was down, or a `query` inside the handler failed) maps to `resend`.
 */
import { isPrestoPayError } from '../errors.js';

const OK_BODY = '{"resend":false}';
const RESEND_BODY = '{"resend":true}';

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function isPermanentFailure(error: unknown): boolean {
  // Only a webhook that failed verification fails the same way on every redelivery. The same error types from an
  // outbound call inside the handler carry source 'response', and that event must be delivered again.
  return (
    isPrestoPayError(error) &&
    (error.name === 'PrestoPaySignatureError' || error.name === 'PrestoPayResponseError') &&
    (error as { source?: unknown }).source === 'webhook'
  );
}

export const NotifyAck = Object.freeze({
  ok: OK_BODY,
  resend: RESEND_BODY,
  okResponse: (): Response => jsonResponse(OK_BODY),
  resendResponse: (): Response => jsonResponse(RESEND_BODY),
  /** `ok` for a webhook that failed verification (permanent — retrying changes nothing); `resend` otherwise. */
  forError: (error: unknown): string => (isPermanentFailure(error) ? OK_BODY : RESEND_BODY),
  forErrorResponse: (error: unknown): Response => jsonResponse(isPermanentFailure(error) ? OK_BODY : RESEND_BODY),
});
