/**
 * Field mapping, js-plan.md §3.5 / §5 "Incoming": a successful response carries every documented field, using
 * `""` or `null` interchangeably for the ones that have no value (confirmed unstable per field, §3.5), so both
 * spellings normalize to `undefined` on optional fields. A required field that arrives empty is a malformed body.
 */
import type { Operation, ReconcileKey } from '../errors.js';
import { PrestoPayResponseError } from '../errors.js';
import type { JsonObject, JsonValue } from '../internal/canonical.js';
import type { InitResponse, PaymentDetail, QueryResponse, RefundDetail, RefundResponse, ReverseResponse } from './types.js';

export interface MapContext {
  readonly operation: Operation;
  readonly rawBody: string;
  /** Stamped on every malformed-body error raised while mapping: a 200 with a broken body may still have run. */
  readonly mayHaveTakenEffect: boolean;
  readonly reconcileBy?: ReconcileKey;
}

/**
 * Assigns only when the value is not `undefined`. Response types are built under `exactOptionalPropertyTypes`,
 * where an optional field must be absent rather than present-with-`undefined`.
 */
function set(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function fail(ctx: MapContext, message: string): never {
  const options = {
    operation: ctx.operation,
    source: 'response' as const,
    rawBody: ctx.rawBody,
    mayHaveTakenEffect: ctx.mayHaveTakenEffect,
    ...(ctx.mayHaveTakenEffect && ctx.reconcileBy ? { reconcileBy: ctx.reconcileBy } : {}),
  };
  throw new PrestoPayResponseError(message, options);
}

/** `""` and `null` are one condition (§3.5): both normalize to "absent" for an optional field. */
function isEmpty(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

export function requireString(body: JsonObject, key: string, ctx: MapContext): string {
  const value = body[key];
  if (isEmpty(value)) fail(ctx, `${key}: required field is missing or empty`);
  if (typeof value === 'string') return value;
  return String(value as JsonValue); // lenient coercion (§3.6 step 5); `strict` mode is a later pass.
}

export function optionalString(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  if (isEmpty(value)) return undefined;
  return typeof value === 'string' ? value : String(value as JsonValue);
}

export function optionalInteger(body: JsonObject, key: string, ctx: MapContext): number | undefined {
  const value = body[key];
  if (isEmpty(value)) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(ctx, `${key}: expected an integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

export function requireInteger(body: JsonObject, key: string, ctx: MapContext): number {
  const value = optionalInteger(body, key, ctx);
  if (value === undefined) fail(ctx, `${key}: required field is missing or empty`);
  return value;
}

/**
 * List fields are JSON strings containing an array on the wire, in both directions (§3.5); a missing field
 * reads as an empty list. Elements are then mapped one at a time by `mapElement`.
 */
export function parseListField<T>(
  body: JsonObject,
  key: string,
  ctx: MapContext,
  mapElement: (element: JsonObject, index: number) => T,
): T[] {
  const raw = body[key];
  if (isEmpty(raw)) return [];
  if (typeof raw !== 'string') fail(ctx, `${key}: expected a JSON string containing an array`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(ctx, `${key}: is not valid JSON`);
  }
  if (!Array.isArray(parsed)) fail(ctx, `${key}: parsed value is not an array`);
  return parsed.map((element, index) => {
    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      fail(ctx, `${key}[${index}]: expected an object`);
    }
    return mapElement(element as JsonObject, index);
  });
}

function mapRefundDetail(element: JsonObject, ctx: MapContext): RefundDetail {
  const out: Record<string, unknown> = {
    refundRefNum: requireString(element, 'refundRefNum', ctx),
    prestoRefundRefNum: requireString(element, 'prestoRefundRefNum', ctx),
    refundStatus: requireString(element, 'refundStatus', ctx),
    refundRequestDate: requireString(element, 'refundRequestDate', ctx),
  };
  set(out, 'refundFinalisedDate', optionalString(element, 'refundFinalisedDate'));
  return out as unknown as RefundDetail;
}

/** Exported for reuse by the webhooks mapper — `paymentDetails` has the identical shape there (§3.8). */
export function mapPaymentDetail(element: JsonObject, ctx: MapContext): PaymentDetail {
  const out: Record<string, unknown> = { amount: requireInteger(element, 'amount', ctx) };
  set(out, 'method', optionalString(element, 'method'));
  set(out, 'cardBin', optionalString(element, 'cardBin'));
  set(out, 'cardSummary', optionalString(element, 'cardSummary'));
  set(out, 'cardType', optionalString(element, 'cardType'));
  set(out, 'refNum', optionalString(element, 'refNum'));
  return out as unknown as PaymentDetail;
}

export function mapInitResponse(body: JsonObject, ctx: MapContext): InitResponse {
  const out: Record<string, unknown> = {
    prestoMrn: requireString(body, 'prestoMrn', ctx),
    paymentRefNum: requireString(body, 'paymentRefNum', ctx),
    paymentStatus: requireString(body, 'paymentStatus', ctx),
  };
  set(out, 'txnRefNum', optionalString(body, 'txnRefNum'));
  set(out, 'paymentUrl', optionalString(body, 'paymentUrl'));
  set(out, 'userRefNum', optionalString(body, 'userRefNum'));
  set(out, 'amount', optionalInteger(body, 'amount', ctx));
  set(out, 'currencyCode', optionalString(body, 'currencyCode'));
  set(out, 'paymentRequestDate', optionalString(body, 'paymentRequestDate'));
  set(out, 'paymentFinalisedDate', optionalString(body, 'paymentFinalisedDate'));
  set(out, 'additionalData', optionalString(body, 'additionalData'));
  return out as unknown as InitResponse;
}

export function mapQueryResponse(body: JsonObject, ctx: MapContext): QueryResponse {
  const out: Record<string, unknown> = {
    prestoMrn: requireString(body, 'prestoMrn', ctx),
    paymentRefNum: requireString(body, 'paymentRefNum', ctx),
    refundDetails: parseListField(body, 'refundDetails', ctx, (el) => mapRefundDetail(el, ctx)),
    paymentDetails: parseListField(body, 'paymentDetails', ctx, (el) => mapPaymentDetail(el, ctx)),
  };
  set(out, 'txnRefNum', optionalString(body, 'txnRefNum'));
  set(out, 'userRefNum', optionalString(body, 'userRefNum'));
  set(out, 'paymentStatus', optionalString(body, 'paymentStatus'));
  set(out, 'amount', optionalInteger(body, 'amount', ctx));
  set(out, 'currencyCode', optionalString(body, 'currencyCode'));
  set(out, 'paymentRequestDate', optionalString(body, 'paymentRequestDate'));
  set(out, 'paymentFinalisedDate', optionalString(body, 'paymentFinalisedDate'));
  set(out, 'reversalRefNum', optionalString(body, 'reversalRefNum'));
  set(out, 'prestoReversalRefNum', optionalString(body, 'prestoReversalRefNum'));
  set(out, 'reversalStatus', optionalString(body, 'reversalStatus'));
  set(out, 'reversalDate', optionalString(body, 'reversalDate'));
  set(out, 'refundRefNum', optionalString(body, 'refundRefNum'));
  set(out, 'prestoRefundRefNum', optionalString(body, 'prestoRefundRefNum'));
  set(out, 'refundStatus', optionalString(body, 'refundStatus'));
  set(out, 'refundRequestDate', optionalString(body, 'refundRequestDate'));
  set(out, 'refundFinalisedDate', optionalString(body, 'refundFinalisedDate'));
  set(out, 'additionalData', optionalString(body, 'additionalData'));
  return out as unknown as QueryResponse;
}

export function mapReverseResponse(body: JsonObject, ctx: MapContext): ReverseResponse {
  const out: Record<string, unknown> = {
    prestoMrn: requireString(body, 'prestoMrn', ctx),
    paymentRefNum: requireString(body, 'paymentRefNum', ctx),
  };
  set(out, 'prestoReversalRefNum', optionalString(body, 'prestoReversalRefNum'));
  set(out, 'amount', optionalInteger(body, 'amount', ctx));
  set(out, 'currencyCode', optionalString(body, 'currencyCode'));
  set(out, 'paymentStatus', optionalString(body, 'paymentStatus'));
  return out as unknown as ReverseResponse;
}

export function mapRefundResponse(body: JsonObject, ctx: MapContext): RefundResponse {
  const out: Record<string, unknown> = {
    prestoMrn: requireString(body, 'prestoMrn', ctx),
    paymentRefNum: requireString(body, 'paymentRefNum', ctx),
  };
  set(out, 'prestoRefundRefNum', optionalString(body, 'prestoRefundRefNum'));
  set(out, 'amount', optionalInteger(body, 'amount', ctx));
  set(out, 'refundAmount', optionalInteger(body, 'refundAmount', ctx));
  set(out, 'currencyCode', optionalString(body, 'currencyCode'));
  set(out, 'paymentStatus', optionalString(body, 'paymentStatus'));
  set(out, 'refundedDate', optionalString(body, 'refundedDate'));
  return out as unknown as RefundResponse;
}
