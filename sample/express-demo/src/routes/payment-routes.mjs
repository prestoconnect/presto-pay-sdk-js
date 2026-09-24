import express from 'express';
import { isPrestoPayError } from '@prestouniverse/presto-pay-sdk';
import {
  asArray,
  customPaymentMethods,
  parseAmount,
  queryPayment,
  refundPayment,
  requireDescription,
  reversePayment,
  startPayment,
} from '../services/payment-service.mjs';

export const paymentRouter = express.Router();

paymentRouter.get('/hosted', (_req, res) => {
  res.render('payment-form', {
    title: 'Hosted payment page demo',
    action: '/hosted/pay',
    description: "Enter an amount and description. The SDK creates a WebPay payment and redirects to Presto's hosted payment page.",
    methods: [],
  });
});

paymentRouter.get('/custom', (_req, res) => {
  res.render('payment-form', {
    title: 'Custom payment method demo',
    action: '/custom/pay',
    description: 'Choose which methods the merchant wants to offer. The SDK sends these values as allowedPaymentMethods.',
    methods: customPaymentMethods,
  });
});

paymentRouter.post('/hosted/pay', async (req, res) => {
  try {
    const payment = await startPayment({ amount: parseAmount(req.body.amount), description: requireDescription(req.body.description) });
    res.redirect(302, payment.paymentUrl);
  } catch (error) {
    await handleInitFailure(res, error.txnRefNum, error, 'hosted payment could not be started');
  }
});

paymentRouter.post('/custom/pay', async (req, res) => {
  try {
    const selected = asArray(req.body.paymentMethod);
    const allowed = selected.filter((method) => customPaymentMethods.some((item) => item.value === method));
    if (allowed.length === 0 || allowed.length !== selected.length) throw new Error('Select at least one valid payment method');
    const payment = await startPayment({
      amount: parseAmount(req.body.amount),
      description: requireDescription(req.body.description),
      allowedPaymentMethods: allowed,
    });
    res.redirect(302, payment.paymentUrl);
  } catch (error) {
    await handleInitFailure(res, error.txnRefNum, error, 'custom payment could not be started');
  }
});

paymentRouter.get('/pay', async (_req, res) => {
  try {
    const payment = await startPayment({ amount: 100, description: 'Presto Pay SDK demo payment', allowedPaymentMethods: ['Wallet'] });
    res.redirect(302, payment.paymentUrl);
  } catch (error) {
    await handleInitFailure(res, error.txnRefNum, error, 'payment could not be started');
  }
});

paymentRouter.get('/return', async (req, res) => {
  try {
    const txnRefNum = typeof req.query.ref === 'string' ? req.query.ref : undefined;
    if (!txnRefNum) throw new Error('/return needs a ?ref=<txnRefNum> query parameter');
    const result = await queryPayment({ txnRefNum });
    res.render('result', { title: `Back from the hosted payment page for ${txnRefNum}`, result });
  } catch (error) {
    renderError(res, `query failed for ${req.query.ref ?? 'payment'}`, error);
  }
});

paymentRouter.get('/payments/:paymentRefNum', async (req, res) => {
  try {
    res.json(await queryPayment({ paymentRefNum: req.params.paymentRefNum }));
  } catch (error) {
    res.status(502).json(describeError(error));
  }
});

paymentRouter.post('/payments/:paymentRefNum/reverse', async (req, res) => {
  try {
    res.json(await reversePayment(req.params.paymentRefNum));
  } catch (error) {
    res.status(502).json(describeError(error));
  }
});

paymentRouter.post('/payments/:paymentRefNum/refund', async (req, res) => {
  try {
    res.json(await refundPayment(req.params.paymentRefNum));
  } catch (error) {
    res.status(502).json(describeError(error));
  }
});

async function handleInitFailure(res, txnRefNum, error, heading) {
  if (isPrestoPayError(error) && error.mayHaveTakenEffect) {
    try {
      const result = await queryPayment(error.reconcileBy ?? { txnRefNum });
      res.render('result', { title: 'Payment may have been created; reconciled via query', result });
    } catch (queryError) {
      renderError(res, 'payment failed and reconciliation also failed', queryError);
    }
    return;
  }
  renderError(res, heading, error);
}

function renderError(res, title, error) {
  res.status(502).render('error', { title, error: describeError(error) });
}

function describeError(error) {
  if (!(error instanceof Error)) return { error: String(error) };
  const base = { name: error.name, message: error.message };
  return isPrestoPayError(error)
    ? { ...base, mayHaveTakenEffect: error.mayHaveTakenEffect, reconcileBy: error.reconcileBy }
    : base;
}
