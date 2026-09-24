import { defineConfig } from 'vitest/config';

/**
 * The edge-runtime test leg. See test/edge/edge-runtime-environment.ts for why this is a custom
 * environment rather than the "edge-runtime" built-in name (that name resolves to a package that doesn't exist).
 */
export default defineConfig({
  test: {
    include: ['test/platform/platform-smoke.test.ts'],
    environment: './test/edge/edge-runtime-environment.ts',
  },
});
