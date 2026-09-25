# @prestouniverse/presto-pay-sdk

[![CI](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Presto Pay SDK `0.1.0` is the first published release. See [CHANGELOG.md](CHANGELOG.md) for the release notes.

Presto Pay SDK for JavaScript and TypeScript. It signs and verifies gateway requests using Web Crypto and has
zero runtime dependencies.

## Before you start

- **Supported runtimes:** Node 18.20+ (20, 22, 24 and 26), Cloudflare Workers, and Vercel Edge. Bun and Deno
  may work but are not in the support statement yet.
- **Server-side only:** browsers are deliberately refused because the merchant private key must not reach
  client-side code. The package is ESM-only; CommonJS callers on Node 18.20–22.11 must use dynamic `import()`.
- **Credentials:** obtain your merchant ID (`mid`), Presto merchant reference (`prestoMrn`), merchant private
  key as unencrypted PKCS#8 PEM, and Presto's public certificate as PEM or DER through onboarding. Credentials
  are external; this repository does not contain bundled staging credentials.

## Install

```bash
npm install @prestouniverse/presto-pay-sdk
```

> **Production safety:** use `environment: 'staging'` while integrating and validating. Switch to
> `environment: 'production'` only with production credentials and a production checklist. Never mix staging
> and production keys, merchant references, or webhook endpoints.

## First payment

```ts
import { createPrestoPay, PaymentMethod, TxnType } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({
  environment: 'staging', // change only after production validation
  merchantId: process.env.PRESTOPAY_MID!,
  privateKey: process.env.PRESTOPAY_PRIVATE_KEY!,
  prestoPublicKey: process.env.PRESTOPAY_PUBLIC_KEY!,
});

const payment = await presto.payments.init({
  prestoMrn: process.env.PRESTO_MRN!,
  txnType: TxnType.WebPay,
  txnRefNum: 'order-123',
  displayDesc: 'Order 123',
  amount: 10_000, // minor units; MYR 100.00
  currencyCode: 'MYR',
  notifyUrl: 'https://merchant.example/presto/notify',
  redirectUrl: 'https://merchant.example/presto/return',
  allowedPaymentMethods: [PaymentMethod.Wallet],
});

// Redirect the shopper to the hosted payment page.
console.log(payment.paymentUrl);
```

`prestoMrn` is selected per operation because one `mid` can have several Presto merchant references.
See [payments and errors](docs/payments-and-errors.md) for hosted-flow completion, retries, and reconciliation.

## API overview

- `payments.init(input)` starts a payment and returns the hosted `paymentUrl`.
- `payments.query(input)` reads payment state; it is safe to retry.
- `payments.reverse(input)` reverses a payment where supported.
- `payments.refund(input)` requests a refund.
- `fromEnv(env)` maps `PRESTOPAY_ENV` or `PRESTOPAY_BASE_URL`, `PRESTOPAY_MID`, `PRESTOPAY_PRIVATE_KEY`, and
  `PRESTOPAY_PUBLIC_KEY` to client options.
- `raw.post(path, body)` is the signed escape hatch for gateway endpoints not yet wrapped by the SDK.
- `createWebhookVerifier(options)` verifies raw webhook bodies without creating a payment client.
- `isPrestoPayError(error)` safely identifies SDK errors across duplicate package copies; `mayHaveSucceeded(error)`
  is a guard for `mayHaveTakenEffect`.

## Choose an integration path

- [Hosted payments, operations, and errors](docs/payments-and-errors.md)
- [Webhook handling](docs/webhooks.md)
- [Production configuration and staging checklist](docs/production.md)
- [Runnable MyStore demo](sample/my-store/README.md)

Reference material: [security policy](SECURITY.md) and the [demo route reference](sample/my-store/README.md).

## Demo

The MyStore demo calls Presto's real staging gateway. Credentials are required and must be supplied by you;
none are bundled or implied by the repository.

```bash
npm install
npm run demo
```

Configure the required variables in `sample/my-store/.env` first: `PRESTOPAY_MID`, `PRESTO_MRN`,
`PRESTOPAY_PRIVATE_KEY_FILE`, and `PRESTOPAY_PUBLIC_KEY_FILE`. `PORT` and `PUBLIC_URL` are optional. The demo
uses localhost for redirects; use a public HTTPS tunnel and set `PUBLIC_URL` to receive webhooks. See the
[demo guide](sample/my-store/README.md) for setup.

## Checks

```bash
npm run typecheck
npm test
npm run check:package
```

The opt-in live staging test is `npm run test:staging` with externally supplied credentials; it is not part of
`npm test`.

## License

Apache-2.0
