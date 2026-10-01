# Webhooks

Presto POSTs a signed JSON webhook to the `notifyUrl` you pass to `init`, `reverse` or `refund` when something
happens to that payment. The [quick start](../README.md#4-handle-the-webhook) has a complete Express handler;
this guide explains each part.

- [What a webhook tells you](#what-a-webhook-tells-you)
- [Reading the raw body](#reading-the-raw-body)
- [Verifying it](#verifying-it)
- [Replying](#replying)
- [Handling redeliveries](#handling-redeliveries)
- [The freshness window](#the-freshness-window)
- [Several merchants, and webhook-only services](#several-merchants-and-webhook-only-services)

## What a webhook tells you

`presto.webhooks.verify(...)` returns a `WebhookEvent`:

| Property | Value |
|----------|-------|
| `eventCode` | What happened: `Authorised`, `Cancelled`, `Reversed`, `Refunded` or `Expired` (compare with `EventCode`). Presto may add codes |
| `success` | Whether it worked. A `Refunded` event with `success` false is a refund that failed |
| `txnRefNum`, `paymentRefNum`, `prestoMrn`, `mid` | Which payment it's about |
| `eventRefNum` | Identifies this event; the same on every redelivery |
| `amount`, `currencyCode`, `paymentDetails` | The payment's amount and how it was paid |

A webhook reports an event, not the payment's resulting status. A failed refund, for example, leaves the
payment in whatever status it had before, which the event doesn't carry. To act on a webhook, `query` the
payment and use the status it returns.

## Reading the raw body

The signature covers the body's exact bytes, so verify the body as received. `verify` takes a `string`, a
`Uint8Array` (including a Node `Buffer`) or an unread `Request`:

- **Express:** mount `express.raw({ type: '*/*' })` on the webhook route and pass `req.body`. Don't let
  `express.json()` parse it first.
- **Cloudflare Workers, Next.js route handlers and other Fetch-style handlers:** pass the `Request` itself, or
  `await request.text()`.
- **Hono:** pass `c.req.raw`.

Passing `JSON.parse(body)`, JSON you've re-serialized, or a request whose body was already read will fail
verification.

## Verifying it

`verify` checks that:

- the body is signed by Presto,
- the required fields are present,
- the event is for your `mid`, and
- its timestamp is within 15 minutes of your clock.

The `mid` check matters: Presto signs webhooks for every merchant with the same key, so a genuine webhook for
someone else's account would otherwise pass.

A failure throws `PrestoPaySignatureError` (bad signature, another merchant's `mid`, or a stale timestamp) or
`PrestoPayResponseError` (malformed body). Answer a `PrestoPaySignatureError` with HTTP 401. For a malformed
body, `NotifyAck.forError(error)` gives `{"resend":false}`, since a redelivery would fail the same way.

## Replying

Reply HTTP 200 with a JSON body:

| Body | Meaning | When to send it |
|------|---------|-----------------|
| `NotifyAck.ok` (`{"resend":false}`) | Handled; don't send it again | You've recorded the event, or had already recorded it earlier |
| `NotifyAck.resend` (`{"resend":true}`) | Send it again later | Your own processing failed, for example the `query` or your database |

In a Fetch-style handler, `NotifyAck.okResponse()` and `NotifyAck.resendResponse()` return a ready-made
`Response`:

```ts
export async function POST(request: Request) {
  let event;
  try {
    event = await presto.webhooks.verify(request);
  } catch (error) {
    if (isPrestoPayError(error) && error.name === 'PrestoPaySignatureError') {
      return new Response(null, { status: 401 });
    }
    return NotifyAck.forErrorResponse(error);
  }
  // ... query and record the event, returning NotifyAck.resendResponse() if that fails
  return NotifyAck.okResponse();
}
```

Presto retries 1, 2, 5 and 10 minutes after the first attempt, so an event is delivered at most five times over
about 18 minutes. Only ask for a resend when trying again could succeed.

`NotifyAck.forError(error)` picks the reply for an error: `ok` for a webhook that failed verification, and
`resend` for anything else, including a failed `query` inside your handler.

Reply quickly. Record the event and reply, and do slow work such as emails or fulfilment afterwards.

## Handling redeliveries

The same event can arrive more than once, for example after you ask for a resend. Every delivery of an event
has the same `eventRefNum`, so:

- record `eventRefNum` once you've handled the event, under a unique constraint in your database;
- skip events you've already recorded, and still reply `NotifyAck.ok`;
- record it only after the `query` succeeds, so a failed attempt isn't mistaken for a handled one on
  redelivery.

Keep recorded `eventRefNum`s for at least as long as the redelivery schedule (about 18 minutes).

## The freshness window

`verify` rejects a webhook whose timestamp is more than 15 minutes from your clock, so a captured webhook can't
be replayed later. Each redelivery carries a fresh timestamp, so redeliveries pass. Keep your server's clock in
sync with NTP.

To change the window, pass `webhooks: { maxTimestampAgeMs }` to `createPrestoPay`, or `maxTimestampAgeMs` to
`createWebhookVerifier`. Widen it only if you deduplicate on `eventRefNum`, since that becomes your protection
against replays.

## Several merchants, and webhook-only services

`createWebhookVerifier` builds a verifier without a client. It holds no private key, so a service that only
receives webhooks needs nothing else, and it accepts several merchants on one endpoint:

```ts
import { createWebhookVerifier } from '@prestouniverse/presto-pay-sdk';

const verifier = createWebhookVerifier({
  merchantId: ['MID_A', 'MID_B'],
  prestoPublicKey: readFileSync('presto.der'),
});

const event = await verifier.verify(request);
// event.mid says which merchant it's for: pick the matching client before you query.
```
