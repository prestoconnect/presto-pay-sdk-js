/**
 * Public API, js-plan.md §4. Wire field names on the way in and on the way out — no separate DTO naming to
 * memorize among sixteen passthrough fields.
 *
 * Webhook verification and `fromEnv` land in milestone 5; this covers the client and the four payment operations
 * (milestone 4).
 */
export { createPrestoPay } from './client.js';
export type {
  CallOptions,
  Environment,
  PaymentsApi,
  PrestoPayClient,
  PrestoPayOptions,
  RawApi,
} from './client.js';

export { importPrestoPublicKey, importPrivateKey } from './keys.js';

export {
  canonicalizeText as canonicalize,
} from './internal/canonical.js';
export { formatGatewayTimestamp, parseGatewayTimestamp } from './internal/timestamp.js';

export {
  isPrestoPayError,
  mayHaveSucceeded,
  PrestoPayApiError,
  PrestoPayConfigError,
  PrestoPayError,
  PrestoPayResponseError,
  PrestoPaySignatureError,
  PrestoPayTransportError,
} from './errors.js';
export type { ErrorSource, Operation, PrestoPayErrorOptions, ReconcileKey } from './errors.js';

export { DEFAULT_RETRY_READS } from './retry.js';
export type { RetryOptions } from './retry.js';

export { SDK_VERSION } from './version.js';

export {
  ErrorCode,
  EventCode,
  PaymentMethod,
  PaymentStatus,
  RefundStatus,
  ReversalStatus,
  TxnType,
} from './payments/constants.js';

export type {
  InitRequest,
  InitResponse,
  LineItem,
  PaymentDetail,
  QueryRequest,
  QueryResponse,
  RefundDetail,
  RefundRequest,
  RefundResponse,
  ReverseRequest,
  ReverseResponse,
} from './payments/types.js';
