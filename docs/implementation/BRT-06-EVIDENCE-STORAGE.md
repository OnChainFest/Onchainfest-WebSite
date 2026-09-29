# BRT-06 — Evidence Storage

| Field | Value |
|---|---|
| Implements | [ADR-0018](../adr/ADR-0018-evidence-object-storage.md) (content-addressed private storage), BRT-02 [ingestion §2](../architecture/BRT-02-INGESTION-AND-ADAPTERS.md#2-evidence-storage), [key management §6](../architecture/BRT-02-SIGNATURES-AND-HASHING.md#6-key-management) |
| New ADR | [ADR-0030](../adr/ADR-0030-development-encrypted-evidence-store-and-fail-closed-production.md) |
| Code | `packages/evidence/src/{blob-store,cipher,media}.ts`, `packages/persistence/src/evidence-store.ts` |

## 1. Ports

```
EvidenceBlobStore { backend, available, put(bytes | AsyncIterable, {maxBytes}), get(hash), exists(hash), purge(hash) }
EvidenceCipher    { keyId, encryptor(), decryptor(keyId, nonce, tag) }
```

- **The store computes the hash.** `put` hashes the exact bytes it receives (streaming SHA-256); a client hash, filename, length or media type is never proof of content (the API schema rejects a client `contentHash` member outright).
- **Content addressing.** The address is `sha256:<hex>`; locations are derived internally from a validated hash. Rows store only `backend` (e.g. `devfs/v1`) and a non-secret `key_ref`; no paths, URLs, bucket names or keys are ever stored, returned, logged or emitted.
- **Streaming-ready.** The port accepts an async iterable and enforces `maxBytes` while streaming; only the bounded *reference API* reads a whole body.
- **Purge only through the lifecycle** (`DELETED_BY_*` availability), never as ordinary deletion.
- **Reads fail closed.** A missing, truncated, corrupted, swapped or wrongly-keyed object → `EVIDENCE_NOT_AVAILABLE`.

## 2. Development implementation: `FilesystemEvidenceBlobStore`

```
<root>/sha256/<h0h1>/<h2h3>/<hex>.blob   = "BREV" ‖ 0x01 ‖ len(keyId) ‖ keyId ‖ nonce(12) ‖ ciphertext ‖ tag(16)
<root>/tmp/<random>.part                 transient; removed on failure
```

- AES-256-GCM, fresh random 96-bit nonce per object, AAD = `br-evidence-blob/v1|aes-256-gcm|<keyId>`.
- Bytes are encrypted **while streaming** into an `O_EXCL` 0600 temp file; plaintext never touches the disk. After `fsync`, the temp file is renamed to its content address (if identical bytes already exist, the new copy is discarded — blob deduplication), then existence is re-checked.
- On read, after GCM authentication the plaintext is re-hashed and compared with the address, so a valid ciphertext of *other* bytes is refused.
- Path traversal is impossible: only `^sha256:[0-9a-f]{64}$` produces a path, and the resolved path must stay under the root.
- Refuses `NODE_ENV=production`. Root must be absolute: explicit option, `BR_EVIDENCE_DEV_DIR`, or an **explicitly requested** ephemeral temp dir.

**EvidenceCipher (development).** No built-in key: explicit material, `BR_EVIDENCE_DEV_KEY` (≥ 32 random chars), or an explicitly requested ephemeral key. The AES key is `SHA-256("br-evidence-dev:" ‖ material)` — a different derivation label from the PII vault (`br-vault-dev:`), and material equal to `BR_VAULT_DEV_KEY` is refused: evidence and PII never share key material or lifecycle (ADR-0016 per-class keys). Not a KMS, no rotation; refuses production. The key never reaches the database, logs, outbox or API.

## 3. Production: fail closed

No production object-store/KMS adapter exists. `unavailableEvidenceBlobStore` is the default everywhere:

- `POST /v1/evidence` → **503 `EVIDENCE_STORAGE_UNAVAILABLE`** (checked before the body is decoded into the store);
- `GET /v1/evidence/:id/content` → 503;
- metadata, attachments of existing items, attestations, retractions, bundles and public cards keep working (they never need bytes).

`apps/api/src/main.ts` never builds the development store in production. Deferred: S3-compatible object storage with SSE-KMS + class-specific envelope encryption, signed short-lived URLs, pre-signed multipart direct upload with server-side hash verification, object lock / retention, integrity sweeps.

## 4. Storage atomicity

Database and blob store are not one transaction. The ingestion workflow is:

1. read the platform-observed receipt time (tiny transaction);
2. `put` the bytes: hash, encrypt, write, `fsync`, rename, re-check existence;
3. one metadata transaction: idempotency, representation/lineage checks, blob registry row (`ON CONFLICT DO NOTHING`), item, lineage, availability/privacy initial facts, optional attachment, ledger (`EVIDENCE_ITEM` stream), outbox, audit, projection.

Guarantee: **a committed EvidenceItem never points to bytes that were never stored** (the blob row is only written after step 2 succeeded; items reference the blob by FK). A crash between 2 and 3 leaves an unreferenced encrypted blob — acceptable, eligible for garbage collection (GC job deferred). **Time (BRT-06R).** `received_at` (step 1) and `recorded_at` (step 3) are two separate readings of the same database clock, in two transactions. No ordering between them is enforced: under a clock step it is not guaranteed, and **neither value is ever rewritten** to force one (the earlier clamp was removed — it would have falsified the observed time). Both are stored verbatim; `received_at` is bound into the descriptor hash exactly as observed.

## 5. Reference upload path (bounded)

`POST /v1/evidence` takes JSON with strict base64 content: cap **2 MiB raw** (`MAX_REFERENCE_UPLOAD_BYTES`), route `bodyLimit` ≈ 2.8 MB. Larger or streamed uploads (video) need the deferred direct-to-object-store path; the ports already support streaming.

## 6. Content-type safety

Allow-list: `application/json`, `application/pdf`, `image/jpeg`, `image/png`, `text/csv`, `text/plain`, `video/mp4` (no parameters). The leading bytes must match (PDF/PNG/JPEG/MP4 magic; text types must be valid UTF-8, NUL-free and not markup-first). Refused whatever the label: HTML/SVG/XML-first text, PE/ELF/Mach-O executables, shebang scripts, ZIP/OOXML/JAR, gzip/bzip2/xz/7z/RAR (archive bombs). Bytes are never parsed, rendered or executed.

Downloads: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`, declared allow-listed media type. Production malware scanning is deferred (threat review §1).

## 7. Rebuilds need no bytes

`rebuildEvidenceReadModels` (maintenance login → `br_rebuild`) reads metadata tables only. No blob credential or cipher key exists in the database or its role configuration (tested: `pg_db_role_setting` is empty for all `br_*` roles).
