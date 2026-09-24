# Plan: Presto Pay SDK for JavaScript / TypeScript

Status: proposal, pre-implementation. This document is self-contained: it defines the gateway contract (§3), the
SDK's API and implementation, and how the two are tested.

## 1. Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Repository | `presto-pay-sdk-js`. The wire contract (built from §3) and the test vectors live in `presto-pay-spec` and are vendored here as a submodule at `spec/`, because four SDKs now implement the same contract (§9) |
| 2 | Package | `@prestouniverse/presto-pay-sdk` on npm, **ESM only** (Node 22.12+ can `require()` ESM) |
| 3 | Runtimes (0.1.0) | Node **22.12+** (22, 24, 26 in CI), Cloudflare Workers, Vercel Edge. Bun and Deno: best effort, not in the 0.1.0 support statement |
| 4 | Web platform only | Core uses `fetch`, `crypto.subtle`, `TextEncoder` / `TextDecoder`, `atob` / `btoa`, `AbortSignal`. No `node:` imports, no `Buffer`, one build |
| 5 | Keys | Private key: unencrypted **PKCS#8 PEM**. Presto key: X.509 certificate (PEM or DER) or SPKI PEM. No PKCS#12, PKCS#1 or encrypted PEM in 0.1.0 |
| 6 | Dependencies | Zero runtime dependencies. TypeScript `strict` |
| 7 | Browsers | Refused: the `browser` export condition resolves to a module that throws. The private key must never reach a browser |

## 2. Goals and non-goals

**Goals**

- The four payment operations (`init`, `query`, `reverse`, `refund`), webhook verification, and key import.
- An API that feels native in TypeScript and in fetch-style servers (Workers, Next.js route handlers, Hono,
  Express 5).
- Safe by default: no retries of `init`, `reverse` or `refund` unless the request certainly was not sent; webhook
  `mid` check and replay window on; a helper that says when an error means "the operation may have happened".

**Non-goals (0.1.0)**

- Browsers, PKCS#12, framework plugins.

## 3. Gateway contract

Tags say how well each rule is established:

| Tag | Meaning |
|-----|---------|
| **[C]** | Confirmed: in Presto's worked example, a body captured from Presto, or exercised against staging |
| **[U]** | Unconfirmed: believed to be gateway behavior; implement it, and ask Presto (§13) |
| **[P]** | SDK policy, not required by the gateway |

When Presto answers a question in §13, update the tag, this section, and the vectors.

### 3.1 Transport

- HTTPS `POST`, one JSON object per request and per response. Body bytes are UTF-8. **[C]**
- Base URLs: staging `https://presto-stg-ext.enovax.com`, production `https://pay-ext.prestouniverse.com`. **[C]**
- Header `Content-Type: application/json; charset=UTF-8` **[C]**; a `User-Agent` of
  `presto-pay-sdk-js/<version>` **[P]**. Redirects are not followed **[P]**.

| Operation | Path | Safe to resend |
|-----------|------|----------------|
| init | `/v1/ext/payment/init` | No |
| query | `/v1/ext/payment/query` | Yes (read-only) |
| reverse | `/v1/ext/payment/reverse` | No |
| refund | `/v1/ext/payment/refund` | No |

Paths **[C]**; resend safety **[C]** for init, which creates a record that a resend collides with as `1203`
(§3.9), **[U]** for reverse and refund, which are treated the same way for want of evidence otherwise.

### 3.2 Common request fields

| Field | Value |
|-------|-------|
| `mid` | Merchant ID, one per client configuration **[C]** |
| `prestoMrn` | Presto merchant reference; one `mid` can have several, so it is chosen per request **[C]** |
| `ts` | Request timestamp (§3.3), fresh for every attempt **[C]** |
| `signature` | Signature over all other fields (§3.4) **[C]** |

Optional fields that are not set are **omitted**, never sent as `null` **[P]**. The gateway sends nulls and
canonicalizes them as the empty string (§3.4), so either form would verify; omitting keeps outgoing bodies to one
shape per request.

### 3.3 Timestamps

- Format `yyyyMMddHHmmss.SSS`, for example `20250423104500.000`, always at the fixed offset **UTC+08:00**
  regardless of the host time zone. **[C]**
- The validity window is **15 minutes**; a request `ts` outside it fails with error `1005`. **[C]**
- `sessionValidity` on init uses the same format **[U]**.
- A host with a skewed clock fails every request with `1005` and has no way to find out why, so the SDK compares
  its own `ts` with the `ts` on each response and reports the observed offset, against the 15-minute window, in
  the `1005` error message. **[P]**

### 3.4 Signatures

**Canonical string**, from a flat JSON object:

1. Take every key except `signature`. **[C]**
2. Sort keys by UTF-16 code unit order (default `Array.prototype.sort`, never `localeCompare`). **[C]** for ASCII
   keys, which is all known keys.
3. Render each value:

   | JSON value | Rendering |
   |------------|-----------|
   | string | the decoded string as-is, no quoting or escaping **[C]** |
   | integer | decimal, no leading zeros, `-` for negatives. Presto confirms numbers are always integers within 2^31 (§13 round 1, answer 1) **[C]** |
   | `true` / `false` | `true` / `false` **[C]** |
   | `null` | empty string, so a null is indistinguishable from `""` and keeps its separator **[C]** |
   | array, object, non-integer number | cannot occur on the wire: list fields are always JSON **strings** (§3.5, §13 round 1, answer 3) and numbers are always integers. Reject the body **[C]** |

4. Join with `:`. Values are not escaped, so `:` inside a value is ambiguous by design. **[C]** A present key with
   an empty value keeps its separator (`x::y`); an absent key contributes nothing.

Worked example from Presto **[C]**:

```json
{"mid":"PW2401XH9KCX","prestoMrn":"PM240110XDSFC","txnType":"WebPay","txnRefNum":"TXN10001",
 "displayDesc":"Order #12345","amount":1200,"currencyCode":"MYR",
 "notifyUrl":"https://merchant.example.com/webhook/notify",
 "redirectUrl":"https://merchant.example.com/redirect/TXN10001","ts":"20250423104500.000"}
```

```text
1200:MYR:Order #12345:PW2401XH9KCX:https://merchant.example.com/webhook/notify:PM240110XDSFC:https://merchant.example.com/redirect/TXN10001:20250423104500.000:TXN10001:WebPay
```

Business-error response captured from Presto **[C]**:

```json
{"success":false,"ts":"20260924124938.038","errorCode":"1201","errorMessage":"Invalid input.","signature":"ORzXBr6JLqKR1LmOkbhL/ksH83GEUEgO7kPKzEAOKNhv2DlHnxobx1B705ZMdqQWGc9DMQp/e1HX8ATPJMq5Lpar89fqvAu6va2zNq5t/GcuwMJ3I/wRU++KpYujjWdQsaLhlBfgn/wjR4tq8MbMVqAPNKHlUSQ4iCpgf2eEa55QhIaXbBIH4UX64PHQfZ/2G4fSeGaObn5T06HBSPSUht5itzXe2dLA2/cuycsu+NoDXXKLZFh3+ON5s/UH9dmUlmoXZzYtsmhKhERBkstrrMfqZDaXpkMIDhHE7wPz4LjLeMocnkEh0wMo7SrQd3yKhf1b8Z+U85OdGJMtySkAFg=="}
```

```text
1201:Invalid input.:false:20260924124938.038
```

**That signature verifies** against Presto's staging certificate (`keys/presto_ext_service_dev.der`) over those
exact bytes, which is the first end-to-end proof of the whole of §3.4 at once: key sorting, lowercase boolean
rendering, the `:` join, `RSASSA-PKCS1-v1_5` with SHA-256, and standard Base64. It is the first vector in
`canonical.json`, and any implementation that disagrees with it is wrong about something.

**Successful init response captured from staging** **[C]**, the body that settles the `null` rule:

```json
{"prestoMrn":"PM181019QGJWH4K","paymentRefNum":"PP260924K4H3DSF","txnRefNum":"PM202609244E33DA4FCCC7445B99821588791F2418","paymentStatus":"PendingAuthorise","paymentUrl":"https://hpp-staging.prestouniverse.com/PM181019QGJWH4K/PP260924K4H3DSF","userRefNum":"","amount":200,"currencyCode":"MYR","paymentRequestDate":"20260924133756.056","paymentFinalisedDate":"","additionalData":null,"success":true,"ts":"20260924133756.056","errorCode":"","errorMessage":"","signature":"YdmEUMfG61ZD781X2q2K5DhJesWgUHd7Z0t5I042PbPf72sqKGHExpl80XHZkbhPv1TiOJ0VjVD3cyY4IDnk722U7tm/gaoJe/uqeCGlAySh/Po03IgDQwQvlU138ghxVjIqs0rNOpB79UXsA3OWDeztoBK5qNJTzzeTYrMT5bVqynWSZVjTECcHnbXMFZ/X07ZhUsnD7DdTKBTCTfusWYr7Csthm1m6OyOzkG0CSkupKxKV79gyfAfyh1Fj4Z7SSaFU8OuC9htbgfftgghY7fSXyyKPwOLuVwhRhhEe3X1VTNk9oC5OD1ALtfu6ry8lQ/RYJJoVJXI00q7KfoCoiw=="}
```

`additionalData` sorts first and renders as the empty string, so the canonical string opens with a bare separator:

```text
:200:MYR::::PP260924K4H3DSF:20260924133756.056:PendingAuthorise:https://hpp-staging.prestouniverse.com/PM181019QGJWH4K/PP260924K4H3DSF:PM181019QGJWH4K:true:20260924133756.056:PM202609244E33DA4FCCC7445B99821588791F2418:
```

**That signature verifies and the alternatives do not.** Rendering the null as the literal `null`, as `NULL`, or
dropping the key and its separator each produce a string Presto's signature rejects, so the rule is settled by
arithmetic rather than by anyone's reading. It is the second vector in `canonical.json`, and it is the one that
would have cost the most to get wrong: a null renders identically to `""`, so every body containing one would
have failed verification and reported an indeterminate result for a payment that had actually succeeded.

**Algorithm**

- `RSASSA-PKCS1-v1_5` with SHA-256 over the UTF-8 bytes of the canonical string; standard Base64 with padding.
  **[C]**
- Requests are signed with the merchant's private key; responses and webhooks are verified with Presto's public key.
  **[C]**
- Presto signs webhooks for **all** merchants with the same key, so a valid signature does not prove the event is
  for this merchant (§3.7). **[U]**
- A signature that is not valid Base64 is a failed verification, not a separate error. **[P]**

**What is signed must be what is sent.** The canonical string uses decoded values, so any valid JSON escaping is
fine as long as the gateway decodes the strings that were signed **[C]**. Consequences:

- Reject lone UTF-16 surrogates in outgoing strings: `TextEncoder` turns them into U+FFFD while `JSON.stringify`
  escapes them, so signature and body would disagree. **[P]**
- Send integers only. **[C]**

### 3.5 JSON rules

**Incoming bodies** **[P]**

- Must be a single JSON object; parse with `JSON.parse`. Duplicate keys resolve last-wins, and the same parsed
  object is used for verification and for field mapping, so what was verified is what the merchant reads.
- Reject integers outside `Number.isSafeInteger` before canonicalizing, rather than verifying a rounded value.
- Decode bytes as UTF-8 with U+FFFD replacement.

**Stringified arrays.** Every list field is a **JSON string that contains an array**, never a native array, in
both directions (§13 round 1, answer 3) **[C]**. They are canonicalized as ordinary strings, and parsed a second
time on input. A captured query response carrying `"refundDetails": "[]"` and `"paymentDetails": "[]"` verifies
only when each renders as the literal two characters `[]`, so this is confirmed rather than inferred, and an
empty list arrives as `"[]"` and not as `""` **[C]**. Whether such a field can be absent entirely is **[U]**, so
a missing one is read as an empty list.

| Field | Direction | Elements |
|-------|-----------|----------|
| `allowedPaymentMethods` | init request | payment method codes |
| `itemList` | init request | line items (§3.8) |
| `refundDetails` | query response | refund details (§3.8) |
| `paymentDetails` | query response, webhook | payment details (§3.8) |

The SDK takes and returns real arrays for these; the string is an encoding detail that never reaches the caller.

**Empty values on responses.** A successful response carries **every** documented field, using `""` or `null` for
the ones that have no value — the captured init response in §3.4 sends `userRefNum: ""`,
`paymentFinalisedDate: ""`, `errorCode: ""`, `errorMessage: ""` and `additionalData: null` **[C]**. **Which of
the two a field uses is not stable**: a captured query response for that same payment sends `userRefNum: null`
where init sent `""`, and mixes nine nulls with five empty strings across fields of the same kind —
`reversalStatus: null` beside `reversalDate: ""` **[C]**. So "optional" in the §3.8 response tables means
*may be empty*, not *may be absent*, the two spellings are one condition, and three rules follow:

- Those keys are in the signed body, so they are in the canonical string and must never be stripped before
  verifying. An empty value keeps its separator, which is why the §3.4 example starts with `:` and contains
  `::::`.
- Mapping normalizes `""` and `null` to `undefined` on optional fields, so a caller never feeds `""` to a date
  parser or treats an empty `errorCode` as an error. A required field that arrives empty is a malformed body.
- A business-error response is the opposite shape: the §3.4 capture carries only `success`, `ts`, `errorCode`,
  `errorMessage` and `signature`, with none of the payment fields. That is consistent — §3.6 throws at step 4,
  before the echo check at step 6 would look for a `prestoMrn` that is not there — but it does mean the two
  response shapes must be mapped separately rather than through one optional-everything type. **[P]**

### 3.6 Responses

Handle a response in this order:

1. **Status not 200:** HTTP error. The body is unsigned and not verified; details are in the `x-http-error-code`
   and `x-http-error` headers (case-insensitive), which are always set **[C]**. There is no rate limiting, so no
   429 **[C]**. The full set of statuses is not enumerated, which does not matter: every non-200 is handled the
   same way.
2. **Parse** (§3.5). Failure: malformed body.
3. **Signature:** missing or invalid is a signature error. This comes **before** `success`, because business errors
   are signed too. **[C]**
4. **`success`:** always present **[C]**. `false` is a business error with `errorCode` and `errorMessage`; absent
   or non-boolean is a malformed body. Nothing is defaulted, so the webhook side (§3.7) now reads the same way.
5. **Map fields** (§3.8). A missing required field is a malformed body. A field documented as a string always
   arrives as a string **[C]**, but a number or boolean there is still coerced to text rather than rejected,
   because rejecting an authentic body after the operation took effect helps nobody; `strict` mode (§4) rejects
   instead, so staging reports the contract violation. **[P]**
6. **Echo check:** `prestoMrn`, and `txnRefNum` where the response carries it, must equal what was signed into the
   request. A mismatch is a response error. The SDK knows what it sent, so this costs nothing and catches a
   mixed-up or replayed response. **[P]**

For `init`, `reverse` and `refund`, a status of 500 or above, or a failure at steps 2, 3, 5 or 6 after a 200, means
**the operation may have taken effect**; reconcile with `query`. The same failures on `query` mean nothing happened,
so the SDK decides this per operation at the point the error is constructed (§4, `mayHaveTakenEffect`). A
`success: false` at step 4 otherwise means nothing happened, with `1203` on init the one exception (§3.9). **[P]**

Error codes are four-digit strings and open-ended; unknown codes are passed through **[U]**. Codes the SDK relies
on:

| Code | Meaning |
|------|---------|
| `1005` | Request `ts` outside the validity window (clock skew) **[C]** |
| `1006`, `1007` | Request signature invalid or failed verification. The two do not distinguish a malformed signature from a well-formed one that failed to verify (§13 round 2, answer 6), so the SDK gives both the same message and attaches `canonical` to either **[C]** |
| `1201` | Invalid input **[C]** |
| `1203` | Duplicate `txnRefNum` on init: a payment record for that `txnRefNum` already exists, in any state including a successful one (§3.9) **[C]** |
| `1212` | Payment not found **[U]** |

Full list for the `ErrorCode` constants **[U]**:

- **Request and auth:** 1001 invalid request path, 1002 invalid content type, 1003 missing master merchant
  reference, 1004 invalid timestamp format, 1005 exceeded validity period, 1006 invalid signature, 1007 signature
  verification failed, 1008 missing authorization header, 1009 invalid authorization header, 1010 invalid access
  token, 1011 access token validation error, 1012 invalid access token ownership, 1013 OAuth resource config error,
  1014 missing OAuth scope, 1015 OAuth service unavailable.
- **Merchant:** 1100 general error, 1101 invalid input, 1102 invalid `mid`, 1103 master merchant info retrieval
  failed, 1104 master merchant info service unavailable, 1105 onboard processing failed, 1106 invalid merchant
  reference, 1107 document upload failed, 1108 missing document, 1109 record exists, 1110 profile not found, 1111
  invalid merchant txn type, 1112 file retry limit exceeded, 1113 merchant rejected.
- **Payment:** 1200 general error, 1201 invalid input, 1202 init failed, 1203 duplicate `txnRefNum`, 1204 QR value
  not recognised, 1205 QR value not bound, 1206 QR TOTP expired, 1207 QR validation failed, 1208 QR invalid TOTP
  secret, 1209 QR invalid TOTP, 1210 QR invalid prefix, 1211 QR payment suspended, 1212 payment not found, 1213
  invalid status for authorisation, 1214 authorisation general error, 1215 QR value already used, 1216 invalid user,
  1217 query access denied, 1218 query failed, 1219 invalid status for reversal, 1220 reversal not allowed (settled),
  1221 reversal grace period ended, 1222 refund to account failed, 1223 reversal failed, 1224 reversal already in
  progress, 1225 invalid payment method, 1226 refund already in progress, 1227 invalid status for refund, 1228
  refund grace period ended, 1229 insufficient unsettled amount, 1230 refund failed, 1231 payment limit exceeded,
  1232 invalid session validity period, 1233 invalid session validity format, 1234 payment method mismatch, 1235
  refund amount exceeds transaction, 1236 refundable amount exceeded.
- **User:** 1400 general error, 1401 invalid user token format, 1402 user token not found, 1403 user reference
  retrieval failed, 1404 user profile retrieval failed, 1405 user info retrieval failed.

### 3.7 Webhooks (notify)

**Delivery.** Presto POSTs a signed JSON body to the `notifyUrl` given on init, reverse or refund; the URL must be
publicly reachable **[C]**. The merchant replies HTTP 200 with `{"resend":false}` (accepted) or `{"resend":true}`
(ask Presto to resend) **[C]**. Presto retries on its own backoff of **1, 2, 5 and 10 minutes** after the first
attempt — five deliveries over roughly 18 minutes — and the client does not manage it **[C]**.

**Retries make the merchant's handler idempotent by necessity**, and they interact with the freshness check
below. Three consequences the SDK has to design around:

- **A permanent failure must not be answered with `{"resend":true}`.** A bad signature, a `mid` that is not ours
  or a stale `ts` will fail identically on every redelivery, so asking for a resend builds a loop that only ends
  when Presto gives up. `resend:true` is for transient merchant-side failures — the database was down — and
  `NotifyAck.forError(error)` encodes exactly that split. **[P]**
- **The freshness window is 15 minutes,** the same as request timestamps (§3.3). A redelivery carries a fresh
  `ts` **[C]**, so the last attempt of the schedule above is timestamped when it is sent, not when the event
  happened, and a legitimate redelivery never looks stale. The window is configurable for hosts that queue
  notifications before verifying them. **[P]**
- **`eventRefNum` is stable across redeliveries of the same event** **[C]**, so it is the deduplication key, and the
  ~18-minute schedule sizes the retention: anything that outlives it by a comfortable margin is enough. The SDK
  surfaces `eventRefNum` on every verified event and the README makes dedupe the default handler shape, since a
  merchant that fulfils on each delivery double-fulfils up to five times. **[P]**

**Verification**, in order:

1. Parse the **raw body** (never a re-serialized framework object) per §3.5.
2. Signature present and valid, otherwise a signature error.
3. Map fields (§3.8). `success` is always present **[C]**, on webhooks as on responses; absent is a malformed
   body. Nothing is defaulted in either direction.
4. `mid` must be one of the configured merchant IDs, otherwise a signature error **[P]**. This is mandatory, not
   defensive: Presto confirms one key signs for every merchant (§13 round 1, answer 10), so the signature alone says
   nothing about who the event is for. One endpoint serving several `mid`s is a normal deployment for the same
   reason, so the verifier takes a set and reports which one matched.
5. Freshness: reject if `|now − ts|` exceeds the window (default 15 min, configurable), in either direction, as a
   signature error; a malformed `ts` is a malformed body. The error message carries both timestamps and the
   configured window, since a skewed clock or a slow queue makes this the first check anyone trips. Widening or
   disabling the check is allowed only if the merchant deduplicates by `eventRefNum`. **[P]**

Event codes (open-ended) **[U]**: `Authorised`, `Cancelled`, `Reversed`, `Refunded`, `Expired`. For `Authorised`,
`success` says whether authorisation succeeded, so the suggested payment status is `Authorised` or `Failed`; for
other codes the event code is the status. `query` remains the authoritative source of payment state.

### 3.8 Operation fields

All **[U]** unless noted. Amounts are integers in minor currency units **[C]**.

**The lengths below are documented maxima, not gateway limits.** Presto enforces no length limit today (§13
answer 9), so hard-rejecting at `≤50` would fail requests the gateway would have accepted, and the
characters-or-bytes question is moot. The SDK carries the numbers as documentation and as `strict`-mode checks
(§4), and never rejects on length outside strict mode. **[P]**

**Requests**

- **init.** Required: `txnType`, `txnRefNum` (≤50), `displayDesc` (≤255). Optional: `qrValue`, `payerRefNum`,
  `deviceRefNum` (≤50), `deviceIp` (≤50), `itemList`, `transactionalData`, `amount` (>0), `currencyCode`,
  `notifyUrl` (≤255), `redirectUrl` (≤255), `sessionValidity`, `additionalData` (≤255), `mode` (≤50), `modeData`
  (≤1000), `allowedPaymentMethods`, `bindData`, `themeRefNum`, `receiptEmail` (≤320), `receiptName` (≤200).
  Rules: `qrValue` and `payerRefNum` are mutually exclusive; `currencyCode` is required with `amount`;
  `redirectUrl` is required when `txnType` is `WebPay`.
- **Line item** (in `itemList`). Required: `itemDesc`, `quantity` (>0), `unitAmount`, `totalAmount`. Optional:
  `imageUrl`, `itemUrl`, `category`, `categoryDesc`, `supplier`, `supplierDesc`, `supplierUrl`.
- **query.** `paymentRefNum` or `txnRefNum` (at least one).
- **reverse.** Required: `reversalRefNum` (≤50) and one of `paymentRefNum` / `txnRefNum`. Optional: `remark`
  (≤200), `notifyUrl` (≤255).
- **refund.** Required: `paymentRefNum`, `refundRefNum` (≤50), `remark` (≤200). Optional: `notifyUrl` (≤255),
  `amount` (>0; omit for a full refund).

**Responses.** Every response also carries `prestoMrn`, `success`, `ts`, `errorCode`, `errorMessage` and
`signature`; on a successful call `errorCode` and `errorMessage` are present and empty **[C]**, so their presence
never signals an error — only `success: false` does. * marks fields that must be non-empty, per §3.5.

| Operation | Fields |
|-----------|--------|
| init | `paymentRefNum`*, `paymentStatus`*, `txnRefNum`, `paymentUrl`, `userRefNum`, `amount`, `currencyCode`, `paymentRequestDate`, `paymentFinalisedDate`, `additionalData` |
| query | `paymentRefNum`*, `txnRefNum`, `userRefNum`, `paymentStatus`, `amount`, `currencyCode`, `paymentRequestDate`, `paymentFinalisedDate`, `reversalRefNum`, `prestoReversalRefNum`, `reversalStatus`, `reversalDate`, `refundRefNum`, `prestoRefundRefNum`, `refundStatus`, `refundRequestDate`, `refundFinalisedDate`, `additionalData`, `refundDetails`, `paymentDetails` |
| reverse | `paymentRefNum`*, `prestoReversalRefNum`, `amount`, `currencyCode`, `paymentStatus` |
| refund | `paymentRefNum`*, `prestoRefundRefNum`, `amount` (original payment), `refundAmount`, `currencyCode`, `paymentStatus`, `refundedDate` |

- **Refund detail:** `refundRefNum`*, `prestoRefundRefNum`*, `refundStatus`*, `refundRequestDate`*,
  `refundFinalisedDate`.
- **Payment detail:** `amount`* (integer), `method`, `cardBin`, `cardSummary`, `cardType`, `refNum`.
- **Webhook:** required `eventCode`, `mid`, `prestoMrn`, `paymentRefNum`, `txnRefNum`, `eventRefNum`, `eventTs`,
  `amount`, `currencyCode`, `ts`, `success` (§13 round 1, answer 5); optional `userRefNum`, `additionalData`,
  `paymentDetails`.

Date fields other than `ts` use the same `yyyyMMddHHmmss.SSS` at UTC+8 as `ts` — the captured response in §3.4
sends `paymentRequestDate: "20260924133756.056"` **[C]** — and are passed through as strings, since only some of
them are confirmed and an unparseable date should not fail an authentic response. `parseGatewayTimestamp` (§4) is
the supported way to read them.

`paymentUrl` is served from a different host than the API (`hpp-staging.prestouniverse.com`, not the
`presto-stg-ext.enovax.com` base URL) **[C]**, so nothing may assume it shares an origin with the gateway.

**Code lists** (open-ended; unknown values pass through as strings) **[U]**:

- Payment status: `PendingAuthorise`, `Cancelled`, `Authorised`, `Failed`, `PendingReverse`, `Reversed`,
  `PendingRefund`, `PartialRefunded`, `Refunded`, `Expired`.
- Reversal status: `Reversing`, `Failed`, `Success`. Refund status: `Refunding`, `Failed`, `Success`.
- Transaction type: `QrPay`, `WebPay`, `MiniAppPay`.
- Payment method (`Wallet` **[C]**): `Wallet`, `CashBack`, `Card`, `BigLife`, `BonusLink`, `RISE`, `PlusMiles`,
  `VSing`, `KLEAN`, `GOrewards`, `Subwallet_NearU`, `Subwallet_CARROTS`, `Subwallet_BUDDY`, `TuneTalk`,
  `PmPgCard`, `Maybank`, `Ambank`, `Rhb`, `HongLeong`, `Cimb`, `PublicBank`, `AffinBank`, `Bsn`, `AllianceBank`,
  `AgroBank`, `BankIslam`, `BankOfChina`, `BankRakyat`, `BankMuamalat`, `BoostBank`, `HsbcBank`,
  `KuwaitFinanceHouse`, `OcbcBank`, `AlRajhiBank`, `StandardChartered`, `UobBank`, `MbsbBank`, `HongLeongPex`,
  `UnionPay`, `UnionPayQR`, `Boost`, `GrabPay`, `GrabPayLater`, `WeChatPayChina`, `TouchNGo`, `TouchNGoEWallet`,
  `AliPayChina`, `LatitudePay`, `ApplePay`, `GooglePay`, `DuitNowQR`.

### 3.9 Idempotency and retries

- `init`, `reverse` and `refund` must not be resent once any byte may have reached the gateway; resending `init`
  with the same `txnRefNum` returns `1203`, which means a payment record for it exists — possibly an authorised
  one. **[C]**
- They may be retried only when the request certainly never left the process (DNS failure, connection refused,
  connect or TLS failure before the body was written). When unsure, do not retry. **[P]**
- `query` may be retried on transport errors and on statuses of 500 and above. **[P]**
- Every attempt gets a fresh `ts` and signature **[C]** (a stale `ts` fails with `1005`).
- After an ambiguous failure, look the transaction up with `query`: by `txnRefNum` after init, by `paymentRefNum`
  after reverse or refund. **[P]**
- `1203` says a record exists but not what state it is in, so it is a `query` prompt rather than an answer: the
  SDK stamps `mayHaveTakenEffect: true` and `reconcileBy: { txnRefNum }` on that business error and says in the
  message that the earlier init reached the gateway. Treating it as "the payment succeeded" would fulfil orders
  whose init was rejected downstream. **[P]**

### 3.10 Keys

- Merchant private key: RSA, delivered at onboarding as a PKCS#12 keystore. **[C]**
- Presto public key: RSA, delivered as an X.509 certificate (PEM or DER). **[C]**
- One Presto key signs responses and webhooks for all merchants, and rotations are announced to partners out of
  band **[C]**. There is no `kid` on the wire, so an overlap period means holding both keys and trying each:
  `prestoPublicKey` takes an array (§4).

## 4. API

```ts
import { createPrestoPay, TxnType, PaymentMethod, NotifyAck, isPrestoPayError } from '@prestouniverse/presto-pay-sdk';

const presto = createPrestoPay({
  environment: 'staging',                 // 'staging' | 'production' | { baseUrl: 'https://...' }
  merchantId: env.PRESTOPAY_MID,
  privateKey: env.PRESTOPAY_PRIVATE_KEY,  // PKCS#8 PEM text, or a key from importPrivateKey()
  prestoPublicKey: env.PRESTOPAY_PUBLIC_KEY,   // one PEM, or an array during a key rotation
  // deadlineMs: 30_000,                          // whole call, retries included
  // retryReads: { maxRetries: 2, initialBackoffMs: 200, maxBackoffMs: 5_000, jitter: true },
  // webhooks: { maxTimestampAgeMs: 15 * 60_000 },  // redeliveries carry a fresh ts, see §3.7
  // strict: false, redactErrorBodies: true,
  // fetch: customFetch, now: () => Date.now(),
});

const payment = await presto.payments.init({
  prestoMrn: 'YOUR_PRESTO_MRN',
  txnType: TxnType.WebPay,
  txnRefNum: 'order-123',
  displayDesc: 'Order 123',
  amount: 10_000,
  currencyCode: 'MYR',
  notifyUrl: 'https://your-app.example/presto/notify',
  redirectUrl: 'https://your-app.example/presto/return',
  allowedPaymentMethods: [PaymentMethod.Wallet],
  // itemList: [...], sessionValidity: new Date(...)
}, { signal });
payment.paymentUrl;

// Webhook: pass the Request itself; the SDK reads the raw body.
const event = await presto.webhooks.verify(request);   // also accepts string | Uint8Array
return new Response(NotifyAck.ok, { headers: { 'content-type': 'application/json' } });
```

Every request takes `prestoMrn`, because one `mid` can have several (§3.2). To serve several merchants, create one
client per `mid`.

| Choice | Reason |
|--------|--------|
| `createPrestoPay()` factory, synchronous | Works as a module-level singleton and per request in Workers. PEM structure is checked synchronously; the Web Crypto import runs on first use and is cached |
| Plain option objects, validated on call | Idiomatic in TypeScript; validation errors name the field |
| **Wire field names on the way in and on the way out** | Not two renames to memorize among sixteen passthrough fields. The §3.8 tables are the input reference as well as the output one, and `JSON.stringify(result)` is useful in logs. Stringified arrays become real arrays; `Date` is accepted for `sessionValidity` |
| `prestoPublicKey` accepts an array | Rotation has no `kid` on the wire (§3.4), so overlapping keys must be tried in turn. Additive now, breaking after 0.1.0 |
| `webhooks.verify(request)` accepts a `Request` | Removes the most common webhook bug (verifying a re-serialized body). Express users pass `req.body` from `express.raw()` |
| `fromEnv(env)` takes a record | Works with `process.env`, Workers `env` bindings and Vercel env |
| No transport interface; optional `fetch` | A wrapped `fetch` covers proxies (undici `dispatcher`), logging and tracing |
| `strict: true` | Presto has confirmed rules the SDK still tolerates violations of — string fields are always strings, numbers are always integers — and enforces length maxima it does not itself enforce. Strict mode rejects instead of coercing and applies the documented lengths, so staging (§11) reports contract drift while production stays lenient |

**Escape hatch.** `presto.raw.post(path, body)` signs, sends, verifies and returns the parsed object, and
`sign(canonicalString)` / `verifyBody(body)` are exported. Error codes are open-ended and the gateway will grow
endpoints faster than the SDK; this turns "not supported yet" into three lines of user code instead of a fork.

Other exports: `createWebhookVerifier()`, `importPrivateKey(pem)`, `importPrestoPublicKey(pemOrDer)`,
`canonicalize(jsonText)` (signature debugging), `formatGatewayTimestamp(date)`, `parseGatewayTimestamp(ts)`
(§3.8 passes `paymentFinalisedDate` and friends through as strings, so the inverse is needed as much as the
forward direction), `fromEnv(env)`, `isPrestoPayError(value)`, `mayHaveSucceeded(error)`, constants, error classes,
`SDK_VERSION`.

### Constants

The code lists from §3.8 as frozen objects **whose keys are the wire values verbatim** — `Authorised`, not
`AUTHORISED`; `WebPay`, not `WEB_PAY`. Nothing in TypeScript style asks for upper case here, so the gateway's
vocabulary survives into the identifier for free, and a test asserts key equals value for every entry. The
Python and PHP SDKs cannot follow suit — PEP 8 and PSR-1 both require upper case — so they carry the spelling
in the value only; the values are identical in all four. `ErrorCode` is the one exception, mapping descriptive
names to the four-digit codes, because `1203` is not a name.

```ts
export const PaymentStatus = Object.freeze({ Authorised: 'Authorised', /* ... */ } as const);
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus] | (string & {});
```

Response fields use these types, so known values autocomplete and unknown gateway values still type-check. No
TypeScript `enum`.

### Errors

All extend `PrestoPayError` (which extends `Error`), with `name` set and `cause` preserved:

```ts
class PrestoPayError extends Error {
  readonly operation: 'init' | 'query' | 'reverse' | 'refund' | 'webhook' | 'config';
  readonly mayHaveTakenEffect: boolean;
  readonly reconcileBy?: { txnRefNum: string } | { paymentRefNum: string };
}
```

| Class | When | Extra fields |
|-------|------|--------------|
| `PrestoPayConfigError` | Invalid options or request input, including lone surrogates | `field` |
| `PrestoPayTransportError` | Network failure, timeout, abort | `requestNotSent` |
| `PrestoPayApiError` | Non-200 status (`kind: 'http'`) or `success: false` (`kind: 'business'`) | `kind`, `httpStatus`, `errorCode`, `errorMessage`, `rawBody`; `canonical` on `1006` / `1007`, and the observed clock offset on `1005` (§3.3) |
| `PrestoPaySignatureError` | Missing or invalid signature, wrong webhook `mid`, stale webhook `ts` | `source` (`'response'` or `'webhook'`), `canonical` |
| `PrestoPayResponseError` | Malformed body, missing required field, bad `ts`, echo mismatch | `source`, `rawBody` |

**`mayHaveTakenEffect` is decided where the error is thrown, not by the catcher.** Only there does the SDK still
know which operation ran, and the answer depends on it: a 500 on `init` is indeterminate, a 500 on `query` means
nothing happened. Deriving it after the fact from the error's shape, as a standalone predicate would have to,
reports every failed `query` as indeterminate. `mayHaveSucceeded(error)` stays exported as a thin guard over the
field for callers that catch `unknown`.

`reconcileBy` carries the lookup key from §3.9 — `txnRefNum` after init, `paymentRefNum` after reverse or refund —
so the recovery path is `if (e.mayHaveTakenEffect) await presto.payments.query(e.reconcileBy)` rather than the
caller re-threading request state into the catch block. This is the README pattern for `init`, `reverse` and
`refund`. A business error with `errorCode` `1203` gets the same treatment even though the call plainly failed:
the code proves an earlier init created a record, possibly an authorised one (§3.9), so it is the one
`success: false` that has to be reconciled rather than reported.

**Identity.** Errors are branded with `Symbol.for('prestopay.error')` and tested with `isPrestoPayError(value)`.
`instanceof` fails as soon as two copies of the package share a dependency tree, and it fails silently, at which
point a merchant's error handling stops catching without anything looking wrong.

**PII.** `rawBody` and `canonical` can contain `cardBin`, `cardSummary`, `receiptEmail` and `receiptName`, and
whole error objects get logged. They are redacted by default; `redactErrorBodies: false` opts in to the full text.
The README states this either way.

## 5. Implementation

The canonical string uses decoded values (§3.4), so the SDK needs no JSON parser or writer of its own:

- **Outgoing:** validate, reject lone surrogates, reject numbers that are not safe integers (the same
  `Number.isSafeInteger` bound §3.5 applies to incoming bodies, plus the `> 0` rules of §3.8), build an object
  with only the fields that are set, add `mid`, `prestoMrn`, `ts`, sign, then `JSON.stringify` and `TextEncoder`.
  Stringified arrays are `JSON.stringify(array)`.
- **Incoming:** read the bytes, decode with `TextDecoder`, `JSON.parse`, require a plain object, then apply the
  §3.4 and §3.5 rejections before canonicalizing. Read keys with `Object.keys`; `__proto__` from `JSON.parse` is an
  ordinary own property.
- **Canonical string:** `Object.keys(body).filter(k => k !== 'signature').sort()`, render per §3.4, join with `:`.
- **Timestamps:** shift epoch millis by +8 h and read the UTC fields; no `Intl`. Parsing is strict: 18 characters,
  digits only, calendar-valid.
- **Crypto:** Web Crypto `RSASSA-PKCS1-v1_5` / `SHA-256`, private key imported as non-extractable; Base64 via `atob` /
  `btoa`.
- **Certificates:** a small DER walker extracts `subjectPublicKeyInfo` from an X.509 certificate. It is the only
  hand-written parser in the package.

## 6. HTTP, retries, idempotency

One code path on every runtime: `fetch(url, { method: 'POST', redirect: 'manual', body, headers, signal })`.

- **Deadline:** `deadlineMs` (default 30 s) is the budget for the **whole call**, retries and backoff included;
  each attempt gets what is left. A per-attempt timeout with two retries is a worst case over 90 s, which outlives
  the wall clock a Vercel function or a Workers request will give you, so the caller gets killed mid-retry instead
  of getting the SDK's error. The deadline is combined with the caller's `signal` using `AbortSignal.any`;
  confirm that method's availability on the oldest `workerd` and `edge-runtime` in CI and keep a small fallback
  if it is missing.
- **Responses:** every status comes back as a response; only 200 bodies are parsed and verified (§3.6). A 3xx is
  an HTTP error (redirects are not followed) and is never retried.
- **`requestNotSent`:** `true` only for an **allowlist** of connect-phase codes on `error.cause.code`: `ENOTFOUND`,
  `EAI_AGAIN`, `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, and TLS certificate or
  handshake codes. It is also `true` when the signal was aborted before `fetch` was called. Everything else,
  including unknown codes, `ECONNRESET` and `UND_ERR_SOCKET`, is `false`. Workers and Edge report no codes, so there
  `init` / `reverse` / `refund` are effectively never retried; the README says so.
- **Proof:** a Node suite drives real sockets for each case (unresolvable host, closed port, blackholed connect, bad
  certificate, reset after the body was sent, slow headers) on every Node version in CI. A Node or undici upgrade
  that changes codes fails these tests instead of silently changing retry behavior.
- **Retry policy:** follows §3.9, and the option is named `retryReads` rather than `retry` because that is all it
  governs. `init`, `reverse` and `refund` are retried only on the connect-phase allowlist above, which on Workers
  and Edge is never; a top-level `retry: { maxRetries: 2 }` would read as "the SDK retries my payments twice",
  which is the opposite of what §3.9 spends a section establishing. Exponential backoff from `initialBackoffMs`,
  capped at `maxBackoffMs`, with full jitter on by default so a fleet does not retry in lockstep after a gateway
  blip. Presto confirms there is no rate limiting, so no 429 is expected; a `Retry-After` header is still
  honoured over the computed delay, subject to the remaining deadline, since it costs three lines. Backoff is
  interrupted by `signal` (throws a `PrestoPayTransportError` with `requestNotSent: false`).
- **Custom `fetch`:** it must not retry POSTs itself. To report "not sent", it throws an error whose `cause.code` is
  on the allowlist.

## 7. Webhooks

`presto.webhooks.verify(input)` and a standalone `createWebhookVerifier({ merchantId, prestoPublicKey, ... })` for
services that only receive webhooks. Order and outcomes follow §3.7. Given a `Request`, the SDK reads
`await request.arrayBuffer()`; a `Request` whose body was already consumed upstream throws a
`PrestoPayConfigError`, as does an already-parsed object, both pointing to `express.raw()` or `request.text()`.

`merchantId` accepts a string or a set of them, and the verified event reports which one matched. Presto signs for
all merchants with one key (§3.4), so a single endpoint receiving notifications for several `mid`s is the normal
shape, and it cannot dispatch on `mid` before verifying without doing the parse twice.

`prestoPublicKey` accepts an array for the same reason as the client (§4): during a rotation both keys must verify.

`NotifyAck.ok` and `NotifyAck.resend` are the two reply bodies, with `NotifyAck.okResponse()` and
`NotifyAck.resendResponse()` returning a ready `Response` with the right `content-type` for Workers and Next.js.
The event includes the derived `paymentStatus` (§3.7) and `eventRefNum`, which is stable across the up-to-five
deliveries of one event (§3.7) and is therefore the key the merchant deduplicates on.

`NotifyAck.forError(error)` picks the reply for a caught error, because getting this wrong loops: Presto retries
at 1, 2, 5 and 10 minutes (§3.7), so answering a bad signature, a foreign `mid` or a stale `ts` with `resend:true`
asks for four redeliveries that will fail identically. It returns `ok` for every
`PrestoPaySignatureError` and `PrestoPayResponseError` — permanent, nothing a retry fixes — and `resend` for
anything else, which is the merchant's own transient failure.

## 8. Configuration and keys

| Variable | Description |
|----------|-------------|
| `PRESTOPAY_ENV` or `PRESTOPAY_BASE_URL` | `staging` / `production`, or an explicit URL |
| `PRESTOPAY_MID` | merchant ID |
| `PRESTOPAY_PRIVATE_KEY` | PKCS#8 PEM text |
| `PRESTOPAY_PUBLIC_KEY` | Presto certificate PEM, or SPKI PEM |

Key errors are specific: an encrypted PEM, a PKCS#1 PEM or a certificate passed as the private key, a non-RSA key,
malformed Base64. Each message includes the command that fixes it:

```bash
# Onboarding .p12 -> unencrypted PKCS#8 PEM (store it in the secret manager only)
openssl pkcs12 -in partner.p12 -nocerts -nodes -out partner-key.pem
# Presto certificate DER -> PEM, if you prefer PEM
openssl x509 -inform der -in presto.der -out presto.pem
```

**That command exits non-zero on the real keystore and still works.** Presto's `.p12` encrypts its certificate
bag with RC2-40-CBC, which OpenSSL 3 will not touch without the legacy provider, so it prints
`unsupported ... RC2-40-CBC` and returns 1 — *after* writing the private key, which uses an algorithm it does
accept. `-nocerts` is what makes this survivable, and piping into `openssl pkcs8` instead of writing a file
would hide the key behind the failed exit status. `-legacy` is the documented fix and is worth trying first,
but it needs `legacy.dll` / `legacy.so` present, which stock builds often omit. The README says all of this,
because "the conversion failed" is the first thing a merchant will report.

## 9. Wire contract and test vectors

- `presto-pay-spec` is a repository of its own holding `wire-contract.md` — the reviewed, language-neutral
  version of §3 — along with `vectors/` and `keys/`. It is vendored here as a git submodule at `spec/`, pinned
  to a commit, and it changes only through PRs that update the contract and the vectors together. The Python, Go
  and PHP SDKs vendor the same commit; with the vectors living in this repo instead, the other three would
  either copy them and drift, or depend on an npm package to run their tests.
- `spec/vectors/` holds hand-written cases, or cases captured from staging, **never** generated by an SDK, so an
  implementation bug cannot leak into its own tests, in any language:

  | File | Contents |
  |------|----------|
  | `canonical.json` | body JSON → canonical string, or `"reject"` with a reason. Includes the §3.4 staging body with its `null`, its canonical string and its real signature, verified against the staging certificate |
  | `timestamps.json` | epoch millis ↔ `ts`, including day, month and year rollovers at UTC+8 |
  | `signatures.json` | canonical string → Base64 signature under the test key |
  | `requests.json` | operation input → expected wire body (minus `ts`, `signature`), or the invalid field |
  | `responses.json` | status, headers, body, the request it answers → result fields, or error class and fields (including echo mismatches and `mayHaveTakenEffect` per operation) |
  | `webhooks.json` | body, merchant IDs, `now` → event fields, or error class. Includes a redelivery of an earlier case: same `eventRefNum`, later `ts`, both accepted under the 15-minute window (§3.7) |

- `spec/keys/` holds **only** throwaway test keys, plus Presto's staging certificate so the captured vectors can
  verify themselves. `scripts/sign-vectors.mjs` regenerates `signatures.json`; PKCS#1 v1.5 is deterministic, so
  the output is stable and matches `openssl dgst -sha256 -sign` byte for byte.
- `scripts/verify-vectors.mjs` checks the vectors against themselves with no SDK involved: it rebuilds every
  canonical string, verifies the two staging captures against Presto's certificate, and round-trips every
  timestamp. It is a second, deliberately naive implementation of §3, so an SDK bug cannot agree with it by
  construction. Both scripts live in the spec repo, because a vector generator that ships inside one SDK is a
  vector generator that answers to that SDK.
- Vector field names are the **wire** names. Each SDK maps them to its own naming in the test harness, which is
  itself a small test of that mapping.

## 10. Repository layout

```
src/
  index.ts             public exports
  browser.ts           throws "server-only"
  client.ts            createPrestoPay, fromEnv, options validation
  payments/            request validation + toWire, response mapping, constants
  webhooks/            verifier, NotifyAck, event codes
  errors.ts  retry.ts  version.ts
  internal/            canonical.ts, timestamp.ts, crypto.ts, pem.ts, der.ts, http.ts, send.ts
spec/                  submodule: presto-pay-spec (wire-contract.md, vectors/, keys/)
test/                  vectors, unit, node-sockets, workers, edge, staging
```

`exports` lists only `.` and `./package.json`, so `internal/` cannot be imported. Within `.`, the runtime
conditions come **before** `browser`:

```jsonc
{ "workerd": "./dist/index.js", "edge-light": "./dist/index.js", "node": "./dist/index.js",
  "browser": "./dist/browser.js", "default": "./dist/index.js" }
```

Refusing browsers is right, but `browser` is not a browser-only condition in practice: Vite- and webpack-based
Worker builds often resolve it, and with `browser` first a legitimate Workers user hits the "server-only" throw
with no obvious cause. Ordering the runtime-specific conditions first makes them win; §11 tests the
misresolution case.

## 11. Testing

- **Vectors:** every file in `spec/vectors/` runs on Node, in `workerd` (`@cloudflare/vitest-pool-workers`), and in
  `edge-runtime`.
- **Unit and contract tests:** vitest with an injected `fetch` that plays the gateway, signing responses with the
  test key. Covers every operation, validation message, error kind, retry matrix entry and webhook outcome.
- **Node socket suite:** the `requestNotSent` cases from §6.
- **Package checks:** `publint`, `@arethetypeswrong/cli`, an import test per export condition (including the
  browser guard **and** a bundler config that sets `browser: true` while targeting Workers, which must still
  resolve the real module, §10), a test asserting `SDK_VERSION` matches `package.json`, and a bundle size budget.
- **Staging:** `npm run test:staging`, skipped unless `PRESTOPAY_STAGING_SMOKE=1`. It runs on Node and on
  `wrangler dev` with `strict: true` (§4), so anything the **[U]** rules guessed wrong about fails loudly instead
  of being absorbed, and saves unfamiliar bodies as candidate vectors.

## 12. Milestones

**This SDK goes first and the other three wait for it.** Four repositories implementing an unproven contract
would each discover the same vector bugs separately and fix them three ways, so the spec is shaken out here:
milestones 0 to 3 are where a real implementation first meets §3, and the vectors are expected to change while
that happens. At milestone 3 `presto-pay-spec` is tagged, and that tag is where `python-plan.md`, `go-plan.md`
and `php-plan.md` start. Contract changes after that point are PRs against the spec that all four repos pin
forward to.

| # | Milestone | Exit criteria |
|---|-----------|---------------|
| 0 | Contract | `presto-pay-spec` created, `wire-contract.md` written from §3 and reviewed, submoduled here; vectors written for canonicalization, timestamps and signatures. Both §3.4 captures verify against Presto's certificate in `keys/` and go in as the first two canonical vectors; the only thing still to make is a throwaway keypair for `spec/keys` |
| 1 | Scaffold | Repo, ESM build, vitest on Node + workerd + edge-runtime, `publint` + `attw`, CI matrix |
| 2 | Wire core | Canonicalization, timestamps, Web Crypto sign and verify, PEM and certificate import; those vectors pass on every runtime |
| 3 | Send path | Error hierarchy with branding, `mayHaveTakenEffect` and `reconcileBy` stamped per operation, whole-call deadline, jittered `retryReads`, fetch sender, `requestNotSent` allowlist proven by the Node socket suite |
| 4 | Payments | Four operations, validation (including outgoing safe-integer bounds), response mapping with the echo check, `raw.post` escape hatch, constants; request and response vectors pass |
| 5 | Webhooks + config | Verifier with multi-`mid` and multi-key support, `Request` input, `NotifyAck`, `fromEnv`, key error messages; webhook vectors pass |
| 6 | Release 0.1.0 | README (quick start, key conversion, idempotency with `mayHaveTakenEffect` / `reconcileBy`, the edge retry caveat, the error-body redaction policy, webhook snippets for Workers / Next.js / Hono / Express that dedupe on `eventRefNum`), CHANGELOG, staging smoke on Node and Workers under `strict`, npm publish with provenance |
| later | | PKCS#12 import, encrypted PEM on Node, Bun and Deno in the support statement |

## 13. Questions for Presto

### Answered (round 1)

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | Non-integer or >2^31 numbers in signed bodies? | No; `"amount": 100` | §3.4 integer rendering and "send integers only" → **[C]**; non-integers cannot occur |
| 2 | Can a string field arrive as a number or boolean? | No | §3.6 step 5 coercion kept only as tolerance; `strict` rejects |
| 3 | Are the list fields always strings? | Yes, always string | §3.5 → **[C]**; native arrays cannot occur on the wire, so §3.4 drops the array rendering rule |
| 4 | How is `null` canonicalized; does the gateway send it? | "Yes, can be null" | Second half answered: nulls **do** arrive. Canonicalization answered in round 2 |
| 5 | Is `success` always present? | Yes | §3.6 and §3.7 stop defaulting it; absent is now a malformed body, and the response/webhook asymmetry is gone. Webhook `success` moves to required in §3.8 |
| 6 | Request `ts` validity window | 15 minutes | §3.3 → **[C]**; the `1005` error reports the observed offset against it |
| 7 | Non-200 statuses, `x-http-error-*`, rate limiting | Headers always set; no rate limiting | §3.6 step 1 → **[C]**; no 429 expected |
| 8 | Webhook resend schedule and reply handling | Presto retries on its own backoff; the client need not manage it | §3.7 → **[C]**, and drives `NotifyAck.forError` (never ask for a resend after a permanent failure). The schedule itself came in round 2 |
| 9 | Are length limits characters or bytes? | No limit today | §3.8 lengths become documentation and `strict`-mode checks; the SDK no longer rejects on length |
| 10 | One key for all merchants; rotation? | Yes; Presto informs partners | §3.10 → **[C]**; confirms the webhook `mid` check is mandatory and `prestoPublicKey` must accept an array |

### Answered (round 2)

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | How is `null` rendered in the canonical string? | Empty string | §3.4 → **[C]**; the last rule that could break verification outright is settled, and the §3.4 staging body becomes the vector that proves it |
| 2 | Is a webhook's `ts` refreshed on each delivery attempt? | Yes, refreshed per attempt | §3.7 freshness window drops from 24 h to **15 minutes**, matching §3.3 → **[C]**. A redelivery is never mistaken for a replay, and the replay margin the wide window gave away is back |
| 3 | Is `eventRefNum` stable across redeliveries? | Yes, stable | §3.7 → **[C]**; it is a sound dedupe key, so §7 makes it the documented handler shape rather than a fallback for merchants who disable the freshness check |
| 4 | How long does the retry schedule run? | 1, 2, 5, 10 minutes | §3.7 → **[C]**: five deliveries over ~18 minutes. Sizes dedupe retention, and bounds the damage of a wrong `resend:true` at four extra calls |
| 5 | Does `1203` mean the original init succeeded? | It can be successful, but at minimum the record was created | §3.9 → **[C]**: `1203` proves a record exists, not that it is authorised, so it is stamped `mayHaveTakenEffect` with `reconcileBy: { txnRefNum }` and still routed through `query` |
| 6 | Do `1006` and `1007` distinguish malformed from failed-to-verify? | No | §3.6 gives both the same message and attaches `canonical` to either |

Nothing is outstanding. What stays **[U]** in §3 is all pass-through behaviour — unknown error codes, the status
and payment-method lists, `sessionValidity` formatting — where a wrong guess surfaces as an unrecognized string
rather than a failed verification or a lost payment, and staging under `strict: true` (§11) is what reports it.
