# Presto Pay SDK — MyStore demo

A runnable demo of `@prestouniverse/presto-pay-sdk` against **Presto's real staging gateway**. Staging
credentials are not bundled; provide your own key files and merchant identifiers through `.env`.

The checkout page models a merchant deciding **where the shopper picks a payment method**: a toggle switches
between letting Presto's hosted payment page collect it (`allowedPaymentMethods` omitted) and collecting it on
this site first (`allowedPaymentMethods` sent). Either way, the final authorization always happens on Presto's
hosted page — the toggle only changes who asks which method to use.

## Run it

From the **repository root** (this is an npm workspace, not a standalone package):

```bash
npm run build      # compiles src/ to dist/, which this demo imports through the package's exports field
npm install        # installs express and links @prestouniverse/presto-pay-sdk to the repo root
npm run demo       # builds + starts the demo on http://localhost:3000
```

Or, from this directory, once the root has been built and installed once: `npm start`. If present, the demo
automatically loads `.env` from this directory.

Open `http://localhost:3000/` and click through. Every submitted payment starts a real call to
`https://presto-stg-ext.enovax.com`. No public URL is required to run the payment demos; they use localhost for
the customer redirect and webhook URL. The server prints a warning because Presto cannot deliver webhooks to
localhost. Set `PUBLIC_URL` to a public HTTPS URL when webhook delivery is needed.

## What it demonstrates

| Route | SDK feature |
|-------|-------------|
| `GET /` | The checkout page. The "Show payment methods on checkout" toggle switches the form between the hosted flow and the self-hosted method picker (client-side, in `public/js/checkout.js`) |
| `POST /checkout` | `payments.init(...)`, with `allowedPaymentMethods` set only when the toggle is on. Returns `{ paymentUrl, txnRefNum }` as JSON, or a 400 field-error map / 502 gateway-error body |
| `GET /return/:txnRefNum` | `payments.query(...)` after the customer comes back from the hosted payment page |
| `GET /payments/:paymentRefNum` | `payments.query(...)` by `paymentRefNum`, for `curl` |
| `POST /payments/:paymentRefNum/reverse` | `payments.reverse(...)` |
| `POST /payments/:paymentRefNum/refund` | `payments.refund(...)` |
| `POST /presto/notify` | `webhooks.verify(...)`, `NotifyAck`, and deduping deliveries on `eventRefNum` |

Selecting a payment method on this site is not a replacement payment processor: it demonstrates the merchant UI
and SDK request that restricts which method Presto displays. The final authorization still happens on the
hosted payment page returned by `payment.paymentUrl`.

## Seeing webhooks actually fire

Presto can only deliver a webhook to a **publicly reachable** URL — it cannot reach your `localhost`. The
payment routes (`init`/`query`/`reverse`/`refund`) work over plain `localhost` regardless, but to see
`/presto/notify` actually get called:

1. Tunnel this port, e.g. `ngrok http 3000`.
2. Set `PUBLIC_URL` to the tunnel's `https://` URL before starting the server (copy `.env.example` to `.env`
   and edit it, or `PUBLIC_URL=https://your-tunnel.example npm start`, or
   `node --env-file=.env src/server.mjs` after editing `.env`).
3. Start a payment from the checkout page and complete it on the hosted payment page — Presto will POST to
   `<PUBLIC_URL>/presto/notify`, and the delivery shows up in the "Recent webhooks" table on the checkout and
   return pages.

## Configuration

See `.env.example`. `PRESTOPAY_MID`, `PRESTO_MRN`, `PRESTOPAY_PRIVATE_KEY_FILE`, and
`PRESTOPAY_PUBLIC_KEY_FILE` are required; `PORT` and `PUBLIC_URL` are optional.
