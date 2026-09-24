# Staging key material

Presto **staging / dev** credentials for the `11StreetMock` merchant. Not production material, and nothing in
this directory may ever be reused for a live merchant.

| File | What it is |
|------|------------|
| `presto_ext_service_dev.der` | Presto's staging certificate (X.509, DER). Verifies responses and webhooks — §3.4 |
| `presto_rm_keystore.p12` | Merchant RSA keypair, PKCS#12. Signs requests. Password `123123123`, alias `rm` |
| `presto_rm_key-pkcs8.pem` | The same private key, pre-converted to unencrypted PKCS#8 PEM (see below) — what `test:staging` reads, so the suite does not need `openssl` on the machine running it |

Staging configuration that goes with them:

```
PRESTOPAY_ENV=staging          # https://presto-stg-ext.enovax.com
PRESTOPAY_MID=11StreetMock
prestoMrn=PM181019QGJWH4K      # per request, not client configuration (§3.2)
```

## What this certificate has already proven

Both bodies captured in §3.4 of the plans verify against it, which settles §3.4 in full:

- the `1201` business error confirms key sorting, lowercase boolean rendering, the `:` join, and
  RSASSA-PKCS1-v1_5 with SHA-256 over Base64;
- the successful init response contains `additionalData: null` and verifies **only** when that null renders as
  the empty string. The literal `null`, `NULL`, and omitting the key all fail.

Both are recorded as vectors in `../../presto-pay-spec/vectors/canonical.json`, where
`node scripts/verify-vectors.mjs` re-checks them against this certificate on every run. To diagnose a *new*
capture that will not verify:

```bash
node ../presto-pay-spec/scripts/probe-canonicalization.mjs <body.json> keys/presto_ext_service_dev.der
```

## The keystore has an RC2 certificate bag

`presto_rm_keystore.p12` stores its certificate under RC2-40-CBC, which OpenSSL 3 refuses without the legacy
provider. The **private key** bag uses an algorithm OpenSSL 3 does accept, so this extracts the key correctly
while still exiting 1 and printing an `unsupported ... RC2-40-CBC` error:

```bash
openssl pkcs12 -in keys/presto_rm_keystore.p12 -nocerts -nodes -passin pass:123123123 -out partner-key.pem
```

Do not pipe it into `openssl pkcs8` — the failed exit status would hide a key that was written successfully.

Python's `cryptography` reads the whole file, certificate included, with no special handling. Whether PHP's
`openssl_pkcs12_read` can is untested and is gated at milestone 2 of `php-plan.md`.
