# Plan: Presto Pay SDK for Python

Status: proposal, pre-implementation. This document is self-contained: it defines the gateway contract (§3), the
SDK's API and implementation, and how the two are tested. §3 is shared with the JavaScript, Go and PHP SDKs;
§1 decision 1 says where it lives.

## 1. Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Repository | `presto-pay-sdk-python`. The contract and vectors live in a separate `presto-pay-spec` repo, vendored here as a git submodule at `spec/` pinned to a commit. Four SDKs now implement §3, and a contract that lives inside one of them is a contract the other three fork (§9) |
| 2 | Package | `presto-pay-sdk` on PyPI, imported as `presto_pay`. Pure-Python wheel plus sdist, no compiled extension |
| 3 | Python | **3.11+** (3.11, 3.12, 3.13, 3.14 in CI). 3.11 is the floor for `StrEnum`, `Self` and `asyncio.timeout`, and by 0.1.0 every 3.10 deployment is on a security-only branch |
| 4 | Dependencies | `cryptography` and `httpx`. The stdlib has no RSA at all, and `httpx` is the one mainstream client with a single API over sync and async. No pydantic: a payment SDK that drags a validation framework into a service that already has one is a version-conflict generator |
| 5 | Sync **and** async | Both, from one sans-IO core (§5). Half the target deployments are Django or Celery and half are FastAPI; shipping one and telling the other half to use a thread pool is shipping half an SDK |
| 6 | Keys | Private key: PKCS#8 PEM **or the onboarding PKCS#12 keystore directly** — `cryptography` reads `.p12`, so making the user run `openssl` first would be inventing a chore. Presto key: X.509 certificate (PEM or DER) or SPKI PEM |
| 7 | Naming | **snake_case** on the Python API, mapped to the wire's camelCase by one mechanical rule (§4). Wire names would fail every linter in the ecosystem, and the mapping is `txn_ref_num` ↔ `txnRefNum` with no exceptions |
| 8 | Typing | `py.typed`, mypy `--strict` in CI, no `Any` in a public signature |
| 9 | Code comments | Never cite this plan or the wire contract by filename or section number (no `python-plan.md §N`, no `wire-contract.md §N`). Explain the *why* in the comment itself, so it still reads once the plan is gone, renamed, or out of date |

## 2. Goals and non-goals

**Goals**

- The four payment operations (`init`, `query`, `reverse`, `refund`), webhook verification, and key import.
- An API that reads as ordinary Python in Django, Flask, FastAPI and Celery, sync or async, with the same
  behaviour and the same wire bytes either way.
- Safe by default: no retries of `init`, `reverse` or `refund` unless the request certainly was not sent; webhook
  `mid` check and replay window on; an error that says when the operation may have happened anyway.

**Non-goals (0.1.0)**

- Framework packages (a Django app, a FastAPI router), gevent or eventlet support statements, Python 3.10 and
  below.

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
  `presto-pay-sdk-python/<version>` **[P]**. Redirects are not followed **[P]**.

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
2. Sort keys by code point. **[C]** for ASCII keys, which is all known keys — and for ASCII, code point order,
   UTF-8 byte order and UTF-16 code unit order are the same, so the four SDKs agree without any of them doing
   anything special. In Python this is plain `sorted()`; never `locale.strcoll`.
3. Render each value:

   | JSON value | Rendering |
   |------------|-----------|
   | string | the decoded string as-is, no quoting or escaping **[C]** |
   | integer | decimal, no leading zeros, `-` for negatives. Presto confirms numbers are always integers within 2^31 (§13 round 1, answer 1) **[C]** |
   | `True` / `False` | `true` / `false` — lowercase, which is `str(bool)` spelled wrong in Python **[C]** |
   | `None` | empty string, so a null is indistinguishable from `""` and keeps its separator **[C]** |
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
  **[C]**
- Requests are signed with the merchant's private key; responses and webhooks are verified with Presto's public key.
  **[C]**
- Presto signs webhooks for **all** merchants with the same key, so a valid signature does not prove the event is
  for this merchant (§3.7). **[C]**
- A signature that is not valid Base64 is a failed verification, not a separate error. **[P]**

**What is signed must be what is sent.** The canonical string uses decoded values, so any valid JSON escaping is
fine as long as the gateway decodes the strings that were signed **[C]**. Two consequences for Python:

- Reject outgoing strings that are not encodable as UTF-8 — in practice, `str` values holding unpaired surrogates
  (`'\ud800'`), which arrive from `surrogateescape` decoding of OS data and from some database drivers. They
  raise `UnicodeEncodeError` deep inside `json.dumps`, so catching them at validation turns a traceback from the
  middle of the send path into a named field error. **[P]**
- Send `int`, never `float` or `Decimal`. `1200.0` serializes as `1200.0` and signs as something else. **[C]**

### 3.5 JSON rules

**Incoming bodies** **[P]**

- Must be a single JSON object. Duplicate keys resolve last-wins, and the same parsed object is used for
  verification and for field mapping, so what was verified is what the merchant reads.
- Reject integers outside ±(2^53 − 1) before canonicalizing. Python integers are exact and would not round, but
  the shared vectors (§9) must produce one answer in all four SDKs, and that bound is the tightest of the four.
  **[P]**
- Reject floats and `NaN` / `Infinity` outright: they cannot be rendered per §3.4, and Python's `json` accepts
  the last two by default (§5).
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

The SDK takes and returns real lists for these; the string is an encoding detail that never reaches the caller.

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
- Mapping normalizes `""` and `null` to `None` on optional fields, so a caller never feeds `""` to a date parser
  or treats an empty `errorCode` as an error. A required field that arrives empty is a malformed body.
- A business-error response is the opposite shape: the §3.4 capture carries only `success`, `ts`, `errorCode`,
  `errorMessage` and `signature`, with none of the payment fields. That is consistent — §3.6 raises at step 4,
  before the echo check at step 6 would look for a `prestoMrn` that is not there — but it means the two response
  shapes are two dataclasses, not one with every field optional. **[P]**

### 3.6 Responses

Handle a response in this order:

1. **Status not 200:** HTTP error. The body is unsigned and not verified; details are in the `x-http-error-code`
   and `x-http-error` headers (case-insensitive), which are always set **[C]**. There is no rate limiting, so no
   429 **[C]**.
2. **Parse** (§3.5). Failure: malformed body.
3. **Signature:** missing or invalid is a signature error. This comes **before** `success`, because business errors
   are signed too. **[C]**
4. **`success`:** always present **[C]**. `False` is a business error with `errorCode` and `errorMessage`; absent
   or non-boolean is a malformed body. Nothing is defaulted, so the webhook side (§3.7) reads the same way.
5. **Map fields** (§3.8). A missing required field is a malformed body. A field documented as a string always
   arrives as a string **[C]**, but a number or bool there is still coerced to text rather than rejected, because
   rejecting an authentic body after the operation took effect helps nobody; `strict=True` (§4) rejects instead,
   so staging reports the contract violation. **[P]**
6. **Echo check:** `prestoMrn`, and `txnRefNum` where the response carries it, must equal what was signed into the
   request. A mismatch is a response error. The SDK knows what it sent, so this costs nothing and catches a
   mixed-up or replayed response. **[P]**

For `init`, `reverse` and `refund`, a status of 500 or above, or a failure at steps 2, 3, 5 or 6 after a 200, means
**the operation may have taken effect**; reconcile with `query`. The same failures on `query` mean nothing happened,
so the SDK decides this per operation at the point the exception is raised (§4, `may_have_taken_effect`). A
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

**Retries make the merchant's handler idempotent by necessity.** Three consequences the SDK designs around:

- **A permanent failure must not be answered with `{"resend":true}`.** A bad signature, a `mid` that is not ours
  or a stale `ts` will fail identically on every redelivery, so asking for a resend builds a loop that only ends
  when Presto gives up. `resend:true` is for transient merchant-side failures — the database was down — and
  `NotifyAck.for_error(exc)` encodes exactly that split. **[P]**
- **The freshness window is 15 minutes,** the same as request timestamps (§3.3). A redelivery carries a fresh
  `ts` **[C]**, so the last attempt of the schedule above is timestamped when it is sent, not when the event
  happened, and a legitimate redelivery never looks stale. The window is configurable for hosts that queue
  notifications before verifying them. **[P]**
- **`eventRefNum` is stable across redeliveries of the same event** **[C]**, so it is the deduplication key, and
  the ~18-minute schedule sizes the retention. A merchant that fulfils on each delivery double-fulfils up to five
  times, so the README's handler shape is dedupe-first. **[P]**

**Verification**, in order:

1. Parse the **raw body** — `request.body` in Django, `request.get_data()` in Flask, `await request.body()` in
   FastAPI, never a framework's already-parsed dict re-serialized (§7).
2. Signature present and valid, otherwise a signature error.
3. Map fields (§3.8). `success` is always present **[C]**; absent is a malformed body.
4. `mid` must be one of the configured merchant IDs, otherwise a signature error **[P]**. This is mandatory, not
   defensive: Presto confirms one key signs for every merchant (§13 round 1, answer 10), so the signature alone
   says nothing about who the event is for. One endpoint serving several `mid`s is a normal deployment for the
   same reason, so the verifier takes a set and reports which one matched.
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
round 1, answer 9), so hard-rejecting at `≤50` would fail requests the gateway would have accepted. The SDK
carries the numbers as documentation and as `strict`-mode checks (§4), and never rejects on length otherwise.
**[P]**

**Requests** (Python names are the snake_case of these, per §4)

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
`paymentRequestDate: "20260924133756.056"` **[C]** — and are passed through as `str`, since only some of them are
confirmed and an unparseable date should not fail an authentic response. `parse_gateway_timestamp` (§4) is the
supported way to read them; it returns an aware `datetime`.

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
  SDK sets `may_have_taken_effect = True` and `reconcile_by = {"txn_ref_num": ...}` on that business error.
  Treating it as "the payment succeeded" would fulfil orders whose init was rejected downstream. **[P]**

### 3.10 Keys

- Merchant private key: RSA, delivered at onboarding as a PKCS#12 keystore. **[C]**
- Presto public key: RSA, delivered as an X.509 certificate (PEM or DER). **[C]**
- One Presto key signs responses and webhooks for all merchants, and rotations are announced to partners out of
  band **[C]**. There is no `kid` on the wire, so an overlap period means holding both keys and trying each:
  `presto_public_key` takes a sequence (§4).

## 4. API

```python
from presto_pay import PrestoPay, PaymentMethod, TxnType, NotifyAck, PrestoPayError

presto = PrestoPay(
    environment="staging",                       # "staging" | "production" | Environment(base_url=...)
    merchant_id=os.environ["PRESTOPAY_MID"],
    private_key=os.environ["PRESTOPAY_PRIVATE_KEY"],        # PKCS#8 PEM, or a PrivateKey from load_private_key()
    presto_public_key=os.environ["PRESTOPAY_PUBLIC_KEY"],   # one PEM, or a list during a key rotation
    # deadline=30.0,                             # seconds, whole call, retries included
    # retry_reads=RetryReads(max_retries=2, initial_backoff=0.2, max_backoff=5.0, jitter=True),
    # webhooks=WebhookOptions(max_timestamp_age=900.0),     # redeliveries carry a fresh ts, see §3.7
    # strict=False, redact_error_bodies=True,
    # http_client=httpx.Client(proxy=...), clock=time.time,
)

payment = presto.payments.init(
    presto_mrn="YOUR_PRESTO_MRN",
    txn_type=TxnType.WEB_PAY,
    txn_ref_num="order-123",
    display_desc="Order 123",
    amount=10_000,
    currency_code="MYR",
    notify_url="https://your-app.example/presto/notify",
    redirect_url="https://your-app.example/presto/return",
    allowed_payment_methods=[PaymentMethod.WALLET],
    # item_list=[LineItem(...)], session_validity=datetime(...)
)
payment.payment_url
```

Async is the same API with `AsyncPrestoPay` and `await`, including `async with` for shutdown. Both clients are
built from one sans-IO core (§5), and a CI test asserts that a sync call and an async call with the same inputs
and the same clock produce byte-identical request bodies — the failure mode of a two-implementation SDK is that
the seldom-used half drifts, and it drifts in the signature.

Every request takes `presto_mrn`, because one `mid` can have several (§3.2). To serve several merchants, create
one client per `mid`.

| Choice | Reason |
|--------|--------|
| Keyword arguments on operations, not a request object | `presto.payments.init(txn_ref_num=..., amount=...)` is what a Python caller expects, it type-checks under mypy, and there is no second class to import. `LineItem` stays a dataclass because it is nested |
| snake_case, mechanically mapped | Wire names fail every linter and read as foreign in Python. The transform is `txnRefNum` ↔ `txn_ref_num` with no exceptions, the §3.8 tables are still the field reference, and every result exposes `.raw` with the wire body for logging and for fields the SDK does not model yet |
| Frozen dataclasses for results, `slots=True` | Immutable, cheap, `repr` that is safe to log after redaction, and `dataclasses.asdict` for callers that want a dict |
| `PrestoPay(...)` is a constructor, not a factory | Key material is parsed eagerly so a bad PEM raises at startup, not on the first payment at 02:00 |
| `presto_public_key` accepts a sequence | Rotation has no `kid` on the wire (§3.4), so overlapping keys must be tried in turn |
| `http_client` injection | An `httpx.Client` covers proxies, custom TLS, retries-off, tracing and connection limits without the SDK inventing a transport interface. Django and Celery users can share one pool |
| `from_env(os.environ)` | Works with `os.environ`, a dict from a secrets manager, or `django.conf.settings` flattened |
| `strict=True` | Presto has confirmed rules the SDK still tolerates violations of, and documented lengths it does not itself enforce. Strict rejects instead of coercing, so staging (§11) reports contract drift while production stays lenient |

Context managers: `with PrestoPay(...) as presto:` closes an SDK-created `httpx.Client`; an injected client is
left alone, because closing something the caller owns is how you break the second request in a Celery worker.

**Escape hatch.** `presto.raw.post(path, body)` signs, sends, verifies and returns the parsed dict, and
`sign(canonical)` / `verify_body(body)` are exported. Error codes are open-ended and the gateway will grow
endpoints faster than the SDK; this turns "not supported yet" into three lines of user code instead of a fork.

Other exports: `create_webhook_verifier()`, `load_private_key(pem_or_p12, password=None)`,
`load_presto_public_key(pem_or_der)`, `canonicalize(text_or_bytes)` (signature debugging),
`format_gateway_timestamp(dt)`, `parse_gateway_timestamp(ts)`, `from_env(env)`, `may_have_succeeded(exc)`,
constants, exception classes, `__version__`.

### Constants

```python
class PaymentStatus(StrEnum):
    AUTHORISED = "Authorised"
    PENDING_AUTHORISE = "PendingAuthorise"
    ...
```

**Member names follow PEP 8**, so they are `SCREAMING_SNAKE_CASE` and the wire value lives in the value, where
the gateway's exact spelling is preserved byte for byte. The other SDKs name these after the wire value directly
because Go's and TypeScript's conventions allow it and Python's does not; the value is identical in all four, so
the vectors and the §3.8 tables still read the same everywhere.

The cost is that a reader holding a wire string has to find the member, and the awkward values are the ones that
make it worth naming the rule: `PmPgCard` is `PM_PG_CARD`, `UnionPayQR` is `UNION_PAY_QR`, `Subwallet_NearU` is
`SUBWALLET_NEAR_U`. Nobody should have to guess, so lookup by value is the documented direction —
`PaymentStatus("PmPgCard")` and `PaymentStatus.try_parse(value)` both work — and a test asserts every member's
value against the code lists in `spec/vectors`, so a mis-transcribed value fails CI even though a
mis-transcribed name would not be visible.

`StrEnum` members **are** `str`, so `result.payment_status == PaymentStatus.AUTHORISED` works while the
attribute itself stays a plain `str` carrying whatever the gateway sent. That is the whole reason results are
not typed as the enum: the lists are open-ended (§3.8), and a new payment method must not raise `ValueError`
inside the mapper. `try_parse` returns `None` for the unknown ones.

### Errors

All inherit `PrestoPayError(Exception)`, with `__cause__` preserved:

```python
class PrestoPayError(Exception):
    operation: Operation          # "init" | "query" | "reverse" | "refund" | "webhook" | "config"
    may_have_taken_effect: bool
    reconcile_by: ReconcileKey | None   # {"txn_ref_num": ...} or {"payment_ref_num": ...}
```

| Class | When | Extra attributes |
|-------|------|------------------|
| `PrestoPayConfigError` | Invalid options or request input, including unencodable strings | `field` |
| `PrestoPayTransportError` | Network failure, timeout, cancellation | `request_not_sent` |
| `PrestoPayApiError` | Non-200 status (`kind="http"`) or `success: false` (`kind="business"`) | `kind`, `http_status`, `error_code`, `error_message`, `raw_body`; `canonical` on `1006` / `1007`, and the observed clock offset on `1005` (§3.3) |
| `PrestoPaySignatureError` | Missing or invalid signature, wrong webhook `mid`, stale webhook `ts` | `source` (`"response"` / `"webhook"`), `canonical` |
| `PrestoPayResponseError` | Malformed body, missing required field, bad `ts`, echo mismatch | `source`, `raw_body` |

`PrestoPayTransportError` also subclasses nothing from httpx: an httpx exception leaking out of the SDK would
make `httpx` part of the public API, and swapping the client later would then be a breaking change. The original
is in `__cause__`.

**`may_have_taken_effect` is decided where the exception is raised, not by the handler.** Only there does the SDK
still know which operation ran, and the answer depends on it: a 500 on `init` is indeterminate, a 500 on `query`
means nothing happened. `reconcile_by` carries the lookup key from §3.9, so the recovery path is

```python
try:
    payment = presto.payments.init(...)
except PrestoPayError as exc:
    if exc.may_have_taken_effect:
        payment = presto.payments.query(**exc.reconcile_by)
    else:
        raise
```

rather than the caller re-threading request state into the `except` block. A business error with `errorCode`
`1203` gets the same treatment even though the call plainly failed, because the code proves an earlier init
created a record (§3.9).

**Identity.** Plain `isinstance` — unlike the JS SDK, one environment cannot hold two copies of a distribution,
so there is no branding problem to solve. `may_have_succeeded(exc)` is exported for handlers that catch broad.

**PII.** `raw_body` and `canonical` can contain `cardBin`, `cardSummary`, `receiptEmail` and `receiptName`, and
whole exceptions get logged by every traceback handler in existence. They are redacted by default, including in
`__str__` and `__repr__`; `redact_error_bodies=False` opts in to the full text.

## 5. Implementation

**Sans-IO core.** `presto_pay._core` turns inputs into a `PreparedRequest` (method, url, headers, body bytes) and
turns a `RawResponse` (status, headers, body bytes) into a result or an exception. It performs no IO, takes the
clock as a parameter, and holds every rule in §3. `PrestoPay` and `AsyncPrestoPay` are thin shells over it —
roughly "prepare, send, interpret, repeat on retry" in each. Everything worth testing is therefore testable
without a socket or an event loop, and the sync/async parity test (§4) is a comparison of two `PreparedRequest`s.

Python-specific hazards the implementation has to get right, each with a test:

- **`bool` is an `int`.** `isinstance(True, int)` is `True`, so the value renderer must test `bool` **before**
  `int` or `True` canonicalizes as `1` and every signed body with a boolean fails.
- **`json.loads` accepts `NaN`, `Infinity` and `-Infinity`** by default, which are not JSON and cannot be
  rendered. Pass `parse_constant=_reject` and `parse_float=_reject`; the float hook also catches `1200.0`,
  `1e400` and anything with an exponent, which §3.4 says cannot occur and §3.5 says to reject rather than round.
- **`base64.b64decode` ignores invalid characters** unless `validate=True`. Without it, a corrupted signature
  decodes to something shorter and fails verification with a confusing message instead of a clean one.
- **`strftime` has no milliseconds.** `%f` is six digits, so format as
  `f"{dt:%Y%m%d%H%M%S}.{dt.microsecond // 1000:03d}"`; parsing is strict at 18 characters, digits only,
  calendar-valid, via `datetime.strptime(ts, "%Y%m%d%H%M%S.%f")` after a regex gate.
- **Fixed offset, never a named zone.** `TZ8 = timezone(timedelta(hours=8))`. `ZoneInfo("Asia/Kuala_Lumpur")`
  happens to be +08:00 today, and encoding a political boundary into a signature is how SDKs break on a Sunday.
- **`sorted()` on `dict` keys** gives code point order, which §3.4 requires; `locale` must not be involved.
- **Unpaired surrogates** are rejected at validation with the field name, not at `json.dumps` (§3.4).

Crypto and keys are `cryptography`, so there is no hand-written parser anywhere in the package — the JS SDK
needs a DER walker to pull `subjectPublicKeyInfo` out of a certificate, and Python does not:

- `serialization.load_pem_private_key`, `load_der_private_key`, `pkcs12.load_key_and_certificates`.
- `x509.load_pem_x509_certificate` / `load_der_x509_certificate`, then `.public_key()`; `load_pem_public_key` for
  a bare SPKI.
- `key.sign(data, padding.PKCS1v15(), hashes.SHA256())` and `public_key.verify(...)`, catching `InvalidSignature`.
- Reject non-RSA keys and keys under 2048 bits at load time with a message naming the file.

Outgoing bodies: validate, build a dict of only the fields that are set, add `mid`, `presto_mrn`, `ts`, sign,
then `json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()`. Stringified arrays (§3.5) are
`json.dumps(list)`.

## 6. HTTP, retries, idempotency

One `httpx` call path for sync and async: `client.post(url, content=body, headers=headers)` with
`follow_redirects=False`.

- **Deadline:** `deadline` (default 30 s) is the budget for the **whole call**, retries and backoff included;
  each attempt gets what is left, as an `httpx.Timeout`. A per-attempt timeout with two retries is a worst case
  over 90 s, which outlives the request budget of every ASGI server and most reverse proxies, so the caller gets
  killed mid-retry instead of getting the SDK's exception. Async also honours an outer `asyncio.timeout`;
  a `CancelledError` is re-raised, never converted, so structured concurrency still works.
- **Responses:** every status comes back as a response; only 200 bodies are parsed and verified (§3.6). A 3xx is
  an HTTP error (redirects are off) and is never retried.
- **`request_not_sent`:** httpx's exception taxonomy answers this far better than a code allowlist. Not sent:
  `ConnectError`, `ConnectTimeout`, `ProxyError`, `UnsupportedProtocol`, `PoolTimeout`, and any TLS failure,
  which httpx raises as `ConnectError` — none of these can have written a request byte. Unknown, therefore
  **sent**: `ReadTimeout`, `WriteTimeout`, `WriteError`, `ReadError`, `RemoteProtocolError`, `LocalProtocolError`
  and everything unrecognized. An injected client that raises its own exception types is treated as sent.
- **Proof:** a socket suite drives the real cases against loopback servers — unresolvable host, closed port,
  blackholed connect, self-signed certificate, reset after the body was sent, headers never sent — and asserts
  the classification on every Python version in CI. An httpx or httpcore upgrade that reshuffles exceptions fails
  these tests instead of silently changing retry behaviour.
- **Retry policy:** follows §3.9, and the option is `retry_reads` rather than `retry` because that is all it
  governs. `init`, `reverse` and `refund` are retried only on the not-sent set above. Exponential backoff from
  `initial_backoff`, capped at `max_backoff`, full jitter on by default so a fleet does not retry in lockstep
  after a gateway blip. Presto confirms there is no rate limiting, so no 429 is expected; `Retry-After` is still
  honoured over the computed delay, subject to the remaining deadline. Backoff sleeps are `time.sleep` and
  `asyncio.sleep` respectively, and are interrupted by cancellation.
- **Injected clients must not retry.** `httpx` does not by default; `httpx.HTTPTransport(retries=n)` does, and it
  only retries connection failures, which is exactly the safe set — the README says so rather than forbidding it.

## 7. Webhooks

`presto.webhooks.verify(body)` takes `bytes` or `str` and is sync; there is no IO in verification, so the async
client exposes the same method rather than a coroutine that never awaits. `create_webhook_verifier(...)` builds a
standalone verifier for services that only receive webhooks and never call the API — it needs no private key.

Getting the **raw** body is the one thing the merchant has to do right, and it differs per framework, so the
README has a snippet for each rather than the SDK guessing:

| Framework | Raw body |
|-----------|----------|
| Django | `request.body` |
| Flask | `request.get_data()` |
| FastAPI / Starlette | `await request.body()` |
| Pyramid | `request.body` |
| aiohttp | `await request.read()` |

Passing a `dict` raises `PrestoPayConfigError` pointing at these, because `json.dumps(request.json())` reorders
nothing in CPython but re-escapes non-ASCII and drops the original spacing, and the signature is over bytes.

`merchant_id` accepts a string or a set; the verified event reports which one matched (§3.7 step 4).
`presto_public_key` accepts a sequence for rotation, as on the client.

`NotifyAck.OK` and `NotifyAck.RESEND` are the two reply bodies as `bytes`, with the right content type available
as `NotifyAck.CONTENT_TYPE`. `NotifyAck.for_error(exc)` picks the reply for a caught exception, because getting
this wrong loops: Presto retries at 1, 2, 5 and 10 minutes (§3.7), so answering a bad signature, a foreign `mid`
or a stale `ts` with `resend:true` asks for four redeliveries that will fail identically. It returns `OK` for
every `PrestoPaySignatureError` and `PrestoPayResponseError` — permanent, nothing a retry fixes — and `RESEND`
for anything else, which is the merchant's own transient failure.

The event carries `event_ref_num`, stable across the up-to-five deliveries of one event (§3.7), and the derived
`payment_status`.

## 8. Configuration and keys

| Variable | Description |
|----------|-------------|
| `PRESTOPAY_ENV` or `PRESTOPAY_BASE_URL` | `staging` / `production`, or an explicit URL |
| `PRESTOPAY_MID` | merchant ID |
| `PRESTOPAY_PRIVATE_KEY` or `PRESTOPAY_PRIVATE_KEY_FILE` | PKCS#8 PEM text, or a path to a PEM or `.p12` |
| `PRESTOPAY_PRIVATE_KEY_PASSWORD` | keystore password, if a `.p12` or an encrypted PEM is used |
| `PRESTOPAY_PUBLIC_KEY` or `PRESTOPAY_PUBLIC_KEY_FILE` | Presto certificate (PEM or DER), or SPKI PEM |

`PrestoPay.from_env(os.environ)` reads these. Because `cryptography` reads PKCS#12 and encrypted PEM directly, the onboarding keystore is a supported input —
**verified against the real one**: `pkcs12.load_key_and_certificates(data, b"...")` returns the 2048-bit key
and the certificate from `keys/presto_rm_keystore.p12`, whose certificate bag is RC2-40-CBC encrypted and which
the OpenSSL 3 command line refuses without the legacy provider. `cryptography` reads it anyway, so Python users
skip the conversion that §8 of the JavaScript and Go plans has to document:

```python
presto = PrestoPay(
    private_key=Path("partner.p12"),
    private_key_password=os.environ["PRESTOPAY_PRIVATE_KEY_PASSWORD"],
    ...
)
```

Key errors are specific: a certificate passed as the private key, a non-RSA key, a wrong password, a truncated
PEM. Each message names the input and the fix.

## 9. Wire contract and test vectors

`presto-pay-spec` is a repository of its own holding `wire-contract.md` (the reviewed, language-neutral version
of §3), `vectors/` and throwaway `keys/`. It is vendored into this repo as a submodule at `spec/`, pinned to a
commit, and CI fails if the pin is behind the spec's default branch by more than a release.

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
| `responses.json` | status, headers, body, the request it answers → result fields, or error class and fields (including echo mismatches and `may_have_taken_effect` per operation) |
| `webhooks.json` | body, merchant IDs, `now` → event fields, or error class. Includes a redelivery: same `eventRefNum`, later `ts`, both accepted under the 15-minute window |

Vector field names are the **wire** names; each SDK maps them to its own naming (§4) in the test harness, which
is itself a small test of the mapping rule.

## 10. Repository layout

```
src/presto_pay/
  __init__.py          public exports
  client.py            PrestoPay, AsyncPrestoPay, from_env
  errors.py  constants.py  _version.py
  _core/               protocol.py (sans-IO), canonical.py, timestamp.py, crypto.py, keys.py, mapping.py
  payments/            inputs, to_wire, results
  webhooks/            verifier, NotifyAck, events
  py.typed
spec/                  submodule: presto-pay-spec
tests/                 vectors, unit, sockets, parity, staging
```

`_core` is private by leading underscore and by not being re-exported; the public surface is `presto_pay` and
nothing else, which keeps `__init__.py` the single place where compatibility is promised.

## 11. Testing

- **Vectors:** every file in `spec/vectors/` runs as parametrized pytest cases, sync and async.
- **Unit and contract tests:** an `httpx.MockTransport` plays the gateway and signs responses with the test key.
  Covers every operation, validation message, error class, retry matrix entry and webhook outcome.
- **Parity:** the same inputs through `PrestoPay` and `AsyncPrestoPay` must produce identical prepared requests
  (§4).
- **Socket suite:** the `request_not_sent` cases from §6, against loopback servers.
- **Static:** mypy `--strict`, ruff (including `RUF`, `B`, `S`), and a test asserting `__version__` matches the
  package metadata.
- **Packaging:** install the built wheel into a clean venv and import it; check `py.typed` ships; check the sdist
  contains `spec/` vectors so a downstream rebuild can run the suite.
- **Staging:** `pytest -m staging`, skipped unless `PRESTOPAY_STAGING_SMOKE=1`, with `strict=True` (§4) so
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
| 1 | Scaffold | Repo, `pyproject.toml` with hatchling, pytest + mypy strict + ruff, CI on 3.11–3.14 |
| 2 | Wire core | Canonicalization, timestamps, sign and verify, PEM / DER / PKCS#12 import; those vectors pass |
| 3 | Sans-IO protocol | `PreparedRequest` / response interpretation, exception hierarchy, `may_have_taken_effect` and `reconcile_by` per operation — all with no IO |
| 4 | Send path | Sync and async shells, whole-call deadline, jittered `retry_reads`, `request_not_sent` classification proven by the socket suite, parity test |
| 5 | Payments | Four operations, validation, response mapping with the echo check, `raw.post`, constants; request and response vectors pass |
| 6 | Webhooks + config | Verifier with multi-`mid` and multi-key support, `NotifyAck`, `from_env`, key error messages; webhook vectors pass |
| 7 | Release 0.1.0 | README (quick start, `.p12` handling, idempotency with `may_have_taken_effect` / `reconcile_by`, the redaction policy, webhook snippets for Django / Flask / FastAPI that dedupe on `event_ref_num`), CHANGELOG, staging smoke under `strict`, PyPI publish with trusted publishing and attestations |
| later | | A Django app and a FastAPI router as separate packages, if they earn it |

## 13. Questions for Presto

All answered. Recorded here because §3 cites them, and because the next person to read a **[C]** tag will want to
know what it rests on.

### Round 1

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | Non-integer or >2^31 numbers in signed bodies? | No; `"amount": 100` | §3.4 integer rendering → **[C]**; non-integers cannot occur |
| 2 | Can a string field arrive as a number or boolean? | No | §3.6 step 5 coercion kept only as tolerance; `strict` rejects |
| 3 | Are the list fields always strings? | Yes, always string | §3.5 → **[C]**; native arrays cannot occur on the wire |
| 4 | Does the gateway send `null`? | Yes | §3.5 → **[C]**; rendering answered in round 2 |
| 5 | Is `success` always present? | Yes | §3.6 and §3.7 stop defaulting it; absent is a malformed body |
| 6 | Request `ts` validity window | 15 minutes | §3.3 → **[C]** |
| 7 | Non-200 statuses, `x-http-error-*`, rate limiting | Headers always set; no rate limiting | §3.6 step 1 → **[C]**; no 429 expected |
| 8 | Webhook resend and reply handling | Presto retries on its own backoff | §3.7 → **[C]**; drives `NotifyAck.for_error` |
| 9 | Are length limits characters or bytes? | No limit today | §3.8 lengths become documentation and `strict` checks |
| 10 | One key for all merchants; rotation? | Yes; Presto informs partners | §3.10 → **[C]**; the webhook `mid` check is mandatory and keys are a sequence |

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
verification or a lost payment, and staging under `strict=True` (§11) is what reports it.
