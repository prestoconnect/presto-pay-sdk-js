import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/internal/canonical.js';
import { importPublicKey, verify } from '../../src/internal/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const vectors = JSON.parse(
  readFileSync(path.join(specDir, 'vectors/canonical.json'), 'utf8'),
) as Array<{
  name: string;
  body?: Record<string, unknown>;
  canonical?: string;
  reject?: string;
  verifyAgainst?: string;
}>;

describe('canonical.json vectors', () => {
  for (const vector of vectors) {
    if (vector.reject) {
      it(`rejects: ${vector.name}`, () => {
        expect(() => canonicalize(vector.body as never)).toThrow();
      });
      continue;
    }

    it(`canonicalizes: ${vector.name}`, () => {
      expect(canonicalize(vector.body as never)).toBe(vector.canonical);
    });

    if (vector.verifyAgainst) {
      it(`signature verifies: ${vector.name}`, async () => {
        const certPath = path.join(specDir, 'keys', vector.verifyAgainst as string);
        const cert = readFileSync(certPath);
        const key = await importPublicKey(new Uint8Array(cert), 'test');
        const canonical = canonicalize(vector.body as never);
        const signature = (vector.body as { signature: string }).signature;
        await expect(verify(key, canonical, signature)).resolves.toBe(true);
      });
    }
  }
});
