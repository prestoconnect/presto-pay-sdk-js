import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { importPrivateKey, importPublicKey, sign, verify } from '../../src/internal/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const testKeyPem = readFileSync(path.join(specDir, 'keys/test-key-pkcs8.pem'), 'utf8');
const testCertPem = readFileSync(path.join(specDir, 'keys/test-cert.pem'), 'utf8');

describe('sign / verify round trip', () => {
  it('a message signed by the private key verifies against the matching public key', async () => {
    const privateKey = await importPrivateKey(testKeyPem, 'privateKey');
    const publicKey = await importPublicKey(testCertPem, 'prestoPublicKey');
    const signature = await sign(privateKey, 'a:b:c');
    await expect(verify(publicKey, 'a:b:c', signature)).resolves.toBe(true);
  });

  it('fails verification when the canonical string does not match what was signed', async () => {
    const privateKey = await importPrivateKey(testKeyPem, 'privateKey');
    const publicKey = await importPublicKey(testCertPem, 'prestoPublicKey');
    const signature = await sign(privateKey, 'a:b:c');
    await expect(verify(publicKey, 'a:b:d', signature)).resolves.toBe(false);
  });

  it('returns false rather than throwing for non-Base64 signatures', async () => {
    const publicKey = await importPublicKey(testCertPem, 'prestoPublicKey');
    await expect(verify(publicKey, 'a:b:c', 'not base64!!')).resolves.toBe(false);
    await expect(verify(publicKey, 'a:b:c', '')).resolves.toBe(false);
  });

  it('imports a DER certificate passed as a Node Buffer that is a view into a larger pool', async () => {
    const der = Buffer.from(testCertPem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');
    const pooled = Buffer.concat([Buffer.alloc(8), der, Buffer.alloc(8)]).subarray(8, 8 + der.length);
    expect(pooled.byteOffset).toBeGreaterThan(0);

    const privateKey = await importPrivateKey(testKeyPem, 'privateKey');
    const publicKey = await importPublicKey(pooled, 'prestoPublicKey');
    const signature = await sign(privateKey, 'a:b:c');
    await expect(verify(publicKey, 'a:b:c', signature)).resolves.toBe(true);
  });

});
