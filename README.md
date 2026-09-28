# @prestouniverse/presto-pay-sdk

[![npm](https://img.shields.io/npm/v/@prestouniverse/presto-pay-sdk.svg)](https://www.npmjs.com/package/@prestouniverse/presto-pay-sdk)
[![CI](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Standalone Presto Pay SDK for JavaScript and TypeScript. It signs and verifies gateway requests using Web Crypto,
handling the parts that are easy to get subtly wrong when integrating a signed payment API by hand.

- **Node 18.20+** (20, 22, 24, 26), Cloudflare Workers, and Vercel Edge — Bun and Deno may work but are not in
  the support statement yet
- **Zero runtime dependencies**
- **Server-side only, ESM-only** — browsers are refused because the merchant private key must not reach
  client-side code; CommonJS callers on Node 18.20–22.11 must use dynamic `import()`

`0.1.0` is the first published release. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Merchant identity](#merchant-identity)
- [Configuration from environment](#configuration-from-environment)
- [Retries and idempotency](#retries-and-idempotency)
- [Webhooks](#webhooks)
- [Errors](#errors)
- [Samples](#samples)
- [Checks](#checks)
- [License](#license)

## Install

```bash
npm install @prestouniverse/presto-pay-sdk
```

> **Production safety:** use `environment: 'staging'` while integrating and validating. Switch to
> `environment: 'production'` only with production credentials and a production checklist. Never mix staging
> and production keys, merchant references, or webhook endpoints.

Credentials — merchant ID (`mid`), Presto merchant reference (`prestoMrn`), an unencrypted PKCS#8 PEM private
key, and Presto's public certificate (PEM or DER) — come from onboarding; this repository does not contain
bundled staging credentials.

## Quick start

```ts
import { createPrestoPay, TxnType } from '@prestouniverse/presto-pay-sdk';

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
  redirectUrl: 'https://merchant.example/presto/return/order-123',
});

// Redirect the shopper to the hosted payment page.
console.log(payment.paymentUrl);
```

See [payments and errors](docs/payments-and-errors.md) for hosted-flow completion, retries, and reconciliation.

## Merchant identity

A client belongs to one merchant: `merchantId` (`mid`) is required in `PrestoPayOptions`, sent on every request,
and `createWebhookVerifier({ merchantId, ... })` rejects events for any other `mid`. `prestoMrn` is set per
operation (`InitRequest.prestoMrn`, etc.), so one client can use several `prestoMrn`s under its `mid`.

To serve several merchants, build one `PrestoPayClient` per `mid` (they can share the same keys) and route each
request and webhook to the matching client, for example with a `Map` keyed by `mid`.

## Configuration from environment

```ts
import { fromEnv, createPrestoPay } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay(fromEnv(process.env));
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PRESTOPAY_ENV` | One of env or base URL | `staging` or `production` |
| `PRESTOPAY_BASE_URL` | Alternative to `PRESTOPAY_ENV` | Override gateway base URL |
| `PRESTOPAY_MID` | Yes | Merchant `mid` for this client |
| `PRESTOPAY_PRIVATE_KEY` | Yes | Unencrypted PKCS#8 PEM private key |
| `PRESTOPAY_PUBLIC_KEY` | Yes | Presto public certificate (PEM or DER) |

`fromEnv` works with `process.env`, a Workers `env` binding, or Vercel's env object — anything shaped like a
string record. Merge in `fetch`, `now`, `strict`, and the rest programmatically:
`createPrestoPay({ ...fromEnv(process.env), strict: true })`. For production, prefer loading keys from your
secret store over raw environment strings when possible.

## Retries and idempotency

`payments.init`, `payments.reverse`, and `payments.refund` are **not** safely retried after the request may have
reached Presto. The default retry policy (`retryReads` / `DEFAULT_RETRY_READS`) only covers `payments.query`;
these three operations are only retried automatically when `PrestoPayTransportError.requestNotSent` is `true`.

If `init` times out or fails ambiguously **after** send, **do not** call `init` again with the same `txnRefNum`
(duplicate refs return error `1203`). Reconcile with:

```ts
const status = await presto.payments.query({
  prestoMrn: process.env.PRESTO_MRN!,
  txnRefNum: 'order-123',
});
```

`payments.query` is read-only and safe to retry on transport errors and 5xx responses.

## Webhooks

Presto POSTs JSON to your `notifyUrl` from its infrastructure — the URL must be **publicly reachable** (not
`localhost` unless you tunnel):

```ts
import { createWebhookVerifier } from '@prestouniverse/presto-pay-sdk';

const verifier = createWebhookVerifier({
  merchantId: process.env.PRESTOPAY_MID!, // required; rejects events signed for other merchants
  prestoPublicKey: process.env.PRESTOPAY_PUBLIC_KEY!,
});

const event = await verifier.verify(rawRequestBody); // string, Uint8Array, or unread Request
console.log(event.paymentStatus); // Authorised maps to success; others pass through
```

Presto signs webhooks for every partner with the same key, so `merchantId` must be checked — without it, a
genuine event for another merchant would still verify. Signature is checked before `mid` and freshness, since a
forged body fails there regardless.

`verify` also rejects a webhook whose signed `ts` is more than 15 minutes from the local clock by default, so a
captured webhook cannot be replayed later. Keep the host clock in sync (NTP). Adjust the window with
`maxTimestampAgeMs`; widening it further means you must deduplicate events yourself (for example by
`eventRefNum`).

After any webhook, call `payments.query` for authoritative payment status. See
[webhook handling](docs/webhooks.md) for the full walkthrough, including framework-specific raw-body setup.

## Errors

All SDK errors extend `PrestoPayError`, identified by `isPrestoPayError(error)` rather than `instanceof` (which
breaks silently across duplicate copies of the package):

| Type | When |
|------|------|
| `PrestoPayApiError` | Non-200 status, or a signed body with `success: false` |
| `PrestoPaySignatureError` | Missing or invalid signature on responses/webhooks; webhook `mid` not allowed or timestamp outside the freshness window |
| `PrestoPayResponseError` | Malformed body, missing required field, unparseable `ts`, echo mismatch |
| `PrestoPayTransportError` | Network failure, timeout, abort — check `requestNotSent` |
| `PrestoPayConfigError` | Invalid options or request input, including strings that cannot survive UTF-8 encoding |

`mayHaveSucceeded(error)` is a guard over `mayHaveTakenEffect`, stamped at the point of throw for `init`,
`reverse`, and `refund` — a 500 on `init` is indeterminate, a 500 on `query` means nothing happened. See
[payments and errors](docs/payments-and-errors.md) for reconciliation guidance.

## Samples

[sample/my-store/](sample/my-store/) — a MyStore-branded checkout demo that calls Presto's real staging gateway.
Credentials are required and must be supplied by you; none are bundled or implied by the repository.

```bash
npm install
npm run demo
```

Configure the required variables in `sample/my-store/.env` first: `PRESTOPAY_MID`, `PRESTO_MRN`,
`PRESTOPAY_PRIVATE_KEY_FILE`, and `PRESTOPAY_PUBLIC_KEY_FILE`. `PORT` and `PUBLIC_URL` are optional. The demo
uses localhost for redirects; use a public HTTPS tunnel and set `PUBLIC_URL` to receive webhooks.

See [sample/my-store/README.md](sample/my-store/README.md) for details, and
[production configuration and staging checklist](docs/production.md) before going live.

## Checks

```bash
npm run typecheck
npm test
npm run check:package
```

The opt-in live staging test is `npm run test:staging` with externally supplied credentials; it is not part of
`npm test`.

Reference material: [security policy](SECURITY.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE).
