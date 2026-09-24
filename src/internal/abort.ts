/**
 * `AbortSignal.any` combines the whole-call deadline with the caller's own `signal` (js-plan.md §6). It landed in
 * Node 20.3, but its availability on the oldest `workerd` and `edge-runtime` this package targets is unproven, so
 * a small manual fallback stands in when it is missing.
 */
export function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 1) return present[0] as AbortSignal;

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(present);
  }

  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
