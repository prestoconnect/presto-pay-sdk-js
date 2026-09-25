/**
 * In-memory activity log for the demo: the checkout record behind each txnRefNum (so the return page can show
 * the description and selected method even though a payment `query` response doesn't carry them), and the last
 * few webhook deliveries (so the page can show that they actually arrived). Resets on every server restart --
 * this is demo state, not a database.
 */
const MAX_WEBHOOK_HISTORY = 50;

const checkoutByTxnRef = new Map();
const webhookHistory = [];

export function saveCheckout(record) {
  checkoutByTxnRef.set(record.txnRefNum, record);
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
