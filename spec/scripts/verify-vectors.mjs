#!/usr/bin/env node
// A second, deliberately naive implementation of wire-contract.md, checking the vectors against themselves
// with no SDK code involved: it rebuilds every canonical string, verifies the two staging captures against
// Presto's certificate, verifies signatures.json against the test certificate, and round-trips every timestamp.
import { readFileSync } from 'node:fs';
import { createVerify, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '..');
const readJson = (p) => JSON.parse(readFileSync(path.join(specDir, p), 'utf8'));

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
}

// --- canonicalization ---
function render(value) {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new RangeError('unrenderable value');
}

function canonicalize(body) {
  return Object.keys(body)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => render(body[k]))
    .join(':');
}

const canonicalVectors = readJson('vectors/canonical.json');
for (const vector of canonicalVectors) {
  if (vector.reject) {
    let threw = false;
    try {
      canonicalize(vector.body);
    } catch {
      threw = true;
    }
    check(threw, `${vector.name}: expected canonicalization to reject`);
    continue;
  }
  let actual;
  try {
    actual = canonicalize(vector.body);
  } catch (err) {
    check(false, `${vector.name}: canonicalize threw: ${err.message}`);
    continue;
  }
  check(actual === vector.canonical, `${vector.name}: canonical mismatch\n  expected: ${vector.canonical}\n  actual:   ${actual}`);

  if (vector.verifyAgainst) {
    const certDer = readFileSync(path.join(specDir, 'keys', vector.verifyAgainst));
    const cert = new X509Certificate(certDer);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(actual, 'utf8');
    verifier.end();
    const ok = verifier.verify(cert.publicKey, Buffer.from(vector.body.signature, 'base64'));
    check(ok, `${vector.name}: signature does not verify against ${vector.verifyAgainst}`);
  }
}

// --- timestamps ---
const OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (n, w) => String(n).padStart(w, '0');
function formatGatewayTimestamp(epochMs) {
  const d = new Date(epochMs + OFFSET_MS);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}
const SHAPE = /^\d{14}\.\d{3}$/;
function parseGatewayTimestamp(ts) {
  if (!SHAPE.test(ts)) throw new RangeError('shape');
  const at = (s, e) => Number(ts.slice(s, e));
  const epochMs =
    Date.UTC(at(0, 4), at(4, 6) - 1, at(6, 8), at(8, 10), at(10, 12), at(12, 14), at(15, 18)) - OFFSET_MS;
  if (formatGatewayTimestamp(epochMs) !== ts) throw new RangeError('not a calendar date');
  return epochMs;
}

const timestampVectors = readJson('vectors/timestamps.json');
for (const vector of timestampVectors) {
  if (vector.reject) {
    let threw = false;
    try {
      parseGatewayTimestamp(vector.invalidTs);
    } catch {
      threw = true;
    }
    check(threw, `${vector.name}: expected parseGatewayTimestamp to reject ${vector.invalidTs}`);
    continue;
  }
  check(
    formatGatewayTimestamp(vector.epochMs) === vector.ts,
    `${vector.name}: format(${vector.epochMs}) !== ${vector.ts}`,
  );
  check(
    parseGatewayTimestamp(vector.ts) === vector.epochMs,
    `${vector.name}: parse(${vector.ts}) !== ${vector.epochMs}`,
  );
}

// --- signatures ---
const publicKeyPem = readFileSync(path.join(specDir, 'keys/test-public-key.pem'), 'utf8');
const signatureVectors = readJson('vectors/signatures.json');
for (const vector of signatureVectors) {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(vector.canonical, 'utf8');
  verifier.end();
  const ok = verifier.verify(publicKeyPem, Buffer.from(vector.signature, 'base64'));
  check(ok, `signature vector "${vector.canonical}" does not verify`);
}

if (failures > 0) {
  console.error(`\n${failures} vector check(s) failed.`);
  process.exit(1);
}
console.log(
  `OK: ${canonicalVectors.length} canonical, ${timestampVectors.length} timestamp, ${signatureVectors.length} signature vectors self-consistent.`,
);
