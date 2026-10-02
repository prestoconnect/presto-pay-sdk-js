import express from 'express';
import { isPrestoPayError, NotifyAck } from '@prestouniverse/presto-pay-sdk';
import { query, recordPaymentStatus, verifyWebhook } from '../services/checkout-service.mjs';
import { appendWebhook } from '../repository/payment-activity-store.mjs';

export const webhookRouter = express.Router();

webhookRouter.post('/notify', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req.body);
  } catch (error) {
    console.error('[webhook] rejected:', error);
    if (isPrestoPayError(error) && error.name === 'PrestoPaySignatureError') {
      res.sendStatus(401);
    } else {
      res.status(200).type('json').send(NotifyAck.forError(error));
    }
    return;
  }

  try {
    // A webhook says what happened, not the payment's resulting status, so ask Presto on every delivery. The
    // order update is guarded on the order's current status, so a redelivery finds it already done.
    const payment = await query(undefined, event.paymentRefNum);
    console.log(
      `[webhook] ${event.eventCode} success=${event.success} for paymentRefNum=${event.paymentRefNum}; ` +
        `queried paymentStatus=${payment.paymentStatus}`,
    );
    recordPaymentStatus(event.txnRefNum, payment.paymentStatus);
    appendWebhook({
      txnRefNum: event.txnRefNum,
      eventCode: event.eventCode,
      paymentStatus: payment.paymentStatus,
      success: event.success,
      amountMinorUnits: event.amount,
      currencyCode: event.currencyCode,
      receivedAt: new Date(),
    });
    res.status(200).type('json').send(NotifyAck.ok);
  } catch (error) {
    console.error('[webhook] not processed:', error);
    res.status(200).type('json').send(NotifyAck.forError(error));
  }
});
