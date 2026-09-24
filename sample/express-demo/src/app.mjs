import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prestoMrn, prestoPayOptions } from './config.mjs';
import { paymentRouter } from './routes/payment-routes.mjs';
import { webhookRouter } from './routes/webhook-routes.mjs';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));

app.set('view engine', 'ejs');
app.set('views', path.join(here, 'views'));
app.use(express.static(path.join(here, '../public')));
app.use(express.urlencoded({ extended: false }));

app.get('/', (_req, res) => {
  res.render('index', { merchantId: prestoPayOptions.merchantId, prestoMrn });
});
app.use('/', paymentRouter);
app.use('/presto', webhookRouter);

export default app;
