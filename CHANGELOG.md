# Changelog

All notable changes to this project are documented in this file.

## Unreleased

Everything below is pre-1.0 groundwork; nothing has been published to npm yet.

### Added

- Wire-core primitives: canonicalization, gateway timestamps (fixed UTC+08:00), PEM/DER parsing, Web Crypto
  RSASSA-PKCS1-v1_5/SHA-256 sign and verify.
- The send path: whole-call deadline, jittered `retryReads` backoff, and the `requestNotSent` connect-phase
  allowlist, proven against real sockets (closed port, unresolvable host, reset-after-body-sent, deadline abort).
- The four payment operations (`init`, `query`, `reverse`, `refund`): request validation, `toWire` mapping,
  response mapping (including the stringified-array round trip and the `""`/`null` equivalence), and the
  §3.6 response-handling order with `mayHaveTakenEffect` / `reconcileBy` stamped per operation.
- Webhook verification (`createWebhookVerifier`, `presto.webhooks.verify`), `NotifyAck`, and `fromEnv`.
- `1005` business errors now report the observed clock offset between the request and response timestamps
  (`PrestoPayApiError.clockOffsetMs`).
- `spec/` vendored locally (wire-contract.md, vectors, throwaway test keys, and the real Presto staging
  certificate) as a stand-in for the eventual `presto-pay-spec` submodule.
- Test infrastructure: vector-driven and unit tests on Node, a workerd smoke suite via
  `@cloudflare/vitest-pool-workers`, a custom `@edge-runtime/vm`-backed environment for the edge-runtime leg
  (no maintained `vitest-environment-edge-runtime` package exists on npm), package hygiene checks (`publint`,
  `attw --profile esm-only`, export-condition resolution against both Node and a real bundler resolver via
  esbuild, and a gzipped bundle-size budget), and a staging smoke suite gated behind
  `PRESTOPAY_STAGING_SMOKE=1`.

### Known gaps before 0.1.0

- PKCS#12 private-key import, encrypted PEM on Node, and a Bun/Deno support statement are explicitly deferred
  (js-plan.md §12, "later").
- `presto-pay-spec` is not yet a real, independently-versioned repository; `spec/` here is a local stand-in.
- CI (the Node 22/24/26 matrix, running the workerd/edge-runtime suites on every push) is not wired up yet —
  the scripts exist and pass locally (`npm run check`), but nothing runs them automatically.
