/**
 * Resolved by the `browser` export condition. Refusing browsers is deliberate: the private
 * key must never reach one. This condition is ordered *after* the runtime-specific ones in package.json, because
 * `browser` is not browser-only in practice — Vite- and webpack-based Worker builds often resolve it too, and a
 * legitimate Workers user must never land here.
 */
throw new Error(
  '@prestouniverse/presto-pay-sdk is server-only and refuses to run in a browser: it holds your merchant ' +
    'private key, which must never reach client-side code. If this was resolved from a Cloudflare Workers or ' +
    'edge build, your bundler is picking the "browser" export condition ahead of "workerd" / "edge-light" — ' +
    'check its condition order.',
);
