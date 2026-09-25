# @prestouniverse/presto-pay-sdk

[![CI](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/prestoconnect/presto-pay-sdk-js/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Pre-release.** Nothing has been published to npm yet — `npm install` below will 404 until the first tag.
> `main` is pre-1.0 groundwork; see [CHANGELOG.md](CHANGELOG.md) for what's done and what's left before 0.1.0.

A JavaScript / TypeScript SDK for the Presto Pay gateway: `init`, `query`, `reverse`, `refund`, and webhook
verification. Zero runtime dependencies, ESM only, built on the Web platform (`fetch`, `crypto.subtle`,
`TextEncoder`/`TextDecoder`) so the same code runs on Node, Cloudflare Workers, and Vercel Edge.

- **Runtimes (0.1.0):** Node 18.20+, 20, 22, 24, 26, Cloudflare Workers, Vercel Edge. Bun and Deno work but
  aren't in the support statement yet.
- **Node 18 caveat:** this package is ESM only. Node 22.12+ can `require()` an ESM package directly; on
  Node 18.20–22.11, CommonJS callers need dynamic `import()` instead. Also, on Node 18 the global `crypto` is
  exposed only on the main thread — a request handler running inside a `worker_threads` Worker or a forked
  child process will see "Web Crypto is unavailable" there; run on the main thread, or move to Node 20+.
- **Refused:** browsers. The `browser` export condition resolves to a module that throws — your merchant private
  key must never reach client-side code.

## Install

```bash
npm install @prestouniverse/presto-pay-sdk
```

## Runnable demo (MyStore)

The repository includes a small Express application, MyStore, that exercises the real staging gateway through
the SDK:

```bash
npm run demo
```

Then open `http://localhost:3000/`. The demo covers hosted payment redirect, payment queries, reversals, refunds,
and raw-body webhook verification. To receive webhooks, expose the port through a public HTTPS tunnel and set
`PUBLIC_URL` before starting the demo. See [`sample/my-store/README.md`](sample/my-store/README.md) for the full
setup and route reference.

**On the committed keys:** `sample/my-store/keys/` and `spec/keys/` intentionally commit a real (but
**staging-only**) merchant private key for Presto's `11StreetMock` mock merchant, so the demo and test suite run
with no setup. It cannot authorize a real payment and must never be reused for a live merchant — if a secret
scanner flags it, that's expected, not a leak. See [`spec/keys/README.md`](spec/keys/README.md) for what each
file is and why.

## Quick start

```ts
import { createPrestoPay, TxnType, PaymentMethod } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({
  environment: 'staging', // 'staging' | 'production' | { baseUrl: 'https://...' }
  merchantId: process.env.PRESTOPAY_MID!,
  privateKey: process.env.PRESTOPAY_PRIVATE_KEY!, // PKCS#8 PEM text
  prestoPublicKey: process.env.PRESTOPAY_PUBLIC_KEY!, // Presto's certificate, PEM or DER
});

const payment = await presto.payments.init({
  prestoMrn: 'YOUR_PRESTO_MRN',
  txnType: TxnType.WebPay,
  txnRefNum: 'order-123',
  displayDesc: 'Order 123',
  amount: 10_000, // minor units
  currencyCode: 'MYR',
  notifyUrl: 'https://your-app.example/presto/notify',
  redirectUrl: 'https://your-app.example/presto/return',
  allowedPaymentMethods: [PaymentMethod.Wallet],
});

console.log(payment.paymentUrl); // redirect the customer here
```

Or read config straight from the environment:

```ts
import { createPrestoPay, fromEnv } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({ ...fromEnv(process.env), strict: true });
```

`fromEnv` reads `PRESTOPAY_ENV` (or `PRESTOPAY_BASE_URL`), `PRESTOPAY_MID`, `PRESTOPAY_PRIVATE_KEY`, and
`PRESTOPAY_PUBLIC_KEY`. It works with `process.env`, a Workers `env` binding, or Vercel's env object —
anything shaped like a string record.

Every request takes `prestoMrn`: one merchant ID (`mid`) can have several Presto merchant references, so it's
chosen per call, not baked into the client. To serve several merchants, create one client per `mid`.

## Converting your keys

Presto issues your merchant keypair as a PKCS#12 keystore (`.p12`) and their own public key as an X.509
certificate. This SDK wants an **unencrypted PKCS#8 PEM** private key and accepts the certificate as-is (PEM or
DER), or a bare SPKI PEM.

```bash
# Your onboarding .p12 -> unencrypted PKCS#8 PEM. Store the output in a secret manager, never in git.
openssl pkcs12 -in partner.p12 -nocerts -nodes -out partner-key.pem

# Presto's certificate, DER -> PEM, if you'd rather have PEM.
openssl x509 -inform der -in presto.der -out presto.pem
```

**That first command can exit non-zero on a real Presto keystore and still have worked.** Presto's `.p12`
encrypts its *certificate* bag with RC2-40-CBC, which OpenSSL 3 refuses without the legacy provider — it prints
something like `error:0308010C:digital envelope routines:...:unsupported` and exits `1`, but only *after* writing
`partner-key.pem`, because the **private key** bag uses an algorithm OpenSSL 3 does accept. `-nocerts` is what
makes this survivable: piping into `openssl pkcs8` instead of writing a file would hide a key that was written
correctly behind the failed exit status. If you'd rather not see the error, `-legacy` is the documented fix, but
it needs `legacy.dll` / `legacy.so`, which stock OpenSSL 3 builds often omit — try it, but don't be surprised if
it's missing.

Not supported in 0.1.0: PKCS#12 import directly, PKCS#1 PEM, or encrypted PEM. The error message for each of
these names the exact `openssl` command that fixes it.

## Idempotency: what to do when a call fails

`init`, `reverse`, and `refund` create or change state; resending one after a failure can leave the gateway with
two competing operations for the same intent. **Never blindly retry them.** `query` is read-only and always
safe to retry.

Every error from this SDK is a `PrestoPayError` (or a subclass) with two fields that tell you what to do next:

```ts
import { isPrestoPayError } from '@prestouniverse/presto-pay-sdk';

try {
  const payment = await presto.payments.init({ /* ... */ });
} catch (err) {
  if (isPrestoPayError(err) && err.mayHaveTakenEffect) {
    // The request may have reached the gateway — do NOT retry `init`. Look it up instead.
    const result = await presto.payments.query(err.reconcileBy as { txnRefNum: string });
    // ... reconcile your own state with result.paymentStatus
  } else {
    // Never sent, or definitely rejected. Safe to fix the input and retry, or just report the failure.
    throw err;
  }
}
```

`mayHaveTakenEffect` is `true` when:

- a transport error occurred and the request was **not** provably unsent (see "the edge retry caveat" below);
- the gateway returned HTTP 500 or above;
- an authentic HTTP 200 response failed to parse, verify, or map after that — the bytes almost certainly
  reached the gateway, so whatever they describe may have happened;
- a **`1203`** business error on `init` — proof a payment record for that `txnRefNum` already exists (possibly
  authorised), even though this particular call failed.

`reconcileBy` gives you the lookup key already: `{ txnRefNum }` after `init`, `{ paymentRefNum }` after
`reverse` or `refund`. There is nothing to reconcile after a *safe* failure (a plain `4xx`, a validation error,
or an ordinary business error) — `mayHaveTakenEffect` is `false` and `reconcileBy` is absent.

If you only have `unknown` in a catch block, `mayHaveSucceeded(error)` is a guard over the same field:

```ts
import { mayHaveSucceeded } from '@prestouniverse/presto-pay-sdk';

catch (err: unknown) {
  if (mayHaveSucceeded(err)) { /* reconcile */ }
}
```

### The edge retry caveat

`retryReads` (below) only ever retries `init` / `reverse` / `refund` when the request certainly never left the
process — DNS failure, connection refused, TLS handshake failure before any bytes were written. Cloudflare
Workers and Vercel Edge report no error codes for these cases (`fetch` there doesn't surface `cause.code`), so
on those runtimes **that automatic retry effectively never fires** for a payment call. This is deliberate, not a
bug: guessing wrong here means double-charging someone. On Workers/Edge, a transport failure for `init` /
`reverse` / `refund` is `mayHaveTakenEffect: true` far more often than on Node — plan your reconciliation path
(`query`) accordingly, especially on those runtimes.

## Configuration reference

```ts
const presto = createPrestoPay({
  environment: 'staging',                    // 'staging' | 'production' | { baseUrl: string }
  merchantId: 'YOUR_MID',
  privateKey: pkcs8Pem,
  prestoPublicKey: certPemOrDer,              // or an array of them during a key rotation overlap
  deadlineMs: 30_000,                         // whole call, retries included (default 30s)
  retryReads: { maxRetries: 2, initialBackoffMs: 200, maxBackoffMs: 5_000, jitter: true },
  webhooks: { maxTimestampAgeMs: 15 * 60_000 },
  strict: false,                              // true rejects contract violations instead of coercing them
  redactErrorBodies: true,                    // false exposes raw bodies/canonical strings in error objects
  fetch: customFetch,                         // e.g. an undici Agent-backed fetch for a proxy
  now: () => Date.now(),                      // inject a clock for tests
});
```

**`strict: true`** enforces the field-length maxima documented in the wire contract (which Presto itself does
not enforce) and rejects a response field whose type doesn't match instead of coercing it. Run it in staging so
contract drift surfaces as a test failure, not a subtle bug: this SDK's default (`false`) prioritizes not
rejecting a real payment result over enforcing everything the contract documents.

**`redactErrorBodies`** matters because raw response bodies and canonical strings can carry `cardBin`,
`cardSummary`, `receiptEmail`, and `receiptName` — and whole error objects tend to get logged wherever they're
thrown. The default (`true`) redacts `rawBody` and `canonical` on every error; set it to `false` only where you
control the log destination and need the raw text to debug a signature failure.

## Webhooks

```ts
import { createPrestoPay, NotifyAck } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({ /* ... */ });

// Pass the Request itself — the SDK reads the raw body, which is what was actually signed.
async function handleNotify(request: Request): Promise<Response> {
  try {
    const event = await presto.webhooks.verify(request);
    await handleOnce(event.eventRefNum, event); // see "dedupe" below
    return NotifyAck.okResponse();
  } catch (err) {
    return NotifyAck.forErrorResponse(err); // "ok" for a permanent failure, "resend" for your own transient one
  }
}
```

A standalone verifier for a service that only receives webhooks (no payment calls, no private key needed):

```ts
import { createWebhookVerifier } from '@prestouniverse/presto-pay-sdk';

const verifier = createWebhookVerifier({
  merchantId: ['MID_A', 'MID_B'], // one endpoint can serve several merchants; Presto signs for all of them
  prestoPublicKey: prestoCertPem,
});
```

### Dedupe on `eventRefNum`

Presto retries a webhook delivery on its own backoff — 1, 2, 5, and 10 minutes after the first attempt, five
deliveries over roughly 18 minutes — until your endpoint replies `{"resend":false}`. **`eventRefNum` is stable
across every redelivery of the same event.** Handle it like this, not by assuming one delivery per event:

```ts
async function handleOnce(eventRefNum: string, event: WebhookEvent) {
  if (await seen(eventRefNum)) return; // e.g. a Redis SETNX with a ~1 hour TTL
  await fulfil(event);
  await markSeen(eventRefNum);
}
```

A merchant that fulfils on every delivery double-fulfils up to five times for one authorisation.

### Framework snippets

**Cloudflare Workers**

```ts
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== '/presto/notify') return new Response('not found', { status: 404 });
    const presto = createPrestoPay({ ...fromEnv(env), environment: 'production' });
    try {
      const event = await presto.webhooks.verify(request);
      await handleOnce(event.eventRefNum, event);
      return NotifyAck.okResponse();
    } catch (err) {
      return NotifyAck.forErrorResponse(err);
    }
  },
};
```

**Next.js (App Router route handler)**

```ts
// app/presto/notify/route.ts
export async function POST(request: Request) {
  try {
    const event = await presto.webhooks.verify(request);
    await handleOnce(event.eventRefNum, event);
    return NotifyAck.okResponse();
  } catch (err) {
    return NotifyAck.forErrorResponse(err);
  }
}
```

**Hono**

```ts
app.post('/presto/notify', async (c) => {
  try {
    const event = await presto.webhooks.verify(c.req.raw);
    await handleOnce(event.eventRefNum, event);
    return c.body(NotifyAck.ok, 200, { 'content-type': 'application/json' });
  } catch (err) {
    return c.body(NotifyAck.forError(err), 200, { 'content-type': 'application/json' });
  }
});
```

**Express 5**

Express's default body parser re-serializes JSON, which changes the exact bytes that were signed — always mount
`express.raw()` on the webhook route specifically, and pass `req.body` (a `Buffer`), not `req.body` from
`express.json()`:

```ts
app.post('/presto/notify', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const event = await presto.webhooks.verify(req.body); // a Buffer, i.e. a Uint8Array
    await handleOnce(event.eventRefNum, event);
    res.status(200).json(JSON.parse(NotifyAck.ok));
  } catch (err) {
    res.status(200).json(JSON.parse(NotifyAck.forError(err)));
  }
});
```

`webhooks.verify()` also throws a clear `PrestoPayConfigError` if you pass a `Request` whose body was already
read upstream, or an already-`JSON.parse`'d object — both point at the same bug: verifying something other than
the exact bytes Presto signed.

## The escape hatch

Error codes are open-ended and Presto will grow endpoints faster than this SDK wraps them:

```ts
const result = await presto.raw.post('/v1/ext/payment/some-new-endpoint', {
  prestoMrn: 'YOUR_PRESTO_MRN',
  // ... whatever the new endpoint documents, minus mid/ts/signature — the client adds those
});
```

`raw.post` signs, sends, verifies, and returns the parsed object. `raw.sign(canonicalString)` and
`raw.verifyBody(body)` are exposed too, for debugging a signature mismatch by hand.

## Errors

Every error extends `PrestoPayError`. Identity is checked with `isPrestoPayError(value)`, not `instanceof` —
`instanceof` silently stops matching the moment two copies of this package end up in the same dependency tree.

| Class | When |
|-------|------|
| `PrestoPayConfigError` | Invalid options or request input (including a string with a lone UTF-16 surrogate) |
| `PrestoPayTransportError` | Network failure, timeout, or abort — `requestNotSent` says whether the request definitely never left the process |
| `PrestoPayApiError` | Non-200 status (`kind: 'http'`) or `success: false` (`kind: 'business'`); `errorCode`/`errorMessage` on business errors, `clockOffsetMs` on a `1005` |
| `PrestoPaySignatureError` | Missing/invalid signature, an unrecognized webhook `mid`, or a stale webhook `ts` |
| `PrestoPayResponseError` | Malformed body, a missing required field, or an echoed value that doesn't match what was signed into the request |

## Testing this package

```bash
npm test              # unit + vector tests on Node
npm run test:workers  # the same core (canonicalization, timestamps, Web Crypto, PEM/DER) under real workerd
npm run test:edge     # ... and under a Vercel-Edge-shaped environment
npm run check         # typecheck + all of the above + publint/attw/export-condition/bundle-size checks
```

`npm run test:staging` hits Presto's real staging gateway and is skipped unless you set
`PRESTOPAY_STAGING_SMOKE=1` — it's a live third-party network call, so it never runs as a side effect of `npm
test` or CI-by-default. See `spec/keys/README.md` for the staging credentials it uses.

## License

Apache-2.0
