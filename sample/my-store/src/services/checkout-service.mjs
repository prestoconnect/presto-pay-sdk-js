import { randomUUID } from 'node:crypto';
import { createPrestoPay, TxnType } from '@prestouniverse/presto-pay-sdk';
import { defaultCurrency, notifyUrl, prestoMrn, prestoPayOptions, returnUrlForTransaction } from '../config.mjs';
import { saveCheckout } from '../repository/payment-activity-store.mjs';
import { toMinorUnits } from './support/checkout-validation.mjs';

const presto = createPrestoPay(prestoPayOptions);

/**
 * Starts a WebPay payment from the checkout form. When `showPaymentMethods` is on, the shopper already picked
 * a method on this site, so it's sent as `allowedPaymentMethods` and Presto's hosted page skips straight to
 * confirming it; when off, no `allowedPaymentMethods` is sent and the shopper chooses on that hosted page.
 */
export async function checkout(form) {
  const txnRefNum = `demo-${randomUUID()}`;
  const amountMinorUnits = toMinorUnits(form.amountInRinggit);
  const displayDesc = form.displayDesc.trim();

  const initRequest = {
    prestoMrn,
    txnType: TxnType.WebPay,
    txnRefNum,
    displayDesc,
    amount: amountMinorUnits,
    currencyCode: defaultCurrency,
    notifyUrl: notifyUrl(),
    redirectUrl: returnUrlForTransaction(txnRefNum),
  };

  let selectedPaymentMethod;
  if (form.showPaymentMethods) {
    selectedPaymentMethod = form.selectedPaymentMethod.trim();
    initRequest.allowedPaymentMethods = [selectedPaymentMethod];
    if (form.receiptName?.trim()) initRequest.receiptName = form.receiptName.trim();
    if (form.receiptEmail?.trim()) initRequest.receiptEmail = form.receiptEmail.trim();
  }

  const pending = {
    txnRefNum,
    displayDesc,
    pageTitle: form.pageTitle,
    amountMinorUnits,
    currencyCode: defaultCurrency,
    selectedPaymentMethod,
    receiptName: form.receiptName,
    receiptEmail: form.receiptEmail,
  };

  try {
    const response = await presto.payments.init(initRequest);
    saveCheckout({
      ...pending,
      txnRefNum: response.txnRefNum ?? txnRefNum,
      paymentRefNum: response.paymentRefNum,
      paymentStatus: response.paymentStatus,
      initiatedAt: new Date(),
    });
    return response;
  } catch (error) {
    error.txnRefNum = txnRefNum;
    throw error;
  }
}

export async function query(txnRefNum, paymentRefNum) {
  return presto.payments.query({ prestoMrn, txnRefNum, paymentRefNum });
}

export function reversePayment(paymentRefNum) {
  return presto.payments.reverse({
    prestoMrn,
    paymentRefNum,
    reversalRefNum: `demo-rev-${randomUUID()}`,
    remark: 'presto-pay-sdk demo reversal',
  });
}

export function refundPayment(paymentRefNum) {
  return presto.payments.refund({
    prestoMrn,
    paymentRefNum,
    refundRefNum: `demo-rfd-${randomUUID()}`,
    remark: 'presto-pay-sdk demo refund',
  });
}

export function verifyWebhook(body) {
  return presto.webhooks.verify(body);
}
