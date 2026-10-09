import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

/**
 * EvidenceCipher port (BRT-06 §14). Separate from the PII cipher: evidence bytes and PII have
 * different lifecycles, access paths and key domains (ADR-0016 per-class data keys), so they never
 * share key material. The production implementation (KMS-wrapped per-object data keys) is
 * deferred; without it evidence ingestion fails closed.
 *
 * Envelope per object: fresh random 96-bit nonce, AES-256-GCM, AAD binding the format version and
 * key id. The object's address (its plaintext SHA-256) is re-verified after decryption, so a
 * swapped or corrupted object fails closed even under a valid key.
 */
export interface EvidenceEncryptor {
  readonly keyId: string;
  readonly nonce: Buffer;
  update(chunk: Uint8Array): Buffer;
  /** Returns the remaining ciphertext and the 16-byte authentication tag. */
  final(): { readonly tail: Buffer; readonly tag: Buffer };
}

export interface EvidenceDecryptor {
  update(chunk: Uint8Array): Buffer;
  /** Throws when the tag does not authenticate (wrong key, tampering, truncation). */
  final(): Buffer;
}

export interface EvidenceCipher {
  /** Non-secret key reference recorded with each blob (internal only; never in public DTOs). */
  readonly keyId: string;
  encryptor(): EvidenceEncryptor;
  decryptor(keyId: string, nonce: Uint8Array, tag: Uint8Array): EvidenceDecryptor;
}

export const EVIDENCE_BLOB_FORMAT = 'br-evidence-blob/v1';
export const MIN_EVIDENCE_KEY_MATERIAL_LENGTH = 32;

function aad(keyId: string): Buffer {
  return Buffer.from(`${EVIDENCE_BLOB_FORMAT}|aes-256-gcm|${keyId}`, 'utf8');
}

export interface DevelopmentEvidenceCipherOptions {
  /** Explicit key material (tests, harnesses). Takes precedence over BR_EVIDENCE_DEV_KEY. */
  readonly keyMaterial?: string;
  /** Explicitly request a random in-memory key (throwaway stores only). */
  readonly ephemeral?: true;
}

/**
 * Development evidence cipher. NO built-in key: explicit key material, BR_EVIDENCE_DEV_KEY
 * (≥ 32 characters, never equal to BR_VAULT_DEV_KEY) or an explicitly requested ephemeral key.
 * The AES key is derived with a distinct domain label ("br-evidence-dev:") so even identical
 * material could not produce the PII vault key. Refuses production. It is NOT a KMS.
 */
export function createDevelopmentEvidenceCipher(
  options: DevelopmentEvidenceCipherOptions = {},
): EvidenceCipher {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'the development evidence cipher is not available in production (configure object storage + KMS)',
    );
  }
  const env = process.env.BR_EVIDENCE_DEV_KEY;
  let material: string;
  if (options.keyMaterial !== undefined) material = options.keyMaterial;
  else if (env !== undefined && env !== '') material = env;
  else if (options.ephemeral === true) material = randomBytes(32).toString('hex');
  else {
    throw new Error(
      'no evidence encryption key configured: set BR_EVIDENCE_DEV_KEY (e.g. `export BR_EVIDENCE_DEV_KEY=$(openssl rand -hex 32)`) or pass keyMaterial explicitly',
    );
  }
  if (material.length < MIN_EVIDENCE_KEY_MATERIAL_LENGTH || new Set(material).size < 10) {
    throw new Error(
      `evidence key material must be at least ${MIN_EVIDENCE_KEY_MATERIAL_LENGTH} random characters`,
    );
  }
  const vault = process.env.BR_VAULT_DEV_KEY;
  if (vault !== undefined && vault !== '' && vault === material) {
    throw new Error('the evidence key must differ from the PII vault key (separate key domains)');
  }
  const key = createHash('sha256').update(`br-evidence-dev:${material}`).digest();
  const keyId = `dev-evidence-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  return {
    keyId,
    encryptor() {
      const nonce = randomBytes(12);
      const cipher: CipherGCM = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(keyId));
      return {
        keyId,
        nonce,
        update: (chunk) => cipher.update(chunk),
        final: () => {
          const tail = cipher.final();
          return { tail, tag: cipher.getAuthTag() };
        },
      };
    },
    decryptor(objectKeyId, nonce, tag) {
      if (objectKeyId !== keyId) throw new Error('evidence blob encrypted under an unknown key');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('malformed evidence envelope');
      const decipher: DecipherGCM = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad(keyId));
      decipher.setAuthTag(tag);
      return { update: (chunk) => decipher.update(chunk), final: () => decipher.final() };
    },
  };
}
