import { createHash, randomBytes } from 'node:crypto';
import { constants, mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isContentHash, type ContentHash } from '@br/canonical';
import { DomainError, DomainErrorCode } from '@br/domain';
import {
  createDevelopmentEvidenceCipher,
  type DevelopmentEvidenceCipherOptions,
  type EvidenceCipher,
} from './cipher';

/**
 * EvidenceBlobStore port (BRT-06 §11; ADR-0018): private, content-addressed evidence bytes.
 *
 *  - The store computes the SHA-256 of the exact bytes it receives; callers never supply it.
 *  - Addresses are content hashes; storage locations are derived internally and never exposed
 *    (no paths, bucket URLs or keys in rows, DTOs, logs or events). Rows keep only the opaque
 *    backend id and a non-secret key reference.
 *  - One blob may back many EvidenceItems (independent provenance over identical bytes).
 *  - `put` streams (the port never assumes small files); `purge` exists only for the explicit
 *    availability lifecycle (retention/erasure), never as ordinary deletion.
 *  - Reads fail closed: a missing, corrupted, swapped or wrongly-keyed object is unavailable.
 */
export interface StoredBlob {
  readonly contentHash: ContentHash;
  readonly byteLength: number;
  /** Opaque backend identifier (e.g. "devfs/v1"), never a path or URL. */
  readonly backend: string;
  readonly keyId: string;
  /** False when identical bytes were already stored (blob-level deduplication). */
  readonly created: boolean;
}

export interface EvidenceBlobStore {
  readonly backend: string;
  /** False for the fail-closed production placeholder. */
  readonly available: boolean;
  put(
    source: Uint8Array | AsyncIterable<Uint8Array>,
    options?: { maxBytes?: number },
  ): Promise<StoredBlob>;
  /** Decrypted bytes, re-verified against the address. */
  get(contentHash: string): Promise<Uint8Array>;
  exists(contentHash: string): Promise<boolean>;
  purge(contentHash: string): Promise<void>;
}

const storageUnavailable = () =>
  new DomainError(
    DomainErrorCode.EVIDENCE_STORAGE_UNAVAILABLE,
    'evidence storage is not configured (production object storage + KMS are not implemented yet)',
  );
const notAvailable = () =>
  new DomainError(DomainErrorCode.EVIDENCE_NOT_AVAILABLE, 'evidence content is not available');

/**
 * Production placeholder: there is no production object store / KMS adapter yet, so evidence byte
 * ingestion and content reads FAIL CLOSED (503 EVIDENCE_STORAGE_UNAVAILABLE). Metadata reads,
 * attestations over existing items and bundle building do not need bytes and keep working.
 */
export const unavailableEvidenceBlobStore: EvidenceBlobStore = {
  backend: 'unavailable',
  available: false,
  put: () => Promise.reject(storageUnavailable()),
  get: () => Promise.reject(storageUnavailable()),
  exists: () => Promise.resolve(false),
  purge: () => Promise.reject(storageUnavailable()),
};

const MAGIC = Buffer.from('BREV', 'ascii');
const FORMAT_VERSION = 0x01;

async function* chunks(source: Uint8Array | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    for (let i = 0; i < source.length; i += 64 * 1024) yield source.subarray(i, i + 64 * 1024);
  } else {
    yield* source;
  }
}

/**
 * Development/test reference implementation: an encrypted, content-addressed directory.
 *   <root>/sha256/<h0h1>/<h2h3>/<hex>.blob     BREV ‖ 0x01 ‖ len(keyId) ‖ keyId ‖ nonce ‖ ct ‖ tag
 * Paths are derived only from a validated hash (no traversal); plaintext never touches the disk
 * (bytes are encrypted while streaming into a temp file, which is renamed into place only after the
 * hash is known). Refuses NODE_ENV=production.
 */
export class FilesystemEvidenceBlobStore implements EvidenceBlobStore {
  readonly backend = 'devfs/v1';
  readonly available = true;
  private readonly root: string;
  private readonly cipher: EvidenceCipher;

  constructor(options: { root: string; cipher: EvidenceCipher }) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('the development evidence blob store is not available in production');
    }
    if (!isAbsolute(options.root)) throw new Error('the evidence store root must be absolute');
    this.root = resolve(options.root);
    this.cipher = options.cipher;
    mkdirSync(join(this.root, 'tmp'), { recursive: true, mode: 0o700 });
  }

  /** Internal location of a blob. Only a validated `sha256:<64 hex>` can produce a path. */
  private pathOf(contentHash: string): string {
    if (!isContentHash(contentHash)) throw notAvailable();
    const hex = contentHash.slice('sha256:'.length);
    const p = resolve(this.root, 'sha256', hex.slice(0, 2), hex.slice(2, 4), `${hex}.blob`);
    if (!p.startsWith(this.root + sep)) throw notAvailable();
    return p;
  }

  async put(
    source: Uint8Array | AsyncIterable<Uint8Array>,
    options: { maxBytes?: number } = {},
  ): Promise<StoredBlob> {
    const enc = this.cipher.encryptor();
    const keyId = Buffer.from(enc.keyId, 'ascii');
    if (keyId.length > 255) throw new Error('evidence key id too long');
    const temp = join(this.root, 'tmp', `${randomBytes(16).toString('hex')}.part`);
    const hash = createHash('sha256');
    let byteLength = 0;
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let moved = false;
    try {
      await file.write(
        Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, keyId.length]), keyId, enc.nonce]),
      );
      for await (const chunk of chunks(source)) {
        byteLength += chunk.length;
        if (options.maxBytes !== undefined && byteLength > options.maxBytes) {
          throw new DomainError(
            DomainErrorCode.EVIDENCE_TOO_LARGE,
            'evidence exceeds the size limit',
          );
        }
        hash.update(chunk);
        await file.write(enc.update(chunk));
      }
      const { tail, tag } = enc.final();
      await file.write(Buffer.concat([tail, tag]));
      await file.sync();
      await file.close();
      const contentHash = `sha256:${hash.digest('hex')}` as ContentHash;
      const target = this.pathOf(contentHash);
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      const created = !(await this.exists(contentHash));
      if (created) await rename(temp, target);
      moved = created;
      // Finalize-then-verify: the metadata transaction only runs after the bytes are durable.
      if (!(await this.exists(contentHash))) throw notAvailable();
      return { contentHash, byteLength, backend: this.backend, keyId: enc.keyId, created };
    } finally {
      await file.close().catch(() => undefined);
      if (!moved) await unlink(temp).catch(() => undefined);
    }
  }

  async get(contentHash: string): Promise<Uint8Array> {
    let raw: Buffer;
    try {
      raw = await readFile(this.pathOf(contentHash));
    } catch {
      throw notAvailable();
    }
    try {
      if (raw.length < 6 || !raw.subarray(0, 4).equals(MAGIC) || raw[4] !== FORMAT_VERSION)
        throw notAvailable();
      const keyLen = raw[5] as number;
      const headerEnd = 6 + keyLen + 12;
      if (raw.length < headerEnd + 16) throw notAvailable();
      const keyId = raw.subarray(6, 6 + keyLen).toString('ascii');
      const nonce = raw.subarray(6 + keyLen, headerEnd);
      const tag = raw.subarray(raw.length - 16);
      const dec = this.cipher.decryptor(keyId, nonce, tag);
      const plain = Buffer.concat([
        dec.update(raw.subarray(headerEnd, raw.length - 16)),
        dec.final(),
      ]);
      // The address is re-verified: a valid ciphertext of other bytes is still refused.
      if (`sha256:${createHash('sha256').update(plain).digest('hex')}` !== contentHash)
        throw notAvailable();
      return new Uint8Array(plain);
    } catch {
      throw notAvailable();
    }
  }

  async exists(contentHash: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(contentHash))).isFile();
    } catch {
      return false;
    }
  }

  async purge(contentHash: string): Promise<void> {
    await unlink(this.pathOf(contentHash)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

export interface DevelopmentEvidenceStoreOptions extends DevelopmentEvidenceCipherOptions {
  /** Explicit root. Otherwise BR_EVIDENCE_DEV_DIR, or a fresh temp dir when `ephemeral`. */
  readonly root?: string;
}

/**
 * Development store from explicit options or the environment:
 *   BR_EVIDENCE_DEV_DIR  absolute storage root (explicit), and
 *   BR_EVIDENCE_DEV_KEY  key material (explicit, ≥ 32 random chars; never the vault key).
 * With `ephemeral: true`, both a fresh temp directory and a random key are used (throwaway runs).
 * Returns undefined when nothing is configured, so callers fall back to the fail-closed store.
 */
export function developmentEvidenceBlobStore(
  options: DevelopmentEvidenceStoreOptions = {},
): EvidenceBlobStore | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  const envDir = process.env.BR_EVIDENCE_DEV_DIR;
  const root =
    options.root ??
    (envDir !== undefined && envDir !== ''
      ? envDir
      : options.ephemeral === true
        ? mkdtempSync(join(tmpdir(), 'br-evidence-'))
        : undefined);
  if (root === undefined) return undefined;
  const envKey = process.env.BR_EVIDENCE_DEV_KEY;
  if (options.keyMaterial === undefined && options.ephemeral !== true && (envKey ?? '') === '')
    return undefined;
  return new FilesystemEvidenceBlobStore({
    root,
    cipher: createDevelopmentEvidenceCipher(options),
  });
}
