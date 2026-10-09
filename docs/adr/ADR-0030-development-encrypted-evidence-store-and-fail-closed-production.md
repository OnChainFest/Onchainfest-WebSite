# ADR-0030 — Development encrypted evidence store; production evidence ingestion fails closed

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-06 (ADR-0018, ADR-0016, ADR-0023)

## Context

ADR-0018 requires private, encrypted, content-addressed storage (S3-compatible + KMS). No production object-store/KMS adapter exists yet, but the model must be exercised end to end, and nothing may pretend to be production storage.

## Decision

1. **Ports:** `EvidenceBlobStore` (computes the hash, content-addressed, streaming, purge only via lifecycle, fail-closed reads) and `EvidenceCipher` (separate from the PII cipher; per-object nonce; AAD-bound key id).
2. **Development:** `FilesystemEvidenceBlobStore` + development AES-256-GCM cipher. Explicit root (`BR_EVIDENCE_DEV_DIR`) or explicit ephemeral; explicit key (`BR_EVIDENCE_DEV_KEY`, never equal to the vault key, distinct derivation label) or explicit ephemeral; no built-in key; plaintext never on disk; refuses production.
3. **Production:** the fail-closed placeholder answers `EVIDENCE_STORAGE_UNAVAILABLE` for byte ingestion and content reads; metadata, attestations and bundles keep working.
4. **Atomicity:** bytes first (durable and re-checked), metadata second; orphan blobs acceptable and collectible; dangling item pointers impossible.
5. **No blob credentials in the database** (rows keep an opaque backend id and a key reference); rebuilds never need bytes.

## Consequences

- Development and CI exercise real encryption, dedupe and fail-closed reads without a cloud dependency.
- A production adapter (object storage + SSE-KMS/envelope keys, signed URLs, multipart direct upload, retention/object lock, integrity sweeps, malware scanning) is required before production evidence ingestion.

## Alternatives considered

- **Store bytes in PostgreSQL:** rejected (ADR-0018).
- **Unencrypted dev directory:** rejected (plaintext at rest; tests must prove encryption).
- **Reuse the PII cipher/key:** rejected (different lifecycle and key domain).
