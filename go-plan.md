# Plan: Presto Pay SDK for Go

Status: proposal, pre-implementation. This document is self-contained: it defines the gateway contract (§3), the
SDK's API and implementation, and how the two are tested. §3 is shared with the JavaScript, Python and PHP SDKs;
§1 decision 1 says where it lives.

## 1. Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Repository | `github.com/prestouniverse/presto-pay-sdk-go`. The contract and vectors live in a separate `presto-pay-spec` repo, vendored here as a plain copy at `spec/` — not a git submodule — pinned to a commit. Four SDKs now implement §3, and a contract that lives inside one of them is a contract the other three fork (§9) |
| 2 | Module and package | Module path above, package `prestopay`, imported as `prestopay.New(...)`. Pre-1.0 as `v0.x`, so the API can still move; `v1.0.0` is a promise, not a version number |
| 3 | Go | **1.24+** (1.24, 1.25, 1.26 in CI). No build tags, no cgo, one build for every GOOS |
| 4 | Dependencies | **None.** `crypto/rsa`, `crypto/x509`, `encoding/pem`, `encoding/json`, `net/http` and `net/http/httptrace` cover every requirement, and a payment SDK in someone's `go.mod` should not bring a dependency tree with it |
| 5 | Keys | Private key: PKCS#8 PEM. Presto key: X.509 certificate (PEM or DER) or PKIX/SPKI PEM. **No PKCS#12**: the stdlib has none, `golang.org/x/crypto/pkcs12` is frozen, decrypts only RC2/3DES and cannot read modern keystores, so §8 documents the one-line `openssl` conversion instead of shipping a parser that fails on half the inputs |
| 6 | Context | Every network method takes `ctx context.Context` first. No package-level client, no implicit timeouts beyond the one the caller sets |
| 7 | Concurrency | `*Client` is safe for concurrent use and is meant to be built once at startup and shared, like `*sql.DB` |
| 8 | Naming | Go initialisms win over wire spelling: `PrestoMRN`, `NotifyURL`, `DeviceIP`. Struct tags carry the wire name, so the mapping is visible in the type definition and `go vet`'s `structtag` check guards it |
| 9 | Code comments | Never cite this plan or the wire contract by filename or section number (no `go-plan.md §N`, no `wire-contract.md §N`). Explain the *why* in the comment itself, so it still reads once the plan is gone, renamed, or out of date |

## 2. Goals and non-goals

**Goals**

- The four payment operations (`Init`, `Query`, `Reverse`, `Refund`), webhook verification, and key loading.
- An API that reads as ordinary Go: context first, `(result, error)`, errors inspected with `errors.As`, an
  `http.Handler`-shaped webhook path.
- Safe by default: no retries of `Init`, `Reverse` or `Refund` unless the request certainly was not sent; webhook
  `mid` check and replay window on; an error that says when the operation may have happened anyway.

**Non-goals (0.1.0)**

- PKCS#12, a framework integration, generics-heavy request builders.

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
  `presto-pay-sdk-go/<version>` **[P]**. Redirects are not followed **[P]**.

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
   anything special. In Go this is `slices.Sort` on `[]string`, which compares bytes.
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
fine as long as the gateway decodes the strings that were signed **[C]**. Three consequences for Go:

- **Reject outgoing strings that are not valid UTF-8.** A Go `string` is arbitrary bytes; `encoding/json`
  silently replaces invalid sequences with U+FFFD, so the body would carry a different string than the canonical
  one that was signed, and the gateway would reject a request the SDK considered fine. `utf8.ValidString` at
  validation turns that into a named field error. **[P]**
- **HTML escaping is harmless but still turned off.** `json.Marshal` escapes `<`, `>` and `&` as `\u003c` and
  friends; since the canonical string uses decoded values, this cannot break a signature. It is disabled anyway
  via `json.Encoder.SetEscapeHTML(false)`, because a body that reads the same as what was signed is worth the
  one line when someone is debugging with a packet capture.
- Send integers only. **[C]**

### 3.5 JSON rules

**Incoming bodies** **[P]**

- Must be a single JSON object. Duplicate keys resolve last-wins, and the same decoded map is used for
  verification and for field mapping, so what was verified is what the merchant reads.
- **Decode numbers with `json.Decoder.UseNumber()`.** The default for `any` is `float64`, which silently rounds
  above 2^53 and renders as `1.2e+07` instead of `12000000` — either one produces a canonical string that does
  not match, and the failure looks like a bad signature rather than a decoding bug. With `json.Number` in hand,
  `strconv.ParseInt` both validates and renders.
- Reject integers outside ±(2^53 − 1). Go would hold them exactly in an `int64`, but the shared vectors (§9)
  must produce one answer in all four SDKs, and that bound is the tightest of the four. **[P]**
- Decode bytes as UTF-8; invalid input is a malformed body.

**Stringified arrays.** Every list field is a **JSON string that contains an array**, never a native array, in
both directions (§13 round 1, answer 3) **[C]**. They are canonicalized as ordinary strings, and unmarshalled a
second time on input. A captured query response carrying `"refundDetails": "[]"` and `"paymentDetails": "[]"`
verifies only when each renders as the literal two characters `[]`, so this is confirmed rather than inferred,
and an empty list arrives as `"[]"` and not as `""` **[C]**. Whether such a field can be absent entirely is
**[U]**, so a missing one is read as an empty slice.

| Field | Direction | Elements |
|-------|-----------|----------|
| `allowedPaymentMethods` | init request | payment method codes |
| `itemList` | init request | line items (§3.8) |
| `refundDetails` | query response | refund details (§3.8) |
| `paymentDetails` | query response, webhook | payment details (§3.8) |

The SDK takes and returns real slices for these; the string is an encoding detail that never reaches the caller.

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
- Mapping normalizes `""` and `null` to the zero value on optional fields. Go has no `undefined`, and that is a
  simplification here rather than a loss: an empty `ErrorCode` and an absent one are the same thing to a caller
  who is told to branch on `Success` (§3.6 step 4), and dates stay strings (§3.8) so nothing parses `""`.
- A business-error response is the opposite shape: the §3.4 capture carries only `success`, `ts`, `errorCode`,
  `errorMessage` and `signature`, with none of the payment fields. That is consistent — §3.6 returns an error at
  step 4, before the echo check at step 6 would look for a `prestoMrn` that is not there — and it is why the
  error carries those fields rather than the result struct carrying them. **[P]**

### 3.6 Responses

Handle a response in this order:

1. **Status not 200:** HTTP error. The body is unsigned and not verified; details are in the `x-http-error-code`
   and `x-http-error` headers (`http.Header.Get` is case-insensitive), which are always set **[C]**. There is no
   rate limiting, so no 429 **[C]**.
2. **Parse** (§3.5). Failure: malformed body.
3. **Signature:** missing or invalid is a signature error. This comes **before** `success`, because business errors
   are signed too. **[C]**
4. **`success`:** always present **[C]**. `false` is a business error with `errorCode` and `errorMessage`; absent
   or non-boolean is a malformed body. Nothing is defaulted, so the webhook side (§3.7) reads the same way.
5. **Map fields** (§3.8). A missing required field is a malformed body. A field documented as a string always
   arrives as a string **[C]**, but a number or bool there is still coerced to text rather than rejected, because
   rejecting an authentic body after the operation took effect helps nobody; `Strict` (§4) rejects instead, so
   staging reports the contract violation. **[P]**
6. **Echo check:** `prestoMrn`, and `txnRefNum` where the response carries it, must equal what was signed into the
   request. A mismatch is a response error. The SDK knows what it sent, so this costs nothing and catches a
   mixed-up or replayed response. **[P]**

For `Init`, `Reverse` and `Refund`, a status of 500 or above, or a failure at steps 2, 3, 5 or 6 after a 200, means
**the operation may have taken effect**; reconcile with `Query`. The same failures on `Query` mean nothing
happened, so the SDK decides this per operation where the error is constructed (§4, `MayHaveTakenEffect`). A
`success: false` at step 4 otherwise means nothing happened, with `1203` on init the one exception (§3.9). **[P]**

Error codes are four-digit strings and open-ended; unknown codes are passed through **[U]**. Codes the SDK relies
on:

| Code | Meaning |
|------|---------|
| `1005` | Request `ts` outside the validity window (clock skew) **[C]** |
| `1006`, `1007` | Request signature invalid or failed verification. The two do not distinguish a malformed signature from a well-formed one that failed to verify (§13 round 2, answer 6), so the SDK gives both the same message and attaches `Canonical` to either **[C]** |
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
  `AckForError(err)` encodes exactly that split. **[P]**
- **The freshness window is 15 minutes,** the same as request timestamps (§3.3). A redelivery carries a fresh
  `ts` **[C]**, so the last attempt of the schedule above is timestamped when it is sent, not when the event
  happened, and a legitimate redelivery never looks stale. The window is configurable for hosts that queue
  notifications before verifying them. **[P]**
- **`eventRefNum` is stable across redeliveries of the same event** **[C]**, so it is the deduplication key, and
  the ~18-minute schedule sizes the retention. A merchant that fulfils on each delivery double-fulfils up to five
  times, so the README's handler shape is dedupe-first. **[P]**

**Verification**, in order:

1. Read and parse the **raw body** — `io.ReadAll(r.Body)` with a `http.MaxBytesReader` cap, never a re-marshalled
   struct (§7).
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
other codes the event code is the status. `Query` remains the authoritative source of payment state.

### 3.8 Operation fields

All **[U]** unless noted. Amounts are integers in minor currency units **[C]**.

**The lengths below are documented maxima, not gateway limits.** Presto enforces no length limit today (§13
round 1, answer 9), so hard-rejecting at `≤50` would fail requests the gateway would have accepted. The SDK
carries the numbers as documentation and as `Strict`-mode checks (§4), and never rejects on length otherwise.
**[P]**

**Requests** (Go field names are the exported form of these, per §1 decision 8)

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
`paymentRequestDate: "20260924133756.056"` **[C]** — and are `string` on the result structs, since only some of
them are confirmed and an unparseable date should not fail an authentic response. `ParseTimestamp` (§4) is the
supported way to read them, and returns a `time.Time` in a fixed +08:00 zone.

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

- `Init`, `Reverse` and `Refund` must not be resent once any byte may have reached the gateway; resending init
  with the same `txnRefNum` returns `1203`, which means a payment record for it exists — possibly an authorised
  one. **[C]**
- They may be retried only when the request certainly never left the process (DNS failure, connection refused,
  connect or TLS failure before the body was written). When unsure, do not retry. **[P]**
- `Query` may be retried on transport errors and on statuses of 500 and above. **[P]**
- Every attempt gets a fresh `ts` and signature **[C]** (a stale `ts` fails with `1005`).
- After an ambiguous failure, look the transaction up with `Query`: by `txnRefNum` after init, by `paymentRefNum`
  after reverse or refund. **[P]**
- `1203` says a record exists but not what state it is in, so it is a `Query` prompt rather than an answer: the
  SDK sets `MayHaveTakenEffect` and a `ReconcileBy` of `txnRefNum` on that business error. Treating it as "the
  payment succeeded" would fulfil orders whose init was rejected downstream. **[P]**

### 3.10 Keys

- Merchant private key: RSA, delivered at onboarding as a PKCS#12 keystore. **[C]**
- Presto public key: RSA, delivered as an X.509 certificate (PEM or DER). **[C]**
- One Presto key signs responses and webhooks for all merchants, and rotations are announced to partners out of
  band **[C]**. There is no `kid` on the wire, so an overlap period means holding both keys and trying each:
  `PrestoPublicKeys` is a slice (§4).

## 4. API

```go
import "github.com/prestouniverse/presto-pay-sdk-go/prestopay"

client, err := prestopay.New(prestopay.Config{
    Environment:      prestopay.Staging,          // or prestopay.Production, or BaseURL: "https://..."
    MerchantID:       os.Getenv("PRESTOPAY_MID"),
    PrivateKeyPEM:    []byte(os.Getenv("PRESTOPAY_PRIVATE_KEY")),
    PrestoPublicKeys: [][]byte{[]byte(os.Getenv("PRESTOPAY_PUBLIC_KEY"))}, // several during a rotation
    // Deadline:     30 * time.Second,            // whole call, retries included
    // RetryReads:   prestopay.RetryReads{MaxRetries: 2, InitialBackoff: 200 * time.Millisecond, MaxBackoff: 5 * time.Second},
    // Webhooks:     prestopay.WebhookOptions{MaxTimestampAge: 15 * time.Minute},
    // Strict:       false, RedactErrorBodies: true,
    // HTTPClient:   &http.Client{Transport: myTransport},
    // Now:          func() time.Time { return ... },
})

res, err := client.Payments.Init(ctx, prestopay.InitRequest{
    PrestoMRN:             "YOUR_PRESTO_MRN",
    TxnType:               prestopay.TxnTypeWebPay,
    TxnRefNum:             "order-123",
    DisplayDesc:           "Order 123",
    Amount:                10_000,
    CurrencyCode:          "MYR",
    NotifyURL:             "https://your-app.example/presto/notify",
    RedirectURL:           "https://your-app.example/presto/return",
    AllowedPaymentMethods: []string{prestopay.PaymentMethodWallet},
})
if err != nil { /* §4 errors */ }
res.PaymentURL
```

Every request takes `PrestoMRN`, because one `mid` can have several (§3.2). To serve several merchants, build one
client per `mid`.

| Choice | Reason |
|--------|--------|
| `New(Config{...}) (*Client, error)` | A config struct beats functional options for a flat, mostly-required configuration: it is one type to document, it zero-values sensibly, and `go doc` shows every knob in one place. Options would earn their keep only if construction had modes, and it does not |
| Request structs per operation, no builders | `InitRequest` is data. The struct tags are the §3.8 mapping, `go vet` checks them, and an unknown field is a compile error rather than a silently ignored map key |
| **Zero value means unset** for optional scalars, no pointers | Every optional number in §3.8 has a `> 0` rule and every optional string is meaningless when empty, so `*int64` would buy nothing but `prestopay.Int64(...)` noise at every call site. Documented per field |
| Operations grouped as `client.Payments.Init(...)` | Keeps `*Client` from growing a flat namespace of four verbs plus webhooks plus raw, and mirrors the other three SDKs |
| Results are structs with `Raw map[string]any` | The mapped fields for normal use, the wire body for logging and for fields the SDK does not model yet |
| `PrestoPublicKeys` is a slice | Rotation has no `kid` on the wire (§3.4), so overlapping keys must be tried in turn |
| `HTTPClient` injection | Covers proxies, custom TLS, tracing and connection pooling without the SDK inventing a transport interface. §6 lists the two settings the SDK overrides and why |
| `Strict: true` | Presto has confirmed rules the SDK still tolerates violations of, and documented lengths it does not itself enforce. Strict rejects instead of coercing, so staging (§11) reports contract drift while production stays lenient |

**Escape hatch.** `client.Raw.Post(ctx, path, map[string]any{...})` signs, sends, verifies and returns the decoded
map, and `Sign(canonical)` / `VerifyBody(body)` are exported. Error codes are open-ended and the gateway will
grow endpoints faster than the SDK; this turns "not supported yet" into three lines of user code instead of a
fork.

Other exports: `NewWebhookVerifier`, `LoadPrivateKey`, `LoadPrestoPublicKey`, `Canonicalize` (signature
debugging), `FormatTimestamp`, `ParseTimestamp`, `ConfigFromEnv`, `MayHaveSucceeded`, the constants, the error
types, and `Version`.

### Constants

Untyped string constants, not a defined type, and **the name after the prefix is the wire value verbatim**:

```go
const (
    PaymentStatusAuthorised       = "Authorised"
    PaymentStatusPendingAuthorise = "PendingAuthorise"
    TxnTypeWebPay                 = "WebPay"
    PaymentMethodWallet           = "Wallet"
    // ...
)
```

Go's MixedCaps convention already agrees with the wire spelling, so this costs nothing: the gateway's
vocabulary is what appears in its logs and in the §3.8 tables, and it survives into the identifier. The only
rule to hold is that nobody "tidies" `PaymentMethodPmPgCard` or `PaymentMethodUnionPayQR` into something more
readable, and a test asserts each constant's name is its prefix plus its value. The Python and PHP SDKs cannot
do this — PEP 8 and PSR-1 both require upper case — so they carry the wire spelling in the value only; the
values are identical in all four. `ErrorCode*` is the one exception here too, mapping descriptive names to the
four-digit codes, because `1203` is not a name.

A `type PaymentStatus string` would look tidier and would be a lie: the lists are open-ended (§3.8), so the type
would carry values that are not constants, and `switch` would still need a `default`. Result fields are `string`,
comparisons read `res.PaymentStatus == prestopay.PaymentStatusAuthorised`, and a new gateway value flows through
untouched.

### Errors

```go
type Error interface {
    error
    Operation() Operation        // Init | Query | Reverse | Refund | Webhook | Config
    MayHaveTakenEffect() bool
    ReconcileBy() (ReconcileKey, bool)
}
```

| Type | When | Extra fields |
|------|------|--------------|
| `*ConfigError` | Invalid config or request input, including invalid UTF-8 | `Field` |
| `*TransportError` | Network failure, timeout, context cancellation | `RequestNotSent` |
| `*APIError` | Non-200 status (`Kind: KindHTTP`) or `success: false` (`Kind: KindBusiness`) | `Kind`, `HTTPStatus`, `ErrorCode`, `ErrorMessage`, `RawBody`; `Canonical` on `1006` / `1007`, and the observed clock offset on `1005` (§3.3) |
| `*SignatureError` | Missing or invalid signature, wrong webhook `mid`, stale webhook `ts` | `Source`, `Canonical` |
| `*ResponseError` | Malformed body, missing required field, bad `ts`, echo mismatch | `Source`, `RawBody` |

Every one implements `Unwrap`, so `errors.Is(err, context.DeadlineExceeded)` works through a `*TransportError`,
and inspection is `errors.As`:

```go
res, err := client.Payments.Init(ctx, req)
if err != nil {
    var pe prestopay.Error
    if errors.As(err, &pe) && pe.MayHaveTakenEffect() {
        key, _ := pe.ReconcileBy()
        res, err = client.Payments.Query(ctx, prestopay.QueryRequest{TxnRefNum: key.TxnRefNum})
    }
}
```

**`MayHaveTakenEffect` is decided where the error is constructed, not by the caller.** Only there does the SDK
still know which operation ran, and the answer depends on it: a 500 on `Init` is indeterminate, a 500 on `Query`
means nothing happened. `ReconcileBy` carries the lookup key from §3.9 so the recovery path above does not
require re-threading request state. An `*APIError` with code `1203` reports both, even though the call plainly
failed, because the code proves an earlier init created a record (§3.9).

Sentinel errors are deliberately absent except `ErrKeyNotRSA` and friends in the key loader: `errors.As` on a
concrete type gives the caller the fields, which is what a payment failure needs, and a sentinel gives only a
label.

**PII.** `RawBody` and `Canonical` can contain `cardBin`, `cardSummary`, `receiptEmail` and `receiptName`, and
errors end up in logs. They are redacted in `Error()` by default, with the full text still reachable on the field
when `RedactErrorBodies: false`.

## 5. Implementation

Go-specific hazards, each with a test:

- **`net/http` may replay a POST.** `http.Transport` retries a request on a broken idle connection when it is
  "replayable", and a POST becomes replayable the moment it carries an `Idempotency-Key` or `X-Idempotency-Key`
  header. The SDK therefore never sets one and documents that a custom `Transport` or middleware must not add
  one either, because a transparent replay of `init` is exactly what §3.9 spends a section forbidding.
- **`UseNumber()` on every decode** (§3.5), and `json.Number` → `strconv.ParseInt` for both validation and
  rendering. `float64` is the default and it rounds and reformats.
- **`SetEscapeHTML(false)` on every encode** (§3.4), which also means encoding through `json.Encoder` rather
  than `json.Marshal`, and trimming the trailing newline `Encoder` appends.
- **`base64.StdEncoding.Strict()`** for signature decoding, so non-canonical padding is a verification failure
  rather than a value that decodes to something almost right.
- **`time.FixedZone("UTC+8", 8*3600)`**, never `time.LoadLocation("Asia/Kuala_Lumpur")`: the tz database may not
  be present in a scratch container at all, and a political boundary has no business inside a signature. Format
  with the reference layout `20060102150405.000`, which gives exactly three fractional digits — Go's `.000` does
  not trim, unlike `.999`, so it is the right verb here.
- **`utf8.ValidString` on outgoing strings** (§3.4).
- **Canonical building** is `keys := slices.Collect(maps.Keys(body)); slices.Sort(keys)`, skip `signature`,
  render per §3.4, join with `:` through a `strings.Builder` sized from the body length.

Crypto and keys are stdlib, so there is no hand-written parser — the JavaScript SDK needs a DER walker to pull
`subjectPublicKeyInfo` out of a certificate and Go does not:

- `pem.Decode`, then `x509.ParsePKCS8PrivateKey`; a PKCS#1 key, an encrypted PEM or a certificate in the private
  key slot each get their own message (§8).
- `x509.ParseCertificate` (DER) or `pem.Decode` + `ParseCertificate`, then `cert.PublicKey`; `ParsePKIXPublicKey`
  for a bare SPKI.
- `rsa.SignPKCS1v15(nil, key, crypto.SHA256, sum[:])` and `rsa.VerifyPKCS1v15`. Reject non-RSA keys and keys
  under 2048 bits at load time.

## 6. HTTP, retries, idempotency

One path: `http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))` on an `*http.Client`
that the SDK either creates or takes from `Config`. Two settings are forced on whatever client is supplied,
because both are correctness rather than preference, and both are documented:

- `CheckRedirect` returns `http.ErrUseLastResponse`. A 3xx is an HTTP error (§3.6 step 1), never followed — a
  redirect to another host with a signed payment body attached is not something to be relaxed about.
- The per-call deadline is applied to `ctx`, not to `http.Client.Timeout`, so it composes with the caller's own
  context instead of racing it.

- **Deadline:** `Deadline` (default 30 s) is the budget for the **whole call**, retries and backoff included;
  each attempt gets a child context with what is left. A per-attempt timeout with two retries is a worst case
  over 90 s, which outlives most inbound request budgets, so the caller gets cancelled mid-retry instead of
  getting the SDK's error.
- **`RequestNotSent` comes from `httptrace`, not from error-string matching.** The SDK attaches a
  `httptrace.ClientTrace` whose `WroteHeaderField` and `WroteRequest` hooks set an atomic flag, so the question
  "did any byte of this request reach the socket" is answered by observation rather than inference. That is a
  material advantage over guessing from error types: a `context.DeadlineExceeded` that fired during the dial and
  one that fired while waiting for a response headers are indistinguishable as errors and completely different
  for §3.9. Error inspection stays as a cross-check — `*net.DNSError`, `*net.OpError` with `Op == "dial"`,
  `*tls.CertificateVerificationError`, `x509` errors — and the two must agree in tests.
- **Proof:** a suite drives real sockets for each case (unresolvable host, closed port, blackholed connect via a
  listener that never accepts, self-signed certificate, reset after the body was written, headers never sent) on
  every Go version in CI. A stdlib change that alters the trace ordering fails these tests instead of silently
  changing retry behaviour.
- **Retry policy:** follows §3.9, and the field is `RetryReads` rather than `Retry` because that is all it
  governs. `Init`, `Reverse` and `Refund` are retried only when the trace says nothing was written. Exponential
  backoff from `InitialBackoff`, capped at `MaxBackoff`, with full jitter on by default so a fleet does not retry
  in lockstep after a gateway blip. Presto confirms there is no rate limiting, so no 429 is expected;
  `Retry-After` is still honoured over the computed delay, subject to the remaining deadline. Backoff is a
  `time.Timer` raced against `ctx.Done()`.
- **Response bodies** are read with an `io.LimitReader` (1 MiB) and always closed, including on the error paths,
  so a misbehaving gateway cannot exhaust the connection pool.

## 7. Webhooks

```go
v, err := prestopay.NewWebhookVerifier(prestopay.WebhookConfig{
    MerchantIDs:      []string{os.Getenv("PRESTOPAY_MID")},
    PrestoPublicKeys: [][]byte{[]byte(os.Getenv("PRESTOPAY_PUBLIC_KEY"))},
})

http.HandleFunc("/presto/notify", func(w http.ResponseWriter, r *http.Request) {
    event, err := v.VerifyRequest(r)   // or v.Verify(bodyBytes)
    if err != nil {
        prestopay.WriteAck(w, prestopay.AckForError(err))
        return
    }
    if err := fulfilOnce(r.Context(), event.EventRefNum, event); err != nil {
        prestopay.WriteAck(w, prestopay.AckResend)
        return
    }
    prestopay.WriteAck(w, prestopay.AckOK)
})
```

`VerifyRequest` reads the body itself, through a `http.MaxBytesReader`, and leaves `r.Body` drained — the SDK
does not restore it, because handing back a consumed-then-refilled body invites the second read that the raw-body
rule exists to prevent. `Verify([]byte)` is there for queue consumers and for frameworks that have already
buffered.

`MerchantIDs` is a set and the verified event reports which one matched (§3.7 step 4). Presto signs for all
merchants with one key (§3.4), so a single endpoint receiving notifications for several `mid`s is the normal
shape, and it cannot dispatch on `mid` before verifying without parsing twice. `PrestoPublicKeys` is a slice for
rotation, as on the client.

A verifier needs no private key, so a webhook-only service configures nothing else and never holds signing
material — worth stating in the README, because the alternative is every service in the fleet mounting the
merchant key.

`AckOK` and `AckResend` are the two reply bodies; `WriteAck` sets the status and content type. `AckForError(err)`
picks the reply for a returned error, because getting this wrong loops: Presto retries at 1, 2, 5 and 10 minutes
(§3.7), so answering a bad signature, a foreign `mid` or a stale `ts` with `resend:true` asks for four
redeliveries that will fail identically. It returns `AckOK` for `*SignatureError` and `*ResponseError` —
permanent, nothing a retry fixes — and `AckResend` for anything else, which is the merchant's own transient
failure.

The event carries `EventRefNum`, stable across the up-to-five deliveries of one event (§3.7), and the derived
`PaymentStatus`.

## 8. Configuration and keys

| Variable | Description |
|----------|-------------|
| `PRESTOPAY_ENV` or `PRESTOPAY_BASE_URL` | `staging` / `production`, or an explicit URL |
| `PRESTOPAY_MID` | merchant ID |
| `PRESTOPAY_PRIVATE_KEY` or `PRESTOPAY_PRIVATE_KEY_FILE` | PKCS#8 PEM text, or a path to one |
| `PRESTOPAY_PUBLIC_KEY` or `PRESTOPAY_PUBLIC_KEY_FILE` | Presto certificate (PEM or DER), or SPKI PEM |

`prestopay.ConfigFromEnv(os.Getenv)` builds a `Config` from these; it takes the lookup function so tests and
`env`-style libraries work without the SDK reaching for the process environment.

Since Go reads no PKCS#12 (§1 decision 5), the onboarding keystore has to be converted once, and the error
message for a `.p12` passed as `PrivateKeyPEM` prints the command rather than just refusing:

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
because "the conversion failed" is the first thing a merchant will report — and it is the strongest argument
for revisiting decision 5 if a maintained Go PKCS#12 parser ever appears.

Key errors are specific: an encrypted PEM, a PKCS#1 PEM, a certificate passed as the private key, a non-RSA key,
malformed Base64, a DER blob that is a certificate where an SPKI was expected. Each message names the input and
the fix.

## 9. Wire contract and test vectors

`presto-pay-spec` is a repository of its own holding `wire-contract.md` (the reviewed, language-neutral version
of §3), `vectors/` and throwaway `keys/`. It is vendored here as a **plain copy** at `spec/`, not a git submodule,
pinned to a commit; the copy is updated by hand when the pin moves, and CI fails if the pin is behind the spec's
default branch by more than a release.

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
| `responses.json` | status, headers, body, the request it answers → result fields, or error type and fields (including echo mismatches and `MayHaveTakenEffect` per operation) |
| `webhooks.json` | body, merchant IDs, `now` → event fields, or error type. Includes a redelivery: same `eventRefNum`, later `ts`, both accepted under the 15-minute window |

Vector field names are the **wire** names; the Go harness maps them to exported field names, which is itself a
small test of the §1 decision 8 mapping. Tests read the files from disk rather than `go:embed`, so a missing or
stale vendored copy fails with "spec/vectors not found" instead of a build error nobody can parse.

## 10. Repository layout

```
prestopay/
  client.go        New, Config, ConfigFromEnv
  payments.go      InitRequest ... RefundResult, the four operations
  webhooks.go      WebhookVerifier, Ack helpers
  errors.go  constants.go  timestamp.go  version.go
  internal/
    canonical/  crypto/  keys/  transport/
spec/              vendored copy of presto-pay-spec, not a submodule
examples/          net/http, chi, Lambda
```

Everything that is not the public surface sits under `internal/`, which the compiler enforces — the equivalent of
the JavaScript SDK's export map, for free.

## 11. Testing

- **Vectors:** table tests over every file in `spec/vectors/`.
- **Contract tests:** `httptest.NewTLSServer` plays the gateway and signs responses with the test key. Covers
  every operation, validation message, error type, retry matrix entry and webhook outcome.
- **Socket suite:** the `RequestNotSent` cases from §6, asserting that the `httptrace` flag and the error
  inspection agree.
- **Race and vet:** `go test -race ./...`, `go vet`, `golangci-lint`, `govulncheck` in CI on 1.24–1.26.
- **API surface:** `gorelease` (or `apidiff`) against the previous tag runs on every PR, so a breaking change is
  a visible decision rather than a surprise for anyone who did not pin.
- **Staging:** `go test -tags staging ./...`, skipped unless `PRESTOPAY_STAGING_SMOKE=1`, with `Strict: true`
  (§4) so anything the **[U]** rules guessed wrong about fails loudly instead of being absorbed. It saves
  unfamiliar bodies as candidate vectors for `presto-pay-spec`.

## 12. Milestones

**This plan starts at the spec's first tag.** The JavaScript SDK goes first and shakes the vectors out against a
real implementation (`js-plan.md` §12); porting in parallel with that would mean fixing the same vector bugs
three times, three ways. Work here begins once `presto-pay-spec` is tagged, which is also when the **[U]** rules
have had their first contact with staging.

| # | Milestone | Exit criteria |
|---|-----------|---------------|
| 0 | Spec | `presto-pay-spec` vendored (plain copy, not a submodule) at its tagged commit |
| 1 | Scaffold | Module, CI on 1.24–1.26 with race, vet, lint and vulncheck |
| 2 | Wire core | Canonicalization, timestamps, sign and verify, PEM and certificate loading; those vectors pass |
| 3 | Send path | Error types with `Unwrap`, `MayHaveTakenEffect` and `ReconcileBy` per operation, whole-call deadline, jittered `RetryReads`, `httptrace` classification proven by the socket suite |
| 4 | Payments | Four operations, validation, response mapping with the echo check, `Raw.Post`, constants; request and response vectors pass |
| 5 | Webhooks + config | Verifier with multi-`mid` and multi-key support, `VerifyRequest`, Ack helpers, `ConfigFromEnv`, key error messages; webhook vectors pass |
| 6 | Release v0.1.0 | README (quick start, key conversion, idempotency with `MayHaveTakenEffect` / `ReconcileBy`, the never-set-Idempotency-Key rule, the redaction policy, a `net/http` webhook example that dedupes on `EventRefNum`), CHANGELOG, examples, staging smoke under `Strict`, tagged and listed on pkg.go.dev |
| later | | PKCS#12 if a maintained parser appears, a `v1.0.0` API freeze once two of the **[U]** rules have survived production |

## 13. Questions for Presto

All answered. Recorded here because §3 cites them, and because the next person to read a **[C]** tag will want to
know what it rests on.

### Round 1

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | Non-integer or >2^31 numbers in signed bodies? | No; `"amount": 100` | §3.4 integer rendering → **[C]**; non-integers cannot occur |
| 2 | Can a string field arrive as a number or boolean? | No | §3.6 step 5 coercion kept only as tolerance; `Strict` rejects |
| 3 | Are the list fields always strings? | Yes, always string | §3.5 → **[C]**; native arrays cannot occur on the wire |
| 4 | Does the gateway send `null`? | Yes | §3.5 → **[C]**; rendering answered in round 2 |
| 5 | Is `success` always present? | Yes | §3.6 and §3.7 stop defaulting it; absent is a malformed body |
| 6 | Request `ts` validity window | 15 minutes | §3.3 → **[C]** |
| 7 | Non-200 statuses, `x-http-error-*`, rate limiting | Headers always set; no rate limiting | §3.6 step 1 → **[C]**; no 429 expected |
| 8 | Webhook resend and reply handling | Presto retries on its own backoff | §3.7 → **[C]**; drives `AckForError` |
| 9 | Are length limits characters or bytes? | No limit today | §3.8 lengths become documentation and `Strict` checks |
| 10 | One key for all merchants; rotation? | Yes; Presto informs partners | §3.10 → **[C]**; the webhook `mid` check is mandatory and keys are a slice |

### Round 2

| # | Question | Answer | Effect |
|---|----------|--------|--------|
| 1 | How is `null` rendered in the canonical string? | Empty string | §3.4 → **[C]**; the last rule that could break verification outright |
| 2 | Is a webhook's `ts` refreshed on each delivery attempt? | Yes | §3.7 window is 15 minutes, matching §3.3 → **[C]** |
| 3 | Is `eventRefNum` stable across redeliveries? | Yes | §3.7 → **[C]**; a sound dedupe key |
| 4 | How long does the retry schedule run? | 1, 2, 5, 10 minutes | §3.7 → **[C]**: five deliveries over ~18 minutes |
| 5 | Does `1203` mean the original init succeeded? | It can be, but at minimum the record was created | §3.9 → **[C]**: reconcile via `Query`, never assume success |
| 6 | Do `1006` and `1007` distinguish malformed from failed-to-verify? | No | §3.6 gives both the same message |

What stays **[U]** in §3 is all pass-through behaviour — unknown error codes, the status and payment-method
lists, `sessionValidity` formatting — where a wrong guess surfaces as an unrecognized string rather than a failed
verification or a lost payment, and staging under `Strict` (§11) is what reports it.
