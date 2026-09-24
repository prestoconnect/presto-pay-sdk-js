import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { privateKeyDer, publicKeyMaterial } from '../../src/internal/pem.js';
import { PrestoPayConfigError } from '../../src/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const testKeyPem = readFileSync(path.join(specDir, 'keys/test-key-pkcs8.pem'), 'utf8');
const testCertPem = readFileSync(path.join(specDir, 'keys/test-cert.pem'), 'utf8');
const testPublicKeyPem = readFileSync(path.join(specDir, 'keys/test-public-key.pem'), 'utf8');

describe('privateKeyDer', () => {
  it('accepts an unencrypted PKCS#8 PEM', () => {
    expect(privateKeyDer(testKeyPem, 'privateKey').length).toBeGreaterThan(0);
  });

  it('names the fix for a PKCS#1 key', () => {
    const pkcs1 = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
    expect(() => privateKeyDer(pkcs1, 'privateKey')).toThrow(/PKCS#1, not PKCS#8/);
  });

  it('names the fix for an encrypted PEM', () => {
    const enc = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----';
    expect(() => privateKeyDer(enc, 'privateKey')).toThrow(/encrypted/i);
  });

  it('rejects a certificate passed as a private key', () => {
    expect(() => privateKeyDer(testCertPem, 'privateKey')).toThrow(/certificate, not a private key/);
  });

  it('throws PrestoPayConfigError with the field name', () => {
    try {
      privateKeyDer('not a pem', 'PRESTOPAY_PRIVATE_KEY');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PrestoPayConfigError);
      expect((err as PrestoPayConfigError).field).toBe('PRESTOPAY_PRIVATE_KEY');
    }
  });
});

describe('publicKeyMaterial', () => {
  it('accepts a certificate PEM', () => {
    expect(publicKeyMaterial(testCertPem, 'presto').kind).toBe('certificate');
  });

  it('accepts a bare SPKI PEM', () => {
    expect(publicKeyMaterial(testPublicKeyPem, 'presto').kind).toBe('spki');
  });

  it('accepts raw DER bytes', () => {
    const der = new Uint8Array([0x30, 0x00]);
    expect(publicKeyMaterial(der, 'presto').kind).toBe('certificate');
  });

  it('rejects a private key passed as the presto key', () => {
    expect(() => publicKeyMaterial(testKeyPem, 'presto')).toThrow(/private key/);
  });
});
