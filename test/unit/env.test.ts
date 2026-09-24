import { describe, it, expect } from 'vitest';
import { fromEnv } from '../../src/env.js';
import { PrestoPayConfigError } from '../../src/errors.js';

const FULL_ENV = {
  PRESTOPAY_ENV: 'staging',
  PRESTOPAY_MID: 'M1',
  PRESTOPAY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
  PRESTOPAY_PUBLIC_KEY: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
};

describe('fromEnv', () => {
  it('maps PRESTOPAY_ENV to the environment field', () => {
    const options = fromEnv(FULL_ENV);
    expect(options.environment).toBe('staging');
    expect(options.merchantId).toBe('M1');
  });

  it('prefers PRESTOPAY_BASE_URL over PRESTOPAY_ENV when both are set', () => {
    const options = fromEnv({ ...FULL_ENV, PRESTOPAY_BASE_URL: 'https://custom.example' });
    expect(options.environment).toEqual({ baseUrl: 'https://custom.example' });
  });

  it('works with PRESTOPAY_BASE_URL alone', () => {
    const { PRESTOPAY_ENV: _drop, ...rest } = FULL_ENV;
    const options = fromEnv({ ...rest, PRESTOPAY_BASE_URL: 'https://custom.example' });
    expect(options.environment).toEqual({ baseUrl: 'https://custom.example' });
  });

  it('throws when neither PRESTOPAY_ENV nor PRESTOPAY_BASE_URL is set', () => {
    const { PRESTOPAY_ENV: _drop, ...rest } = FULL_ENV;
    expect(() => fromEnv(rest)).toThrow(PrestoPayConfigError);
  });

  it('throws naming the missing variable', () => {
    const { PRESTOPAY_MID: _drop, ...rest } = FULL_ENV;
    try {
      fromEnv(rest);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PrestoPayConfigError);
      expect((err as PrestoPayConfigError).field).toBe('PRESTOPAY_MID');
    }
  });

  it('treats an empty string the same as missing', () => {
    expect(() => fromEnv({ ...FULL_ENV, PRESTOPAY_PRIVATE_KEY: '' })).toThrow(PrestoPayConfigError);
  });

  it('works with a Workers-style env binding (any string record)', () => {
    const workersEnv: Record<string, string | undefined> = { ...FULL_ENV };
    expect(() => fromEnv(workersEnv)).not.toThrow();
  });
});
