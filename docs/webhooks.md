# Webhooks

Webhook signatures cover the exact request body bytes. Verify the raw body before parsing it, and configure the
merchant ID(s) and Presto public certificate used to sign events.

```ts
import { NotifyAck } from '@prestouniverse/presto-pay-sdk';

async function handleNotify(request: Request) {
  try {
    const event = await presto.webhooks.verify(request);
    await handleOnce(event.eventRefNum, event);
    return NotifyAck.okResponse();
  } catch (error) {
    return NotifyAck.forErrorResponse(error);
  }
}
```

`createWebhookVerifier` is available when a service only receives webhooks:

```ts
const verifier = createWebhookVerifier({
  merchantId: ['MID_A', 'MID_B'],
  prestoPublicKey: prestoCertificate,
});
```

## Raw-body examples

- Fetch/Workers/Next.js route handlers: pass the `Request` directly, or pass `await request.text()`.
- Express: mount `express.raw({ type: '*/*' })` on this route and pass the resulting `Buffer`; do not use a body
  already processed by `express.json()`.
- Hono: pass `c.req.raw`.

Passing `JSON.parse(body)` or a request whose body was already consumed will fail verification. The verifier checks the
signature, configured `mid`, and webhook timestamp freshness (15 minutes by default).

## Deduplication and acknowledgements

Presto can redeliver an event. `eventRefNum` is stable across redeliveries, so record it in durable storage with a
reasonable TTL and make fulfilment idempotent:

```ts
async function handleOnce(eventRefNum: string, event: WebhookEvent) {
  if (await seen(eventRefNum)) return;
  await fulfil(event);
  await markSeen(eventRefNum);
}
```

Return HTTP 200 with `NotifyAck.ok` (or `okResponse()`) after accepting the event. Return `NotifyAck.resend` only for
your own transient failure, such as an unavailable database. `NotifyAck.forError` maps permanent signature or malformed
body failures to `resend: false`; retrying those failures cannot repair the request.

`query` remains the authoritative source of payment state. See the [payment reconciliation guide](payments-and-errors.md)
and the [MyStore webhook route](../sample/my-store/README.md).
