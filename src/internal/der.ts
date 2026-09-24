/**
 * The only hand-written parser in the package: enough DER to pull `subjectPublicKeyInfo` out of an X.509
 * certificate, because Web Crypto imports SPKI but not certificates, and Presto delivers a certificate.
 *
 *   Certificate  ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 *   TBSCertificate ::= SEQUENCE {
 *     version         [0] EXPLICIT Version DEFAULT v1,
 *     serialNumber        INTEGER,
 *     signature           AlgorithmIdentifier,
 *     issuer              Name,
 *     validity            Validity,
 *     subject             Name,
 *     subjectPublicKeyInfo SubjectPublicKeyInfo,
 *     ... }
 *
 * Nothing here interprets the key itself — Web Crypto does that, and will reject anything malformed.
 */

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const CONTEXT_0 = 0xa0;

interface Element {
  readonly tag: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  /** Offset just past this element, i.e. where its sibling begins. */
  readonly end: number;
}

function readElement(bytes: Uint8Array, offset: number): Element {
  if (offset + 2 > bytes.length) {
    throw new RangeError('truncated DER: no room for a tag and length');
  }
  const tag = bytes[offset] as number;
  const first = bytes[offset + 1] as number;
  let contentStart = offset + 2;
  let length: number;

  if (first < 0x80) {
    length = first;
  } else {
    const lengthBytes = first & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      // Indefinite length is not valid DER; more than 4 bytes means a length no sane certificate carries.
      throw new RangeError('unsupported DER length encoding');
    }
    if (contentStart + lengthBytes > bytes.length) {
      throw new RangeError('truncated DER: length runs past the end');
    }
    length = 0;
    for (let i = 0; i < lengthBytes; i += 1) {
      length = length * 256 + (bytes[contentStart + i] as number);
    }
    contentStart += lengthBytes;
  }

  const contentEnd = contentStart + length;
  if (contentEnd > bytes.length) {
    throw new RangeError('truncated DER: content runs past the end');
  }
  return { tag, contentStart, contentEnd, end: contentEnd };
}

function expect(bytes: Uint8Array, offset: number, tag: number, what: string): Element {
  const element = readElement(bytes, offset);
  if (element.tag !== tag) {
    throw new RangeError(
      `expected ${what} (tag 0x${tag.toString(16)}), found tag 0x${element.tag.toString(16)}`,
    );
  }
  return element;
}

/** Returns the SPKI as its own complete DER element, ready for `crypto.subtle.importKey('spki', ...)`. */
export function subjectPublicKeyInfoFromCertificate(certificate: Uint8Array): Uint8Array {
  const outer = expect(certificate, 0, SEQUENCE, 'Certificate');
  const tbs = expect(certificate, outer.contentStart, SEQUENCE, 'TBSCertificate');

  let offset = tbs.contentStart;
  const version = readElement(certificate, offset);
  if (version.tag === CONTEXT_0) {
    offset = version.end;
  }

  offset = expect(certificate, offset, INTEGER, 'serialNumber').end;
  offset = expect(certificate, offset, SEQUENCE, 'signature AlgorithmIdentifier').end;
  offset = expect(certificate, offset, SEQUENCE, 'issuer').end;
  offset = expect(certificate, offset, SEQUENCE, 'validity').end;
  offset = expect(certificate, offset, SEQUENCE, 'subject').end;

  const spki = expect(certificate, offset, SEQUENCE, 'subjectPublicKeyInfo');
  return certificate.slice(offset, spki.end);
}

/** A DER blob starting with a SEQUENCE whose first child is also a SEQUENCE is a certificate, not an SPKI. */
export function looksLikeCertificate(bytes: Uint8Array): boolean {
  try {
    const outer = readElement(bytes, 0);
    if (outer.tag !== SEQUENCE) return false;
    const inner = readElement(bytes, outer.contentStart);
    if (inner.tag !== SEQUENCE) return false;
    // An SPKI's first child is an AlgorithmIdentifier whose own first child is an OID (0x06).
    const grandchild = readElement(bytes, inner.contentStart);
    return grandchild.tag !== 0x06;
  } catch {
    return false;
  }
}
