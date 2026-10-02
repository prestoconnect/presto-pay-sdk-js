# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Changed

- Webhook guidance now guards on the order record instead of deduplicating on `eventRefNum`: the handler
  queries the payment on every delivery and applies its status with a conditional update that finalises an
  order only once and fulfils only on the change into `Authorised`. Updated the README, `docs/webhooks.md`,
  `docs/production.md`, the `eventRefNum` doc comment, and the `my-store` sample, whose return page and webhook
  now share one guarded update.

### Added

- New `docs/payment-methods.md`, linked from the README: every payment method code with its SDK constant,
  a note that Presto enables payment methods per merchant during onboarding, which methods need a Presto
  account (the PrestoPay eWallet and Credits, `Card` and the loyalty programmes), which are legacy
  (`TouchNGo`, `BigLife`), and how to pass a code the SDK doesn't list yet.

## 0.2.2 - 2026-10-01

Documentation only; no change to the SDK's behaviour.

### Changed

- The README's key-pair command makes the merchant certificate valid for 99999 days, so it doesn't expire and
  need registering with Presto again.
- The README's `init` example uses `PaymentMethod.PmPgCard` as the card method for a merchant's own payment
  selection page.

## 0.2.1 - 2026-10-01

### Fixed

- Passing Presto's DER certificate as a Node `Buffer`, for example straight from `readFileSync`, failed with
  "the certificate could not be imported as an RSA public key". A small `Buffer` is usually a view into Node's
  shared memory pool, and `Buffer.slice()` returns another view rather than a copy, so Web Crypto was handed the
  whole pool. The key bytes are now copied out exactly.

### Changed

- The README is now a getting-started guide: creating your key pair and sending Presto the `.der` public key,
  how a payment flows, a four-step quick start and a payment status table. Reference material moved to
  `docs/` (payments and errors, webhooks, production), and `docs/production.md` shows how to convert Presto's
  `.der` certificate to PEM for `PRESTOPAY_PUBLIC_KEY`.
- The MyStore sample answers HTTP 401 to a webhook that fails with a `PrestoPaySignatureError`, instead of
  acknowledging it.
- The private-key error hints no longer assume the key came from an onboarding keystore.

## 0.2.0 - 2026-10-01

### Changed

- **Breaking:** `WebhookEvent.paymentStatus` is removed. A webhook reports what happened (`eventCode`, `success`),
  not the payment's resulting status, and deriving one was guesswork: a `Refunded` or `Reversed` event with
  `success: false` is a refund or reversal that failed, leaving the payment in its previous status, which the event
  does not carry. Call `payments.query` for the current status. This follows the shared wire contract.
- The MyStore sample queries the payment in its webhook route and lists the returned status, marking
  `eventRefNum` as seen only after the query succeeds.

### Fixed

- `NotifyAck.forError` answered `ok` for any `PrestoPaySignatureError` or `PrestoPayResponseError`, including ones
  from a `query` made inside the webhook handler, which told Presto to stop redelivering an event the handler never
  processed. It now answers `ok` only for errors whose `source` is `'webhook'`.

## 0.1.0 - 2026-09-25

First published release.

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
- `spec/` vectors and throwaway test keys are kept locally for contract testing. Real Presto staging credentials
  are supplied externally.
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

### Known limitations

- PKCS#12 private-key import, encrypted PEM on Node, and a Bun/Deno support statement are explicitly deferred
  to a later milestone.
- `presto-pay-spec` remains an independent repository; this SDK keeps only the vectors and fixtures needed for
  its own tests rather than using a submodule checkout.
