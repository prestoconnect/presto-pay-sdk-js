# Presto Pay wire contract

Language-neutral contract for the four Presto Pay SDKs (JS, Python, Go, PHP). This is the reviewed extract of
`js-plan.md` §3; when the two disagree, this file is authoritative and `js-plan.md` should be updated to match.

Tags say how well each rule is established:

| Tag | Meaning |
|-----|---------|
| **[C]** | Confirmed: in Presto's worked example, a body captured from Presto, or exercised against staging |
| **[U]** | Unconfirmed: believed to be gateway behavior; implement it, flag it for Presto if still open |
| **[P]** | SDK policy, not required by the gateway |

## 1. Transport

- HTTPS `POST`, one JSON object per request and per response. Body bytes are UTF-8. **[C]**
- Base URLs: staging `https://presto-stg-ext.enovax.com`, production `https://pay-ext.prestouniverse.com`. **[C]**
- Header `Content-Type: application/json; charset=UTF-8` **[C]**; a `User-Agent` identifying the SDK and its
  version **[P]**. Redirects are not followed **[P]**.

| Operation | Path | Safe to resend |
|-----------|------|----------------|
| init | `/v1/ext/payment/init` | No |
| query | `/v1/ext/payment/query` | Yes (read-only) |
| reverse | `/v1/ext/payment/reverse` | No |
| refund | `/v1/ext/payment/refund` | No |

Paths **[C]**; resend safety **[C]** for init (a resend collides as `1203`, §9), **[U]** for reverse and refund.

## 2. Common request fields

| Field | Value |
|-------|-------|
| `mid` | Merchant ID, one per client configuration **[C]** |
| `prestoMrn` | Presto merchant reference; one `mid` can have several, chosen per request **[C]** |
| `ts` | Request timestamp (§3), fresh for every attempt **[C]** |
| `signature` | Signature over all other fields (§4) **[C]** |

Optional fields that are not set are **omitted**, never sent as `null` **[P]**.

## 3. Timestamps

- Format `yyyyMMddHHmmss.SSS`, e.g. `20250423104500.000`, always at the fixed offset **UTC+08:00** regardless of
  host time zone. **[C]**
- The validity window is **15 minutes**; a request `ts` outside it fails with error `1005`. **[C]**
- `sessionValidity` on init uses the same format **[U]**.
- Implementations should report the observed clock offset (request `ts` vs. response `ts`) in the `1005` error,
  since a skewed host clock has no other way to find out why every request fails. **[P]**

## 4. Signatures

**Canonical string**, from a flat JSON object:

1. Take every key except `signature`. **[C]**
2. Sort keys by UTF-16 code unit order (all known keys are ASCII, where this agrees with code-point and UTF-8
   byte order). **[C]**
3. Render each value:

   | JSON value | Rendering |
   |------------|-----------|
   | string | the decoded string as-is, no quoting or escaping **[C]** |
   | integer | decimal, no leading zeros, `-` for negatives. Numbers on the wire are always integers within 2^31 **[C]** |
   | `true` / `false` | `true` / `false` **[C]** |
   | `null` | empty string; a null is indistinguishable from `""` and keeps its separator **[C]** |
   | array, object, non-integer number | cannot occur on the wire: list fields are always JSON **strings** (§5) and numbers are always integers. Reject the body **[C]** |

4. Join with `:`. Values are not escaped, so `:` inside a value is ambiguous by design. A present key with an
   empty value keeps its separator (`x::y`); an absent key contributes nothing. **[C]**

Two worked/captured examples verify this rule set end to end, including the null-canonicalizes-as-empty-string
rule: see `vectors/canonical.json` (`worked-example-init-request`, `captured-business-error-1201`,
`captured-init-success-null-handling`). The captured response signatures remain as wire examples; the
corresponding staging certificate is intentionally not committed.

**Algorithm**

- `RSASSA-PKCS1-v1_5` with SHA-256 over the UTF-8 bytes of the canonical string; standard Base64 with padding. **[C]**
- Requests are signed with the merchant's private key; responses and webhooks are verified with Presto's public
  key. **[C]**
- Presto signs webhooks for **all** merchants with the same key, so a valid signature does not prove the event is
  for this merchant (§6). **[C]**
- A signature that is not valid Base64 is a failed verification, not a separate error. **[P]**

**What is signed must be what is sent.** Consequences:

- Reject lone UTF-16 surrogates in outgoing strings before encoding. **[P]**
- Send integers only. **[C]**

## 5. JSON rules

**Incoming bodies** **[P]**

- Must be a single JSON object. Duplicate keys resolve last-wins; the same parsed object is used for
  verification and for field mapping.
- Reject integers outside the platform's safe-integer range before canonicalizing.
- Decode bytes as UTF-8 with replacement-character handling for invalid sequences.

**Stringified arrays.** Every list field is a **JSON string that contains an array**, never a native array, in
both directions. **[C]** An empty list arrives as the two characters `[]`, not as `""`. **[C]** Whether such a
field can be absent entirely is **[U]**; a missing one should be read as an empty list.

| Field | Direction | Elements |
|-------|-----------|----------|
| `allowedPaymentMethods` | init request | payment method codes |
| `itemList` | init request | line items (§7) |
| `refundDetails` | query response | refund details (§7) |
| `paymentDetails` | query response, webhook | payment details (§7) |

SDKs should present real arrays for these to callers; the string is a wire encoding detail.

**Empty values on responses.** A successful response carries **every** documented field, using `""` or `null`
for fields that have no value, and which of the two a given field uses is **not stable** across responses of the
same kind. **[C]** Consequences:

- Those keys are in the signed body and must never be stripped before verifying.
- Field mapping should normalize `""` and `null` to "absent" on optional fields.
- A business-error response (`success: false`) carries only `success`, `ts`, `errorCode`, `errorMessage` and
  `signature` — none of the payment fields — so the two response shapes must be mapped separately. **[P]**

## 6. Responses

Handle a response in this order:

1. **Status not 200:** HTTP error. The body is unsigned and not verified; details are in the `x-http-error-code`
   and `x-http-error` headers (case-insensitive), always set. **[C]** There is no rate limiting, so no 429. **[C]**
2. **Parse** (§5). Failure: malformed body.
3. **Signature:** missing or invalid is a signature error. This comes **before** `success`, because business
   errors are signed too. **[C]**
4. **`success`:** always present. **[C]** `false` is a business error with `errorCode` / `errorMessage`; absent
   or non-boolean is a malformed body.
5. **Map fields** (§7). A missing required field is a malformed body. A field documented as a string always
   arrives as a string **[C]**, but a number or boolean there should be coerced to text rather than rejected in
   lenient mode; a strict mode may reject instead.
6. **Echo check:** `prestoMrn`, and `txnRefNum` where the response carries it, must equal what was signed into
   the request. A mismatch is a response error. **[P]**

For `init`, `reverse` and `refund`, a status of 500+, or a failure at steps 2, 3, 5 or 6 after a 200, means **the
operation may have taken effect**; reconcile with `query`. The same failures on `query` mean nothing happened. A
`success: false` at step 4 otherwise means nothing happened, with `1203` on init the one exception (§9). **[P]**

Error codes are four-digit strings and open-ended; unknown codes should pass through. **[U]** Codes SDKs rely on:

| Code | Meaning |
|------|---------|
| `1005` | Request `ts` outside the validity window (clock skew) **[C]** |
| `1006`, `1007` | Request signature invalid or failed verification; treat identically **[C]** |
| `1201` | Invalid input **[C]** |
| `1203` | Duplicate `txnRefNum` on init: a payment record for that `txnRefNum` already exists, in any state including a successful one (§9) **[C]** |
| `1212` | Payment not found **[U]** |

See `js-plan.md` §3.6 for the full open-ended `ErrorCode` list.

## 7. Webhooks (notify)

**Delivery.** Presto POSTs a signed JSON body to the `notifyUrl` given on init, reverse or refund; the URL must
be publicly reachable. **[C]** The merchant replies HTTP 200 with `{"resend":false}` (accepted) or
`{"resend":true}` (ask Presto to resend). **[C]** Presto retries on its own backoff of **1, 2, 5 and 10 minutes**
after the first attempt — five deliveries over roughly 18 minutes. **[C]**

- A permanent failure (bad signature, foreign `mid`, stale `ts`) must not be answered with `{"resend":true}`,
  since it will fail identically on every redelivery. **[P]**
- The freshness window is **15 minutes**, matching §3. A redelivery carries a fresh `ts`. **[C]**
- `eventRefNum` is stable across redeliveries of the same event **[C]** and is the deduplication key; the
  ~18-minute schedule sizes the retention.

**Verification**, in order:

1. Parse the **raw body** per §5.
2. Signature present and valid, otherwise a signature error.
3. Map fields (§7 below / js-plan.md §3.8). `success` is always present, on webhooks as on responses. **[C]**
4. `mid` must be one of the configured merchant IDs, otherwise a signature error. **[P]** Mandatory, since one
   key signs for every merchant (§4).
5. Freshness: reject if `|now − ts|` exceeds the window (default 15 min, configurable) as a signature error; a
   malformed `ts` is a malformed body. **[P]**

Event codes (open-ended): `Authorised`, `Cancelled`, `Reversed`, `Refunded`, `Expired`. **[U]** For `Authorised`,
`success` says whether authorisation succeeded; for other codes the event code is the status. `query` remains the
authoritative source of payment state.

## 8. Operation fields

See `js-plan.md` §3.8 for the full request/response field tables, code lists, and per-field length maxima (which
are documentation only — Presto enforces no length limit today, confirmed).

## 9. Idempotency and retries

- `init`, `reverse` and `refund` must not be resent once any byte may have reached the gateway; resending `init`
  with the same `txnRefNum` returns `1203`. **[C]**
- They may be retried only when the request certainly never left the process. When unsure, do not retry. **[P]**
- `query` may be retried on transport errors and on statuses of 500+. **[P]**
- Every attempt gets a fresh `ts` and signature (a stale `ts` fails with `1005`). **[C]**
- After an ambiguous failure, look the transaction up with `query`: by `txnRefNum` after init, by `paymentRefNum`
  after reverse or refund. **[P]**
- `1203` says a record exists but not what state it is in; it should be treated as "reconcile with `query`," not
  as "the payment succeeded." **[P]**

## 10. Keys

- Merchant private key: RSA, delivered at onboarding as a PKCS#12 keystore. **[C]**
- Presto public key: RSA, delivered as an X.509 certificate (PEM or DER). **[C]**
- One Presto key signs responses and webhooks for all merchants; rotations are announced out of band. **[C]**
  There is no `kid` on the wire, so an overlap period means holding and trying both keys.

## Status

Nothing is outstanding as open questions for Presto as of 2026-09-24 (see `js-plan.md` §13 for the full Q&A log).
What stays **[U]** here is pass-through behaviour — unknown error codes, the status and payment-method lists,
`sessionValidity` formatting — where a wrong guess surfaces as an unrecognized string rather than a failed
verification or a lost payment.
