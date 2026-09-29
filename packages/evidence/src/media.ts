import { EVIDENCE_MEDIA_TYPES, type EvidenceMediaType } from '@br/domain';

/**
 * Bounded reference ingestion (BRT-06 §15–16, §54). The platform never parses, renders or executes
 * evidence bytes; it only checks that the declared media type is on the allow-list and that the
 * leading bytes are consistent with it (so an HTML/SVG/script/executable/archive cannot be smuggled
 * in under an allowed label). Production malware scanning is deferred (threat review §1).
 */

/** Hard cap of the JSON/base64 reference upload path. The storage ports themselves stream. */
export const MAX_REFERENCE_UPLOAD_BYTES = 2 * 1024 * 1024;

export type MediaCheck =
  | { readonly ok: true; readonly mediaType: EvidenceMediaType }
  | { readonly ok: false; readonly reason: 'TYPE_NOT_ALLOWED' | 'CONTENT_MISMATCH' | 'EMPTY' };

const startsWith = (bytes: Uint8Array, sig: readonly number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/** Signatures refused whatever the declared type: executables, archives, compressed streams. */
const REFUSED_SIGNATURES: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // MZ (PE executables)
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x50, 0x4b, 0x03, 0x04], // ZIP (and OOXML/JAR)
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x23, 0x21], // "#!" shebang scripts
];

function firstNonWhitespace(bytes: Uint8Array): number | undefined {
  let i = 0;
  // UTF-8 BOM
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) i = 3;
  for (; i < bytes.length && i < 4096; i++) {
    const b = bytes[i] as number;
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return b;
  }
  return undefined;
}

/** Text evidence: valid UTF-8, no NUL, and never markup-first (HTML/SVG/XML are sniffable). */
function plausibleText(bytes: Uint8Array): boolean {
  if (bytes.includes(0x00)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return firstNonWhitespace(bytes) !== 0x3c; // '<'
}

export function isAllowedMediaType(value: string): value is EvidenceMediaType {
  return (EVIDENCE_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Checks a declared media type against the allow-list and the leading bytes. */
export function checkEvidenceMedia(declared: string, bytes: Uint8Array): MediaCheck {
  // Media type parameters (e.g. "; charset=utf-8") are not part of the identity; refuse them
  // rather than silently stripping, so the descriptor records exactly what was accepted.
  if (!isAllowedMediaType(declared)) return { ok: false, reason: 'TYPE_NOT_ALLOWED' };
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY' };
  if (REFUSED_SIGNATURES.some((sig) => startsWith(bytes, sig)))
    return { ok: false, reason: 'CONTENT_MISMATCH' };
  let ok: boolean;
  switch (declared) {
    case 'application/pdf':
      ok = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
      break;
    case 'image/png':
      ok = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      break;
    case 'image/jpeg':
      ok = startsWith(bytes, [0xff, 0xd8, 0xff]);
      break;
    case 'video/mp4':
      ok = startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4); // ....ftyp
      break;
    case 'application/json': {
      const first = firstNonWhitespace(bytes);
      ok = plausibleText(bytes) && (first === 0x7b || first === 0x5b); // { or [
      break;
    }
    case 'text/plain':
    case 'text/csv':
      ok = plausibleText(bytes);
      break;
  }
  return ok ? { ok: true, mediaType: declared } : { ok: false, reason: 'CONTENT_MISMATCH' };
}

/** Strict RFC 4648 base64 (no whitespace, correct padding) → bytes, or undefined. */
export function decodeStrictBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? new Uint8Array(bytes) : undefined;
}
