import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { formatGatewayTimestamp, parseGatewayTimestamp } from '../../src/internal/timestamp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const specDir = path.resolve(here, '../../spec');
const vectors = JSON.parse(
  readFileSync(path.join(specDir, 'vectors/timestamps.json'), 'utf8'),
) as Array<{ name: string; epochMs?: number; ts?: string; invalidTs?: string; reject?: string }>;

describe('timestamps.json vectors', () => {
  for (const vector of vectors) {
    if (vector.reject) {
      it(`rejects: ${vector.name}`, () => {
        expect(() => parseGatewayTimestamp(vector.invalidTs as string)).toThrow();
      });
      continue;
    }

    it(`formats: ${vector.name}`, () => {
      expect(formatGatewayTimestamp(vector.epochMs as number)).toBe(vector.ts);
    });

    it(`parses: ${vector.name}`, () => {
      expect(parseGatewayTimestamp(vector.ts as string).getTime()).toBe(vector.epochMs);
    });
  }
});
