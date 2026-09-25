/**
 * Node 18's global `crypto` is only exposed on the main thread: it is `undefined` inside
 * `worker_threads` Workers and forked child processes, which is exactly how vitest isolates test
 * files. `node:crypto`'s `webcrypto` export is unaffected, so this backfills the global for the
 * test harness only. The shipped SDK itself never imports `node:crypto` — it targets the Web
 * Crypto API directly so the same build runs on Workers, Edge and Node alike.
 */
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
