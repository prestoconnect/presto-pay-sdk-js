import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { importPublicKey, verify } from '../../src/internal/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const vectors = JSON.parse(
  readFileSync(path.join(specDir, 'vectors/signatures.json'), 'utf8'),
) as Array<{ canonical: string; signature: string }>;

describe('signatures.json vectors', () => {
  it('verify against the throwaway test certificate', async () => {
    const cert = readFileSync(path.join(specDir, 'keys/test-cert.pem'), 'utf8');
    const key = await importPublicKey(cert, 'test');
    for (const vector of vectors) {
      await expect(verify(key, vector.canonical, vector.signature)).resolves.toBe(true);
    }
  });

  it('rejects a tampered canonical string', async () => {
    const cert = readFileSync(path.join(specDir, 'keys/test-cert.pem'), 'utf8');
    const key = await importPublicKey(cert, 'test');
    const [first] = vectors;
    if (!first) throw new Error('no vectors');
    await expect(verify(key, `${first.canonical}x`, first.signature)).resolves.toBe(false);
  });
});
