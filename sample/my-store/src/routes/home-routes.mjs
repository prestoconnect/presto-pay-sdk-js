import express from 'express';
import { isPrestoPayError } from '@prestouniverse/presto-pay-sdk';
import { checkout } from '../services/checkout-service.mjs';
import { validateCheckoutForm } from '../services/support/checkout-validation.mjs';
import { recentWebhooks } from '../repository/payment-activity-store.mjs';

export const homeRouter = express.Router();

const defaultForm = {
  pageTitle: 'MyStore',
  displayDesc: 'Checkout demo',
  amountInRinggit: '10.00',
  showPaymentMethods: false,
  selectedPaymentMethod: 'PmPgCard',
};

homeRouter.get('/', (_req, res) => {
  res.render('index', { checkout: defaultForm, recentWebhooks: recentWebhooks() });
});

/**
 * JSON checkout API consumed by the page's own JavaScript (public/js/checkout.js). Returns 200 with
 * { paymentUrl, txnRefNum } on success, 400 with a field-name to message map on validation failure, and 502
 * with a gateway-failure body otherwise.
 */
homeRouter.post('/checkout', express.json(), async (req, res) => {
  const errors = validateCheckoutForm(req.body);
  if (Object.keys(errors).length > 0) {
    return res.status(400).json(errors);
  }

  try {
    const response = await checkout(req.body);
    res.json({ paymentUrl: response.paymentUrl, txnRefNum: response.txnRefNum });
  } catch (error) {
    res.status(502).json(describeCheckoutFailure(error));
  }
});

function describeCheckoutFailure(error) {
  const body = { message: error instanceof Error ? error.message : String(error) };
  if (!isPrestoPayError(error)) return body;
  if (error.name === 'PrestoPayApiError') {
    body.errorCode = error.errorCode;
    body.errorMessage = error.errorMessage;
  } else if (error.name === 'PrestoPaySignatureError') {
    body.signatureError = true;
  }
  return body;
}
