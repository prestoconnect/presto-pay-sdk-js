import { describe, it, expect } from 'vitest';
import { buildInitBody, buildQueryBody, buildRefundBody, buildReverseBody } from '../../src/payments/wire.js';
import { PrestoPayConfigError } from '../../src/errors.js';
import { TxnType } from '../../src/payments/constants.js';

describe('buildInitBody', () => {
  const base = {
    prestoMrn: 'PM1',
    txnType: TxnType.WebPay,
    txnRefNum: 'order-1',
    displayDesc: 'Order 1',
    redirectUrl: 'https://merchant.example/return',
  };

  it('omits optional fields that are not set, never as null', () => {
    const body = buildInitBody(base, false);
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('qrValue');
    expect(Object.values(body)).not.toContain(null);
  });

  it('requires redirectUrl for WebPay', () => {
    const { redirectUrl: _drop, ...withoutRedirect } = base;
    expect(() => buildInitBody(withoutRedirect, false)).toThrow(/redirectUrl/);
  });

  it('does not require redirectUrl for QrPay', () => {
    const { redirectUrl: _drop, ...withoutRedirect } = base;
    const body = buildInitBody({ ...withoutRedirect, txnType: TxnType.QrPay }, false);
    expect(body.txnType).toBe('QrPay');
  });

  it('requires currencyCode when amount is set', () => {
    expect(() => buildInitBody({ ...base, amount: 100 }, false)).toThrow(/currencyCode/);
  });

  it('rejects amount <= 0', () => {
    expect(() => buildInitBody({ ...base, amount: 0, currencyCode: 'MYR' }, false)).toThrow(PrestoPayConfigError);
    expect(() => buildInitBody({ ...base, amount: -5, currencyCode: 'MYR' }, false)).toThrow(PrestoPayConfigError);
  });

  it('qrValue and payerRefNum are mutually exclusive', () => {
    expect(() =>
      buildInitBody({ ...base, qrValue: 'qr', payerRefNum: 'payer' }, false),
    ).toThrow(/mutually exclusive/);
  });

  it('allows either qrValue or payerRefNum alone, or neither', () => {
    expect(() => buildInitBody({ ...base, qrValue: 'qr' }, false)).not.toThrow();
    expect(() => buildInitBody({ ...base, payerRefNum: 'payer' }, false)).not.toThrow();
    expect(() => buildInitBody(base, false)).not.toThrow();
  });

  it('stringifies itemList and allowedPaymentMethods as JSON strings', () => {
    const body = buildInitBody(
      {
        ...base,
        itemList: [{ itemDesc: 'Widget', quantity: 2, unitAmount: 500, totalAmount: 1000 }],
        allowedPaymentMethods: ['Wallet', 'Card'],
      },
      false,
    );
    expect(typeof body.itemList).toBe('string');
    expect(JSON.parse(body.itemList as string)).toEqual([
      { itemDesc: 'Widget', quantity: 2, unitAmount: 500, totalAmount: 1000 },
    ]);
    expect(JSON.parse(body.allowedPaymentMethods as string)).toEqual(['Wallet', 'Card']);
  });

  it('rejects a line item with quantity <= 0', () => {
    expect(() =>
      buildInitBody(
        { ...base, itemList: [{ itemDesc: 'Widget', quantity: 0, unitAmount: 500, totalAmount: 1000 }] },
        false,
      ),
    ).toThrow(/quantity/);
  });

  it('formats a Date sessionValidity as a gateway timestamp', () => {
    const body = buildInitBody({ ...base, sessionValidity: new Date(Date.UTC(2025, 3, 23, 2, 45, 0, 0)) }, false);
    expect(body.sessionValidity).toBe('20250423104500.000');
  });

  it('passes a string sessionValidity through unchanged', () => {
    const body = buildInitBody({ ...base, sessionValidity: '20250423104500.000' }, false);
    expect(body.sessionValidity).toBe('20250423104500.000');
  });

  it('strict mode enforces documented length maxima; lenient mode does not', () => {
    const longRef = 'x'.repeat(51);
    expect(() => buildInitBody({ ...base, txnRefNum: longRef }, true)).toThrow(/exceeds the documented maximum/);
    expect(() => buildInitBody({ ...base, txnRefNum: longRef }, false)).not.toThrow();
  });

  it('rejects a lone UTF-16 surrogate in displayDesc', () => {
    expect(() => buildInitBody({ ...base, displayDesc: 'bad\ud800desc' }, false)).toThrow(PrestoPayConfigError);
  });
});

describe('buildQueryBody', () => {
  it('requires at least one of paymentRefNum / txnRefNum', () => {
    expect(() => buildQueryBody({ prestoMrn: 'PM1' })).toThrow(/at least one/);
  });

  it('accepts either alone', () => {
    expect(buildQueryBody({ prestoMrn: 'PM1', paymentRefNum: 'PP1' })).toMatchObject({ paymentRefNum: 'PP1' });
    expect(buildQueryBody({ prestoMrn: 'PM1', txnRefNum: 'T1' })).toMatchObject({ txnRefNum: 'T1' });
  });
});

describe('buildReverseBody', () => {
  it('requires reversalRefNum and one lookup key', () => {
    expect(() =>
      buildReverseBody({ prestoMrn: 'PM1', reversalRefNum: '', paymentRefNum: 'PP1' }, false),
    ).toThrow(PrestoPayConfigError);
    expect(() => buildReverseBody({ prestoMrn: 'PM1', reversalRefNum: 'R1' }, false)).toThrow(/at least one/);
  });

  it('builds a valid body', () => {
    const body = buildReverseBody({ prestoMrn: 'PM1', reversalRefNum: 'R1', paymentRefNum: 'PP1' }, false);
    expect(body).toMatchObject({ prestoMrn: 'PM1', reversalRefNum: 'R1', paymentRefNum: 'PP1' });
  });
});

describe('buildRefundBody', () => {
  it('requires paymentRefNum, refundRefNum and remark', () => {
    expect(() => buildRefundBody({ prestoMrn: 'PM1', paymentRefNum: '', refundRefNum: 'R1', remark: 'x' }, false)).toThrow(
      PrestoPayConfigError,
    );
  });

  it('omits amount for a full refund', () => {
    const body = buildRefundBody({ prestoMrn: 'PM1', paymentRefNum: 'PP1', refundRefNum: 'R1', remark: 'x' }, false);
    expect(body).not.toHaveProperty('amount');
  });

  it('rejects amount <= 0 when given', () => {
    expect(() =>
      buildRefundBody({ prestoMrn: 'PM1', paymentRefNum: 'PP1', refundRefNum: 'R1', remark: 'x', amount: 0 }, false),
    ).toThrow(PrestoPayConfigError);
  });
});
