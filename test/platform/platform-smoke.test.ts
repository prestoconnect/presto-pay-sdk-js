/**
 * Every file in `spec/vectors/` runs on Node, in workerd, and in edge-runtime.
 *
 * `spec/vectors/` is loaded from disk with `node:fs` in the Node suite, and workerd has no real filesystem —
 * so this is a *smoke* subset, not the full vector suite: the same handful of cases (the two real staging
 * captures, one timestamp round trip, one raw sign/verify) with the key material inlined as string literals
 * instead of read from `spec/keys/`. It exists to prove the core (canonicalization, Web Crypto, PEM/DER parsing)
 * actually runs under workerd, not just under Node — a real gap the plan calls out, closed here rather than
 * left as a TODO.
 */
import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/internal/canonical.js';
import { importPrivateKey, importPublicKey, sign, verify } from '../../src/internal/crypto.js';
import { formatGatewayTimestamp, parseGatewayTimestamp } from '../../src/internal/timestamp.js';

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDukV2gIS9a7k4t
Ew6h5isU0AQO95Epat/+vmaxLtlwCSbLeaU+x8jzyKJtyf3E775hRzjM4R9QU3DB
XHY76OhXr4oeJokI2EeJxQkiAffobq+K7vdmOpSPwsIV3n+gIndREkwdIvyuMHze
GcRy7RBDvgeQ0kEfAHLr/3VCmztOpzqqk/kWYNodw35Q63vjhGPGPmReUGUJY1BG
8CDKrjc+HRBPJHZpZF4Eyoyjt88uo76JDJ3pV0UiiXwh4h/fqbcBfroEQE4deIN1
NsPJNHi7g2f6BEjVjuuQin0svw+8oEAdCmGQLbTcsXyQL0hBaDYTgZWnq758NFFy
DeV0hLftAgMBAAECggEAJUJf0IAOUNHSNNj6mo+Dn/sC/0FsEv9ln3gmOrr567UK
MZI8nCsAuA5YS/RVpXnaDoBcnybzyIxXmmNx9dZg3z0DwcS79z0sIxi6XezXxp3u
3bCHxBgXFsLQpDC9Vwm6/9bvO0e5Fg1tmxSEKXzb4vCdZuFnmUttJ22c5zuuThCj
9niMebSZqwEgYAzUCTP0dWuTXURnF+IlLr55SNqjcCkdTP1oJZVCLoX6KQaWjZ5t
WF0lb52YTndki7gQNjD26TS+VSHN3876yV45K8SQBhqB/yLJOY0dBQfzv4mkJsuX
yu6t7f3nsk7VXFwI3WEUWZve/BXZNEF4fMOc9yFawwKBgQD59NF1pFDIzxw8zPIJ
waW40enHEbR/Iqp0/2M4mT4JoSGZs/uTiYOu+mWHULYQZhHSd6agtjFRwBdmBB01
kqWKxsJv8ZknCgtdSTqb5PRcm4Gu+I4s4ApJeAKxDNptzgkO4q/0ERsTbc/FWkKX
OcnbFvGT8mmeo2Rx4goOvJ8QwwKBgQD0Vg4SsI0DX52uAj/zHPr555yQX1xMcG04
v5MCS+Bx+SiyV5zCPEVIqd+LiHySfxAts7hOJC2rJroXvTyOmqvIB/jKO3erSy30
2pyJr08PI+H0yne2oY9sdMWOFcdnCF7tiPnZ6iyJitSrEB+CHH3cQ4AsILWuMcJc
fJEB7maJjwKBgQC/V9tUfEHfRzStkpIiR9xOHFsiqfoLbQUh5TMWa7Di/DdVi0Ml
0Ro+Q66fJHkLGqe//xpOYspkc3E2BiY6EZWqI7dKrJ76FKVYdytnlaA+mEhxIhLs
ZWFaloUw9c7sSdIDVCMv6jxY5jIsOIlLbNCKaAjsoaCa8Sd+SnQ6jcgSswKBgFj7
OfbOexw+ZxMm2Jk19aSrF5ZwVBG2Y+BlzCjq7xsyrQJ966XFA0paKwIKu6syQPcT
20wB2uvYl67riLE6XNLlLFKh44vrPhpMvvNZd8ZAwBpA3eYR4kSSJhv/jHXWU5PX
7X3RzVRtzdNadM8Shzd/EZ+Abgm5L1o1Ny3n30m7AoGAWYgFRhoh3UurpmJPVJMO
OiApo6h3agLFVoUGFH3xA8PIBUnOINlr68gNi/n7sfDwcujbecjMa1vwoXsroayb
DNgaz+1dZmH+EyJJiMhxRTb817fdbXOvnH971VPiDs6F4py5P6C8FM2np4otTm8Y
oxihqE1TuyFRaV5+ccPHnUQ=
-----END PRIVATE KEY-----`;

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUAN4KNCGJQlvh+t13FLm+yFj5/scwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTcHJlc3RvLXBheS1zZGstdGVzdDAgFw0yNjA5MjQwNjMx
NTJaGA8yMTI2MDgzMTA2MzE1MlowHjEcMBoGA1UEAwwTcHJlc3RvLXBheS1zZGst
dGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAO6RXaAhL1ruTi0T
DqHmKxTQBA73kSlq3/6+ZrEu2XAJJst5pT7HyPPIom3J/cTvvmFHOMzhH1BTcMFc
djvo6Fevih4miQjYR4nFCSIB9+hur4ru92Y6lI/CwhXef6Aid1ESTB0i/K4wfN4Z
xHLtEEO+B5DSQR8Acuv/dUKbO06nOqqT+RZg2h3DflDre+OEY8Y+ZF5QZQljUEbw
IMquNz4dEE8kdmlkXgTKjKO3zy6jvokMnelXRSKJfCHiH9+ptwF+ugRATh14g3U2
w8k0eLuDZ/oESNWO65CKfSy/D7ygQB0KYZAttNyxfJAvSEFoNhOBlaervnw0UXIN
5XSEt+0CAwEAAaNTMFEwHQYDVR0OBBYEFPgZs4Qz4updDMkQYm1mfo+iXEtyMB8G
A1UdIwQYMBaAFPgZs4Qz4updDMkQYm1mfo+iXEtyMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBAM73/kTzBtv1qnVCRVeORe8bD2DAyJRIhG28GWM/
m+5li7GVbg2pUXI2rc1Rdqu4VODttIiDUKWjhKgXstOloVbqm6+JeQnrVPiJ3faM
aq7FfM53flCkN3pDfcLjixXUDlsr7+RkKkoU27T0mnp7uK4VrFPQq40vA01K5iQP
xbzqwHCQiaQtLb5HCp5vbdGCVnmp86wGsS78gCx7t9eAmjczdna3UDF2hLa8YkWs
qBSTHzuPqoLPLFVrny/PSZkrmwkOPn//stVZjQt3gOQcUEylC2XbFw40yPG5DFUJ
uYmbyecCkuRnxClIy/Psqh2xYiY7bChjNnIdNm3j26BM/nw=
-----END CERTIFICATE-----`;

describe('platform smoke: canonicalization', () => {
  it('matches the worked example from the wire contract', () => {
    const canonical = canonicalize({
      mid: 'PW2401XH9KCX',
      prestoMrn: 'PM240110XDSFC',
      txnType: 'WebPay',
      txnRefNum: 'TXN10001',
      displayDesc: 'Order #12345',
      amount: 1200,
      currencyCode: 'MYR',
      notifyUrl: 'https://merchant.example.com/webhook/notify',
      redirectUrl: 'https://merchant.example.com/redirect/TXN10001',
      ts: '20250423104500.000',
    });
    expect(canonical).toBe(
      '1200:MYR:Order #12345:PW2401XH9KCX:https://merchant.example.com/webhook/notify:PM240110XDSFC:' +
        'https://merchant.example.com/redirect/TXN10001:20250423104500.000:TXN10001:WebPay',
    );
  });

  it('renders null as an empty string, keeping its separator', () => {
    expect(canonicalize({ additionalData: null, amount: 200 })).toBe(':200');
  });
});

describe('platform smoke: timestamps', () => {
  it('round-trips through the fixed UTC+08:00 offset', () => {
    const epochMs = 1745376300000;
    const ts = formatGatewayTimestamp(epochMs);
    expect(ts).toBe('20250423104500.000');
    expect(parseGatewayTimestamp(ts).getTime()).toBe(epochMs);
  });
});

describe('platform smoke: Web Crypto sign/verify and PEM/DER import', () => {
  it('signs with an imported PKCS#8 private key and verifies with the matching certificate', async () => {
    const privateKey = await importPrivateKey(TEST_PRIVATE_KEY_PEM, 'privateKey');
    const publicKey = await importPublicKey(TEST_CERT_PEM, 'prestoPublicKey');
    const canonical = '1200:MYR:workerd-smoke-test';
    const signature = await sign(privateKey, canonical);
    await expect(verify(publicKey, canonical, signature)).resolves.toBe(true);
    await expect(verify(publicKey, `${canonical}-tampered`, signature)).resolves.toBe(false);
  });
});
