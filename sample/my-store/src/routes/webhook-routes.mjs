import express from 'express';
import { NotifyAck } from '@prestouniverse/presto-pay-sdk';
import { query, verifyWebhook } from '../services/checkout-service.mjs';
import { appendWebhook } from '../repository/payment-activity-store.mjs';

export const webhookRouter = express.Router();
const seenWebhookEvents = new Set();

webhookRouter.post('/notify', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body);
    if (seenWebhookEvents.has(event.eventRefNum)) {
      console.log(`[webhook] duplicate delivery of ${event.eventRefNum}, ignoring`);
    } else {
      // A webhook says what happened, not the payment's resulting status, so ask Presto. The event is marked as
      // seen only after this succeeds; if it fails, forError asks for a resend that must not look like a duplicate.
      const payment = await query(undefined, event.paymentRefNum);
      seenWebhookEvents.add(event.eventRefNum);
      console.log(
        `[webhook] ${event.eventCode} success=${event.success} for paymentRefNum=${event.paymentRefNum} ` +
          `(eventRefNum=${event.eventRefNum}); queried paymentStatus=${payment.paymentStatus}`,
      );
      appendWebhook({
        txnRefNum: event.txnRefNum,
        eventCode: event.eventCode,
        paymentStatus: payment.paymentStatus,
        success: event.success,
        amountMinorUnits: event.amount,
        currencyCode: event.currencyCode,
        receivedAt: new Date(),
      });
    }
    res.status(200).type('json').send(NotifyAck.ok);
  } catch (error) {
    console.error('[webhook] not processed:', error);
    res.status(200).type('json').send(NotifyAck.forError(error));
  }
});
