/**
 * `fromEnv`, js-plan.md §4 / §8: reads the four `PRESTOPAY_*` variables into a `PrestoPayOptions`. Works with
 * `process.env`, a Workers `env` binding, or Vercel's env object — anything shaped like a string record.
 */
import { PrestoPayConfigError } from './errors.js';
import type { Environment, PrestoPayOptions } from './client.js';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

function requireVar(env: EnvRecord, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrestoPayConfigError(`${name}: required environment variable is missing`, {
      operation: 'config',
      field: name,
    });
  }
  return value;
}

function resolveEnvironment(env: EnvRecord): Environment {
  const baseUrl = env.PRESTOPAY_BASE_URL;
  if (typeof baseUrl === 'string' && baseUrl.length > 0) return { baseUrl };

  const name = env.PRESTOPAY_ENV;
  if (name === 'staging' || name === 'production') return name;

  throw new PrestoPayConfigError(
    'PRESTOPAY_ENV or PRESTOPAY_BASE_URL: required (expected "staging", "production", or a URL)',
    { operation: 'config', field: 'PRESTOPAY_ENV' },
  );
}

/**
 * Returns the options that came from the environment; merge in `fetch`, `now`, `strict` and the rest
 * programmatically — `createPrestoPay({ ...fromEnv(process.env), strict: true })`.
 */
export function fromEnv(env: EnvRecord): PrestoPayOptions {
  return {
    environment: resolveEnvironment(env),
    merchantId: requireVar(env, 'PRESTOPAY_MID'),
    privateKey: requireVar(env, 'PRESTOPAY_PRIVATE_KEY'),
    prestoPublicKey: requireVar(env, 'PRESTOPAY_PUBLIC_KEY'),
  };
}
