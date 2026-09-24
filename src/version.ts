/**
 * Kept in sync with package.json by a test (test/package.test.ts), not by reading the file at runtime —
 * `resolveJsonModule` is off in the build tsconfig and this must work with zero dependencies on every runtime.
 */
export const SDK_VERSION = '0.0.0-dev.0';
