import express from 'express';
import { isPrestoPayError } from '@prestouniverse/presto-pay-sdk';
import { query, refundPayment, reversePayment } from '../services/checkout-service.mjs';

/** curl-friendly JSON routes over `paymentRefNum`, kept alongside the checkout/return pages for exploring the SDK. */
export const apiRouter = express.Router();

apiRouter.get('/payments/:paymentRefNum', async (req, res) => {
  try {
    res.json(await query(undefined, req.params.paymentRefNum));
  } catch (error) {
    res.status(502).json(describeError(error));
  }
});

apiRouter.post('/payments/:paymentRefNum/reverse', async (req, res) => {
  try {
    res.json(await reversePayment(req.params.paymentRefNum));
  } catch (error) {
    res.status(502).json(describeError(error));
  }
});

apiRouter.post('/payments/:paymentRefNum/refund', async (req, res) => {
  try {
    res.json(await refundPayment(req.params.paymentRefNum));
  } catch (error) {
    res.status(502).json(describeError(error));
  }
});

function describeError(error) {
  if (!(error instanceof Error)) return { error: String(error) };
  const base = { name: error.name, message: error.message };
  return isPrestoPayError(error)
    ? { ...base, mayHaveTakenEffect: error.mayHaveTakenEffect, reconcileBy: error.reconcileBy }
    : base;
}
