/**
 * The error hierarchy from js-plan.md §4.
 *
 * Two rules shape this file. `mayHaveTakenEffect` is stamped where the error is thrown, because only there does
 * the SDK still know which operation ran — a 500 on `init` is indeterminate, a 500 on `query` means nothing
 * happened. And errors are identified by a brand rather than by `instanceof`, which stops working the moment two
 * copies of the package share a dependency tree, and stops working silently.
 */

export type Operation = 'init' | 'query' | 'reverse' | 'refund' | 'webhook' | 'config';

export type ReconcileKey = { txnRefNum: string } | { paymentRefNum: string };

export type ErrorSource = 'response' | 'webhook';

const BRAND: unique symbol = Symbol.for('prestopay.error') as never;

export interface PrestoPayErrorOptions {
  readonly operation: Operation;
  readonly mayHaveTakenEffect?: boolean;
  readonly reconcileBy?: ReconcileKey;
  readonly cause?: unknown;
}

export class PrestoPayError extends Error {
  readonly operation: Operation;
  readonly mayHaveTakenEffect: boolean;
  readonly reconcileBy: ReconcileKey | undefined;

  constructor(message: string, options: PrestoPayErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.operation = options.operation;
    this.mayHaveTakenEffect = options.mayHaveTakenEffect ?? false;
    this.reconcileBy = options.reconcileBy;
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }
}

/** Invalid options or request input, including strings that cannot survive UTF-8 encoding. */
export class PrestoPayConfigError extends PrestoPayError {
  readonly field: string | undefined;

  constructor(message: string, options: PrestoPayErrorOptions & { field?: string }) {
    super(message, options);
    this.field = options.field;
  }
}

/** Network failure, timeout, abort. */
export class PrestoPayTransportError extends PrestoPayError {
  readonly requestNotSent: boolean;

  constructor(message: string, options: PrestoPayErrorOptions & { requestNotSent: boolean }) {
    super(message, options);
    this.requestNotSent = options.requestNotSent;
  }
}

/** Non-200 status, or a signed body with `success: false`. */
export class PrestoPayApiError extends PrestoPayError {
  readonly kind: 'http' | 'business';
  readonly httpStatus: number | undefined;
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
  readonly rawBody: string | undefined;
  readonly canonical: string | undefined;
  /** On error `1005`: how far this host's clock is from the gateway's, `responseTs - requestTs` (§3.3). */
  readonly clockOffsetMs: number | undefined;

  constructor(
    message: string,
    options: PrestoPayErrorOptions & {
      kind: 'http' | 'business';
      httpStatus?: number;
      errorCode?: string;
      errorMessage?: string;
      rawBody?: string;
      canonical?: string;
      clockOffsetMs?: number;
    },
  ) {
    super(message, options);
    this.kind = options.kind;
    this.httpStatus = options.httpStatus;
    this.errorCode = options.errorCode;
    this.errorMessage = options.errorMessage;
    this.rawBody = options.rawBody;
    this.canonical = options.canonical;
    this.clockOffsetMs = options.clockOffsetMs;
  }
}

/** Missing or invalid signature, a webhook `mid` that is not ours, a stale webhook `ts`. */
export class PrestoPaySignatureError extends PrestoPayError {
  readonly source: ErrorSource;
  readonly canonical: string | undefined;

  constructor(
    message: string,
    options: PrestoPayErrorOptions & { source: ErrorSource; canonical?: string },
  ) {
    super(message, options);
    this.source = options.source;
    this.canonical = options.canonical;
  }
}

/** Malformed body, missing required field, unparseable `ts`, echo mismatch. */
export class PrestoPayResponseError extends PrestoPayError {
  readonly source: ErrorSource;
  readonly rawBody: string | undefined;

  constructor(
    message: string,
    options: PrestoPayErrorOptions & { source: ErrorSource; rawBody?: string },
  ) {
    super(message, options);
    this.source = options.source;
    this.rawBody = options.rawBody;
  }
}

/**
 * `instanceof` fails across duplicate copies of the package, and fails silently, at which point a merchant's
 * error handling stops catching without anything looking wrong. The brand survives that.
 */
export function isPrestoPayError(value: unknown): value is PrestoPayError {
  return typeof value === 'object' && value !== null && BRAND in value;
}

/** Thin guard over `mayHaveTakenEffect` for callers that catch `unknown`. */
export function mayHaveSucceeded(value: unknown): boolean {
  return isPrestoPayError(value) && value.mayHaveTakenEffect;
}

const REDACTED = '[redacted: set redactErrorBodies: false to see it]';

/**
 * Bodies and canonical strings can carry `cardBin`, `cardSummary`, `receiptEmail` and `receiptName`, and whole
 * error objects get logged. Redaction is the default; §4 requires the README to say so either way.
 */
export function redact(text: string | undefined, redactErrorBodies: boolean): string | undefined {
  if (text === undefined) return undefined;
  return redactErrorBodies ? REDACTED : text;
}
