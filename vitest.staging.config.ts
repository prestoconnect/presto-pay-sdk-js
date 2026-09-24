import { defineConfig } from 'vitest/config';

/**
 * `npm run test:staging`, a live call against Presto's real staging gateway. Kept out of the
 * default vitest.config.ts (which excludes test/staging/**) so it can never run as a side effect of `npm test`
 * or an unrelated `vitest run <pattern>`; the suite itself also no-ops unless PRESTOPAY_STAGING_SMOKE=1.
 */
export default defineConfig({
  test: {
    include: ['test/staging/**/*.test.ts'],
  },
});
