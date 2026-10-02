/**
 * In-memory activity log for the demo: the checkout record behind each txnRefNum (so the return page can show
 * the description and selected method even though a payment `query` response doesn't carry them), each order's
 * payment status, and the last few webhook deliveries (so the page can show that they actually arrived). Resets
 * on every server restart -- this is demo state, not a database.
 */
import { PaymentStatus } from '@prestouniverse/presto-pay-sdk';

const MAX_WEBHOOK_HISTORY = 50;

const PAID_AND_STILL_OPEN = new Set([
  PaymentStatus.Authorised,
  PaymentStatus.PendingReverse,
  PaymentStatus.PendingRefund,
  PaymentStatus.PartialRefunded,
]);
const AFTER_PAYMENT = new Set([...PAID_AND_STILL_OPEN, PaymentStatus.Reversed, PaymentStatus.Refunded]);

const checkoutByTxnRef = new Map();
const orderStatusByTxnRef = new Map();
const webhookHistory = [];

export function saveCheckout(record) {
  checkoutByTxnRef.set(record.txnRefNum, record);
  if (record.paymentStatus && !orderStatusByTxnRef.has(record.txnRefNum)) {
    orderStatusByTxnRef.set(record.txnRefNum, record.paymentStatus);
  }
}

function canChangeStatus(current, next) {
  if (current === next) return false;
  if (current === undefined || current === PaymentStatus.PendingAuthorise) return true;
  if (PAID_AND_STILL_OPEN.has(current)) return AFTER_PAYMENT.has(next);
  return false;
}

/**
 * A real store makes this one conditional UPDATE on the orders table, so that only one of the return page and
 * the webhook finalises the order. `fulfil` is true only for the change that pays the order.
 */
export function applyPaymentStatus(txnRefNum, next) {
  const current = orderStatusByTxnRef.get(txnRefNum);
  if (!canChangeStatus(current, next)) return { changed: false, fulfil: false };
  orderStatusByTxnRef.set(txnRefNum, next);
  const paidNow =
    next === PaymentStatus.Authorised && (current === undefined || current === PaymentStatus.PendingAuthorise);
  return { changed: true, fulfil: paidNow };
}

export function findCheckoutByTxnRef(txnRefNum) {
  return checkoutByTxnRef.get(txnRefNum);
}

export function appendWebhook(record) {
  webhookHistory.unshift(record);
  webhookHistory.length = Math.min(webhookHistory.length, MAX_WEBHOOK_HISTORY);
}

export function recentWebhooks() {
  return webhookHistory.slice();
}
