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
- `spec/` vendored locally (wire-contract.md, vectors, and throwaway test keys) as a plain copy of
  `presto-pay-spec`, not a git submodule. Real Presto staging credentials are supplied externally.
- Test infrastructure: vector-driven and unit tests on Node, a workerd smoke suite via
  `@cloudflare/vitest-pool-workers`, a custom `@edge-runtime/vm`-backed environment for the edge-runtime leg
  (no maintained `vitest-environment-edge-runtime` package exists on npm), package hygiene checks (`publint`,
  `attw --profile esm-only`, export-condition resolution against both Node and a real bundler resolver via
  esbuild, and a gzipped bundle-size budget), and a staging smoke suite gated behind
  `PRESTOPAY_STAGING_SMOKE=1`.
- CI (`.github/workflows/ci.yml`) on push and PR: one `checks` job (typecheck, the workerd/edge-runtime suites,
  and package hygiene) on a single modern Node, plus a `test-node` job matrixed across Node 18.20, 20, 22, 24
  and 26 running only the plain Node test project. The split matters, not just for CI minutes: the workerd/edge
  suites run inside simulated runtimes regardless of host Node, and some of that tooling — miniflare's `undici`
  (`engines.node: ">=20.18.1"`) and `@arethetypeswrong/cli` (`engines.node: ">=20"`) — doesn't run on Node 18.20
  at all, so folding them into the 18.20 leg would silently skip or break the tooling meant to verify that leg,
  not exercise the SDK. `vite` is separately pinned to `^6.4.3` via a package.json `overrides` entry so vitest
  itself (which the 18.20 leg does need, for `test:node`) can still run there — vitest 3's own default resolves
  the vite 7 line, which dropped Node 18 support (`engines.node: "^20.19.0 || >=22.12.0"`).
  `.github/workflows/release.yml` publishes to npm with provenance on a `v*` tag.
- Support floor lowered to **Node 18.20+** (was 22.12+). Verified end-to-end on Node 18.20.5: signing,
  verification, and the full send path all work, since Node 18's Web Crypto and `fetch` globals are present by
  its final LTS patch. The one real gap is that Node 18 only exposes global `crypto` on the main thread, not
  inside `worker_threads` Workers or forked child processes — `subtle()` now names this in its error message,
  and the vitest Node project backfills the global in a test-only setup file
  (`test/setup/node18-crypto-polyfill.ts`) since vitest isolates each test file that way.

### Known gaps before 0.1.0

- PKCS#12 private-key import, encrypted PEM on Node, and a Bun/Deno support statement are explicitly deferred
  to a later milestone.
- `presto-pay-spec` is a real, independent repository now, but `spec/` here stays a plain vendored copy rather
  than a git submodule; each SDK repo copies the wire contract and vectors it needs instead of sharing a
  submodule checkout.
- No version has been tagged and nothing has been published to npm yet; `package.json` is still
  `0.0.0-dev.0`. `.github/workflows/release.yml` publishes with provenance on a `v*` tag once `NPM_TOKEN` is
  configured as a repository secret under the `npm` environment.
