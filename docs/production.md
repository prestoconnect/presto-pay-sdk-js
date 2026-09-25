# Production and environment configuration

Use staging to validate the integration, then create a separate production configuration. A production process
must never receive staging keys or merchant references by accident.

## Environment variables

`fromEnv` accepts any string record, including `process.env`, a Cloudflare Workers binding, or a Vercel env object:

```ts
import { createPrestoPay, fromEnv } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({ ...fromEnv(process.env), strict: true });
```

Use these variables:

| Variable | Value |
| --- | --- |
| `PRESTOPAY_ENV` | `staging` or `production` |
| `PRESTOPAY_BASE_URL` | Alternative to `PRESTOPAY_ENV` for a custom gateway URL |
| `PRESTOPAY_MID` | Merchant ID from onboarding |
| `PRESTOPAY_PRIVATE_KEY` | Unencrypted PKCS#8 PEM merchant private key |
| `PRESTOPAY_PUBLIC_KEY` | Presto certificate as PEM or DER, or SPKI PEM |

`PRESTOPAY_BASE_URL` takes precedence over `PRESTOPAY_ENV`; do not set it casually in production. `prestoMrn` is
not part of client configuration: pass the correct reference to each payment operation.

## Key files and conversion

Keep key files outside the repository and restrict their permissions. If onboarding supplies a PKCS#12 file, convert
the merchant private key to the format accepted by this SDK:

```bash
openssl pkcs12 -in partner.p12 -nocerts -nodes -out partner-key.pem
openssl x509 -inform der -in presto.der -out presto.pem
```

The first output is an unencrypted PKCS#8 PEM. Do not commit it, print it in CI logs, or pass it to browser code.
The SDK does not import PKCS#12, PKCS#1 PEM, or encrypted PEM directly.

## Secret management and runtime restrictions

Load secrets from the deployment platform's secret manager or protected environment bindings. Do not put private
keys in source control, a frontend bundle, client-side environment variables, logs, error reports, or the demo.
The package is ESM-only and supports Node 18.20+, Cloudflare Workers, and Vercel Edge; browser imports are
deliberately refused.

## Staging validation checklist

1. Use staging credentials, `environment: 'staging'`, and a staging `prestoMrn`.
2. Verify hosted redirect, return-page `query`, webhook verification, and duplicate webhook handling.
3. Exercise safe reconciliation for an indeterminate `init`, `reverse`, or `refund` response.
4. Confirm logs redact response bodies by leaving `redactErrorBodies` at its default.
5. Confirm production secrets, URLs, merchant references, webhook endpoint, and monitoring are separate.
6. Change the environment and credentials together, then run a small production verification payment.

The [security policy](../SECURITY.md) remains the authoritative reference for credential and secret handling.
