import { describe, it, expect } from 'vitest';
import { assertEncodable, canonicalizeText, parseSignedBody } from '../../src/internal/canonical.js';
import { PrestoPayConfigError, PrestoPayResponseError } from '../../src/errors.js';

describe('assertEncodable', () => {
  it('accepts ordinary strings and valid surrogate pairs', () => {
    expect(() => assertEncodable('hello', 'displayDesc', 'init')).not.toThrow();
    expect(() => assertEncodable('😀', 'displayDesc', 'init')).not.toThrow(); // 😀
  });

  it('rejects a lone high surrogate', () => {
    expect(() => assertEncodable('\ud800', 'displayDesc', 'init')).toThrow(PrestoPayConfigError);
  });

  it('rejects a lone low surrogate', () => {
    expect(() => assertEncodable('\udc00', 'displayDesc', 'init')).toThrow(PrestoPayConfigError);
  });
});

describe('parseSignedBody', () => {
  const ctx = { operation: 'init' as const, source: 'response' as const };

  it('parses a flat object', () => {
    expect(parseSignedBody('{"a":1,"b":"x"}', ctx)).toEqual({ a: 1, b: 'x' });
  });

  it('rejects invalid JSON', () => {
    expect(() => parseSignedBody('{not json', ctx)).toThrow(PrestoPayResponseError);
  });

  it('rejects a JSON array at the top level', () => {
    expect(() => parseSignedBody('[1,2,3]', ctx)).toThrow(PrestoPayResponseError);
  });

  it('rejects an unsafe integer', () => {
    expect(() => parseSignedBody('{"amount":99999999999999999}', ctx)).toThrow(PrestoPayResponseError);
  });

  it('rejects a nested object value', () => {
    expect(() => parseSignedBody('{"a":{"b":1}}', ctx)).toThrow(PrestoPayResponseError);
  });
});

describe('canonicalizeText', () => {
  it('parses then canonicalizes in one step', () => {
    expect(canonicalizeText('{"b":1,"a":"x"}')).toBe('x:1');
  });
});
