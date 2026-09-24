/**
 * The canonical string, wire-contract.md §4.
 *
 * Take every key but `signature`, sort by code point, render each value, join with `:`. The rendering rules are
 * short but every one of them has a real signature behind it in spec/vectors/canonical.json.
 */

import { PrestoPayConfigError, PrestoPayResponseError } from '../errors.js';
import type { ErrorSource, Operation } from '../errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A body ready to canonicalize: flat, with only the value types the gateway can send. */
export type FlatBody = Record<string, JsonPrimitive>;

function describe(value: JsonValue): string {
  if (Array.isArray(value)) return 'array value (list fields are JSON strings on the wire)';
  if (typeof value === 'object' && value !== null) return 'object value';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? 'integer outside ±(2^53 − 1)'
      : 'non-integer number';
  }
  return `unrenderable ${typeof value} value`;
}

function render(value: JsonValue, key: string): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new RangeError(`${key}: ${describe(value)}`);
}

/**
 * Sorting is `Array.prototype.sort`, which compares UTF-16 code units. Every known key is ASCII, where that is
 * the same order as code points and as UTF-8 bytes, so the four SDKs agree. `localeCompare` would not.
 */
export function canonicalize(body: Readonly<JsonObject>): string {
  return Object.keys(body)
    .filter((key) => key !== 'signature')
    .sort()
    .map((key) => render(body[key] as JsonValue, key))
    .join(':');
}

/**
 * Parse an incoming body and apply the §5 rejections, so that canonicalization cannot be handed something it
 * would have to guess about.
 *
 * `JSON.parse` rounds integers above 2^53 as it reads them, which is why the check is `Number.isSafeInteger`
 * rather than a comparison: anything larger lands on an even number beyond the safe range and fails it.
 */
export function parseSignedBody(
  text: string,
  context: { operation: Operation; source: ErrorSource; rawBody?: string },
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PrestoPayResponseError('body is not valid JSON', { ...context, cause });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PrestoPayResponseError('body is not a JSON object', context);
  }

  const body = parsed as JsonObject;
  for (const key of Object.keys(body)) {
    const value = body[key] as JsonValue;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isSafeInteger(value)) continue;
    throw new PrestoPayResponseError(`${key}: ${describe(value)}`, context);
  }
  return body;
}

/**
 * A lone surrogate encodes as U+FFFD but serializes as an escape, so the signed canonical string and the body
 * on the wire would disagree — and the gateway would reject a request the SDK thought was fine. Catch it at
 * validation, where the field name is still known.
 */
export function assertEncodable(value: string, field: string, operation: Operation): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const isHighSurrogate = code <= 0xdbff;
    const next = isHighSurrogate ? value.charCodeAt(i + 1) : Number.NaN;
    const paired = isHighSurrogate && next >= 0xdc00 && next <= 0xdfff;
    if (!paired) {
      throw new PrestoPayConfigError(
        `${field}: contains an unpaired UTF-16 surrogate at index ${i}, which cannot be encoded as UTF-8`,
        { operation, field },
      );
    }
    i += 1;
  }
}

/** Debugging aid, exported from the package: JSON text in, canonical string out. */
export function canonicalizeText(text: string): string {
  return canonicalize(
    parseSignedBody(text, { operation: 'config', source: 'response' }),
  );
}
