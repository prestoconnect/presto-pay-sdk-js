import { describe, it, expect } from 'vitest';
import { mapInitResponse, mapQueryResponse, type MapContext } from '../../src/payments/response.js';
import { PrestoPayResponseError } from '../../src/errors.js';
import type { JsonObject } from '../../src/internal/canonical.js';

const ctx: MapContext = { operation: 'init', rawBody: '{}', mayHaveTakenEffect: false };

describe('mapInitResponse', () => {
  const full: JsonObject = {
    prestoMrn: 'PM1',
    paymentRefNum: 'PP1',
    paymentStatus: 'PendingAuthorise',
    txnRefNum: '',
    paymentUrl: null,
    userRefNum: '',
    amount: 200,
    currencyCode: 'MYR',
    paymentRequestDate: '20260924133756.056',
    paymentFinalisedDate: '',
    additionalData: null,
  };

  it('normalizes "" and null to undefined on optional fields identically', () => {
    const mapped = mapInitResponse(full, ctx);
    expect(mapped.txnRefNum).toBeUndefined();
    expect(mapped.paymentUrl).toBeUndefined();
    expect(mapped.userRefNum).toBeUndefined();
    expect(mapped.paymentFinalisedDate).toBeUndefined();
    expect(mapped.additionalData).toBeUndefined();
    expect(mapped.amount).toBe(200);
  });

  it('throws on a missing required field', () => {
    const { paymentRefNum: _drop, ...missing } = full;
    expect(() => mapInitResponse(missing, ctx)).toThrow(PrestoPayResponseError);
  });

  it('throws when a required field is present but empty', () => {
    expect(() => mapInitResponse({ ...full, paymentStatus: '' }, ctx)).toThrow(PrestoPayResponseError);
  });

  it('stamps mayHaveTakenEffect and reconcileBy from context on a malformed body', () => {
    const strictCtx: MapContext = {
      operation: 'init',
      rawBody: '{}',
      mayHaveTakenEffect: true,
      reconcileBy: { txnRefNum: 'order-1' },
    };
    try {
      mapInitResponse({ ...full, paymentStatus: undefined as unknown as string }, strictCtx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PrestoPayResponseError);
      expect((err as PrestoPayResponseError).mayHaveTakenEffect).toBe(true);
      expect((err as PrestoPayResponseError).reconcileBy).toEqual({ txnRefNum: 'order-1' });
    }
  });

  it('coerces a non-string value in a string field rather than rejecting (lenient mode)', () => {
    const mapped = mapInitResponse({ ...full, paymentStatus: 'PendingAuthorise', txnRefNum: 123 as never }, ctx);
    expect(mapped.txnRefNum).toBe('123');
  });
});

describe('mapQueryResponse: stringified list fields', () => {
  const base: JsonObject = { prestoMrn: 'PM1', paymentRefNum: 'PP1' };
  const queryCtx: MapContext = { operation: 'query', rawBody: '{}', mayHaveTakenEffect: false };

  it('a missing list field reads as an empty array', () => {
    const mapped = mapQueryResponse(base, queryCtx);
    expect(mapped.refundDetails).toEqual([]);
    expect(mapped.paymentDetails).toEqual([]);
  });

  it('"[]" reads as an empty array, not absence', () => {
    const mapped = mapQueryResponse({ ...base, refundDetails: '[]', paymentDetails: '[]' }, queryCtx);
    expect(mapped.refundDetails).toEqual([]);
    expect(mapped.paymentDetails).toEqual([]);
  });

  it('rejects a native array where a JSON string is expected', () => {
    expect(() => mapQueryResponse({ ...base, refundDetails: [] as never }, queryCtx)).toThrow(
      PrestoPayResponseError,
    );
  });

  it('rejects invalid JSON in a list field', () => {
    expect(() => mapQueryResponse({ ...base, refundDetails: 'not json' }, queryCtx)).toThrow(
      PrestoPayResponseError,
    );
  });

  it('maps refund and payment detail elements', () => {
    const mapped = mapQueryResponse(
      {
        ...base,
        refundDetails: JSON.stringify([
          {
            refundRefNum: 'R1',
            prestoRefundRefNum: 'PR1',
            refundStatus: 'Success',
            refundRequestDate: '20250423104500.000',
          },
        ]),
        paymentDetails: JSON.stringify([{ amount: 500 }]),
      },
      queryCtx,
    );
    expect(mapped.refundDetails[0]?.refundFinalisedDate).toBeUndefined();
    expect(mapped.paymentDetails[0]?.method).toBeUndefined();
  });
});
