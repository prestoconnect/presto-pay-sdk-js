import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes/api-routes.mjs';
import { homeRouter } from './routes/home-routes.mjs';
import { returnRouter } from './routes/return-routes.mjs';
import { webhookRouter } from './routes/webhook-routes.mjs';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));

app.set('view engine', 'ejs');
app.set('views', path.join(here, 'views'));
app.use(express.static(path.join(here, '../public')));

app.use('/', homeRouter);
app.use('/', returnRouter);
app.use('/', apiRouter);
app.use('/presto', webhookRouter);

export default app;
