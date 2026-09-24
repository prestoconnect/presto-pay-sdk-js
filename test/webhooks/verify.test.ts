import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createWebhookVerifier } from '../../src/webhooks/verify.js';
import { NotifyAck } from '../../src/webhooks/notify-ack.js';
import {
  PrestoPayConfigError,
  PrestoPayResponseError,
  PrestoPaySignatureError,
} from '../../src/errors.js';
import { canonicalize, type FlatBody } from '../../src/internal/canonical.js';
import { importPrivateKey, sign } from '../../src/internal/crypto.js';
import { formatGatewayTimestamp } from '../../src/internal/timestamp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const gatewayPrivateKeyPem = readFileSync(path.join(specDir, 'keys/test-gateway-key-pkcs8.pem'), 'utf8');
const gatewayCertPem = readFileSync(path.join(specDir, 'keys/test-gateway-cert.pem'), 'utf8');

async function signedWebhook(overrides: Partial<FlatBody> = {}, now = Date.now()): Promise<string> {
  const body: FlatBody = {
    eventCode: 'Authorised',
    mid: 'MID1',
    prestoMrn: 'PM1',
    paymentRefNum: 'PP1',
    txnRefNum: 'T1',
    eventRefNum: 'EVT1',
    eventTs: formatGatewayTimestamp(now),
    amount: 1000,
    currencyCode: 'MYR',
    ts: formatGatewayTimestamp(now),
    success: true,
    ...overrides,
  };
  const key = await importPrivateKey(gatewayPrivateKeyPem, 'test');
  const canonical = canonicalize(body);
  const signature = await sign(key, canonical);
  return JSON.stringify({ ...body, signature });
}

function verifier(overrides: Partial<Parameters<typeof createWebhookVerifier>[0]> = {}) {
  return createWebhookVerifier({
    merchantId: 'MID1',
    prestoPublicKey: gatewayCertPem,
    ...overrides,
  });
}

describe('createWebhookVerifier', () => {
  it('rejects an empty merchantId set', () => {
    expect(() => createWebhookVerifier({ merchantId: [], prestoPublicKey: gatewayCertPem })).toThrow(
      PrestoPayConfigError,
    );
  });

  it('verifies a well-formed, well-signed event and derives paymentStatus', async () => {
    const text = await signedWebhook();
    const event = await verifier().verify(text);
    expect(event.mid).toBe('MID1');
    expect(event.eventRefNum).toBe('EVT1');
    expect(event.paymentStatus).toBe('Authorised'); // Authorised + success:true
    expect(event.paymentDetails).toEqual([]);
  });

  it('derives Failed for an Authorised event with success:false', async () => {
    const text = await signedWebhook({ success: false });
    const event = await verifier().verify(text);
    expect(event.paymentStatus).toBe('Failed');
  });

  it('uses the event code itself as the status for non-Authorised events', async () => {
    const text = await signedWebhook({ eventCode: 'Refunded' });
    const event = await verifier().verify(text);
    expect(event.paymentStatus).toBe('Refunded');
  });

  it('normalizes optional fields and maps paymentDetails', async () => {
    const text = await signedWebhook({
      userRefNum: '',
      additionalData: null,
      paymentDetails: JSON.stringify([{ amount: 1000, method: 'Wallet' }]),
    });
    const event = await verifier().verify(text);
    expect(event.userRefNum).toBeUndefined();
    expect(event.additionalData).toBeUndefined();
    expect(event.paymentDetails).toEqual([{ amount: 1000, method: 'Wallet' }]);
  });

  it('rejects an invalid signature', async () => {
    const text = JSON.stringify({
      eventCode: 'Authorised',
      mid: 'MID1',
      prestoMrn: 'PM1',
      paymentRefNum: 'PP1',
      txnRefNum: 'T1',
      eventRefNum: 'EVT1',
      eventTs: formatGatewayTimestamp(Date.now()),
      amount: 1000,
      currencyCode: 'MYR',
      ts: formatGatewayTimestamp(Date.now()),
      success: true,
      signature: 'aGVsbG8=',
    });
    await expect(verifier().verify(text)).rejects.toBeInstanceOf(PrestoPaySignatureError);
  });

  it('rejects a missing "success" field as malformed', async () => {
    const text = await signedWebhook();
    const parsed = JSON.parse(text);
    delete parsed.success;
    // Re-sign without success so the signature still verifies but success is absent.
    const key = await importPrivateKey(gatewayPrivateKeyPem, 'test');
    const canonical = canonicalize(parsed);
    const signature = await sign(key, canonical);
    const resigned = JSON.stringify({ ...parsed, signature });
    await expect(verifier().verify(resigned)).rejects.toBeInstanceOf(PrestoPayResponseError);
  });

  it('rejects an unconfigured mid as a signature error (mandatory check, §3.7)', async () => {
    const text = await signedWebhook({ mid: 'SOME-OTHER-MID' });
    await expect(verifier().verify(text)).rejects.toBeInstanceOf(PrestoPaySignatureError);
  });

  it('accepts any of several configured merchant IDs, reporting which matched', async () => {
    const text = await signedWebhook({ mid: 'MID2' });
    const event = await verifier({ merchantId: ['MID1', 'MID2'] }).verify(text);
    expect(event.mid).toBe('MID2');
  });

  it('rejects a stale ts outside the freshness window', async () => {
    const staleNow = Date.now() - 20 * 60_000;
    const text = await signedWebhook({}, staleNow);
    await expect(verifier({ now: () => Date.now() }).verify(text)).rejects.toBeInstanceOf(PrestoPaySignatureError);
  });

  it('accepts a redelivery with a fresh ts inside the window', async () => {
    const text = await signedWebhook({ eventRefNum: 'EVT1' }, Date.now());
    const event = await verifier().verify(text);
    expect(event.eventRefNum).toBe('EVT1');
  });

  it('a custom maxTimestampAgeMs widens or narrows the window', async () => {
    const now = Date.now();
    const text = await signedWebhook({}, now - 5000);
    await expect(
      verifier({ maxTimestampAgeMs: 1000, now: () => now }).verify(text),
    ).rejects.toBeInstanceOf(PrestoPaySignatureError);
    await expect(verifier({ maxTimestampAgeMs: 60_000, now: () => now }).verify(text)).resolves.toBeDefined();
  });

  it('rejects a malformed ts as a malformed body, not a signature error', async () => {
    const text = await signedWebhook({ ts: 'not-a-timestamp' });
    await expect(verifier().verify(text)).rejects.toBeInstanceOf(PrestoPayResponseError);
  });

  it('accepts a Uint8Array body', async () => {
    const text = await signedWebhook();
    const bytes = new TextEncoder().encode(text);
    const event = await verifier().verify(bytes);
    expect(event.eventRefNum).toBe('EVT1');
  });

  it('accepts a Request and reads its raw body', async () => {
    const text = await signedWebhook();
    const request = new Request('https://merchant.example/webhook', { method: 'POST', body: text });
    const event = await verifier().verify(request);
    expect(event.eventRefNum).toBe('EVT1');
  });

  it('rejects a Request whose body was already consumed', async () => {
    const text = await signedWebhook();
    const request = new Request('https://merchant.example/webhook', { method: 'POST', body: text });
    await request.text(); // consume it upstream
    await expect(verifier().verify(request)).rejects.toBeInstanceOf(PrestoPayConfigError);
  });

  it('rejects an already-parsed object, pointing at raw-body input', async () => {
    await expect(verifier().verify({ not: 'a raw body' } as never)).rejects.toBeInstanceOf(PrestoPayConfigError);
  });
});

describe('NotifyAck', () => {
  it('ok/resend are the two documented reply bodies', () => {
    expect(NotifyAck.ok).toBe('{"resend":false}');
    expect(NotifyAck.resend).toBe('{"resend":true}');
  });

  it('okResponse/resendResponse return a ready Response with the right content-type', async () => {
    const ok = NotifyAck.okResponse();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/json/);
    expect(await ok.text()).toBe(NotifyAck.ok);
  });

  it('forError returns ok for signature and malformed-body errors (permanent)', () => {
    const sigError = new PrestoPaySignatureError('bad sig', { operation: 'webhook', source: 'webhook' });
    const bodyError = new PrestoPayResponseError('bad body', { operation: 'webhook', source: 'webhook' });
    expect(NotifyAck.forError(sigError)).toBe(NotifyAck.ok);
    expect(NotifyAck.forError(bodyError)).toBe(NotifyAck.ok);
  });

  it('forError returns resend for anything else (the merchant\'s own transient failure)', () => {
    expect(NotifyAck.forError(new Error('database is down'))).toBe(NotifyAck.resend);
    expect(NotifyAck.forError('not even an error')).toBe(NotifyAck.resend);
  });
});
