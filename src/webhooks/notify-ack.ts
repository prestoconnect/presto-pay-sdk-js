/**
 * The merchant's reply to a webhook delivery, wire-contract.md §7: HTTP 200 with `{"resend":false}` (accepted)
 * or `{"resend":true}` (ask Presto to resend). Presto retries on its own backoff of 1, 2, 5 and 10 minutes, so
 * `forError` matters: answering a permanent failure — bad signature, a foreign `mid`, a stale `ts` — with
 * `resend:true` buys four redeliveries that fail identically. Those map to `ok`; a merchant's own transient
 * failure (the database was down) maps to `resend`.
 */
import { isPrestoPayError } from '../errors.js';

const OK_BODY = '{"resend":false}';
const RESEND_BODY = '{"resend":true}';

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function isPermanentFailure(error: unknown): boolean {
  return isPrestoPayError(error) && (error.name === 'PrestoPaySignatureError' || error.name === 'PrestoPayResponseError');
}

export const NotifyAck = Object.freeze({
  ok: OK_BODY,
  resend: RESEND_BODY,
  okResponse: (): Response => jsonResponse(OK_BODY),
  resendResponse: (): Response => jsonResponse(RESEND_BODY),
  /** `ok` for a signature or malformed-body error (permanent — retrying changes nothing); `resend` otherwise. */
  forError: (error: unknown): string => (isPermanentFailure(error) ? OK_BODY : RESEND_BODY),
  forErrorResponse: (error: unknown): Response => jsonResponse(isPermanentFailure(error) ? OK_BODY : RESEND_BODY),
});
