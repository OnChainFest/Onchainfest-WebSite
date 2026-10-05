# ADR-0018 — Private, content-addressed object storage for evidence

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

Evidence includes photos, video, documents, timing exports, sensor streams and officiating outputs. It is often personal, sometimes about minors, and sometimes large. BRT-01 E-5, E-6 and ADR-0009 forbid putting it on-chain or publishing it by default.

## Decision

1. **Store** blobs in **private S3-compatible buckets**, keyed by the SHA-256 of the raw bytes. Use SSE-KMS, class-specific envelope encryption for AUTHORITY_ONLY, versioning, and object lock for retention-bound classes.
2. **Separate bytes from provenance.** `evidence_blob` (bytes, by hash) is distinct from `evidence_item` (provenance, privacy, retention). One blob may back many items. Derived evidence is always a new item with provenance edges.
3. **Access** is only through short-lived signed URLs issued after application and domain checks. Access is audited, including the purpose.
4. **Large objects and streams** use pre-signed multipart upload with server-side hash verification, and chunk manifests (device-signed for certified systems).
5. **IPFS or public replicas** are only for evidence explicitly released as PUBLIC, and for trophy metadata.
6. **Retention deletes bytes, never hashes or metadata.** Record-supporting and disputed evidence is retention-locked. Availability (`AVAILABLE`, `ARCHIVED`, `RESTRICTED`, `EXPIRED`, `DELETED_BY_RETENTION`, `DELETED_BY_ERASURE`, plus a `legal_hold` flag) is an append-only status. Historical verifications remain immutable. New verification runs flag `EVIDENCE_UNAVAILABLE`, and policy decides whether the level can be retained. Deleted evidence is never presented as inspectable ([Ingestion §2.4](../architecture/BRT-02-INGESTION-AND-ADAPTERS.md#24-evidence-availability-model)).

## Consequences

**Benefits:**

- Integrity is independently checkable.
- Privacy is preserved.
- Storage cost scales.

**Costs:**

- Signed-URL and encryption plumbing.
- Integrity sweeps are needed.
