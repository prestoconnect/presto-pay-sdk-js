import { readFileSync } from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; see sample/my-store/.env.example`);
  return value;
}

export const port = Number(process.env.PORT ?? 3000);
export const hasPublicUrl = Boolean(process.env.PUBLIC_URL?.trim());
export const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
export const prestoMrn = required('PRESTO_MRN');
export const defaultCurrency = 'MYR';

const privateKeyFile = path.resolve(required('PRESTOPAY_PRIVATE_KEY_FILE'));
const publicKeyFile = path.resolve(required('PRESTOPAY_PUBLIC_KEY_FILE'));

export const prestoPayOptions = {
  environment: 'staging',
  merchantId: required('PRESTOPAY_MID'),
  privateKey: readFileSync(privateKeyFile, 'utf8'),
  // Convert Node's Buffer to a plain Uint8Array for Web Crypto DER import.
  prestoPublicKey: new Uint8Array(readFileSync(publicKeyFile)),
};

// Presto calls notifyUrl from its own servers -- localhost only works behind a public tunnel (see README).
export function notifyUrl() {
  return `${publicUrl}/presto/notify`;
}

export function returnUrlForTransaction(txnRefNum) {
  if (!txnRefNum || !txnRefNum.trim()) throw new Error('txnRefNum is required to build the return URL');
  return `${publicUrl}/return/${encodeURIComponent(txnRefNum.trim())}`;
}
