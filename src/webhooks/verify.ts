/**
 * Webhook verification, wire-contract.md §7 / js-plan.md §3.7, in order: parse the raw body, check the
 * signature, map fields, check `mid` against the configured set, then check freshness. `mid` and freshness come
 * after signature verification because a forged event fails signature first regardless of what it claims.
 */
import { PrestoPayConfigError, PrestoPayResponseError, PrestoPaySignatureError } from '../errors.js';
import { canonicalize, parseSignedBody } from '../internal/canonical.js';
import { importPublicKey, verify as verifySignature } from '../internal/crypto.js';
import { formatGatewayTimestamp, parseGatewayTimestamp } from '../internal/timestamp.js';
import { EventCode, PaymentStatus } from '../payments/constants.js';
import {
  mapPaymentDetail,
  optionalString,
  parseListField,
  requireInteger,
  requireString,
  type MapContext,
} from '../payments/response.js';
import type { WebhookEvent } from './types.js';

const DEFAULT_MAX_TIMESTAMP_AGE_MS = 15 * 60_000;

export interface WebhookVerifierOptions {
  readonly merchantId: string | Iterable<string>;
  /** A certificate (PEM or DER) or SPKI PEM; an array while a key rotation overlap is in progress (§3.10). */
  readonly prestoPublicKey: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
  /** Redeliveries carry a fresh `ts` (§3.7), so this rarely needs widening; default 15 minutes. */
  readonly maxTimestampAgeMs?: number;
  readonly now?: () => number;
}

export interface WebhookVerifier {
  verify(input: Request | string | Uint8Array): Promise<WebhookEvent>;
}

async function readRawBody(input: Request | string | Uint8Array): Promise<string> {
  if (typeof input === 'string') return input;
  if (input instanceof Uint8Array) return new TextDecoder().decode(input);
  if (typeof Request !== 'undefined' && input instanceof Request) {
    if (input.bodyUsed) {
      throw new PrestoPayConfigError(
        'webhooks.verify() received a Request whose body was already read. Pass the raw body instead: in ' +
          'Express, mount express.raw({ type: "*/*" }) on this route and pass req.body; elsewhere, call ' +
          'await request.text() (or .arrayBuffer()) yourself and pass that.',
        { operation: 'webhook', field: 'input' },
      );
    }
    return new TextDecoder().decode(await input.arrayBuffer());
  }
  throw new PrestoPayConfigError(
    'webhooks.verify() expects a Request, a string, or a Uint8Array — not an already-parsed object. Pass the ' +
      'raw body (e.g. await request.text()), not JSON.parse(...) of it: what was verified must be what is read.',
    { operation: 'webhook', field: 'input' },
  );
}

export function createWebhookVerifier(options: WebhookVerifierOptions): WebhookVerifier {
  const merchantIds = new Set(typeof options.merchantId === 'string' ? [options.merchantId] : options.merchantId);
  if (merchantIds.size === 0) {
    throw new PrestoPayConfigError('merchantId: required', { operation: 'config', field: 'merchantId' });
  }
  const maxTimestampAgeMs = options.maxTimestampAgeMs ?? DEFAULT_MAX_TIMESTAMP_AGE_MS;
  const now = options.now ?? (() => Date.now());

  const publicKeyInputs = Array.isArray(options.prestoPublicKey)
    ? options.prestoPublicKey
    : [options.prestoPublicKey];
  if (publicKeyInputs.length === 0) {
    throw new PrestoPayConfigError('prestoPublicKey: required', { operation: 'config', field: 'prestoPublicKey' });
  }

  let publicKeysPromise: Promise<CryptoKey[]> | undefined;
  const getPublicKeys = (): Promise<CryptoKey[]> =>
    (publicKeysPromise ??= Promise.all(
      publicKeyInputs.map((input, index) => importPublicKey(input, `prestoPublicKey[${index}]`)),
    ));

  async function verifyAgainstAnyKey(canonical: string, signature: string): Promise<boolean> {
    const keys = await getPublicKeys();
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop -- trying each key in an overlap window is inherently sequential
      if (await verifySignature(key, canonical, signature)) return true;
    }
    return false;
  }

  return {
    async verify(input: Request | string | Uint8Array): Promise<WebhookEvent> {
      const text = await readRawBody(input);

      // Step 1: parse the raw body.
      const body = parseSignedBody(text, { operation: 'webhook', source: 'webhook', rawBody: text });

      // Step 2: signature — before mid and freshness, since a forged body fails here regardless.
      const canonical = canonicalize(body);
      const signature = typeof body.signature === 'string' ? body.signature : '';
      const validSignature = signature.length > 0 && (await verifyAgainstAnyKey(canonical, signature));
      if (!validSignature) {
        throw new PrestoPaySignatureError('webhook signature is missing or does not verify', {
          operation: 'webhook',
          source: 'webhook',
          canonical,
        });
      }

      // Step 3: map fields. `success` is always present, on webhooks as on responses (§13 round 1, answer 5).
      if (typeof body.success !== 'boolean') {
        throw new PrestoPayResponseError('webhook body is missing the "success" field', {
          operation: 'webhook',
          source: 'webhook',
          rawBody: text,
        });
      }
      const mapCtx: MapContext = { operation: 'webhook', rawBody: text, mayHaveTakenEffect: false };
      const mid = requireString(body, 'mid', mapCtx);
      const eventCode = requireString(body, 'eventCode', mapCtx);
      const prestoMrn = requireString(body, 'prestoMrn', mapCtx);
      const paymentRefNum = requireString(body, 'paymentRefNum', mapCtx);
      const txnRefNum = requireString(body, 'txnRefNum', mapCtx);
      const eventRefNum = requireString(body, 'eventRefNum', mapCtx);
      const eventTs = requireString(body, 'eventTs', mapCtx);
      const amount = requireInteger(body, 'amount', mapCtx);
      const currencyCode = requireString(body, 'currencyCode', mapCtx);
      const ts = requireString(body, 'ts', mapCtx);
      const userRefNum = optionalString(body, 'userRefNum');
      const additionalData = optionalString(body, 'additionalData');
      const paymentDetails = parseListField(body, 'paymentDetails', mapCtx, (element) =>
        mapPaymentDetail(element, mapCtx),
      );
      const success = body.success;

      // Step 4: mid must be one of the configured merchant IDs — mandatory, since one key signs for everyone.
      if (!merchantIds.has(mid)) {
        throw new PrestoPaySignatureError(`webhook mid "${mid}" is not one of the configured merchant IDs`, {
          operation: 'webhook',
          source: 'webhook',
          canonical,
        });
      }

      // Step 5: freshness. A malformed ts is a malformed body, not a signature failure.
      let tsInstantMs: number;
      try {
        tsInstantMs = parseGatewayTimestamp(ts).getTime();
      } catch (cause) {
        throw new PrestoPayResponseError(`ts: ${cause instanceof Error ? cause.message : 'malformed'}`, {
          operation: 'webhook',
          source: 'webhook',
          rawBody: text,
          cause,
        });
      }
      const nowMs = now();
      const ageMs = Math.abs(nowMs - tsInstantMs);
      if (ageMs > maxTimestampAgeMs) {
        throw new PrestoPaySignatureError(
          `webhook ts ${ts} is ${ageMs}ms from now (${formatGatewayTimestamp(nowMs)}), outside the ` +
            `${maxTimestampAgeMs}ms freshness window`,
          { operation: 'webhook', source: 'webhook', canonical },
        );
      }

      const paymentStatus =
        eventCode === EventCode.Authorised ? (success ? PaymentStatus.Authorised : PaymentStatus.Failed) : eventCode;

      const event: Record<string, unknown> = {
        eventCode,
        mid,
        prestoMrn,
        paymentRefNum,
        txnRefNum,
        eventRefNum,
        eventTs,
        amount,
        currencyCode,
        ts,
        success,
        paymentDetails,
        paymentStatus,
      };
      if (userRefNum !== undefined) event.userRefNum = userRefNum;
      if (additionalData !== undefined) event.additionalData = additionalData;
      return event as unknown as WebhookEvent;
    },
  };
}
