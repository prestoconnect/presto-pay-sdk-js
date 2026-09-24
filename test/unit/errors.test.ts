import { describe, it, expect } from 'vitest';
import {
  PrestoPayApiError,
  PrestoPayConfigError,
  isPrestoPayError,
  mayHaveSucceeded,
  redact,
} from '../../src/errors.js';

describe('isPrestoPayError', () => {
  it('recognizes every subclass via the brand, not instanceof', () => {
    const err = new PrestoPayConfigError('bad field', { operation: 'config', field: 'mid' });
    expect(isPrestoPayError(err)).toBe(true);
    expect(isPrestoPayError(new Error('plain'))).toBe(false);
    expect(isPrestoPayError(null)).toBe(false);
    expect(isPrestoPayError(undefined)).toBe(false);
  });
});

describe('mayHaveSucceeded', () => {
  it('reflects mayHaveTakenEffect stamped at the throw site', () => {
    const indeterminate = new PrestoPayApiError('duplicate txnRefNum', {
      operation: 'init',
      kind: 'business',
      errorCode: '1203',
      mayHaveTakenEffect: true,
      reconcileBy: { txnRefNum: 'order-1' },
    });
    expect(mayHaveSucceeded(indeterminate)).toBe(true);

    const definite = new PrestoPayApiError('invalid input', {
      operation: 'init',
      kind: 'business',
      errorCode: '1201',
    });
    expect(mayHaveSucceeded(definite)).toBe(false);
    expect(mayHaveSucceeded('not an error')).toBe(false);
  });
});

describe('redact', () => {
  it('redacts by default and passes through when disabled', () => {
    expect(redact('sensitive body', true)).toMatch(/redacted/);
    expect(redact('sensitive body', false)).toBe('sensitive body');
    expect(redact(undefined, true)).toBeUndefined();
  });
});
