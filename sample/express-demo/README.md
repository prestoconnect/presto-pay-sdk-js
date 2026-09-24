# Presto Pay SDK — Express demo

A runnable demo of `@prestouniverse/presto-pay-sdk` against **Presto's real staging gateway**, using the
`11StreetMock` demo merchant and runtime keys bundled in this demo's `keys/` directory. This is
staging test material, not production credentials — nothing here may be reused for a live merchant.

## Run it

From the **repository root** (this is an npm workspace, not a standalone package):

```bash
npm run build      # compiles src/ to dist/, which this demo imports through the package's exports field
npm install        # installs express and links @prestouniverse/presto-pay-sdk to the repo root
npm run demo       # builds + starts the demo on http://localhost:3000
```

Or, from this directory, once the root has been built and installed once: `npm start`. If present, the demo
automatically loads `.env` from this directory.

Open `http://localhost:3000/` and click through. Every submitted payment form makes a real call to
`https://presto-stg-ext.enovax.com`. No public URL is required to run the payment demos; they use localhost for
the customer redirect and webhook URL. The server prints a warning because Presto cannot deliver webhooks to
localhost. Set `PUBLIC_URL` to a public HTTPS URL when webhook delivery is needed.

## What it demonstrates

| Route | SDK feature |
|-------|-------------|
| `GET /hosted` | Hosted-payment demo form: the user enters only amount and description; `payments.init(...)` redirects to Presto's hosted payment page |
| `GET /custom` | Custom merchant-owned form displaying PM PG Card, GrabPay, Touch n Go eWallet, Affin Bank, and Maybank |
| `POST /custom/pay` | Sends the selected methods as SDK `allowedPaymentMethods`, then redirects to the hosted payment page |
| `GET /pay` | Fixed MYR 1.00 shortcut retained for `curl`; demonstrates `payments.init(...)` |
| `GET /return` | `payments.query(...)` after the customer comes back from the hosted payment page |
| `GET /payments/:paymentRefNum` | `payments.query(...)` by `paymentRefNum`, for `curl` |
| `POST /payments/:paymentRefNum/reverse` | `payments.reverse(...)` |
| `POST /payments/:paymentRefNum/refund` | `payments.refund(...)` |
| `POST /presto/notify` | `webhooks.verify(...)`, `NotifyAck`, and deduping deliveries on `eventRefNum` |

The custom form is not a replacement payment processor: it demonstrates the merchant UI and SDK request that
restricts which methods Presto displays. The final authorization still happens on the hosted payment page returned
by `payment.paymentUrl`.

## Seeing webhooks actually fire

Presto can only deliver a webhook to a **publicly reachable** URL — it cannot reach your `localhost`. The
payment routes (`init`/`query`/`reverse`/`refund`) work over plain `localhost` regardless, but to see
`/presto/notify` actually get called:

1. Tunnel this port, e.g. `ngrok http 3000`.
2. Set `PUBLIC_URL` to the tunnel's `https://` URL before starting the server (copy `.env.example` to `.env`
   and edit it, or `PUBLIC_URL=https://your-tunnel.example npm start`, or
   `node --env-file=.env src/server.mjs` after editing `.env`).
3. Start a payment via `/pay` and complete it on the hosted payment page — Presto will POST to
   `<PUBLIC_URL>/presto/notify`.

## Configuration

See `.env.example`. Nothing is required to get started — every value defaults to the committed staging demo
credentials — but `PORT` and `PUBLIC_URL` are worth overriding, per above.
