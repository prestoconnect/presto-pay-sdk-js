# Test key material

This directory contains generated test keys and certificates only. Real Presto staging keys and certificates are
not committed. The staging smoke test requires credentials supplied through environment variables or file paths.

| File | What it is |
|------|------------|
| `test-key-pkcs8.pem` | Generated test private key |
| `test-cert.pem` | Generated test certificate |
| `test-public-key.pem` | Public key matching `test-key-pkcs8.pem` |

To run the opt-in staging smoke test, provide your own credentials:

```text
PRESTOPAY_STAGING_SMOKE=1
PRESTOPAY_MID=your-staging-merchant-id
PRESTO_MRN=your-staging-merchant-reference
PRESTOPAY_PRIVATE_KEY_FILE=/path/to/merchant-key-pkcs8.pem
PRESTOPAY_PUBLIC_KEY_FILE=/path/to/presto-public-key.der
```

The test vectors use the generated test key material and do not require any Presto credentials.
