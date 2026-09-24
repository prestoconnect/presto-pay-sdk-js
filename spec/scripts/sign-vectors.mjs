#!/usr/bin/env node
// Regenerates spec/vectors/signatures.json: canonical string -> Base64 signature, signed with
// spec/keys/test-key-pkcs8.pem. PKCS#1 v1.5 is deterministic, so re-running this produces byte-identical
// output, which is what lets it be checked against `openssl dgst -sha256 -sign` independently.
import { readFileSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '..');
const keyPem = readFileSync(path.join(specDir, 'keys/test-key-pkcs8.pem'), 'utf8');

const canonicalStrings = [
  '1200:MYR:Order #12345:PW2401XH9KCX:https://merchant.example.com/webhook/notify:PM240110XDSFC:https://merchant.example.com/redirect/TXN10001:20250423104500.000:TXN10001:WebPay',
  '1201:Invalid input.:false:20260924124938.038',
  ':200:MYR::::PP260924K4H3DSF:20260924133756.056:PendingAuthorise:https://hpp-staging.prestouniverse.com/PM181019QGJWH4K/PP260924K4H3DSF:PM181019QGJWH4K:true:20260924133756.056:PM202609244E33DA4FCCC7445B99821588791F2418:',
  '',
  'a::b',
  'x:y:z',
];

function sign(canonical) {
  const signer = createSign('RSA-SHA256');
  signer.update(canonical, 'utf8');
  signer.end();
  return signer.sign(keyPem).toString('base64');
}

const vectors = canonicalStrings.map((canonical) => ({ canonical, signature: sign(canonical) }));
const outPath = path.join(specDir, 'vectors/signatures.json');
writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${outPath}`);
