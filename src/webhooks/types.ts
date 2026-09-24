import type { PaymentDetail } from '../payments/types.js';
import type { EventCode, PaymentStatus } from '../payments/constants.js';

/** A verified webhook event. Wire field names, as with the payment responses. */
export interface WebhookEvent {
  readonly eventCode: EventCode;
  /** Which of the configured merchant IDs this event was for — one endpoint can serve several (§3.7). */
  readonly mid: string;
  readonly prestoMrn: string;
  readonly paymentRefNum: string;
  readonly txnRefNum: string;
  /** Stable across redeliveries of the same event (§3.7) — the key to deduplicate on. */
  readonly eventRefNum: string;
  readonly eventTs: string;
  readonly amount: number;
  readonly currencyCode: string;
  readonly ts: string;
  readonly success: boolean;
  readonly userRefNum?: string;
  readonly additionalData?: string;
  readonly paymentDetails: readonly PaymentDetail[];
  /**
   * Derived, not on the wire (§3.7): for `Authorised`, `success` decides `Authorised` / `Failed`; for every
   * other event code, the event code itself is the status. `query` remains the authoritative source of truth.
   */
  readonly paymentStatus: PaymentStatus;
}
