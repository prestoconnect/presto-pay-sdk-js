# Payments and errors

This guide covers the four payment operations and how to handle their failures. It assumes you've set up a
client as in the [quick start](../README.md#quick-start).

- [Look up a payment](#look-up-a-payment)
- [Reverse a payment](#reverse-a-payment)
- [Refund a payment](#refund-a-payment)
- [Errors](#errors)
- [When you don't know whether it worked](#when-you-dont-know-whether-it-worked)
- [Retries and deadlines](#retries-and-deadlines)

Every request needs your `prestoMrn`. Amounts are integers in minor units (`10_000` is MYR 100.00). A missing or
invalid field throws `PrestoPayConfigError` before anything is sent.

## Look up a payment

`query` returns a payment's current status and details. Look it up by your `txnRefNum` or by Presto's
`paymentRefNum`:

```ts
const payment = await presto.payments.query({
  prestoMrn: 'YOUR_PRESTO_MRN',
  txnRefNum: 'order-123', // or paymentRefNum
});

payment.paymentStatus;  // see the status table in the README
payment.reversalStatus; // Reversing, Failed or Success, once you've requested a reversal
payment.refundStatus;   // Refunding, Failed or Success, once you've requested a refund
payment.refundDetails;  // one entry per refund
```

`query` only reads, so it is always safe to call again.

## Reverse a payment

`reverse` undoes a whole payment:

```ts
const reversal = await presto.payments.reverse({
  prestoMrn: 'YOUR_PRESTO_MRN',
  paymentRefNum, // or txnRefNum
  reversalRefNum: 'rev-order-123', // your reference for this reversal, at most 50 characters
  remark: 'Customer cancelled', // optional
  notifyUrl: 'https://your-app.example/presto/notify', // optional: get a Reversed webhook
});
```

What happens depends on the payment's status:

- **`PendingAuthorise`** (not paid yet): the payment is cancelled and its status becomes `Cancelled`.
- **`Expired`**: fails with error `1219` (`ErrorCode.InvalidStatusForReversal`). There's nothing left to undo.
- **Paid**: the gateway decides. It can refuse once the payment has settled (`1220`) or its reversal window
  has passed (`1221`). Use `refund` instead in that case.

## Refund a payment

`refund` returns all or part of a paid payment's amount:

```ts
const refund = await presto.payments.refund({
  prestoMrn: 'YOUR_PRESTO_MRN',
  paymentRefNum,
  refundRefNum: 'ref-order-123', // your reference for this refund, at most 50 characters
  remark: 'Item out of stock', // required, at most 200 characters
  amount: 2_500, // optional: leave it out to refund the full amount
  notifyUrl: 'https://your-app.example/presto/notify', // optional: get a Refunded webhook
});
```

You can request a refund for any payment method, but whether it succeeds depends on the method; some need
manual or offline processing by Presto. A successful `refund` call means Presto accepted the request, not that
the money has moved. Check `refundStatus` with `query`, or wait for the `Refunded` webhook, before treating the
refund as complete. A refund on an unpaid (`PendingAuthorise`) payment fails with `1227`; use `reverse` to
cancel it instead.

## Errors

Every SDK error extends `PrestoPayError` and carries `operation`, `mayHaveTakenEffect` and `reconcileBy`.
Recognise them with `isPrestoPayError(error)` and `error.name`, not `instanceof`, which silently fails when two
copies of the package end up in your bundle.

| `name` | When | Useful properties |
|--------|------|-------------------|
| `PrestoPayConfigError` | Invalid options or request input, including strings that can't be encoded as UTF-8 | `field` |
| `PrestoPayTransportError` | Network failure, timeout or abort | `requestNotSent` |
| `PrestoPayApiError` | Presto rejected the request: a non-200 status (`kind: 'http'`) or `success: false` (`kind: 'business'`) | `httpStatus`, `errorCode`, `errorMessage`, `rawBody`; `canonical` on `1006`/`1007`; `clockOffsetMs` on `1005` |
| `PrestoPaySignatureError` | A response or webhook signature is missing or invalid, a webhook is for another `mid`, or a webhook is too old | `source`, `canonical` |
| `PrestoPayResponseError` | A response or webhook body is malformed, missing a field, or doesn't match the request | `source`, `rawBody` |

Compare `errorCode` with the `ErrorCode` constants, for example
`error.errorCode === ErrorCode.PaymentNotFound`. For codes that point at your setup (`1005`, `1006`, `1007`),
see [Troubleshooting](production.md#troubleshooting).

`rawBody` and `canonical` can contain card and customer details, so by default those values are redacted.
Set `redactErrorBodies: false` only in a controlled environment while debugging.

## When you don't know whether it worked

A timeout, a server error (HTTP 5xx) or a garbled response leaves you not knowing whether Presto acted on your
request. Every error tells you this directly: `mayHaveTakenEffect` is true when the request may have reached
Presto and been acted on. `mayHaveSucceeded(error)` checks the same thing on a value of type `unknown`.

**`init`: call it again with the same `txnRefNum`.** That's safe. If the first call reached Presto, you get the
existing payment and its current status back rather than a second payment:

```ts
let payment;
try {
  payment = await presto.payments.init(request);
} catch (error) {
  if (!mayHaveSucceeded(error)) throw error;
  payment = await presto.payments.init(request); // same txnRefNum: returns the payment if it was created
}
```

If Presto answers `1203` (`ErrorCode.DuplicateTxnRefNum`), a payment with that `txnRefNum` exists; `query` it
to find its state.

**`reverse` and `refund`: check before trying again.** Sending one of these twice could reverse or refund
twice, so `query` first, and look at `reversalStatus` or `refundStatus`. Try again only if the first request
didn't take effect. `error.reconcileBy` gives you the key to query with:

```ts
const current = await presto.payments.query({ prestoMrn: 'YOUR_PRESTO_MRN', ...error.reconcileBy });
```

## Retries and deadlines

The client retries for you only when it's safe:

- **`query`**: on network errors and HTTP 5xx responses, honouring `Retry-After`.
- **`init`, `reverse`, `refund`**: only when the request certainly never left your machine
  (`requestNotSent` is true).

By default it retries twice, backing off exponentially with jitter from 200 ms up to 5 seconds. `deadlineMs`
(30 seconds by default) is the budget for a whole call, retries included. To change them:

```ts
const presto = createPrestoPay({
  // ...
  retryReads: { maxRetries: 3, initialBackoffMs: 500 },
  deadlineMs: 20_000,
});
```

Each call also takes an `AbortSignal`: `presto.payments.query(input, { signal })`.

For a gateway operation the SDK doesn't wrap yet, `presto.raw.post('/path', body)` signs, sends, verifies and
parses the response. Leave out `mid`, `ts` and `signature`; the client adds them.
