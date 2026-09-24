import { describe, it, expect } from 'vitest';
import { base64ToBytes, bytesToBase64, isStandardBase64 } from '../../src/internal/base64.js';

describe('base64', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips a large buffer past the fromCharCode chunk size', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('accepts standard padded base64', () => {
    expect(isStandardBase64('YQ==')).toBe(true);
    expect(isStandardBase64('YQ')).toBe(false);
  });

  it('rejects non-standard characters', () => {
    expect(isStandardBase64('a_b-')).toBe(false);
    expect(() => base64ToBytes('not base64!!')).toThrow();
  });

  it('rejects wrong-length input', () => {
    expect(() => base64ToBytes('abc')).toThrow();
  });
});
