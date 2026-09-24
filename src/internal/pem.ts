/**
 * PEM handling and the key-shaped mistakes people actually make.
 *
 * Every message names what was supplied and the command that fixes it, because the alternative is a merchant
 * reading "invalid key" at the point where their integration stops working.
 */

import { PrestoPayConfigError } from '../errors.js';
import { base64ToBytes } from './base64.js';

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

export interface PemBlock {
  readonly label: string;
  readonly bytes: Uint8Array;
}

const CONVERT_P12 =
  'openssl pkcs12 -in partner.p12 -nocerts -nodes -out partner-key.pem ' +
  '(this exits non-zero on Presto\'s keystore because its certificate bag is RC2-encrypted, ' +
  'while still writing the key correctly)';

export function decodePem(text: string, field: string): PemBlock {
  const match = PEM_BLOCK.exec(text);
  if (!match) {
    throw new PrestoPayConfigError(
      `${field}: no PEM block found. Expected text beginning with -----BEGIN ...-----`,
      { operation: 'config', field },
    );
  }
  const label = match[1] as string;
  const body = (match[2] as string).replace(/\s+/g, '');
  try {
    return { label, bytes: base64ToBytes(body) };
  } catch (cause) {
    throw new PrestoPayConfigError(`${field}: PEM body is not valid Base64`, {
      operation: 'config',
      field,
      cause,
    });
  }
}

/** Accepts only unencrypted PKCS#8, and explains every other shape it recognizes. */
export function privateKeyDer(text: string, field: string): Uint8Array {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) {
    throw new PrestoPayConfigError(
      `${field}: the PEM is an encrypted private key. Decrypt it first: ` +
        'openssl pkcs8 -topk8 -nocrypt -in encrypted.pem -out partner-key.pem',
      { operation: 'config', field },
    );
  }
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(text)) {
    throw new PrestoPayConfigError(
      `${field}: the PEM is PKCS#1, not PKCS#8. Convert it: ` +
        'openssl pkcs8 -topk8 -nocrypt -in pkcs1.pem -out partner-key.pem',
      { operation: 'config', field },
    );
  }
  if (/-----BEGIN CERTIFICATE-----/.test(text)) {
    throw new PrestoPayConfigError(
      `${field}: this is a certificate, not a private key. The private key comes from the onboarding ` +
        `keystore: ${CONVERT_P12}`,
      { operation: 'config', field },
    );
  }

  const block = decodePem(text, field);
  if (block.label !== 'PRIVATE KEY') {
    throw new PrestoPayConfigError(
      `${field}: expected a "PRIVATE KEY" PEM block (unencrypted PKCS#8), found "${block.label}"`,
      { operation: 'config', field },
    );
  }
  return block.bytes;
}

export type PublicKeyMaterial =
  | { readonly kind: 'spki'; readonly bytes: Uint8Array }
  | { readonly kind: 'certificate'; readonly bytes: Uint8Array };

/** Presto's key arrives as a certificate, in PEM or DER, but a bare SPKI PEM is accepted too. */
export function publicKeyMaterial(input: string | Uint8Array, field: string): PublicKeyMaterial {
  if (typeof input !== 'string') {
    return { kind: 'certificate', bytes: input };
  }
  if (/-----BEGIN PRIVATE KEY-----|-----BEGIN RSA PRIVATE KEY-----/.test(input)) {
    throw new PrestoPayConfigError(
      `${field}: this is a private key. Presto's key is the certificate they issued you`,
      { operation: 'config', field },
    );
  }

  const block = decodePem(input, field);
  switch (block.label) {
    case 'CERTIFICATE':
      return { kind: 'certificate', bytes: block.bytes };
    case 'PUBLIC KEY':
      return { kind: 'spki', bytes: block.bytes };
    default:
      throw new PrestoPayConfigError(
        `${field}: expected a "CERTIFICATE" or "PUBLIC KEY" PEM block, found "${block.label}"`,
        { operation: 'config', field },
      );
  }
}
