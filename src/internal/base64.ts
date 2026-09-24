/**
 * Base64 on the web platform: `atob` / `btoa`, no `Buffer`.
 *
 * Decoding is strict. `atob` accepts sloppy input in several runtimes, and a signature that "almost" decodes
 * turns a corrupted value into a puzzling verification failure instead of a clear one.
 */

const STANDARD_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isStandardBase64(text: string): boolean {
  return text.length % 4 === 0 && STANDARD_BASE64.test(text);
}

export function base64ToBytes(text: string): Uint8Array {
  if (!isStandardBase64(text)) {
    throw new RangeError('not standard Base64 with padding');
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a large input cannot blow the argument limit of String.fromCharCode.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
