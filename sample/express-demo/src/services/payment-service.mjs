import { randomUUID } from 'node:crypto';
import { createPrestoPay, PaymentMethod, TxnType } from '@prestouniverse/presto-pay-sdk';
import { port, prestoMrn, publicUrl, prestoPayOptions } from '../config.mjs';

const presto = createPrestoPay(prestoPayOptions);

export const customPaymentMethods = [
  { value: PaymentMethod.PmPgCard, label: 'PM PG Card' },
  { value: PaymentMethod.GrabPay, label: 'GrabPay' },
  { value: PaymentMethod.TouchNGoEWallet, label: 'Touch n Go eWallet' },
  { value: PaymentMethod.AffinBank, label: 'Affin Bank' },
  { value: PaymentMethod.Maybank, label: 'Maybank' },
];

const paymentsByTxnRefNum = new Map();

export async function startPayment({ amount, description, allowedPaymentMethods }) {
  const txnRefNum = `demo-${randomUUID()}`;
  try {
    const payment = await presto.payments.init({
      prestoMrn,
      txnType: TxnType.WebPay,
      txnRefNum,
      displayDesc: description,
      amount,
      currencyCode: 'MYR',
      notifyUrl: `${publicUrl}/presto/notify`,
      redirectUrl: `${publicUrl}/return?ref=${encodeURIComponent(txnRefNum)}`,
      allowedPaymentMethods,
    });
    paymentsByTxnRefNum.set(txnRefNum, { paymentRefNum: payment.paymentRefNum });
    console.log(`[init] txnRefNum=${txnRefNum} -> paymentRefNum=${payment.paymentRefNum} status=${payment.paymentStatus}`);
    return payment;
  } catch (error) {
    error.txnRefNum = txnRefNum;
    throw error;
  }
}

export async function queryPayment(input) {
  const result = await presto.payments.query({ prestoMrn, ...input });
  if (result.txnRefNum) paymentsByTxnRefNum.set(result.txnRefNum, { paymentRefNum: result.paymentRefNum });
  return result;
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

export function parseAmount(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('Amount must be a positive number with up to two decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(`${whole}${fraction.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Amount is out of range');
  return amount;
}

export function requireDescription(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Description is required');
  return value.trim();
}

export function asArray(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
}
