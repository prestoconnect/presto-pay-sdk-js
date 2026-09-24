/**
 * Kept in sync with package.json by a test (test/package.test.ts), not by reading the file at runtime —
 * `resolveJsonModule` is off in the build tsconfig and this must work with zero dependencies on every runtime.
 */
export const SDK_VERSION = '0.0.0-dev.0';

/** js-plan.md §3.1: `presto-pay-sdk-js/<version>`, SDK policy rather than a gateway requirement. */
export const USER_AGENT = `presto-pay-sdk-js/${SDK_VERSION}`;
