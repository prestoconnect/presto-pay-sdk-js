import { describe, it, expect } from 'vitest';
import { connectPhaseCode, isRequestNotSentError } from '../../src/internal/http.js';

describe('connectPhaseCode', () => {
  it('reads code from cause.code (Node fetch/undici shape)', () => {
    const error = new Error('fetch failed');
    (error as unknown as { cause: unknown }).cause = Object.assign(new Error('connect'), {
      code: 'ECONNREFUSED',
    });
    expect(connectPhaseCode(error)).toBe('ECONNREFUSED');
  });

  it('reads code directly off the error when there is no cause', () => {
    const error = Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    expect(connectPhaseCode(error)).toBe('ENOTFOUND');
  });

  it('returns undefined for a plain error or non-object', () => {
    expect(connectPhaseCode(new Error('plain'))).toBeUndefined();
    expect(connectPhaseCode('boom')).toBeUndefined();
    expect(connectPhaseCode(null)).toBeUndefined();
  });
});

describe('isRequestNotSentError', () => {
  const withCode = (code: string): Error =>
    Object.assign(new Error('x'), { cause: Object.assign(new Error('y'), { code }) });

  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ])('treats %s as requestNotSent: true', (code) => {
    expect(isRequestNotSentError(withCode(code))).toBe(true);
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'SOME_UNKNOWN_CODE'])(
    'treats %s as requestNotSent: false',
    (code) => {
      expect(isRequestNotSentError(withCode(code))).toBe(false);
    },
  );

  it('treats an AbortError (no code) as requestNotSent: false', () => {
    expect(isRequestNotSentError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});
