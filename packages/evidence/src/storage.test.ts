import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashEvidenceBytes } from '@br/canonical';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDevelopmentEvidenceCipher,
  developmentEvidenceBlobStore,
  FilesystemEvidenceBlobStore,
  unavailableEvidenceBlobStore,
} from './index';

const SENTINEL = `EVIDENCE-SENTINEL-${Math.random().toString(36).slice(2)}-plaintext`;
const key = () => `k-${Math.random().toString(36).slice(2)}-${'0123456789abcdef'.repeat(3)}`;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

const store = (keyMaterial = key(), root = mkdtempSync(join(tmpdir(), 'br-ev-test-'))) => ({
  root,
  keyMaterial,
  s: new FilesystemEvidenceBlobStore({
    root,
    cipher: createDevelopmentEvidenceCipher({ keyMaterial }),
  }),
});

describe('development encrypted content-addressed evidence store', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('put → get round-trip; the store computes the hash of the exact bytes', async () => {
    const { s } = store();
    const bytes = new TextEncoder().encode(`{"sheet":"${SENTINEL}"}`);
    const put = await s.put(bytes);
    expect(put.contentHash).toBe(hashEvidenceBytes(bytes));
    expect(put.byteLength).toBe(bytes.length);
    expect(put.backend).toBe('devfs/v1');
    expect(await s.get(put.contentHash)).toEqual(bytes);
  });

  it('identical bytes deduplicate to one blob (streamed input too)', async () => {
    const { s, root } = store();
    const bytes = new TextEncoder().encode(SENTINEL.repeat(1000));
    const a = await s.put(bytes);
    async function* stream() {
      yield bytes.subarray(0, 7);
      yield bytes.subarray(7);
    }
    const b = await s.put(stream());
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.contentHash).toBe(a.contentHash);
    expect(files(join(root, 'sha256'))).toHaveLength(1);
    expect(files(join(root, 'tmp'))).toHaveLength(0);
  });

  it('the file on disk never contains the plaintext sentinel, and paths contain only the hash', async () => {
    const { s, root } = store();
    const put = await s.put(new TextEncoder().encode(SENTINEL));
    for (const f of files(root)) {
      expect(readFileSync(f).includes(Buffer.from(SENTINEL))).toBe(false);
      expect(f).not.toContain(SENTINEL);
      expect(f.endsWith(`${put.contentHash.slice(7)}.blob`)).toBe(true);
    }
  });

  it('path traversal and malformed addresses are impossible', async () => {
    const { s } = store();
    for (const bad of [
      '../../etc/passwd',
      'sha256:../../x',
      `sha256:${'a'.repeat(63)}/`,
      'sha256:ZZ',
    ])
      await expect(s.get(bad)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_AVAILABLE' });
    expect(await s.exists('../x')).toBe(false);
  });

  it('missing, corrupt or swapped blobs and wrong keys fail closed', async () => {
    const { s, root, keyMaterial } = store();
    const a = await s.put(new TextEncoder().encode('first'));
    const b = await s.put(new TextEncoder().encode('second'));
    await expect(s.get(hashEvidenceBytes(new Uint8Array([1])))).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_AVAILABLE',
    });
    const [fa, fb] = [a, b].map(
      (x) => files(root).find((f) => f.includes(x.contentHash.slice(7))) as string,
    );
    // swapped object: valid ciphertext of other bytes under the right key is refused (address check)
    writeFileSync(fa as string, readFileSync(fb as string));
    await expect(s.get(a.contentHash)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_AVAILABLE' });
    // corruption (flip one byte)
    const raw = readFileSync(fb as string);
    raw[raw.length - 20] = (raw[raw.length - 20] as number) ^ 0xff;
    writeFileSync(fb as string, raw);
    await expect(s.get(b.contentHash)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_AVAILABLE' });
    // wrong key
    const c = await s.put(new TextEncoder().encode('third'));
    const other = new FilesystemEvidenceBlobStore({
      root,
      cipher: createDevelopmentEvidenceCipher({ keyMaterial: key() }),
    });
    await expect(other.get(c.contentHash)).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_AVAILABLE',
    });
    expect(keyMaterial).not.toBe('');
  });

  it('size limit is enforced while streaming; purge removes bytes', async () => {
    const { s } = store();
    await expect(s.put(new Uint8Array(1025), { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'EVIDENCE_TOO_LARGE',
    });
    const p = await s.put(new Uint8Array([1, 2, 3]));
    await s.purge(p.contentHash);
    expect(await s.exists(p.contentHash)).toBe(false);
    await expect(s.get(p.contentHash)).rejects.toMatchObject({ code: 'EVIDENCE_NOT_AVAILABLE' });
  });

  it('no built-in key: explicit material, env key or explicit ephemeral only; never the vault key', () => {
    delete process.env.BR_EVIDENCE_DEV_KEY;
    delete process.env.BR_EVIDENCE_DEV_DIR;
    expect(() => createDevelopmentEvidenceCipher()).toThrow(/no evidence encryption key/);
    expect(() => createDevelopmentEvidenceCipher({ keyMaterial: 'short' })).toThrow(/at least/);
    expect(() => createDevelopmentEvidenceCipher({ keyMaterial: 'a'.repeat(40) })).toThrow(
      /random/,
    );
    const shared = key();
    process.env.BR_VAULT_DEV_KEY = shared;
    expect(() => createDevelopmentEvidenceCipher({ keyMaterial: shared })).toThrow(
      /differ from the PII vault key/,
    );
    expect(developmentEvidenceBlobStore()).toBeUndefined(); // nothing configured → caller fails closed
    expect(developmentEvidenceBlobStore({ ephemeral: true })?.available).toBe(true);
  });

  it('production refuses the development adapter and the fail-closed store refuses bytes', async () => {
    process.env.NODE_ENV = 'production';
    expect(() => createDevelopmentEvidenceCipher({ keyMaterial: key() })).toThrow(/production/);
    expect(() => new FilesystemEvidenceBlobStore({ root: tmpdir(), cipher: {} as never })).toThrow(
      /production/,
    );
    expect(developmentEvidenceBlobStore({ ephemeral: true })).toBeUndefined();
    expect(unavailableEvidenceBlobStore.available).toBe(false);
    await expect(unavailableEvidenceBlobStore.put(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'EVIDENCE_STORAGE_UNAVAILABLE',
    });
  });
});
