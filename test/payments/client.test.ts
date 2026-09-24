import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPrestoPay } from '../../src/client.js';
import {
  PrestoPayApiError,
  PrestoPayConfigError,
  PrestoPayResponseError,
  PrestoPaySignatureError,
} from '../../src/errors.js';
import { TxnType } from '../../src/payments/constants.js';
import { createFakeGateway, type HandleResult } from '../support/fake-gateway.js';
import type { JsonObject } from '../../src/internal/canonical.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const merchantPrivateKeyPem = readFileSync(path.join(specDir, 'keys/test-key-pkcs8.pem'), 'utf8');
const merchantPublicKeyPem = readFileSync(path.join(specDir, 'keys/test-public-key.pem'), 'utf8');
const gatewayPrivateKeyPem = readFileSync(path.join(specDir, 'keys/test-gateway-key-pkcs8.pem'), 'utf8');
const gatewayCertPem = readFileSync(path.join(specDir, 'keys/test-gateway-cert.pem'), 'utf8');

const FAST_RETRY = { maxRetries: 1, initialBackoffMs: 1, maxBackoffMs: 2, jitter: false };

function makeClient(handle: (path: string, body: JsonObject) => HandleResult) {
  const fetchImpl = createFakeGateway({ merchantPublicKeyPem, gatewayPrivateKeyPem, handle });
  return createPrestoPay({
    environment: { baseUrl: 'https://fake.presto.invalid' },
    merchantId: 'TESTMID',
    privateKey: merchantPrivateKeyPem,
    prestoPublicKey: gatewayCertPem,
    fetch: fetchImpl,
    retryReads: FAST_RETRY,
  });
}

describe('createPrestoPay: config validation', () => {
  it('rejects a missing merchantId', () => {
    expect(() =>
      createPrestoPay({
        environment: 'staging',
        merchantId: '',
        privateKey: merchantPrivateKeyPem,
        prestoPublicKey: gatewayCertPem,
      }),
    ).toThrow(PrestoPayConfigError);
  });

  it('rejects an unknown environment string', () => {
    expect(() =>
      createPrestoPay({
        environment: 'sandbox' as never,
        merchantId: 'M1',
        privateKey: merchantPrivateKeyPem,
        prestoPublicKey: gatewayCertPem,
      }),
    ).toThrow(/environment/);
  });

  it('checks PEM structure synchronously, before any network call', () => {
    expect(() =>
      createPrestoPay({
        environment: 'staging',
        merchantId: 'M1',
        privateKey: 'not a pem',
        prestoPublicKey: gatewayCertPem,
      }),
    ).toThrow(PrestoPayConfigError);
  });
});

describe('payments.init', () => {
  it('signs the request, verifies the response, and maps fields', async () => {
    let seenPath = '';
    let seenBody: JsonObject | undefined;
    const client = makeClient((requestPath, body) => {
      seenPath = requestPath;
      seenBody = body;
      return {
        body: {
          prestoMrn: body.prestoMrn as string,
          paymentRefNum: 'PP1',
          txnRefNum: body.txnRefNum as string,
          paymentStatus: 'PendingAuthorise',
          paymentUrl: 'https://hpp.example/PP1',
          userRefNum: '',
          amount: 1000,
          currencyCode: 'MYR',
          paymentRequestDate: '20250423104500.000',
          paymentFinalisedDate: '',
          additionalData: null,
          success: true,
          ts: '20250423104500.000',
          errorCode: '',
          errorMessage: '',
        },
      };
    });

    const result = await client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      amount: 1000,
      currencyCode: 'MYR',
      redirectUrl: 'https://merchant.example/return',
    });

    expect(seenPath).toBe('/v1/ext/payment/init');
    expect(seenBody?.mid).toBe('TESTMID');
    expect(seenBody?.txnType).toBe('WebPay');
    expect(result.paymentRefNum).toBe('PP1');
    expect(result.paymentStatus).toBe('PendingAuthorise');
    expect(result.userRefNum).toBeUndefined(); // "" normalizes to undefined
    expect(result.additionalData).toBeUndefined(); // null normalizes to undefined
    expect(result.amount).toBe(1000);
  });

  it('rejects redirectUrl missing for WebPay before ever sending', async () => {
    let called = false;
    const client = makeClient(() => {
      called = true;
      return { body: {} };
    });
    await expect(
      client.payments.init({
        prestoMrn: 'PM1',
        txnType: TxnType.WebPay,
        txnRefNum: 'order-1',
        displayDesc: 'Order 1',
      }),
    ).rejects.toBeInstanceOf(PrestoPayConfigError);
    expect(called).toBe(false);
  });

  it('a 1203 duplicate txnRefNum is stamped mayHaveTakenEffect with reconcileBy', async () => {
    const client = makeClient((_path, body) => ({
      body: {
        success: false,
        ts: body.ts as string,
        errorCode: '1203',
        errorMessage: 'duplicate txnRefNum',
      },
    }));

    const promise = client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      redirectUrl: 'https://merchant.example/return',
    });
    await promise.catch((err: PrestoPayApiError) => {
      expect(err.errorCode).toBe('1203');
      expect(err.mayHaveTakenEffect).toBe(true);
      expect(err.reconcileBy).toEqual({ txnRefNum: 'order-1' });
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayApiError);
  });

  it('a plain 1201 business error is definite, not indeterminate', async () => {
    const client = makeClient((_path, body) => ({
      body: { success: false, ts: body.ts as string, errorCode: '1201', errorMessage: 'Invalid input.' },
    }));
    const promise = client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      redirectUrl: 'https://merchant.example/return',
    });
    await promise.catch((err: PrestoPayApiError) => {
      expect(err.mayHaveTakenEffect).toBe(false);
      expect(err.reconcileBy).toBeUndefined();
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayApiError);
  });

  it('an echo mismatch on prestoMrn is a response error, indeterminate for init', async () => {
    const client = makeClient((_path, body) => ({
      body: {
        prestoMrn: 'SOME-OTHER-MRN',
        paymentRefNum: 'PP1',
        paymentStatus: 'PendingAuthorise',
        success: true,
        ts: body.ts as string,
        errorCode: '',
        errorMessage: '',
      },
    }));
    const promise = client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      redirectUrl: 'https://merchant.example/return',
    });
    await promise.catch((err: PrestoPayResponseError) => {
      expect(err.mayHaveTakenEffect).toBe(true);
      expect(err.reconcileBy).toEqual({ txnRefNum: 'order-1' });
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayResponseError);
  });

  it('an invalid response signature is a signature error, indeterminate for init', async () => {
    const client = makeClient(() => ({
      rawBody: JSON.stringify({
        prestoMrn: 'PM1',
        paymentRefNum: 'PP1',
        paymentStatus: 'PendingAuthorise',
        success: true,
        ts: '20250423104500.000',
        errorCode: '',
        errorMessage: '',
        signature: 'aGVsbG8=', // valid base64, wrong signature
      }),
    }));
    const promise = client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      redirectUrl: 'https://merchant.example/return',
    });
    await promise.catch((err: PrestoPaySignatureError) => {
      expect(err.mayHaveTakenEffect).toBe(true);
      expect(err.canonical).toBeDefined();
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPaySignatureError);
  });

  it('a 500 status is indeterminate with reconcileBy for init', async () => {
    const client = makeClient(() => ({ status: 500, rawBody: 'server error' }));
    const promise = client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      redirectUrl: 'https://merchant.example/return',
    });
    await promise.catch((err: PrestoPayApiError) => {
      expect(err.kind).toBe('http');
      expect(err.mayHaveTakenEffect).toBe(true);
      expect(err.reconcileBy).toEqual({ txnRefNum: 'order-1' });
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayApiError);
  });

  it('a 400 status is definite, not indeterminate', async () => {
    const client = makeClient(() => ({ status: 400, rawBody: 'bad request' }));
    const promise = client.payments.init({
      prestoMrn: 'PM1',
      txnType: TxnType.WebPay,
      txnRefNum: 'order-1',
      displayDesc: 'Order 1',
      redirectUrl: 'https://merchant.example/return',
    });
    await promise.catch((err: PrestoPayApiError) => {
      expect(err.mayHaveTakenEffect).toBe(false);
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayApiError);
  });
});

describe('payments.query', () => {
  it('a 500 status on query is never indeterminate (safe to resend)', async () => {
    let attempts = 0;
    const client = makeClient(() => {
      attempts += 1;
      return { status: 503, rawBody: 'unavailable' };
    });
    const promise = client.payments.query({ prestoMrn: 'PM1', txnRefNum: 'order-1' });
    await promise.catch((err: PrestoPayApiError) => {
      expect(err.mayHaveTakenEffect).toBe(false);
      expect(err.reconcileBy).toBeUndefined();
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayApiError);
    expect(attempts).toBe(FAST_RETRY.maxRetries + 1);
  });

  it('round-trips refundDetails and paymentDetails from stringified arrays', async () => {
    const client = makeClient((_path, body) => ({
      body: {
        prestoMrn: body.prestoMrn as string,
        paymentRefNum: 'PP1',
        paymentStatus: 'Refunded',
        refundDetails: JSON.stringify([
          {
            refundRefNum: 'R1',
            prestoRefundRefNum: 'PR1',
            refundStatus: 'Success',
            refundRequestDate: '20250423104500.000',
            refundFinalisedDate: '20250423104600.000',
          },
        ]),
        paymentDetails: JSON.stringify([{ amount: 1000, method: 'Wallet' }]),
        success: true,
        ts: body.ts as string,
        errorCode: '',
        errorMessage: '',
      },
    }));
    const result = await client.payments.query({ prestoMrn: 'PM1', paymentRefNum: 'PP1' });
    expect(result.refundDetails).toEqual([
      {
        refundRefNum: 'R1',
        prestoRefundRefNum: 'PR1',
        refundStatus: 'Success',
        refundRequestDate: '20250423104500.000',
        refundFinalisedDate: '20250423104600.000',
      },
    ]);
    expect(result.paymentDetails).toEqual([{ amount: 1000, method: 'Wallet' }]);
  });

  it('an empty list arrives as "[]", mapped to an empty array', async () => {
    const client = makeClient((_path, body) => ({
      body: {
        prestoMrn: body.prestoMrn as string,
        paymentRefNum: 'PP1',
        refundDetails: '[]',
        paymentDetails: '[]',
        success: true,
        ts: body.ts as string,
        errorCode: '',
        errorMessage: '',
      },
    }));
    const result = await client.payments.query({ prestoMrn: 'PM1', paymentRefNum: 'PP1' });
    expect(result.refundDetails).toEqual([]);
    expect(result.paymentDetails).toEqual([]);
  });

  it('requires at least one of paymentRefNum / txnRefNum', async () => {
    const client = makeClient(() => ({ body: {} }));
    await expect(client.payments.query({ prestoMrn: 'PM1' })).rejects.toBeInstanceOf(PrestoPayConfigError);
  });
});

describe('payments.reverse and payments.refund', () => {
  it('reverse derives reconcileBy from paymentRefNum', async () => {
    const client = makeClient(() => ({ status: 500, rawBody: 'err' }));
    const promise = client.payments.reverse({
      prestoMrn: 'PM1',
      reversalRefNum: 'rev-1',
      paymentRefNum: 'PP1',
    });
    await promise.catch((err: PrestoPayApiError) => {
      expect(err.reconcileBy).toEqual({ paymentRefNum: 'PP1' });
    });
    await expect(promise).rejects.toBeInstanceOf(PrestoPayApiError);
  });

  it('refund maps amount and refundAmount separately', async () => {
    const client = makeClient((_path, body) => ({
      body: {
        prestoMrn: body.prestoMrn as string,
        paymentRefNum: 'PP1',
        amount: 1000,
        refundAmount: 400,
        currencyCode: 'MYR',
        paymentStatus: 'PartialRefunded',
        success: true,
        ts: body.ts as string,
        errorCode: '',
        errorMessage: '',
      },
    }));
    const result = await client.payments.refund({
      prestoMrn: 'PM1',
      paymentRefNum: 'PP1',
      refundRefNum: 'rf-1',
      remark: 'customer request',
      amount: 400,
    });
    expect(result.amount).toBe(1000);
    expect(result.refundAmount).toBe(400);
  });
});

describe('raw escape hatch', () => {
  it('post() signs, sends, verifies, and returns the parsed object', async () => {
    const client = makeClient((_path, body) => ({
      body: { prestoMrn: body.prestoMrn as string, echoed: body.foo as string, success: true, ts: body.ts as string, errorCode: '', errorMessage: '' } as never,
    }));
    const result = await client.raw.post('/v1/ext/some/new-endpoint', { prestoMrn: 'PM1', foo: 'bar' });
    expect(result.echoed).toBe('bar');
  });

  it('sign() and verifyBody() round-trip', async () => {
    // sign() uses the client's own private key; verifyBody() checks against its configured prestoPublicKey.
    // To test the round trip in one client, configure both to the same throwaway keypair.
    const client = createPrestoPay({
      environment: { baseUrl: 'https://fake.presto.invalid' },
      merchantId: 'TESTMID',
      privateKey: merchantPrivateKeyPem,
      prestoPublicKey: merchantPublicKeyPem,
    });
    const body: JsonObject = { amount: 100, currencyCode: 'MYR' };
    const canonical = Object.keys(body)
      .sort()
      .map((key) => String(body[key]))
      .join(':');
    const signature = await client.raw.sign(canonical);
    const signedBody = { ...body, signature };
    expect(await client.raw.verifyBody(signedBody)).toBe(true);
    expect(await client.raw.verifyBody({ ...signedBody, amount: 999 })).toBe(false);
  });
});
