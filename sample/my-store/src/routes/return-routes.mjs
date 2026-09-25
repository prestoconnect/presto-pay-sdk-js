import express from 'express';
import { isPrestoPayError } from '@prestouniverse/presto-pay-sdk';
import { query } from '../services/checkout-service.mjs';
import { findCheckoutByTxnRef, recentWebhooks } from '../repository/payment-activity-store.mjs';

export const returnRouter = express.Router();

const EMPTY_VIEW = {
  missingTxnRefNum: false,
  txnRefNum: undefined,
  checkout: undefined,
  query: undefined,
  queryError: undefined,
  querySignatureError: false,
  signatureSide: undefined,
};

returnRouter.get('/return', (_req, res) => {
  res.render('return', { ...EMPTY_VIEW, missingTxnRefNum: true, recentWebhooks: recentWebhooks() });
});

/**
 * Where Presto redirects the shopper back after the hosted payment page. Any status other than
 * PendingAuthorise means Presto has finalised the payment. This page and the /presto/notify webhook are
 * triggered independently by Presto and can arrive in either order, or at nearly the same time -- this route
 * must not assume the webhook has (or hasn't) already been processed.
 */
returnRouter.get('/return/:txnRefNum', async (req, res) => {
  const txnRefNum = req.params.txnRefNum?.trim();
  if (!txnRefNum) {
    return res.render('return', { ...EMPTY_VIEW, missingTxnRefNum: true, recentWebhooks: recentWebhooks() });
  }

  const view = { ...EMPTY_VIEW, txnRefNum, checkout: findCheckoutByTxnRef(txnRefNum), recentWebhooks: recentWebhooks() };
  try {
    view.query = await query(txnRefNum);
  } catch (error) {
    view.queryError = error instanceof Error ? error.message : String(error);
    if (isPrestoPayError(error) && error.name === 'PrestoPaySignatureError') {
      view.querySignatureError = true;
      view.signatureSide = error.source;
    }
  }
  res.render('return', view);
});
