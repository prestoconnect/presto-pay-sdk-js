/**
 * RSASSA-PKCS1-v1_5 over SHA-256, via Web Crypto only — the one crypto API that exists unchanged on Node,
 * workerd, Deno, Bun and the edge runtimes.
 *
 * Keys are imported once and cached on the client, because importKey is the expensive part and signing is not.
 */

import { PrestoPayConfigError } from '../errors.js';
import { base64ToBytes, bytesToBase64, isStandardBase64 } from './base64.js';
import { subjectPublicKeyInfoFromCertificate, looksLikeCertificate } from './der.js';
import { privateKeyDer, publicKeyMaterial } from './pem.js';

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new PrestoPayConfigError(
      'Web Crypto is unavailable. On Node this needs 22.12 or newer; in a browser it needs a secure context',
      { operation: 'config' },
    );
  }
  return available;
}

export async function importPrivateKey(pem: string, field: string): Promise<CryptoKey> {
  const der = privateKeyDer(pem, field);
  try {
    return await subtle().importKey('pkcs8', bufferOf(der), ALGORITHM, false, ['sign']);
  } catch (cause) {
    throw new PrestoPayConfigError(
      `${field}: the key could not be imported as an RSA private key. Presto issues RSA-2048 keys; ` +
        'EC and Ed25519 keys cannot sign for this gateway',
      { operation: 'config', field, cause },
    );
  }
}

export async function importPublicKey(
  input: string | Uint8Array,
  field: string,
): Promise<CryptoKey> {
  const material = publicKeyMaterial(input, field);
  const spki =
    material.kind === 'spki' || !looksLikeCertificate(material.bytes)
      ? material.bytes
      : subjectPublicKeyInfoFromCertificate(material.bytes);
  try {
    return await subtle().importKey('spki', bufferOf(spki), ALGORITHM, false, ['verify']);
  } catch (cause) {
    throw new PrestoPayConfigError(
      `${field}: the certificate could not be imported as an RSA public key`,
      { operation: 'config', field, cause },
    );
  }
}

export async function sign(key: CryptoKey, canonical: string): Promise<string> {
  const signature = await subtle().sign(ALGORITHM.name, key, encoder.encode(canonical));
  return bytesToBase64(new Uint8Array(signature));
}

/**
 * Returns false rather than throwing for a malformed signature: from the caller's side a signature that is not
 * Base64 and a signature that is Base64 but wrong are the same event, and both end at the same error.
 */
export async function verify(
  key: CryptoKey,
  canonical: string,
  signature: string,
): Promise<boolean> {
  if (!isStandardBase64(signature) || signature.length === 0) return false;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(signature);
  } catch {
    return false;
  }
  return subtle().verify(ALGORITHM.name, key, bufferOf(bytes), encoder.encode(canonical));
}

/** Web Crypto wants an ArrayBuffer; a Uint8Array view may be a window onto a larger one. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
}
