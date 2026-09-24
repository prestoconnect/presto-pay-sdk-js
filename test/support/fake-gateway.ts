/**
 * js-plan.md §11: "vitest with an injected fetch that plays the gateway, signing responses with the test key."
 *
 * Verifies every incoming request against the merchant's test public key (so a client bug that mis-signs a
 * request is caught here too, not just in the unit tests), then hands the parsed body to `handle` and signs
 * whatever it returns with the gateway's own throwaway key.
 */
import { canonicalize, parseSignedBody, type FlatBody, type JsonObject } from '../../src/internal/canonical.js';
import { importPrivateKey, importPublicKey, sign, verify } from '../../src/internal/crypto.js';

export interface HandleResult {
  readonly status?: number;
  readonly body?: FlatBody;
  /** Bypasses signing entirely, for testing malformed/unsigned responses. */
  readonly rawBody?: string;
  readonly headers?: Record<string, string>;
}

export interface FakeGatewayOptions {
  readonly merchantPublicKeyPem: string;
  readonly gatewayPrivateKeyPem: string;
  readonly handle: (path: string, body: JsonObject) => HandleResult;
}

function bodyToText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new TypeError('fake gateway only understands string or Uint8Array request bodies');
}

export function createFakeGateway(options: FakeGatewayOptions): typeof fetch {
  let merchantKeyPromise: Promise<CryptoKey> | undefined;
  let gatewayKeyPromise: Promise<CryptoKey> | undefined;
  const getMerchantKey = (): Promise<CryptoKey> =>
    (merchantKeyPromise ??= importPublicKey(options.merchantPublicKeyPem, 'test-merchant-public-key'));
  const getGatewayKey = (): Promise<CryptoKey> =>
    (gatewayKeyPromise ??= importPrivateKey(options.gatewayPrivateKeyPem, 'test-gateway-private-key'));

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const requestBody = parseSignedBody(bodyToText(init?.body ?? null), {
      operation: 'config',
      source: 'response',
    });

    const canonical = canonicalize(requestBody);
    const signature = typeof requestBody.signature === 'string' ? requestBody.signature : '';
    const merchantKey = await getMerchantKey();
    const validSignature = signature.length > 0 && (await verify(merchantKey, canonical, signature));
    if (!validSignature) {
      const body = JSON.stringify({
        success: false,
        ts: requestBody.ts,
        errorCode: '1006',
        errorMessage: 'invalid signature',
        signature: 'not-a-real-signature',
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const result = options.handle(url.pathname, requestBody);
    if (result.rawBody !== undefined) {
      return new Response(result.rawBody, {
        status: result.status ?? 200,
        headers: result.headers ?? {},
      });
    }

    const gatewayKey = await getGatewayKey();
    const responseBody = result.body ?? {};
    const responseCanonical = canonicalize(responseBody);
    const responseSignature = await sign(gatewayKey, responseCanonical);
    const text = JSON.stringify({ ...responseBody, signature: responseSignature });
    return new Response(text, {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  }) as typeof fetch;
}
