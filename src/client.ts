/**
 * `createPrestoPay`: a synchronous factory (so it works as a module-level singleton, and per
 * request in Workers) whose PEM structure is checked synchronously, while the Web Crypto import runs lazily on
 * first use and is cached — importKey is the expensive part, signing is not.
 */
import type { Operation, ReconcileKey } from './errors.js';
import { PrestoPayApiError, PrestoPayConfigError, PrestoPayResponseError, PrestoPaySignatureError, redact } from './errors.js';
import { canonicalize, parseSignedBody, type FlatBody, type JsonObject } from './internal/canonical.js';
import { importPrivateKey, importPublicKey, sign, verify } from './internal/crypto.js';
import { publicKeyMaterial, privateKeyDer } from './internal/pem.js';
import { send, type SendRequest } from './internal/send.js';
import { formatGatewayTimestamp, parseGatewayTimestamp } from './internal/timestamp.js';
import type { RetryOptions } from './retry.js';
import { USER_AGENT } from './version.js';
import { buildInitBody, buildQueryBody, buildRefundBody, buildReverseBody } from './payments/wire.js';
import {
  mapInitResponse,
  mapQueryResponse,
  mapRefundResponse,
  mapReverseResponse,
  type MapContext,
} from './payments/response.js';
import type {
  InitRequest,
  InitResponse,
  QueryRequest,
  QueryResponse,
  RefundRequest,
  RefundResponse,
  ReverseRequest,
  ReverseResponse,
} from './payments/types.js';
import { createWebhookVerifier, type WebhookVerifier } from './webhooks/verify.js';

const BASE_URLS: Record<string, string> = {
  staging: 'https://presto-stg-ext.enovax.com',
  production: 'https://pay-ext.prestouniverse.com',
};

export type Environment = 'staging' | 'production' | { readonly baseUrl: string };

export interface PrestoPayOptions {
  readonly environment: Environment;
  readonly merchantId: string;
  /** Unencrypted PKCS#8 PEM text. */
  readonly privateKey: string;
  /** A certificate (PEM or DER) or SPKI PEM; an array while a key rotation overlap is in progress (§3.10). */
  readonly prestoPublicKey: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
  readonly deadlineMs?: number;
  readonly retryReads?: Partial<RetryOptions>;
  readonly strict?: boolean;
  readonly redactErrorBodies?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly webhooks?: { readonly maxTimestampAgeMs?: number };
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface PaymentsApi {
  init(input: InitRequest, options?: CallOptions): Promise<InitResponse>;
  query(input: QueryRequest, options?: CallOptions): Promise<QueryResponse>;
  reverse(input: ReverseRequest, options?: CallOptions): Promise<ReverseResponse>;
  refund(input: RefundRequest, options?: CallOptions): Promise<RefundResponse>;
}

export interface RawApi {
  /** Signs, sends, verifies and returns the parsed object — the escape hatch for an endpoint this SDK does not
   *  wrap yet. `body` must not include `mid`, `ts` or `signature`; the client adds them. */
  post(path: string, body: FlatBody, options?: CallOptions): Promise<JsonObject>;
  /** Signs a canonical string with this client's private key. */
  sign(canonicalString: string): Promise<string>;
  /** Verifies a parsed body's signature against this client's configured Presto public key(s). */
  verifyBody(body: JsonObject): Promise<boolean>;
}

export interface PrestoPayClient {
  readonly payments: PaymentsApi;
  readonly raw: RawApi;
  readonly webhooks: WebhookVerifier;
}

function resolveBaseUrl(environment: Environment): string {
  if (typeof environment === 'string') {
    const url = BASE_URLS[environment];
    if (url === undefined) {
      throw new PrestoPayConfigError(
        `environment: unknown value ${JSON.stringify(environment)}; expected "staging", "production", or { baseUrl }`,
        { operation: 'config', field: 'environment' },
      );
    }
    return url;
  }
  if (typeof environment === 'object' && environment !== null && typeof environment.baseUrl === 'string') {
    return environment.baseUrl.replace(/\/+$/, '');
  }
  throw new PrestoPayConfigError('environment: expected "staging", "production", or { baseUrl }', {
    operation: 'config',
    field: 'environment',
  });
}

/** `responseTs - requestTs`, in milliseconds — the offset a skewed host clock would show up as (§3.3). */
function clockOffsetMsBetween(requestTs: string, responseTs: string): number | undefined {
  try {
    return parseGatewayTimestamp(responseTs).getTime() - parseGatewayTimestamp(requestTs).getTime();
  } catch {
    return undefined;
  }
}

interface CallSpec<T> {
  readonly operation: Operation;
  readonly resendSafe: boolean;
  readonly path: string;
  readonly wireBody: FlatBody;
  readonly reconcileBy?: ReconcileKey;
  readonly expectedPrestoMrn: string;
  readonly expectedTxnRefNum?: string;
  readonly mapResponse: (body: JsonObject, ctx: MapContext) => T;
}

export function createPrestoPay(options: PrestoPayOptions): PrestoPayClient {
  if (typeof options.merchantId !== 'string' || options.merchantId.length === 0) {
    throw new PrestoPayConfigError('merchantId: required', { operation: 'config', field: 'merchantId' });
  }
  const baseUrl = resolveBaseUrl(options.environment);
  const strict = options.strict ?? false;
  const redactErrorBodies = options.redactErrorBodies ?? true;
  const now = options.now ?? (() => Date.now());

  // PEM/certificate structure is checked synchronously here; the (expensive) Web Crypto import is lazy below.
  privateKeyDer(options.privateKey, 'privateKey');
  const publicKeyInputs = Array.isArray(options.prestoPublicKey)
    ? options.prestoPublicKey
    : [options.prestoPublicKey];
  if (publicKeyInputs.length === 0) {
    throw new PrestoPayConfigError('prestoPublicKey: required', { operation: 'config', field: 'prestoPublicKey' });
  }
  publicKeyInputs.forEach((input, index) => publicKeyMaterial(input, `prestoPublicKey[${index}]`));

  let privateKeyPromise: Promise<CryptoKey> | undefined;
  const getPrivateKey = (): Promise<CryptoKey> =>
    (privateKeyPromise ??= importPrivateKey(options.privateKey, 'privateKey'));

  let publicKeysPromise: Promise<CryptoKey[]> | undefined;
  const getPublicKeys = (): Promise<CryptoKey[]> =>
    (publicKeysPromise ??= Promise.all(
      publicKeyInputs.map((input, index) => importPublicKey(input, `prestoPublicKey[${index}]`)),
    ));

  async function verifyAgainstAnyKey(canonical: string, signature: string): Promise<boolean> {
    const keys = await getPublicKeys();
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop -- trying each key in an overlap window is inherently sequential
      if (await verify(key, canonical, signature)) return true;
    }
    return false;
  }

  function headers(): Record<string, string> {
    return { 'content-type': 'application/json; charset=UTF-8', 'user-agent': USER_AGENT };
  }

  async function signedBody(wireBody: FlatBody, onTs?: (ts: string) => void): Promise<Uint8Array> {
    const privateKey = await getPrivateKey();
    const ts = formatGatewayTimestamp(now());
    onTs?.(ts);
    const withMidTs: FlatBody = { ...wireBody, mid: options.merchantId, ts };
    const canonical = canonicalize(withMidTs);
    const signature = await sign(privateKey, canonical);
    const withSignature: FlatBody = { ...withMidTs, signature };
    return new TextEncoder().encode(JSON.stringify(withSignature));
  }

  async function handleResponse<T>(
    result: { status: number; bodyText: string },
    spec: Pick<
      CallSpec<T>,
      'operation' | 'resendSafe' | 'reconcileBy' | 'expectedPrestoMrn' | 'expectedTxnRefNum' | 'mapResponse'
    >,
    lastRequestTs?: string,
  ): Promise<T> {
    const { operation, resendSafe, reconcileBy } = spec;
    const rawBody = redact(result.bodyText, redactErrorBodies) ?? result.bodyText;

    // Step 1: HTTP status.
    if (result.status !== 200) {
      const mayHaveTakenEffect = !resendSafe && result.status >= 500;
      throw new PrestoPayApiError(`gateway responded with HTTP ${result.status}`, {
        operation,
        kind: 'http',
        httpStatus: result.status,
        rawBody,
        mayHaveTakenEffect,
        ...(mayHaveTakenEffect && reconcileBy ? { reconcileBy } : {}),
      });
    }

    // Step 2: parse.
    const indeterminate = !resendSafe; // any failure from here on happened after an authentic 200.
    let body: JsonObject;
    try {
      body = parseSignedBody(result.bodyText, { operation, source: 'response', rawBody: result.bodyText });
    } catch (cause) {
      throw new PrestoPayResponseError(
        cause instanceof Error ? cause.message : 'response body is malformed',
        {
          operation,
          source: 'response',
          rawBody,
          mayHaveTakenEffect: indeterminate,
          ...(indeterminate && reconcileBy ? { reconcileBy } : {}),
          cause,
        },
      );
    }

    // Step 3: signature. Comes before `success` — business errors are signed too.
    const canonical = canonicalize(body);
    const signature = typeof body.signature === 'string' ? body.signature : '';
    const verified = signature.length > 0 && (await verifyAgainstAnyKey(canonical, signature));
    if (!verified) {
      throw new PrestoPaySignatureError('response signature is missing or does not verify', {
        operation,
        source: 'response',
        canonical,
        mayHaveTakenEffect: indeterminate,
        ...(indeterminate && reconcileBy ? { reconcileBy } : {}),
      });
    }

    // Step 4: success.
    if (typeof body.success !== 'boolean') {
      throw new PrestoPayResponseError('response is missing the "success" field', {
        operation,
        source: 'response',
        rawBody,
        mayHaveTakenEffect: indeterminate,
        ...(indeterminate && reconcileBy ? { reconcileBy } : {}),
      });
    }
    if (body.success === false) {
      const errorCode = typeof body.errorCode === 'string' ? body.errorCode : '';
      const errorMessage = typeof body.errorMessage === 'string' ? body.errorMessage : '';
      // §3.9: a duplicate txnRefNum on init proves a payment record exists, possibly an authorised one.
      const isDuplicateInit = operation === 'init' && errorCode === '1203';
      const attachCanonical = errorCode === '1006' || errorCode === '1007';
      // §3.3: a skewed host clock fails every request with 1005 and has no other way to find out why, so the
      // offset between what this host sent and what the gateway's own clock says is folded into the message.
      const isClockSkew = errorCode === '1005';
      const clockOffsetMs =
        isClockSkew && lastRequestTs !== undefined && typeof body.ts === 'string'
          ? clockOffsetMsBetween(lastRequestTs, body.ts)
          : undefined;
      const message =
        isClockSkew && clockOffsetMs !== undefined
          ? `${errorMessage || 'request timestamp outside the validity window'} (this host's clock appears to ` +
            `be off by ${clockOffsetMs}ms relative to the gateway; request ts was ${lastRequestTs}, gateway ts ` +
            `was ${body.ts})`
          : errorMessage.length > 0
            ? errorMessage
            : `business error ${errorCode}`;
      throw new PrestoPayApiError(message, {
        operation,
        kind: 'business',
        httpStatus: 200,
        errorCode,
        errorMessage,
        rawBody,
        mayHaveTakenEffect: isDuplicateInit,
        ...(isDuplicateInit && reconcileBy ? { reconcileBy } : {}),
        ...(attachCanonical ? { canonical } : {}),
        ...(clockOffsetMs !== undefined ? { clockOffsetMs } : {}),
      });
    }

    // Step 5: map fields.
    const mapCtx: MapContext = {
      operation,
      rawBody,
      mayHaveTakenEffect: indeterminate,
      ...(reconcileBy ? { reconcileBy } : {}),
    };
    const mapped = spec.mapResponse(body, mapCtx);

    // Step 6: echo check.
    if (typeof body.prestoMrn === 'string' && body.prestoMrn !== spec.expectedPrestoMrn) {
      throw new PrestoPayResponseError(
        `prestoMrn echoed back ("${body.prestoMrn}") does not match what was signed into the request ("${spec.expectedPrestoMrn}")`,
        {
          operation,
          source: 'response',
          rawBody,
          mayHaveTakenEffect: indeterminate,
          ...(indeterminate && reconcileBy ? { reconcileBy } : {}),
        },
      );
    }
    if (
      spec.expectedTxnRefNum !== undefined &&
      typeof body.txnRefNum === 'string' &&
      body.txnRefNum !== spec.expectedTxnRefNum
    ) {
      throw new PrestoPayResponseError(
        `txnRefNum echoed back ("${body.txnRefNum}") does not match what was signed into the request ("${spec.expectedTxnRefNum}")`,
        {
          operation,
          source: 'response',
          rawBody,
          mayHaveTakenEffect: indeterminate,
          ...(indeterminate && reconcileBy ? { reconcileBy } : {}),
        },
      );
    }

    return mapped;
  }

  async function call<T>(spec: CallSpec<T>, callOptions?: CallOptions): Promise<T> {
    let lastRequestTs: string | undefined;
    const sendRequest: SendRequest = {
      operation: spec.operation,
      resendSafe: spec.resendSafe,
      url: `${baseUrl}${spec.path}`,
      headers: headers(),
      buildBody: () => signedBody(spec.wireBody, (ts) => (lastRequestTs = ts)),
      ...(spec.reconcileBy ? { reconcileBy: spec.reconcileBy } : {}),
    };
    const result = await send(sendRequest, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
      ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      ...(options.retryReads ? { retryReads: options.retryReads } : {}),
    });
    return handleResponse(result, spec, lastRequestTs);
  }

  const payments: PaymentsApi = {
    async init(input, callOptions) {
      const wireBody = buildInitBody(input, strict);
      return call(
        {
          operation: 'init',
          resendSafe: false,
          path: '/v1/ext/payment/init',
          wireBody,
          reconcileBy: { txnRefNum: input.txnRefNum },
          expectedPrestoMrn: input.prestoMrn,
          expectedTxnRefNum: input.txnRefNum,
          mapResponse: mapInitResponse,
        },
        callOptions,
      );
    },
    async query(input, callOptions) {
      const wireBody = buildQueryBody(input);
      const spec: CallSpec<QueryResponse> = {
        operation: 'query',
        resendSafe: true,
        path: '/v1/ext/payment/query',
        wireBody,
        expectedPrestoMrn: input.prestoMrn,
        mapResponse: mapQueryResponse,
        ...(input.txnRefNum !== undefined ? { expectedTxnRefNum: input.txnRefNum } : {}),
      };
      return call(spec, callOptions);
    },
    async reverse(input, callOptions) {
      const wireBody = buildReverseBody(input, strict);
      const spec: CallSpec<ReverseResponse> = {
        operation: 'reverse',
        resendSafe: false,
        path: '/v1/ext/payment/reverse',
        wireBody,
        expectedPrestoMrn: input.prestoMrn,
        mapResponse: mapReverseResponse,
        ...(input.paymentRefNum !== undefined
          ? { reconcileBy: { paymentRefNum: input.paymentRefNum } }
          : input.txnRefNum !== undefined
            ? { reconcileBy: { txnRefNum: input.txnRefNum } }
            : {}),
      };
      return call(spec, callOptions);
    },
    async refund(input, callOptions) {
      const wireBody = buildRefundBody(input, strict);
      const spec: CallSpec<RefundResponse> = {
        operation: 'refund',
        resendSafe: false,
        path: '/v1/ext/payment/refund',
        wireBody,
        reconcileBy: { paymentRefNum: input.paymentRefNum },
        expectedPrestoMrn: input.prestoMrn,
        mapResponse: mapRefundResponse,
      };
      return call(spec, callOptions);
    },
  };

  const raw: RawApi = {
    async post(path, body, callOptions) {
      const sendRequest: SendRequest = {
        operation: 'config',
        resendSafe: false,
        url: `${baseUrl}${path}`,
        headers: headers(),
        buildBody: () => signedBody(body),
      };
      const result = await send(sendRequest, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
      const rawBody = redact(result.bodyText, redactErrorBodies) ?? result.bodyText;
      if (result.status !== 200) {
        throw new PrestoPayApiError(`gateway responded with HTTP ${result.status}`, {
          operation: 'config',
          kind: 'http',
          httpStatus: result.status,
          rawBody,
          mayHaveTakenEffect: false,
        });
      }
      const parsed = parseSignedBody(result.bodyText, {
        operation: 'config',
        source: 'response',
        rawBody: result.bodyText,
      });
      const canonical = canonicalize(parsed);
      const signature = typeof parsed.signature === 'string' ? parsed.signature : '';
      const verified = signature.length > 0 && (await verifyAgainstAnyKey(canonical, signature));
      if (!verified) {
        throw new PrestoPaySignatureError('response signature is missing or does not verify', {
          operation: 'config',
          source: 'response',
          canonical,
          mayHaveTakenEffect: false,
        });
      }
      return parsed;
    },
    async sign(canonicalString) {
      const privateKey = await getPrivateKey();
      return sign(privateKey, canonicalString);
    },
    async verifyBody(body) {
      const canonical = canonicalize(body);
      const signature = typeof body.signature === 'string' ? body.signature : '';
      if (signature.length === 0) return false;
      return verifyAgainstAnyKey(canonical, signature);
    },
  };

  const webhooks = createWebhookVerifier({
    merchantId: options.merchantId,
    prestoPublicKey: options.prestoPublicKey,
    ...(options.webhooks?.maxTimestampAgeMs !== undefined
      ? { maxTimestampAgeMs: options.webhooks.maxTimestampAgeMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return { payments, raw, webhooks };
}
