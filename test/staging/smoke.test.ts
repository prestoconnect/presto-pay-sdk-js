/**
 * `npm run test:staging`, skipped unless PRESTOPAY_STAGING_SMOKE=1. It runs against real staging with
 * `strict: true`, so anything an unconfirmed rule guessed wrong about fails loudly instead of being absorbed,
 * and saves unfamiliar bodies as candidate vectors.
 *
 * This hits Presto's real staging gateway, which is a live third-party network call — it must never run as
 * part of `npm test` or CI-by-default. It only runs when a human explicitly opts in.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPrestoPay } from '../../src/client.js';
import { isPrestoPayError } from '../../src/errors.js';
import { TxnType } from '../../src/payments/constants.js';

const enabled = process.env.PRESTOPAY_STAGING_SMOKE === '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const candidatesDir = path.resolve(here, 'candidate-vectors');

function saveCandidate(name: string, data: unknown): void {
  if (!existsSync(candidatesDir)) mkdirSync(candidatesDir, { recursive: true });
  writeFileSync(path.join(candidatesDir, `${name}.json`), JSON.stringify(data, null, 2));
}

describe.skipIf(!enabled)('staging smoke (PRESTOPAY_STAGING_SMOKE=1)', () => {
  const privateKey = readFileSync(path.join(specDir, 'keys/presto_rm_key-pkcs8.pem'), 'utf8');
  const prestoPublicKey = readFileSync(path.join(specDir, 'keys/presto_ext_service_dev.der'));

  const client = createPrestoPay({
    environment: 'staging',
    merchantId: '11StreetMock',
    privateKey,
    prestoPublicKey: new Uint8Array(prestoPublicKey),
    strict: true, // reports [U]-rule drift as a failure instead of silently coercing it (§4, §11)
  });

  it('init a QrPay payment and query it back', async () => {
    const txnRefNum = `smoke-${Date.now()}`;
    let initResult;
    try {
      initResult = await client.payments.init({
        prestoMrn: 'PM181019QGJWH4K',
        txnType: TxnType.QrPay,
        txnRefNum,
        displayDesc: 'presto-pay-sdk-js staging smoke test',
        amount: 100,
        currencyCode: 'MYR',
      });
    } catch (err) {
      saveCandidate('init-error', {
        isPrestoPayError: isPrestoPayError(err),
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      throw err;
    }
    saveCandidate('init-success', initResult);
    expect(initResult.paymentRefNum).toBeTruthy();
    expect(initResult.paymentStatus).toBeTruthy();

    const queryResult = await client.payments.query({
      prestoMrn: 'PM181019QGJWH4K',
      paymentRefNum: initResult.paymentRefNum,
    });
    saveCandidate('query-success', queryResult);
    expect(queryResult.paymentRefNum).toBe(initResult.paymentRefNum);
  }, 30_000);

  it('reports a clear clock-skew message on a deliberately stale request', async () => {
    const staleClient = createPrestoPay({
      environment: 'staging',
      merchantId: '11StreetMock',
      privateKey,
      prestoPublicKey: new Uint8Array(prestoPublicKey),
      now: () => Date.now() - 20 * 60_000, // outside the 15-minute validity window (§3.3)
    });
    const promise = staleClient.payments.query({
      prestoMrn: 'PM181019QGJWH4K',
      txnRefNum: 'does-not-matter',
    });
    await promise.catch((err) => {
      saveCandidate('stale-ts-error', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
    await expect(promise).rejects.toThrow(/1005|clock|skew|validity/i);
  }, 30_000);
});

if (!enabled) {
  describe('staging smoke', () => {
    it.skip('set PRESTOPAY_STAGING_SMOKE=1 to run this suite against real staging', () => {});
  });
}
