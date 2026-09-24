/**
 * `requestNotSent` classification, js-plan.md §6: `true` only for an **allowlist** of connect-phase codes.
 * Everything else — including codes this list does not know about, `ECONNRESET`, and `UND_ERR_SOCKET` — is
 * `false`, because the safe assumption once bytes may have left the process is that they arrived.
 *
 * Workers and Edge report no `cause.code` at all, so there `init` / `reverse` / `refund` are effectively never
 * retried; that is the correct, conservative outcome, not a gap.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  // DNS
  'ENOTFOUND',
  'EAI_AGAIN',
  // TCP connect
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS handshake / certificate
  'UND_ERR_TLS',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'HOSTNAME_MISMATCH',
]);

/** Node wraps connect-phase failures as `cause.code`; some runtimes and custom `fetch` wrappers set `.code` directly. */
export function connectPhaseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function isRequestNotSentError(error: unknown): boolean {
  const code = connectPhaseCode(error);
  return code !== undefined && CONNECT_PHASE_CODES.has(code);
}

export { CONNECT_PHASE_CODES };
