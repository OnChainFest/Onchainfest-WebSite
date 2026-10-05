import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * PII cipher port (BRT-02 key management; BRT-04 §6). The vault stores only envelopes.
 *
 * No production KMS is selected yet. `DevelopmentPiiCipher` provides AES-256-GCM with a key taken
 * from the environment: it protects vault rows against readers without the key (e.g. a leaked
 * dump), nothing more. It is NOT a KMS, has no key rotation, and refuses to run in production;
 * production therefore fails closed until a KMS-backed cipher is implemented.
 */
export interface EncryptedEnvelope {
  readonly alg: 'AES-256-GCM';
  readonly keyId: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

export interface PiiCipher {
  readonly keyId: string;
  encrypt(field: string, plaintext: string): EncryptedEnvelope;
  decrypt(field: string, envelope: EncryptedEnvelope): string;
  /** Keyed fingerprint (HMAC) for idempotency comparisons — never a plain hash of PII. */
  fingerprint(data: string): string;
}

/** Minimum length of development key material (e.g. `openssl rand -hex 32` gives 64). */
export const MIN_DEV_KEY_MATERIAL_LENGTH = 32;

export interface DevelopmentPiiCipherOptions {
  /** Explicit key material (tests, harnesses). Takes precedence over BR_VAULT_DEV_KEY. */
  readonly keyMaterial?: string;
  /**
   * Explicitly request a random in-memory key. Data encrypted with it is unreadable after the
   * process exits: only for throwaway runs (e.g. an in-process demo), never for persistent data.
   */
  readonly ephemeral?: true;
}

/**
 * Development PII cipher. There is NO built-in key: key material must be passed explicitly or
 * provided via BR_VAULT_DEV_KEY (≥ 32 characters), or an ephemeral key must be requested
 * explicitly. Otherwise it fails closed. It never runs in production.
 */
export function createDevelopmentPiiCipher(options: DevelopmentPiiCipherOptions = {}): PiiCipher {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'the development PII cipher is not available in production (configure a KMS-backed cipher)',
    );
  }
  const env = process.env.BR_VAULT_DEV_KEY;
  let keyMaterial: string;
  if (options.keyMaterial !== undefined) keyMaterial = options.keyMaterial;
  else if (env !== undefined && env !== '') keyMaterial = env;
  else if (options.ephemeral === true) keyMaterial = randomBytes(32).toString('hex');
  else {
    throw new Error(
      'no PII vault key configured: set BR_VAULT_DEV_KEY (e.g. `export BR_VAULT_DEV_KEY=$(openssl rand -hex 32)`) or pass keyMaterial explicitly',
    );
  }
  if (keyMaterial.length < MIN_DEV_KEY_MATERIAL_LENGTH) {
    throw new Error(
      `PII vault key material must be at least ${MIN_DEV_KEY_MATERIAL_LENGTH} characters`,
    );
  }
  const key = createHash('sha256').update(`br-vault-dev:${keyMaterial}`).digest();
  const keyId = `dev-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  return {
    keyId,
    encrypt(field, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(field, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        alg: 'AES-256-GCM',
        keyId,
        iv: iv.toString('base64'),
        ct: ct.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    },
    decrypt(field, envelope) {
      if (envelope.keyId !== keyId) throw new Error('unknown PII key id');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(field, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ct, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
    fingerprint(data) {
      return `hmac-sha256:${createHmac('sha256', key).update(data, 'utf8').digest('hex')}`;
    },
  };
}
