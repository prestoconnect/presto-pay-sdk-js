import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * The workerd test leg: proves the core actually runs under Cloudflare's runtime, not just Node.
 * A separate config (not a `projects` entry in vitest.config.ts) because vitest-pool-workers owns the whole
 * pool/environment for its project and does not compose with the default node project in one config file.
 */
export default defineWorkersConfig({
  test: {
    include: ['test/platform/platform-smoke.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.workers-test.toml' },
      },
    },
  },
});
