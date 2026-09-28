import { createHash } from 'node:crypto';
import { CanonicalError, CanonicalErrorCode } from './errors';

/** Profile identifier bound into every preimage (ADR-0014). */
export const PROFILE_ID = 'br-json/1';
/** Hash-construction version byte following the "BR" magic. */
export const HASH_CONSTRUCTION_VERSION = 0x01;

export const DOMAIN_TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `sha256:<64 lowercase hex>` */
export type ContentHash = `sha256:${string}`;

export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: string): value is ContentHash {
  return CONTENT_HASH_PATTERN.test(value);
}

export function toContentHash(digest: Uint8Array): ContentHash {
  return `sha256:${Buffer.from(digest).toString('hex')}`;
}

/**
 * Preimage per BRT-02 §3.2:
 *   "BR" ‖ 0x01 ‖ domainTag ‖ 0x00 ‖ schemaId "@" schemaVersion ‖ 0x00 ‖ profileId ‖ 0x00 ‖ JCS bytes
 */
export function buildPreimage(
  domainTag: string,
  schemaId: string,
  schemaVersion: number,
  jcs: Uint8Array,
): Uint8Array {
  if (!DOMAIN_TAG_PATTERN.test(domainTag)) {
    throw new CanonicalError(
      CanonicalErrorCode.DOMAIN_TAG,
      '',
      `invalid domain tag ${JSON.stringify(domainTag)}`,
    );
  }
  const ascii = (s: string): Buffer => {
    if (!/^[\x20-\x7e]*$/.test(s))
      throw new CanonicalError(
        CanonicalErrorCode.DOMAIN_TAG,
        '',
        `non-ASCII preimage label ${JSON.stringify(s)}`,
      );
    return Buffer.from(s, 'ascii');
  };
  const zero = Buffer.from([0x00]);
  return Buffer.concat([
    Buffer.from('BR', 'ascii'),
    Buffer.from([HASH_CONSTRUCTION_VERSION]),
    ascii(domainTag),
    zero,
    ascii(`${schemaId}@${schemaVersion}`),
    zero,
    ascii(PROFILE_ID),
    zero,
    Buffer.from(jcs),
  ]);
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

/**
 * Evidence bytes are hashed as plain SHA-256 of the raw bytes, with no domain separation, so
 * anyone can verify them with standard tools (BRT-02 §3.2, ADR-0018).
 */
export function hashEvidenceBytes(bytes: Uint8Array): ContentHash {
  return toContentHash(sha256(bytes));
}
