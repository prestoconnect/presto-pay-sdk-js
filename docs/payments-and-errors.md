# Payments and errors

## Hosted payment flow

Call `payments.init` with a unique `txnRefNum` and the merchant's `prestoMrn`. Redirect the shopper to the returned
`paymentUrl`. Treat the browser return as a navigation hint, not final payment proof: query the payment server-side
with `payments.query`, and use verified webhooks for asynchronous updates.

```ts
const result = await presto.payments.query({ prestoMrn, txnRefNum });
// Reconcile your order from result.paymentStatus and the gateway identifiers.
```

Amounts are integer minor units. `reverse` identifies a payment by `paymentRefNum` or `txnRefNum`; `refund` requires
`paymentRefNum`, a unique `refundRefNum`, and a `remark`. `query` accepts `paymentRefNum` or `txnRefNum`.

## Retry and idempotency

`query` is read-only and safe to retry. `init`, `reverse`, and `refund` change gateway state; never blindly resend one
after a timeout, 5xx, malformed response, or signature failure. A request may have reached the gateway even when the
client could not receive its response.

Every SDK error has `mayHaveTakenEffect`. When it is true, use `reconcileBy` with `query` before deciding whether to
retry or fulfil the order:

```ts
import { isPrestoPayError, TxnType } from '@prestouniverse/presto-pay-sdk';

try {
  await presto.payments.init({ prestoMrn, txnType: TxnType.WebPay, txnRefNum, displayDesc, amount, currencyCode });
} catch (error) {
  if (isPrestoPayError(error) && error.mayHaveTakenEffect) {
    const key = error.reconcileBy; // { txnRefNum } for init; { paymentRefNum } for reverse/refund
    if (!key) throw error;
    const current = await presto.payments.query({ prestoMrn, ...key });
    // Reconcile the order with current.paymentStatus; do not create a second operation.
  } else {
    throw error; // validate/fix the request or report a definite rejection
  }
}
```

`mayHaveTakenEffect` is set for an uncertain transport failure, a 5xx on a state-changing call, a post-200 parsing or
verification failure, and duplicate `init` business error `1203`. A normal 4xx or ordinary business rejection is safe
to handle as a rejection. `mayHaveSucceeded(error)` is a convenience guard when the caught value is `unknown`.

## Error classification

- `PrestoPayConfigError`: invalid client or request input; fix configuration or input.
- `PrestoPayTransportError`: network, timeout, or abort; inspect `requestNotSent` and reconcile state-changing calls.
- `PrestoPayApiError`: HTTP or signed business error; inspect `kind`, `errorCode`, and `mayHaveTakenEffect`.
- `PrestoPaySignatureError`: invalid response/webhook signature, foreign merchant, or stale webhook.
- `PrestoPayResponseError`: malformed, incomplete, or mismatched response.

Use `isPrestoPayError` instead of `instanceof`. Error bodies are redacted by default because they may contain payment
data; only set `redactErrorBodies: false` in a controlled diagnostic environment.

For a gateway operation not wrapped by the SDK, `raw.post('/path', body)` signs, sends, verifies, and parses the
response. Omit `mid`, `ts`, and `signature`; the client adds them.
