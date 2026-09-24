/**
 * Shared validation helpers for the four operations.
 *
 * Length maxima are documentation, not gateway limits (Presto enforces none today) — they are only checked in
 * `strict` mode, where the point is to catch a contract violation in staging rather than in production.
 */
import type { Operation } from '../errors.js';
import { PrestoPayConfigError } from '../errors.js';
import { assertEncodable, type FlatBody } from '../internal/canonical.js';

export function requireString(
  value: unknown,
  field: string,
  operation: Operation,
  maxLength?: number,
  strict = false,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrestoPayConfigError(`${field}: required`, { operation, field });
  }
  assertEncodable(value, field, operation);
  if (strict && maxLength !== undefined && value.length > maxLength) {
    throw new PrestoPayConfigError(`${field}: exceeds the documented maximum of ${maxLength} characters`, {
      operation,
      field,
    });
  }
  return value;
}

export function optionalString(
  value: unknown,
  field: string,
  operation: Operation,
  maxLength?: number,
  strict = false,
): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, operation, maxLength, strict);
}

export function requireInteger(
  value: unknown,
  field: string,
  operation: Operation,
  options: { positive?: boolean } = {},
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PrestoPayConfigError(`${field}: required and must be an integer`, { operation, field });
  }
  if (options.positive && value <= 0) {
    throw new PrestoPayConfigError(`${field}: must be greater than 0`, { operation, field });
  }
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  operation: Operation,
  options: { positive?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  return requireInteger(value, field, operation, options);
}

/** Sets a key only when the value is not `undefined` — optional fields are omitted, never sent as `null` (§3.2). */
export function put(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) body[key] = value;
}

export function stringifyArray(value: readonly unknown[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

/** §3.8: `qrValue` and `payerRefNum` are mutually exclusive, but both may be absent. */
export function requireAtMostOneOf(fields: Record<string, unknown>, operation: Operation): void {
  const present = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (present.length > 1) {
    const names = Object.keys(fields).join(' / ');
    throw new PrestoPayConfigError(`${names} are mutually exclusive`, { operation, field: names });
  }
}

/** §3.8: at least one of the two must be supplied (query's `paymentRefNum` / `txnRefNum`). */
export function requireAtLeastOneOf(fields: Record<string, unknown>, operation: Operation): void {
  const present = Object.values(fields).some((value) => value !== undefined);
  if (!present) {
    const names = Object.keys(fields).join(' / ');
    throw new PrestoPayConfigError(`at least one of ${names} is required`, { operation, field: names });
  }
}

export type { FlatBody };
