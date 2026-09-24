# Plan: Presto Pay SDK for PHP

Status: proposal, pre-implementation. This document is self-contained: it defines the gateway contract (§3), the
SDK's API and implementation, and how the two are tested. §3 is shared with the JavaScript, Python and Go SDKs;
§1 decision 1 says where it lives.

## 1. Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Repository | `presto-pay-sdk-php`. The contract and vectors live in a separate `presto-pay-spec` repo, vendored here as a git submodule at `spec/` pinned to a commit. Four SDKs now implement §3, and a contract that lives inside one of them is a contract the other three fork (§9) |
| 2 | Package | `prestouniverse/presto-pay-sdk` on Packagist, namespace `PrestoUniverse\PrestoPay` |
| 3 | PHP | **8.2+** (8.2, 8.3, 8.4, 8.5 in CI), 64-bit only. `readonly` classes, enums and named arguments are the whole API style, and a 32-bit `PHP_INT_SIZE` cannot hold the amounts safely, so the constructor refuses it with a clear message rather than truncating money |
| 4 | Extensions | `ext-json`, `ext-openssl`. Both ship with every mainstream PHP build; neither has a pure-PHP substitute worth writing |
| 5 | HTTP | **PSR-18 / PSR-17** interfaces, with a small bundled cURL client used when none is injected. Requiring Guzzle would conflict with half the Laravel and Symfony apps in the field; requiring the user to wire a PSR-18 client before their first payment would make "hello world" a dependency-resolution exercise |
| 6 | Keys | Private key: PKCS#8 PEM **or the onboarding PKCS#12 keystore directly** — `openssl_pkcs12_read` is in the extension already, so making the user run `openssl` first would be inventing a chore. Presto key: X.509 certificate (PEM or DER) or SPKI PEM |
| 7 | Naming | Wire spelling, unchanged: `txnRefNum`, `notifyUrl`, `prestoMrn`. PHP's convention is camelCase for properties and parameters, so the wire names *are* idiomatic here — the one language of the four where no mapping is needed |
| 8 | Static analysis | PHPStan at `max` with strict rules, `declare(strict_types=1)` in every file, no `mixed` in a public signature |

## 2. Goals and non-goals

**Goals**

- The four payment operations (`init`, `query`, `reverse`, `refund`), webhook verification, and key loading.
- An API that drops into Laravel, Symfony and plain PHP without a framework package: constructor injection, PSR
  interfaces at the edges, immutable value objects in the middle.
- Safe by default: no retries of `init`, `reverse` or `refund` unless the request certainly was not sent; webhook
  `mid` check and replay window on; an exception that says when the operation may have happened anyway.

**Non-goals (0.1.0)**

- A Laravel service provider or Symfony bundle (separate packages later if they earn it), async / Fibers,
  PHP 8.1 and below.

## 3. Gateway contract

Tags say how well each rule is established:

| Tag | Meaning |
|-----|---------|
| **[C]** | Confirmed: in Presto's worked example, a body captured from Presto, answered by Presto, or exercised against staging |
| **[U]** | Unconfirmed: believed to be gateway behavior; implement it, and ask Presto (§13) |
| **[P]** | SDK policy, not required by the gateway |

### 3.1 Transport

- HTTPS `POST`, one JSON object per request and per response. Body bytes are UTF-8. **[C]**
- Base URLs: staging `https://presto-stg-ext.enovax.com`, production `https://pay-ext.prestouniverse.com`. **[C]**
- Header `Content-Type: application/json; charset=UTF-8` **[C]**; a `User-Agent` of
  `presto-pay-sdk-php/<version>` **[P]**. Redirects are not followed **[P]**.

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
  regardless of the host time zone or `date.timezone`. **[C]**
- The validity window is **15 minutes**; a request `ts` outside it fails with error `1005`. **[C]**
- `sessionValidity` on init uses the same format **[U]**.
- A host with a skewed clock fails every request with `1005` and has no way to find out why, so the SDK compares
  its own `ts` with the `ts` on each response and reports the observed offset, against the 15-minute window, in
  the `1005` error message. **[P]**

### 3.4 Signatures

**Canonical string**, from a flat JSON object:

1. Take every key except `signature`. **[C]**
2. Sort keys by code point. **[C]** for ASCII keys, which is all known keys — and for ASCII, code point order,
   UTF-8 byte order and UTF-16 code unit order are the same, so the four SDKs agree without any of them doing
   anything special. In PHP this is `uksort($body, strcmp(...))`; see §5 for why `ksort` is a trap.
3. Render each value:

   | JSON value | Rendering |
   |------------|-----------|
   | string | the decoded string as-is, no quoting or escaping **[C]** |
   | integer | decimal, no leading zeros, `-` for negatives. Presto confirms numbers are always integers within 2^31 (§13 round 1, answer 1) **[C]** |
   | `true` / `false` | `true` / `false` — note that PHP's `(string) false` is `''`, so the renderer spells both out **[C]** |
   | `null` | empty string, so a null is indistinguishable from `''` and keeps its separator **[C]** |
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

**That signature verifies** against Presto's staging certificate over those exact bytes, which is the first
end-to-end proof of the whole of §3.4 at once: key sorting, lowercase boolean rendering, the `:` join,
`RSASSA-PKCS1-v1_5` with SHA-256, and standard Base64. It is the first vector in `canonical.json`, and any
implementation that disagrees with it is wrong about something.

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
arithmetic rather than by anyone's reading. It is the second vector in `canonical.json`.

**Algorithm**

- `RSASSA-PKCS1-v1_5` with SHA-256 over the UTF-8 bytes of the canonical string; standard Base64 with padding.
  This is `openssl_sign($data, $sig, $key, OPENSSL_ALGO_SHA256)` exactly — PKCS#1 v1.5 is OpenSSL's default
  padding for `openssl_sign`, so no extra configuration is involved. **[C]**
- Requests are signed with the merchant's private key; responses and webhooks are verified with Presto's public key.
  **[C]**
- Presto signs webhooks for **all** merchants with the same key, so a valid signature does not prove the event is
  for this merchant (§3.7). **[C]**
- A signature that is not valid Base64 is a failed verification, not a separate error. **[P]**

**What is signed must be what is sent.** The canonical string uses decoded values, so any valid JSON escaping is
fine as long as the gateway decodes the strings that were signed **[C]**. Two consequences for PHP:

- **Reject outgoing strings that are not valid UTF-8.** A PHP string is arbitrary bytes, and `json_encode` fails
  the whole body with `JSON_ERROR_UTF8` when one field holds Latin-1 from a legacy database — after the
  canonical string was already built from those same bytes. Validating per field turns a mystifying
  "Malformed UTF-8 characters" into a named field error. **[P]**
- Send `int`, never `float`. `1200.0` encodes as `1200.0` and signs as something else, and PHP will hand you a
  float from any arithmetic that touched a division. **[C]**

### 3.5 JSON rules

**Incoming bodies** **[P]**

- Must be a single JSON object, decoded with `json_decode($raw, true, 512, JSON_THROW_ON_ERROR)`. Duplicate keys
  resolve last-wins, and the same decoded array is used for verification and for field mapping, so what was
  verified is what the merchant reads.
- **Guard the two PHP-specific decoding hazards** before canonicalizing (§5): integers beyond `PHP_INT_MAX`
  silently become floats, and object keys that look like integers become `int` array keys.
- Reject integers outside ±(2^53 − 1). A 64-bit PHP holds more than that exactly, but the shared vectors (§9)
  must produce one answer in all four SDKs, and that bound is the tightest of the four. **[P]**
- Reject floats, `NAN` and `INF` outright: they cannot be rendered per §3.4.

**Stringified arrays.** Every list field is a **JSON string that contains an array**, never a native array, in
both directions (§13 round 1, answer 3) **[C]**. They are canonicalized as ordinary strings, and decoded a
second time on input. A captured query response carrying `"refundDetails": "[]"` and `"paymentDetails": "[]"`
verifies only when each renders as the literal two characters `[]`, so this is confirmed rather than inferred,
and an empty list arrives as `"[]"` and not as `""` **[C]**. Whether such a field can be absent entirely is
**[U]**, so a missing one is read as an empty array.

| Field | Direction | Elements |
|-------|-----------|----------|
| `allowedPaymentMethods` | init request | payment method codes |
| `itemList` | init request | line items (§3.8) |
| `refundDetails` | query response | refund details (§3.8) |
| `paymentDetails` | query response, webhook | payment details (§3.8) |

The SDK takes and returns real arrays of value objects for these; the string is an encoding detail that never
reaches the caller.

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
- Mapping normalizes `''` and `null` to `null` on optional fields, so a caller never feeds `''` to a date parser
  or treats an empty `errorCode` as an error. A required field that arrives empty is a malformed body. Nullable
  typed properties make this visible in the signature of every result class.
- A business-error response is the opposite shape: the §3.4 capture carries only `success`, `ts`, `errorCode`,
  `errorMessage` and `signature`, with none of the payment fields. That is consistent — §3.6 throws at step 4,
  before the echo check at step 6 would look for a `prestoMrn` that is not there — but it means the error and
  the result are two classes rather than one with every property nullable. **[P]**

### 3.6 Responses

Handle a response in this order:

1. **Status not 200:** HTTP error. The body is unsigned and not verified; details are in the `x-http-error-code`
   and `x-http-error` headers (PSR-7 `getHeaderLine` is case-insensitive), which are always set **[C]**. There is
   no rate limiting, so no 429 **[C]**.
2. **Parse** (§3.5). Failure: malformed body.
3. **Signature:** missing or invalid is a signature error. This comes **before** `success`, because business errors
   are signed too. **[C]**
4. **`success`:** always present **[C]**. `false` is a business error with `errorCode` and `errorMessage`; absent
   or non-boolean is a malformed body. Nothing is defaulted, so the webhook side (§3.7) reads the same way.
5. **Map fields** (§3.8). A missing required field is a malformed body. A field documented as a string always
   arrives as a string **[C]**, but a number or bool there is still coerced to text rather than rejected, because
   rejecting an authentic body after the operation took effect helps nobody; strict mode (§4) rejects instead, so
   staging reports the contract violation. **[P]**
6. **Echo check:** `prestoMrn`, and `txnRefNum` where the response carries it, must equal what was signed into the
   request. A mismatch is a response error. The SDK knows what it sent, so this costs nothing and catches a
   mixed-up or replayed response. **[P]**

For `init`, `reverse` and `refund`, a status of 500 or above, or a failure at steps 2, 3, 5 or 6 after a 200, means
**the operation may have taken effect**; reconcile with `query`. The same failures on `query` mean nothing
happened, so the SDK decides this per operation where the exception is thrown (§4, `mayHaveTakenEffect()`). A
`success: false` at step 4 otherwise means nothing happened, with `1203` on init the one exception (§3.9). **[P]**

Error codes are four-digit strings and open-ended; unknown codes are passed through **[U]**. Codes the SDK relies
on:

| Code | Meaning |
|------|---------|
| `1005` | Request `ts` outside the validity window (clock skew) **[C]** |
| `1006`, `1007` | Request signature invalid or failed verification. The two do not distinguish a malformed signature from a well-formed one that failed to verify (§13 round 2, answer 6), so the SDK gives both the same message and attaches the canonical string to either **[C]** |
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

**Retries make the merchant's handler idempotent by necessity.** Three consequences the SDK designs around:

- **A permanent failure must not be answered with `{"resend":true}`.** A bad signature, a `mid` that is not ours
  or a stale `ts` will fail identically on every redelivery, so asking for a resend builds a loop that only ends
  when Presto gives up. `resend:true` is for transient merchant-side failures — the database was down — and
  `NotifyAck::forThrowable($e)` encodes exactly that split. **[P]**
- **The freshness window is 15 minutes,** the same as request timestamps (§3.3). A redelivery carries a fresh
  `ts` **[C]**, so the last attempt of the schedule above is timestamped when it is sent, not when the event
  happened, and a legitimate redelivery never looks stale. The window is configurable for hosts that queue
  notifications before verifying them. **[P]**
- **`eventRefNum` is stable across redeliveries of the same event** **[C]**, so it is the deduplication key, and
  the ~18-minute schedule sizes the retention. A merchant that fulfils on each delivery double-fulfils up to five
  times, so the README's handler shape is a unique index on `eventRefNum` and an insert that swallows the
  duplicate. **[P]**

**Verification**, in order:

1. Parse the **raw body** — `file_get_contents('php://input')` in plain PHP, `$request->getContent()` in
   Symfony and Laravel, `(string) $request->getBody()` in PSR-7 — never a framework's decoded array
   re-encoded (§7).
2. Signature present and valid, otherwise a signature error.
3. Map fields (§3.8). `success` is always present **[C]**; absent is a malformed body.
4. `mid` must be one of the configured merchant IDs, otherwise a signature error **[P]**. This is mandatory, not
   defensive: Presto confirms one key signs for every merchant (§13 round 1, answer 10), so the signature alone
   says nothing about who the event is for. One endpoint serving several `mid`s is a normal deployment for the
   same reason, so the verifier takes a list and reports which one matched.
5. Freshness: reject if `|now − ts|` exceeds the window (default 15 min, configurable), in either direction, as a
   signature error; a malformed `ts` is a malformed body. The message carries both timestamps and the window,
   since a skewed clock or a slow queue makes this the first check anyone trips. Widening or disabling it is
   allowed only if the merchant deduplicates by `eventRefNum`. **[P]**

Event codes (open-ended) **[U]**: `Authorised`, `Cancelled`, `Reversed`, `Refunded`, `Expired`. For `Authorised`,
`success` says whether authorisation succeeded, so the suggested payment status is `Authorised` or `Failed`; for
other codes the event code is the status. `query` remains the authoritative source of payment state.

### 3.8 Operation fields

All **[U]** unless noted. Amounts are integers in minor currency units **[C]**.

**The lengths below are documented maxima, not gateway limits.** Presto enforces no length limit today (§13
round 1, answer 9), so hard-rejecting at `≤50` would fail requests the gateway would have accepted, and the
characters-or-bytes question is moot. The SDK carries the numbers as documentation and as strict-mode checks
(§4), and never rejects on length otherwise. **[P]**

**Requests** (PHP parameter names are these exactly, per §1 decision 7)

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

Date fields other than `ts` use the same `yyyyMMddHHmmss.SSS` at UTC+8 — the captured response in §3.4 sends
`paymentRequestDate: "20260924133756.056"` **[C]** — and are `string` on the result classes, since only some of
them are confirmed and an unparseable date should not fail an authentic response. `Timestamp::parse()` (§4) is
the supported way to read them and returns a `DateTimeImmutable`.

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

- `init`, `reverse` and `refund` must not be resent once any byte may have reached the gateway; resending init
  with the same `txnRefNum` returns `1203`, which means a payment record for it exists — possibly an authorised
  one. **[C]**
- They may be retried only when the request certainly never left the process (DNS failure, connection refused,
  connect or TLS failure before the body was written). When unsure, do not retry. **[P]**
- `query` may be retried on transport errors and on statuses of 500 and above. **[P]**
- Every attempt gets a fresh `ts` and signature **[C]** (a stale `ts` fails with `1005`).
- After an ambiguous failure, look the transaction up with `query`: by `txnRefNum` after init, by `paymentRefNum`
  after reverse or refund. **[P]**
- `1203` says a record exists but not what state it is in, so it is a `query` prompt rather than an answer: the
  SDK sets `mayHaveTakenEffect()` and a `reconcileBy()` of `txnRefNum` on that business exception. Treating it as
  "the payment succeeded" would fulfil orders whose init was rejected downstream. **[P]**

### 3.10 Keys

- Merchant private key: RSA, delivered at onboarding as a PKCS#12 keystore. **[C]**
- Presto public key: RSA, delivered as an X.509 certificate (PEM or DER). **[C]**
- One Presto key signs responses and webhooks for all merchants, and rotations are announced to partners out of
  band **[C]**. There is no `kid` on the wire, so an overlap period means holding both keys and trying each:
  `prestoPublicKeys` is a list (§4).

## 4. API

```php
use PrestoUniverse\PrestoPay\{PrestoPay, Environment, TxnType, PaymentMethod, NotifyAck};
use PrestoUniverse\PrestoPay\Key\{PrivateKey, PublicKey};
use PrestoUniverse\PrestoPay\Request\{InitRequest, QueryRequest};

$presto = new PrestoPay(
    environment: Environment::Staging,          // or Environment::custom('https://...')
    merchantId: $_ENV['PRESTOPAY_MID'],
    privateKey: PrivateKey::fromPem($_ENV['PRESTOPAY_PRIVATE_KEY']),
    prestoPublicKeys: [PublicKey::fromPem($_ENV['PRESTOPAY_PUBLIC_KEY'])],
    // deadline: 30.0,                          // seconds, whole call, retries included
    // retryReads: new RetryReads(maxRetries: 2, initialBackoff: 0.2, maxBackoff: 5.0),
    // webhooks: new WebhookOptions(maxTimestampAge: 900),
    // strict: false, redactErrorBodies: true,
    // httpClient: $psr18Client, requestFactory: $psr17, streamFactory: $psr17,
);

$payment = $presto->payments()->init(new InitRequest(
    prestoMrn: 'YOUR_PRESTO_MRN',
    txnType: TxnType::WebPay,
    txnRefNum: 'order-123',
    displayDesc: 'Order 123',
    amount: 10_000,
    currencyCode: 'MYR',
    notifyUrl: 'https://your-app.example/presto/notify',
    redirectUrl: 'https://your-app.example/presto/return',
    allowedPaymentMethods: [PaymentMethod::Wallet],
));

echo $payment->paymentUrl;
```

Every request takes `prestoMrn`, because one `mid` can have several (§3.2). To serve several merchants,
construct one client per `mid`.

| Choice | Reason |
|--------|--------|
| `final readonly class` request objects with named arguments | Nineteen optional init fields make an associative array unreadable and unanalysable. A constructor with named arguments gives PHPStan and every IDE the full field list, and `readonly` means the object that was validated is the object that was signed |
| Wire field names throughout | Unlike the other three SDKs, PHP's conventions and the wire's agree, so the §3.8 tables are literally the API reference and nothing has to be memorized twice |
| `final readonly class` results with public typed properties | `$payment->paymentUrl`, not `$payment->get('paymentUrl')`. Nullable properties are the §3.5 "may be empty" rule made visible. `->raw` holds the wire array for logging and for fields the SDK does not model yet |
| Enums only where the set is closed | `Environment` and `TxnType` are enums: the SDK defines them and the gateway never sends them back. Everything the gateway *can* send — payment status, payment method, error code — is a class of `public const string` values, because §3.8 says the lists are open-ended and an enum would throw `ValueError` on a payment method Presto added last week |
| Operations grouped as `$presto->payments()->init()` | Keeps the client from being a bag of verbs, and matches the other three SDKs |
| PSR-18 injection, bundled cURL default | Works out of the box and drops into any framework's container. §6 lists the constraints an injected client must satisfy |
| `strict: true` | Presto has confirmed rules the SDK still tolerates violations of, and documented lengths it does not itself enforce. Strict rejects instead of coercing, so staging (§11) reports contract drift while production stays lenient |

**Escape hatch.** `$presto->raw()->post($path, $body)` signs, sends, verifies and returns the decoded array, and
`Signer::sign()` / `Verifier::verifyBody()` are public. Error codes are open-ended and the gateway will grow
endpoints faster than the SDK; this turns "not supported yet" into three lines of user code instead of a fork.

Also public: `WebhookVerifier`, `PrivateKey::fromPem|fromPkcs12|fromFile`, `PublicKey::fromPem|fromDer|fromFile`,
`Canonicalizer::canonicalize()` (signature debugging), `Timestamp::format|parse`, `PrestoPay::fromEnv()`,
`Errors::mayHaveSucceeded()`, the constant classes and `PrestoPay::VERSION`.

### Constants

Each follows the PHP convention for what it is, which means the two halves are spelled differently:

```php
enum TxnType: string {
    case WebPay = 'WebPay';          // PER: enum cases are PascalCase, which is the wire value here
    case QrPay = 'QrPay';
    case MiniAppPay = 'MiniAppPay';
}

final class PaymentStatus {
    public const string AUTHORISED = 'Authorised';        // PSR-1: class constants are UPPER_CASE
    public const string PENDING_AUTHORISE = 'PendingAuthorise';
    // ...
}
```

Enum cases land on the wire value by coincidence of convention and the constant classes do not, and neither is
worth fighting a style rule over: the value carries the gateway's exact spelling either way, which is what the
signature and the §3.8 tables depend on.

The awkward values are the ones that make the lookup direction matter — `PmPgCard` is `PM_PG_CARD`,
`UnionPayQR` is `UNION_PAY_QR`, `Subwallet_NearU` is `SUBWALLET_NEAR_U` — so a reader holding a wire string
should never guess at a constant name. A test asserts every case and constant value against the code lists in
`spec/vectors`, which catches a mis-transcribed value even though a mis-transcribed name would not be visible.

### Exceptions

All extend `PrestoPayException` (which extends `RuntimeException`), with the original in `getPrevious()`:

```php
abstract class PrestoPayException extends \RuntimeException
{
    public function operation(): Operation;        // Init|Query|Reverse|Refund|Webhook|Config
    public function mayHaveTakenEffect(): bool;
    public function reconcileBy(): ?ReconcileKey;  // txnRefNum or paymentRefNum
}
```

| Class | When | Extra accessors |
|-------|------|-----------------|
| `ConfigException` | Invalid config or request input, including invalid UTF-8 | `field()` |
| `TransportException` | Network failure, timeout | `requestNotSent()` |
| `ApiException` | Non-200 status (`kind() === Kind::Http`) or `success: false` (`Kind::Business`) | `kind()`, `httpStatus()`, `errorCode()`, `errorMessage()`, `rawBody()`; `canonical()` on `1006` / `1007`, and the observed clock offset on `1005` (§3.3) |
| `SignatureException` | Missing or invalid signature, wrong webhook `mid`, stale webhook `ts` | `source()`, `canonical()` |
| `ResponseException` | Malformed body, missing required field, bad `ts`, echo mismatch | `source()`, `rawBody()` |

`TransportException` deliberately does not extend PSR-18's `ClientExceptionInterface`: the SDK's exception
hierarchy should not change shape depending on which HTTP client the user injected. The PSR-18 exception is the
`previous`.

**`mayHaveTakenEffect()` is decided where the exception is thrown, not by the catcher.** Only there does the SDK
still know which operation ran, and the answer depends on it: a 500 on `init` is indeterminate, a 500 on `query`
means nothing happened. `reconcileBy()` carries the lookup key from §3.9, so the recovery path is

```php
try {
    $payment = $presto->payments()->init($request);
} catch (PrestoPayException $e) {
    if (!$e->mayHaveTakenEffect()) {
        throw $e;
    }
    $payment = $presto->payments()->query(QueryRequest::from($e->reconcileBy()));
}
```

rather than the caller re-threading request state into the `catch` block. An `ApiException` with code `1203`
reports both, even though the call plainly failed, because the code proves an earlier init created a record
(§3.9).

**PII.** `rawBody()` and `canonical()` can contain `cardBin`, `cardSummary`, `receiptEmail` and `receiptName`,
and PHP's default exception handler prints `getMessage()` into the log of every uncaught error. They are redacted
in the message by default, with the full text still reachable through the accessor when
`redactErrorBodies: false`. `__debugInfo()` on the client and the key objects hides the key material, because a
`var_dump($presto)` in a debug template is how private keys reach log aggregators.

## 5. Implementation

PHP-specific hazards, each with a test, and several of them the reason this SDK is not a mechanical port:

- **`ksort` is not lexicographic by default.** `ksort($body)` uses `SORT_REGULAR`, which compares numeric-looking
  strings as numbers. Use `uksort($body, strcmp(...))`, which is byte order and matches §3.4 in every locale.
- **JSON object keys that look like integers become `int` array keys.** `json_decode('{"1":"x"}', true)` yields
  `[1 => 'x']`, and an `int` key breaks `strcmp` and would render differently. Every key is cast back with
  `(string)` before sorting and joining. No current field is numeric, which is exactly why this would be found in
  production rather than in development.
- **Integers beyond `PHP_INT_MAX` silently become floats** in `json_decode`. Decode with `JSON_BIGINT_AS_STRING`
  so an oversized integer arrives as a string and can be rejected per §3.5 instead of being rendered in
  scientific notation.
- **`json_encode` on a float writes `1200.0`,** and `serialize_precision` can turn `0.1 + 0.2` into
  `0.30000000000000004`. The renderer rejects floats outright rather than trying to format them.
- **`(string) false` is the empty string.** The boolean renderer writes the literals `true` and `false`.
- **`openssl_verify` returns `1`, `0` or `-1`.** Anything but `=== 1` is a failure, and `-1` must not be treated
  as truthy — it is the one that means the call itself errored.
- **OpenSSL's error queue is global and sticky.** Every crypto call is followed by a drain loop over
  `openssl_error_string()`, so an unrelated error from earlier in the request does not get attached to a payment
  failure, and the SDK's own errors carry the real OpenSSL message.
- **`base64_decode($s, true)`** in strict mode, so a corrupted signature is a clean verification failure rather
  than bytes that are almost right.
- **Timestamps** use `DateTimeImmutable` with `new DateTimeZone('+08:00')` and the format `'Ymd His.v'` without
  the space — `v` is milliseconds, three digits, which is exactly §3.3; `u` would give six. Never a named zone:
  `Asia/Kuala_Lumpur` happens to be +08:00 today, and `date_default_timezone_get()` is whatever the ini file
  says.
- **`hash_equals` is not needed** — signature verification is public-key — but the SDK uses it for the webhook
  `mid` comparison anyway, since that one compares a configured value against attacker-controlled input.

Keys use the extension directly, so there is no hand-written parser — the JavaScript SDK needs a DER walker to
pull `subjectPublicKeyInfo` out of a certificate and PHP does not: `openssl_pkey_get_private`,
`openssl_pkcs12_read`, `openssl_x509_read` plus `openssl_pkey_get_public`, and `openssl_pkey_get_details` to
confirm `OPENSSL_KEYTYPE_RSA` and at least 2048 bits at load time.

Outgoing bodies: validate, build an array of only the fields that are set, add `mid`, `prestoMrn`, `ts`, sign,
then `json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)`.
`JSON_UNESCAPED_SLASHES` matters only for readability in captures — escaping cannot change a signature because
the canonical string uses decoded values — but a body whose URLs read as URLs saves an hour the first time
someone diffs a request against the gateway's logs.

## 6. HTTP, retries, idempotency

One path: a PSR-7 request built from the injected PSR-17 factories and sent through the PSR-18 client, or through
the bundled `CurlHttpClient` when none is injected.

- **Deadline:** `deadline` (default 30 s) is the budget for the **whole call**, retries and backoff included. The
  bundled client applies what is left of it as `CURLOPT_TIMEOUT_MS` per attempt. PSR-18 has no timeout concept,
  so an injected client's timeout is the user's to configure, and the SDK still enforces the overall budget by
  refusing to start an attempt that cannot finish inside it — the README says to set the client's timeout at or
  below `deadline`.
- **Redirects off.** `CURLOPT_FOLLOWLOCATION` stays `false` (cURL's default). A 3xx is an HTTP error (§3.6 step
  1) and is never retried; an injected client that follows redirects is a documented misconfiguration, and the
  SDK detects the symptom by rejecting a 200 that arrives from a different host than it addressed.
- **`requestNotSent`** with the bundled client comes from cURL's error code, which is precise:
  `CURLE_COULDNT_RESOLVE_HOST` (6), `CURLE_COULDNT_RESOLVE_PROXY` (5), `CURLE_COULDNT_CONNECT` (7),
  `CURLE_SSL_CONNECT_ERROR` (35), `CURLE_PEER_FAILED_VERIFICATION` (60) and `CURLE_SSL_CACERT_BADFILE` (77) are
  not sent. `CURLE_OPERATION_TIMEDOUT` (28) is ambiguous on its own, so it is resolved with
  `curl_getinfo($ch, CURLINFO_CONNECT_TIME)`: a connect time of zero means the timeout fired before the
  connection existed, and nothing was written. Everything else, including `CURLE_RECV_ERROR` and
  `CURLE_SEND_ERROR`, counts as sent.
- **An injected PSR-18 client cannot report this.** `NetworkExceptionInterface` says "the request never
  completed", not "the request was never written", so the SDK treats every injected-client failure as **sent**
  and therefore never retries `init`, `reverse` or `refund` behind one. The README states this plainly: it is a
  reason to use the bundled client for the payment path, not a defect to work around.
- **Proof:** a suite drives real sockets for each case (unresolvable host, closed port, blackholed connect,
  self-signed certificate, reset after the body was written, headers never sent) against loopback servers on
  every PHP version in CI, so a cURL upgrade that renumbers or reclassifies an error fails the tests instead of
  silently changing retry behaviour.
- **Retry policy:** follows §3.9, and the option is `retryReads` rather than `retry` because that is all it
  governs. Exponential backoff from `initialBackoff`, capped at `maxBackoff`, with full jitter on by default so a
  fleet does not retry in lockstep after a gateway blip. Presto confirms there is no rate limiting, so no 429 is
  expected; `Retry-After` is still honoured over the computed delay, subject to the remaining deadline. Backoff
  sleeps with `usleep`, which in a synchronous PHP request is a blocked worker — another reason `retryReads`
  defaults to two attempts, not five.

## 7. Webhooks

```php
$verifier = new WebhookVerifier(
    merchantIds: [$_ENV['PRESTOPAY_MID']],
    prestoPublicKeys: [PublicKey::fromPem($_ENV['PRESTOPAY_PUBLIC_KEY'])],
);

try {
    $event = $verifier->verify(file_get_contents('php://input'));
    $fulfilment->once($event->eventRefNum, $event);   // unique index on eventRefNum
    $ack = NotifyAck::Ok;
} catch (\Throwable $e) {
    $ack = NotifyAck::forThrowable($e);
}

header('Content-Type: application/json');
echo $ack->body();
```

`verify(string $rawBody)` is the whole API; `verifyServerRequest(ServerRequestInterface $request)` is the PSR-7
convenience. Getting the **raw** body right is the one thing the merchant has to do, and it differs per
framework:

| Framework | Raw body |
|-----------|----------|
| Plain PHP | `file_get_contents('php://input')` |
| Laravel | `$request->getContent()` |
| Symfony | `$request->getContent()` |
| Slim / PSR-7 | `(string) $request->getBody()` — rewind first if anything upstream read it |

Passing an array throws `ConfigException` pointing at this table, because `json_encode($request->all())` reorders
nothing but re-escapes and re-spaces, and the signature is over bytes. The PSR-7 path rewinds the stream itself
and throws a clear error if the stream is not seekable and already consumed.

`merchantIds` is a list and the verified event reports which one matched (§3.7 step 4). Presto signs for all
merchants with one key (§3.4), so a single endpoint receiving notifications for several `mid`s is the normal
shape, and it cannot dispatch on `mid` before verifying without decoding twice. `prestoPublicKeys` is a list for
rotation, as on the client.

A verifier needs no private key, so a webhook-only endpoint holds no signing material.

`NotifyAck` is an enum with `Ok` and `Resend` cases and a `body()` method returning the JSON.
`NotifyAck::forThrowable($e)` picks the reply for a caught exception, because getting this wrong loops: Presto
retries at 1, 2, 5 and 10 minutes (§3.7), so answering a bad signature, a foreign `mid` or a stale `ts` with
`resend:true` asks for four redeliveries that will fail identically. It returns `Ok` for `SignatureException`
and `ResponseException` — permanent, nothing a retry fixes — and `Resend` for anything else, which is the
merchant's own transient failure.

The event carries `eventRefNum`, stable across the up-to-five deliveries of one event (§3.7), and the derived
`paymentStatus`.

## 8. Configuration and keys

| Variable | Description |
|----------|-------------|
| `PRESTOPAY_ENV` or `PRESTOPAY_BASE_URL` | `staging` / `production`, or an explicit URL |
| `PRESTOPAY_MID` | merchant ID |
| `PRESTOPAY_PRIVATE_KEY` or `PRESTOPAY_PRIVATE_KEY_FILE` | PKCS#8 PEM text, or a path to a PEM or `.p12` |
| `PRESTOPAY_PRIVATE_KEY_PASSWORD` | keystore password, if a `.p12` or an encrypted PEM is used |
| `PRESTOPAY_PUBLIC_KEY` or `PRESTOPAY_PUBLIC_KEY_FILE` | Presto certificate (PEM or DER), or SPKI PEM |

`PrestoPay::fromEnv($_ENV)` reads these from any array, so `getenv()`, `$_SERVER`, a Dotenv result or a Laravel
config array all work without the SDK reaching into the process environment itself.

Because `ext-openssl` reads PKCS#12, the onboarding keystore is a supported input:

```php
privateKey: PrivateKey::fromPkcs12('/run/secrets/partner.p12', $_ENV['PRESTOPAY_PRIVATE_KEY_PASSWORD']),
```

**This is the one decision in the plan that is not yet verified, and it is gated at milestone 2.** The real
onboarding keystore (`keys/presto_rm_keystore.p12`) has an RC2-40-CBC certificate bag, which OpenSSL 3 will not
decrypt without the legacy provider loaded — the command line on a stock Windows OpenSSL 3.6 build cannot do it
at all. Python's `cryptography` reads the same file without complaint, but `openssl_pkcs12_read` calls into
whatever libssl the PHP build links, so it may well fail. Milestone 2 tries it on each supported PHP version
before the README promises anything, and if it fails the SDK drops to PEM-only like the Go SDK and documents
the conversion instead:

```bash
openssl pkcs12 -legacy -in partner.p12 -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out partner-key.pem
```

Either way the SDK detects the RC2 failure and prints that command rather than surfacing OpenSSL's opaque
"unsupported algorithm" message.

Other key errors are specific too: a certificate passed as the private key, a non-RSA key, a wrong password, a
truncated PEM, a DER blob that is a certificate where an SPKI was expected. Each message names the input and the
fix.

## 9. Wire contract and test vectors

`presto-pay-spec` is a repository of its own holding `wire-contract.md` (the reviewed, language-neutral version
of §3), `vectors/` and throwaway `keys/`. It is vendored here as a submodule at `spec/`, pinned to a commit, and
CI fails if the pin is behind the spec's default branch by more than a release.

Four SDKs is what forces this. With the vectors living in the JavaScript repo, the other three either copy them —
and drift — or depend on a JavaScript package to run their tests. A separate repo also makes the rule that
matters enforceable: **vectors are hand-written or captured from staging, never generated by an SDK**, so an
implementation bug cannot leak into its own tests, in any language.

| File | Contents |
|------|----------|
| `canonical.json` | body JSON → canonical string, or `"reject"` with a reason. Includes the §3.4 staging body with its `null`, its canonical string and its real signature |
| `timestamps.json` | epoch millis ↔ `ts`, including day, month and year rollovers at UTC+8 |
| `signatures.json` | canonical string → Base64 signature under the test key |
| `requests.json` | operation input → expected wire body (minus `ts`, `signature`), or the invalid field |
| `responses.json` | status, headers, body, the request it answers → result fields, or exception class and accessors (including echo mismatches and `mayHaveTakenEffect` per operation) |
| `webhooks.json` | body, merchant IDs, `now` → event fields, or exception class. Includes a redelivery: same `eventRefNum`, later `ts`, both accepted under the 15-minute window |

Vector field names are the wire names, which for this SDK are also the API names — so the PHP harness is the
thinnest of the four, and a vector that needs translating here is a sign the naming decision slipped.

## 10. Repository layout

```
src/
  PrestoPay.php            client, fromEnv
  Payments.php  Raw.php
  Request/                 InitRequest, QueryRequest, ReverseRequest, RefundRequest, LineItem
  Result/                  InitResult, QueryResult, ReverseResult, RefundResult, RefundDetail, PaymentDetail
  Webhook/                 WebhookVerifier, NotifyAck, WebhookEvent
  Key/                     PrivateKey, PublicKey
  Exception/               PrestoPayException and the five subclasses
  Internal/                Canonicalizer, Signer, Verifier, Timestamp, Mapper, CurlHttpClient, Retry
  Constant/                PaymentStatus, PaymentMethod, ErrorCode, ...
spec/                      submodule: presto-pay-spec
tests/                     Vector, Unit, Socket, Staging
```

`Internal\` is marked `@internal` and excluded from the documented surface; BC promises cover `src/` minus that
namespace, and a PHPStan rule fails the build if a public signature mentions an internal type.

## 11. Testing

- **Vectors:** every file in `spec/vectors/` runs as PHPUnit data providers.
- **Unit and contract tests:** a PSR-18 mock client plays the gateway and signs responses with the test key.
  Covers every operation, validation message, exception class, retry matrix entry and webhook outcome.
- **Socket suite:** the `requestNotSent` cases from §6 against loopback servers started with `proc_open`, on
  every PHP version in CI.
- **Static:** PHPStan at `max` with `phpstan-strict-rules`, PHP-CS-Fixer, and a test asserting
  `PrestoPay::VERSION` matches the tag on release.
- **Compatibility:** the suite runs against both the bundled cURL client and an injected Guzzle and Symfony
  HttpClient, since PSR-18 conformance varies in exactly the places that matter here — header case, redirect
  behaviour, exception types.
- **Staging:** `composer test:staging`, skipped unless `PRESTOPAY_STAGING_SMOKE=1`, with `strict: true` (§4) so
  anything the **[U]** rules guessed wrong about fails loudly instead of being absorbed. It saves unfamiliar
  bodies as candidate vectors for `presto-pay-spec`.

## 12. Milestones

**This plan starts at the spec's first tag.** The JavaScript SDK goes first and shakes the vectors out against a
real implementation (`js-plan.md` §12); porting in parallel with that would mean fixing the same vector bugs
three times, three ways. Work here begins once `presto-pay-spec` is tagged, which is also when the **[U]** rules
have had their first contact with staging.

| # | Milestone | Exit criteria |
|---|-----------|---------------|
| 0 | Spec | `presto-pay-spec` submoduled at its tagged commit |
| 1 | Scaffold | Repo, `composer.json`, PHPUnit + PHPStan max + CS-Fixer, CI on 8.2–8.5 |
| 2 | Wire core | Canonicalization with the §5 hazards covered, timestamps, sign and verify, PEM / DER loading; those vectors pass. **Decides PKCS#12**: `openssl_pkcs12_read` is tried against the real RC2 keystore on every supported PHP version, and decision 6 is confirmed or downgraded to PEM-only (§8) |
| 3 | Send path | Exception hierarchy, `mayHaveTakenEffect()` and `reconcileBy()` per operation, whole-call deadline, jittered `retryReads`, bundled cURL client with cURL-code classification proven by the socket suite |
| 4 | Payments | Four operations, request objects and validation, result mapping with the echo check, `raw()->post()`, constants; request and response vectors pass |
| 5 | Webhooks + config | Verifier with multi-`mid` and multi-key support, PSR-7 input, `NotifyAck`, `fromEnv`, key error messages; webhook vectors pass |
| 6 | Release 0.1.0 | README (quick start, `.p12` handling including the `-legacy` case, idempotency with `mayHaveTakenEffect()` / `reconcileBy()`, the injected-client retry caveat, the redaction policy, webhook snippets for plain PHP / Laravel / Symfony that dedupe on `eventRefNum`), CHANGELOG, staging smoke under strict, Packagist release |
| later | | A Laravel service provider and a Symfony bundle as separate packages, if they earn it |

## 13. Questions for Presto

All answered. Recorded here because §3 cites them, and because the next person to read a **[C]** tag will want to
know what it rests on.

### Round 1

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | Non-integer or >2^31 numbers in signed bodies? | No; `"amount": 100` | §3.4 integer rendering → **[C]**; non-integers cannot occur |
| 2 | Can a string field arrive as a number or boolean? | No | §3.6 step 5 coercion kept only as tolerance; strict rejects |
| 3 | Are the list fields always strings? | Yes, always string | §3.5 → **[C]**; native arrays cannot occur on the wire |
| 4 | Does the gateway send `null`? | Yes | §3.5 → **[C]**; rendering answered in round 2 |
| 5 | Is `success` always present? | Yes | §3.6 and §3.7 stop defaulting it; absent is a malformed body |
| 6 | Request `ts` validity window | 15 minutes | §3.3 → **[C]** |
| 7 | Non-200 statuses, `x-http-error-*`, rate limiting | Headers always set; no rate limiting | §3.6 step 1 → **[C]**; no 429 expected |
| 8 | Webhook resend and reply handling | Presto retries on its own backoff | §3.7 → **[C]**; drives `NotifyAck::forThrowable` |
| 9 | Are length limits characters or bytes? | No limit today | §3.8 lengths become documentation and strict checks |
| 10 | One key for all merchants; rotation? | Yes; Presto informs partners | §3.10 → **[C]**; the webhook `mid` check is mandatory and keys are a list |

### Round 2

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | How is `null` rendered in the canonical string? | Empty string | §3.4 → **[C]**; the last rule that could break verification outright |
| 2 | Is a webhook's `ts` refreshed on each delivery attempt? | Yes | §3.7 window is 15 minutes, matching §3.3 → **[C]** |
| 3 | Is `eventRefNum` stable across redeliveries? | Yes | §3.7 → **[C]**; a sound dedupe key |
| 4 | How long does the retry schedule run? | 1, 2, 5, 10 minutes | §3.7 → **[C]**: five deliveries over ~18 minutes |
| 5 | Does `1203` mean the original init succeeded? | It can be, but at minimum the record was created | §3.9 → **[C]**: reconcile via `query`, never assume success |
| 6 | Do `1006` and `1007` distinguish malformed from failed-to-verify? | No | §3.6 gives both the same message |

What stays **[U]** in §3 is all pass-through behaviour — unknown error codes, the status and payment-method
lists, `sessionValidity` formatting — where a wrong guess surfaces as an unrecognized string rather than a failed
verification or a lost payment, and staging under `strict: true` (§11) is what reports it.
