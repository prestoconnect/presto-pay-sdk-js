import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  EventCode,
  PaymentMethod,
  PaymentStatus,
  RefundStatus,
  ReversalStatus,
  TxnType,
} from '../../src/payments/constants.js';

describe('code-list constants: key equals value', () => {
  it.each(
    Object.entries({ PaymentStatus, ReversalStatus, RefundStatus, TxnType, PaymentMethod, EventCode }),
  )('every entry of %s has key === value', (_name, table) => {
    for (const [key, value] of Object.entries(table)) {
      expect(value).toBe(key);
    }
  });
});

describe('ErrorCode', () => {
  it('maps descriptive names to four-digit code strings', () => {
    expect(ErrorCode.DuplicateTxnRefNum).toBe('1203');
    expect(ErrorCode.InvalidSignature).toBe('1006');
    expect(ErrorCode.SignatureVerificationFailed).toBe('1007');
    expect(ErrorCode.ExceededValidityPeriod).toBe('1005');
  });

  it('every value is a four-digit numeric string', () => {
    for (const value of Object.values(ErrorCode)) {
      expect(value).toMatch(/^\d{4}$/);
    }
  });

  it('has no duplicate codes', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});
