/** Public key-import helpers, thin wrappers naming the field for error messages. */
import { importPrivateKey as importPrivateKeyInternal, importPublicKey } from './internal/crypto.js';

export function importPrivateKey(pem: string): Promise<CryptoKey> {
  return importPrivateKeyInternal(pem, 'privateKey');
}

/** Accepts Presto's certificate (PEM or DER) or a bare SPKI PEM. */
export function importPrestoPublicKey(pemOrDer: string | Uint8Array): Promise<CryptoKey> {
  return importPublicKey(pemOrDer, 'prestoPublicKey');
}
