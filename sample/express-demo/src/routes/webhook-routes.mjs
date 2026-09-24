import express from 'express';
import { NotifyAck } from '@prestouniverse/presto-pay-sdk';
import { verifyWebhook } from '../services/payment-service.mjs';

export const webhookRouter = express.Router();
const seenWebhookEvents = new Set();

webhookRouter.post('/notify', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body);
    if (seenWebhookEvents.has(event.eventRefNum)) {
      console.log(`[webhook] duplicate delivery of ${event.eventRefNum}, ignoring`);
    } else {
      seenWebhookEvents.add(event.eventRefNum);
      console.log(`[webhook] ${event.eventCode} for paymentRefNum=${event.paymentRefNum} (eventRefNum=${event.eventRefNum})`);
    }
    res.status(200).type('json').send(NotifyAck.ok);
  } catch (error) {
    console.error('[webhook] verification failed:', error);
    res.status(200).type('json').send(NotifyAck.forError(error));
  }
});
