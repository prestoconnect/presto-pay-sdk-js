import app from './app.mjs';
import { hasPublicUrl, port, publicUrl } from './config.mjs';

app.listen(port, () => {
  console.log(`Presto Pay SDK demo listening on http://localhost:${port}`);
  console.log(`publicUrl (used for notifyUrl/redirectUrl) = ${publicUrl}`);
  if (!hasPublicUrl) {
    console.log(`WARNING: PUBLIC_URL is not set; using localhost for redirects and notifyUrl. Presto cannot deliver webhooks to localhost. Set PUBLIC_URL after exposing port ${port} publicly to enable webhook delivery.`);
  }
});
