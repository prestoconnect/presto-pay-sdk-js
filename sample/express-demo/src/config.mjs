import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keysDir = path.resolve(here, '../keys');

export const port = Number(process.env.PORT ?? 3000);
export const hasPublicUrl = Boolean(process.env.PUBLIC_URL?.trim());
export const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
export const prestoMrn = process.env.PRESTO_MRN ?? 'PM181019QGJWH4K';

export const prestoPayOptions = {
  environment: 'staging',
  merchantId: process.env.PRESTOPAY_MID ?? '11StreetMock',
  privateKey: readFileSync(path.join(keysDir, 'presto_rm_key-pkcs8.pem'), 'utf8'),
  // Convert Node's Buffer to a plain Uint8Array for Web Crypto DER import.
  prestoPublicKey: new Uint8Array(readFileSync(path.join(keysDir, 'presto_ext_service_dev.der'))),
};
