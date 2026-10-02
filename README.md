# Presto Pay SDK for JavaScript

[![npm](https://img.shields.io/npm/v/@prestouniverse/presto-pay-sdk.svg)](https://www.npmjs.com/package/@prestouniverse/presto-pay-sdk)
[![CI](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Accept payments through the **Presto Connect** payment gateway from JavaScript or TypeScript on the server. The
SDK signs every request, verifies every response and webhook, and gives you typed requests and results, so you
don't have to handle the gateway's signature scheme yourself.

- **Node 18.20+**, Cloudflare Workers and Vercel Edge
- **Zero runtime dependencies**; signing uses Web Crypto
- **Server-side only, ESM-only**: it refuses to load in a browser, because your private key must never reach
  client-side code. On Node 18.20–22.11, CommonJS code loads it with dynamic `import()`

## Contents

- [Install](#install)
- [Before you start](#before-you-start)
- [How a payment works](#how-a-payment-works)
- [Quick start](#quick-start)
- [Payment statuses](#payment-statuses)
- [Next steps](#next-steps)

## Install

```bash
npm install @prestouniverse/presto-pay-sdk
```

## Before you start

### 1. Create your key pair

You sign every request with your own RSA private key, and Presto verifies it with the matching public key.
Generate the pair yourself with `openssl`; the private key never leaves your systems:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out merchant-key.pem
openssl req -new -x509 -key merchant-key.pem -days 99999 -subj "/CN=Your Company" -outform DER -out merchant.der
```

`merchant-key.pem` is your private key in the unencrypted PKCS#8 PEM format the SDK reads; keep it secret and
out of source control. Send `merchant.der` (your public key, in the DER format Presto requires) to Presto.
The certificate is valid for 99999 days (until the year 2300), so you won't have to generate a new key pair
and register it with Presto again.

### 2. Get your details from Presto

| From Presto | What it is | Where it goes |
|-------------|------------|---------------|
| Merchant ID (`mid`) | Identifies your merchant account | `createPrestoPay({ merchantId })` |
| Presto merchant reference (`prestoMrn`) | Identifies the shop or outlet; one `mid` can have several | Every request: `prestoMrn` |
| Presto certificate (`.der`) | Verifies Presto's responses and webhooks; the SDK reads it as is | `createPrestoPay({ prestoPublicKey })` |

Staging and production are separate: each has its own `mid`, `prestoMrn` and Presto certificate, and you
register your public key for each. Never mix them.

## How a payment works

```
 Your server                      Presto                     Shopper's browser
     |---- 1. init ------------------>|                              |
     |<--- paymentUrl ----------------|                              |
     |---- 2. redirect to paymentUrl ------------------------------->|
     |                                |<---- 3. shopper pays --------|
     |                                |---- 4a. redirect to your redirectUrl -->|
     |<--- 4b. webhook to your notifyUrl                             |
     |---- 5. query ----------------->|                              |
```

1. Your server calls `init` with your order's reference and amount. Presto returns a `paymentUrl`.
2. You redirect the shopper to `paymentUrl`.
3. The shopper chooses a payment method and pays on Presto's page.
4. Presto sends the shopper's browser back to your `redirectUrl` **and** POSTs a signed webhook to your
   `notifyUrl`. These happen independently and can arrive in either order.
5. On both, you call `query` to get the payment's status from Presto, and update the order.

The identifiers you'll see:

| Name | Who creates it | What it's for |
|------|----------------|---------------|
| `txnRefNum` | You | Your reference for the payment, such as an order ID. Unique per payment, at most 50 characters |
| `paymentRefNum` | Presto | Presto's reference for the payment, returned by `init` |
| `eventRefNum` | Presto | Identifies one webhook event; stays the same when Presto redelivers it |
| `reversalRefNum`, `refundRefNum` | You | Your reference for a reversal or a refund |

## Quick start

These examples use Node and Express. Workers, Next.js and other runtimes work the same way; see
[Webhooks](docs/webhooks.md#reading-the-raw-body) for how to read the raw body in each.

### 1. Create the client

Create it once at startup and reuse it.

```ts
import { readFileSync } from 'node:fs';
import { createPrestoPay } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({
  environment: 'staging',
  merchantId: 'YOUR_MID',
  privateKey: readFileSync('merchant-key.pem', 'utf8'),
  prestoPublicKey: readFileSync('presto.der'),
});
```

To configure the client from environment variables instead, see
[Configuration](docs/production.md#configuration-from-environment).

### 2. Start a payment

```ts
import { PaymentMethod, TxnType } from '@prestouniverse/presto-pay-sdk';

const payment = await presto.payments.init({
  prestoMrn: 'YOUR_PRESTO_MRN',
  txnType: TxnType.WebPay,
  txnRefNum: orderId,
  displayDesc: `Order ${orderId}`,
  amount: 10_000, // minor units: MYR 100.00
  currencyCode: 'MYR',
  notifyUrl: 'https://your-app.example/presto/notify',
  redirectUrl: `https://your-app.example/presto/return/${orderId}`,
  allowedPaymentMethods: [PaymentMethod.PmPgCard], // Skip this unless you build your own payment selection page
});

// Save payment.paymentRefNum with the order, then send the shopper to Presto.
if (!payment.paymentUrl) throw new Error(`Presto returned no paymentUrl for ${orderId}`);
res.redirect(payment.paymentUrl);
```

`notifyUrl` must be reachable from the internet; on your own machine, use a tunnel such as ngrok. For the codes
you can pass to `allowedPaymentMethods`, see [Payment methods](docs/payment-methods.md).

### 3. Show the result on your return page

The redirect only tells you the shopper came back, not whether they paid. Ask Presto:

```ts
import { PaymentStatus } from '@prestouniverse/presto-pay-sdk';

const result = await presto.payments.query({ prestoMrn: 'YOUR_PRESTO_MRN', txnRefNum: orderId });

if (result.paymentStatus === PaymentStatus.Authorised) {
  // Paid: show the confirmation.
} else if (result.paymentStatus === PaymentStatus.PendingAuthorise) {
  // Not finished yet: show "processing" and check again shortly.
} else {
  // Not paid (Failed, Cancelled, Expired, ...).
}
```

### 4. Handle the webhook

A webhook tells you something happened to a payment (`eventCode`, and `success` for whether it worked), not the
payment's resulting status, so query for that here too. Verify the **raw** request body, exactly as received.

```ts
import express from 'express';
import { isPrestoPayError, NotifyAck } from '@prestouniverse/presto-pay-sdk';

app.post('/presto/notify', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await presto.webhooks.verify(req.body);
  } catch (error) {
    if (isPrestoPayError(error) && error.name === 'PrestoPaySignatureError') {
      res.sendStatus(401); // forged, for another mid, or too old
    } else {
      res.type('json').send(NotifyAck.forError(error)); // malformed body
    }
    return;
  }

  try {
    const payment = await presto.payments.query({
      prestoMrn: event.prestoMrn,
      paymentRefNum: event.paymentRefNum,
    });
    await orders.applyStatus(event.txnRefNum, payment.paymentStatus);
  } catch {
    res.type('json').send(NotifyAck.resend);
    return;
  }
  res.type('json').send(NotifyAck.ok);
});
```

`NotifyAck.ok` tells Presto the event is handled. `NotifyAck.resend` asks Presto to deliver it again, which you
want when your own processing failed. Presto resends with a backoff of 2, 4, 8, 16, 32, 64, 128, 256, 512 and 1024
minutes between attempts.

The same event can arrive more than once, so `applyStatus` checks the order, not the event: it finalises the
order only if the order hasn't been finalised yet, and fulfils only on the change into `Authorised`. A
redelivery then finds the order already in that status and changes nothing. See
[Webhooks](docs/webhooks.md#handling-redeliveries) for the details.

Update the order the same way from your return page and your webhook: whichever arrives first records the
status, and the other finds it already done.

## Payment statuses

`paymentStatus` is one of these strings; compare it with the `PaymentStatus` constants.

| Status | Meaning | What to do |
|--------|---------|------------|
| `PendingAuthorise` | Created; the shopper hasn't finished paying | Wait. It becomes `Expired` if not paid within 15 minutes of `init` |
| `Authorised` | Paid | Fulfil the order |
| `Failed` | The payment attempt failed | Don't fulfil |
| `Cancelled` | Cancelled before it was paid, for example by `reverse` | Don't fulfil |
| `Expired` | Not paid within 15 minutes | Don't fulfil; start a new payment if the shopper returns |
| `PendingReverse` | A reversal is in progress | Query again later |
| `Reversed` | The payment was reversed | Treat the order as cancelled |
| `PendingRefund` | A refund is in progress | Query again later |
| `PartialRefunded` | Part of the amount was refunded | Update the order's refunded amount |
| `Refunded` | The full amount was refunded | Treat the order as refunded |

The gateway can add statuses, so handle an unknown value without failing.

## Next steps

- [Payment methods](docs/payment-methods.md): every payment method code, which ones you can use, and passing a
  code the SDK doesn't list yet.
- [Payments and errors](docs/payments-and-errors.md): query, reverse and refund payments; handle errors and
  timeouts safely.
- [Webhooks](docs/webhooks.md): reading the raw body in each runtime, replies, redelivery and guarding the order update.
- [Production](docs/production.md): configuration, keys and secrets, several merchants, the go-live
  checklist and troubleshooting.
- [Sample](sample/my-store/README.md): a runnable Express checkout against Presto staging (`npm run demo`).

## Contributing

```bash
npm run typecheck
npm test
npm run check:package
```

`npm run test:staging` runs an opt-in test against Presto staging with your own credentials. Report security
issues as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE).
