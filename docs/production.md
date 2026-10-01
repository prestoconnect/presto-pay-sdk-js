# Production

- [Configuration from environment](#configuration-from-environment)
- [Keys and secrets](#keys-and-secrets)
- [Several merchants](#several-merchants)
- [Custom fetch](#custom-fetch)
- [Going live checklist](#going-live-checklist)
- [Troubleshooting](#troubleshooting)

## Configuration from environment

`fromEnv` turns environment variables into `createPrestoPay` options. It accepts any string record: `process.env`,
a Cloudflare Workers `env` binding, or Vercel's env object.

```ts
import { createPrestoPay, fromEnv } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay(fromEnv(process.env));
```

| Variable | Value |
|----------|-------|
| `PRESTOPAY_ENV` or `PRESTOPAY_BASE_URL` | `staging` or `production`, or a gateway base URL (which wins if both are set) |
| `PRESTOPAY_MID` | Your `mid` |
| `PRESTOPAY_PRIVATE_KEY` | Your private key: the text of `merchant-key.pem` |
| `PRESTOPAY_PUBLIC_KEY` | Presto's certificate as PEM text (see below) |

An environment variable holds text, so it can't hold Presto's binary `.der` certificate. Convert it to PEM
once, and put the contents of `presto.pem` in `PRESTOPAY_PUBLIC_KEY`:

```bash
openssl x509 -inform der -in presto.der -out presto.pem
```

Store both keys with their real line breaks. To set other options, spread the result:
`createPrestoPay({ ...fromEnv(process.env), deadlineMs: 20_000 })`.

`prestoMrn` isn't part of the client's configuration: pass it to each payment operation.

## Keys and secrets

`privateKey` takes an unencrypted PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), as created in
[Before you start](../README.md#1-create-your-key-pair). The SDK doesn't read PKCS#12, PKCS#1
(`BEGIN RSA PRIVATE KEY`) or encrypted PEM.

`prestoPublicKey` takes Presto's certificate as DER bytes or PEM text. It also takes an array, so that when
Presto announces a new certificate you can accept both the old and the new one until the change-over is done.

**Using an existing `.p12` keystore.** If you already have your key in a `.p12` file, convert it once:

```bash
openssl pkcs12 -in merchant.p12 -nocerts -nodes -out merchant-key.pem
```

Some keystores use an old encryption algorithm that OpenSSL 3 refuses: it prints an `unsupported` error and
exits with status 1, but only after writing the key. If `merchant-key.pem` contains a `BEGIN PRIVATE KEY` block,
the conversion worked.

Load keys from your platform's secret manager or protected environment bindings. Never put the private key in
source control, a frontend bundle, client-side environment variables, logs or error reports. The package
refuses to load in a browser for this reason.

## Several merchants

A client belongs to one `mid`: it sends that `mid` on every request and accepts webhooks only for it. One `mid`
can have several `prestoMrn`s, which you choose per call, so one client covers all of them.

To serve several merchants, create one client per `mid` (they can share the same keys) and route each request
to the matching client, for example with a `Map` keyed by `mid`. For webhooks, one verifier can accept all of
them; see [Webhooks](webhooks.md#several-merchants-and-webhook-only-services).

## Custom fetch

Pass `fetch` to `createPrestoPay` to send requests through your own implementation, for example to add a proxy,
logging or tracing. Don't make it follow redirects or retry requests on its own: the SDK decides when a retry is
safe, and a resent `init`, `reverse` or `refund` could take effect twice.

## Going live checklist

- [ ] Generate a separate key pair for production and register its public key with Presto.
- [ ] Use `environment: 'production'` with your production `mid`, `prestoMrn` and Presto certificate. Never mix
      staging and production values, and change them all together.
- [ ] Load the private key from a secret store, not from source control or the image.
- [ ] Make `notifyUrl` a public HTTPS URL that Presto can reach.
- [ ] Have your return page `query` the payment instead of trusting the redirect.
- [ ] Have your webhook handler verify the raw body, `query` the payment, deduplicate on `eventRefNum` under a
      unique constraint, return 401 for a `PrestoPaySignatureError`, and reply `NotifyAck.resend` when your own
      processing fails.
- [ ] After a timeout or server error, call `init` again with the same `txnRefNum`, and query before retrying
      `reverse` or `refund`, as in
      [Payments and errors](payments-and-errors.md#when-you-dont-know-whether-it-worked).
- [ ] Keep `redactErrorBodies` at its default, so logs don't hold card or customer details.
- [ ] Keep the server clock in sync with NTP.
- [ ] Log `errorCode` and `errorMessage` from `PrestoPayApiError`, so you can quote them to Presto support.
- [ ] Make a small payment in production to confirm the setup.

## Troubleshooting

**`1005` (`ErrorCode.ExceededValidityPeriod`).** Your request's timestamp is too far from Presto's clock. Sync
the server clock with NTP; `error.clockOffsetMs` shows how far off it was. The SDK converts to the gateway's time
zone itself, so the host's time zone doesn't matter.

**`1006` or `1007` (`ErrorCode.InvalidSignature`, `ErrorCode.SignatureVerificationFailed`).** Presto couldn't
verify your signature. Usually the private key doesn't match the public key you registered for this
environment, or you're using a staging key in production or the other way round. `error.canonical` holds the
exact string the SDK signed; `canonicalize(body)` rebuilds it from a raw JSON body.

**`PrestoPaySignatureError` from a payment call.** Presto's response didn't verify with the certificate you
configured. Check that it's the certificate for this environment, and whether Presto has announced a new one.

**`1102` or `1106` (`ErrorCode.InvalidMid`, `ErrorCode.InvalidMerchantReference`).** The `mid` or `prestoMrn`
isn't valid for this environment.

**Webhooks never arrive.** `notifyUrl` must be reachable from the internet. `localhost` and private addresses
won't work; during development, use a tunnel such as ngrok and pass its URL as `notifyUrl`.

**Webhooks fail with `PrestoPaySignatureError`.** Either the event is for a different `mid` than the client's,
its timestamp is more than 15 minutes from your clock (sync with NTP), or the Presto certificate is for the
wrong environment.

**The SDK refuses to load.** It's server-only. If a Workers or Edge build picks the browser version, your bundler
is resolving the `browser` export condition ahead of `workerd` or `edge-light`; check its condition order.
