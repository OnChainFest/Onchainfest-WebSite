# BRT-06 — Evidence Model

| Field | Value |
|---|---|
| Ticket | BRT-06 (Sports Truth Layer, part 1: Evidence & Attestation) |
| Implements | BRT-01 [verification model §2–3](../domain/BRT-01-VERIFICATION-MODEL.md), [data boundaries](../architecture/BRT-01-DATA-BOUNDARIES.md); BRT-02 [ingestion §2](../architecture/BRT-02-INGESTION-AND-ADAPTERS.md#2-evidence-storage), [persistence §4.2–4.3](../architecture/BRT-02-PERSISTENCE-ARCHITECTURE.md) |
| ADRs | [0002](../adr/ADR-0002-separate-evidence-attestation-verification.md), [0014](../adr/ADR-0014-canonical-json-and-hashing.md), [0018](../adr/ADR-0018-evidence-object-storage.md), new [0027](../adr/ADR-0027-person-principal-and-issuer-representation.md)–[0030](../adr/ADR-0030-development-encrypted-evidence-store-and-fail-closed-production.md) |
| Code | `packages/domain/src/evidence.ts` (vocabulary), `packages/evidence` (pure domain + storage ports), `packages/persistence/src/evidence-*.ts`, `db/migrations/0010_evidence.sql` |

Companion documents: [storage](./BRT-06-EVIDENCE-STORAGE.md) · [attestation protocol](./BRT-06-ATTESTATION-PROTOCOL.md) · [evidence bundle](./BRT-06-EVIDENCE-BUNDLE.md) · [development](./BRT-06-DEVELOPMENT.md) · [threat review](../security/BRT-06-EVIDENCE-ATTESTATION-THREAT-REVIEW.md).

---

## 1. What BRT-06 answers — and what it never decides

BRT-06 answers: what evidence exists; which exact bytes it is; where it came from; when the platform received it; what sporting object it is associated with; who submitted it; who signed which exact claim about which exact ResultVersion, citing which exact evidence; whether that signature is cryptographically valid; whether the claim was retracted or superseded; and it can reproduce the whole set deterministically (the [Evidence Bundle](./BRT-06-EVIDENCE-BUNDLE.md)).

It never decides **"is the sporting claim true?"** — that is BRT-07.

| Distinction | Where it is enforced |
|---|---|
| Evidence ≠ Attestation ≠ Result ≠ Verification | Separate schemas (`evidence`, `attestation`, `results`), separate module role `br_evidence` with no results/competition write access; no verification table, event or DTO field exists |
| Signature validity ≠ sporting truth / authority | Attestations are accepted **without** an authority decision (`authority: NOT_EVALUATED` in every DTO/event); the public card says "cryptographically signed claim" |
| Organization membership / competition staff / FEDERATION `org_type` ≠ sporting authority | Issuer representation is an application permission returned by a DB function; tests prove zero grants/anchors and a denied `ATTEST_RESULT` for representing principals |
| Evidence availability ≠ credibility | Availability is a lifecycle fact; there is no credibility/confidence field |
| Attachment ≠ assertion | Every attachment DTO carries `meaning: ASSOCIATED_WITH` |
| Result FINAL ≠ VERIFIED | BRT-06 never transitions a Result (tests prove status and transition counts unchanged) |

## 2. Vocabulary: accepted terms vs the ticket's illustrative names

The ticket proposed illustrative names "or equivalent accepted terminology". BRT-06 uses the **accepted** BRT-01/BRT-02/ADR-0018 vocabulary so no accepted semantics are silently reinterpreted:

| Ticket name | Implemented (accepted) term | Source |
|---|---|---|
| Source kinds `USER_UPLOAD`, `ORGANIZATION_UPLOAD`, `PROVIDER_IMPORT`, `DEVICE_CAPTURE`, `SYSTEM_CAPTURE`, `MACHINE_DERIVED` | `HUMAN`, `ORGANIZATION`, `EXTERNAL_API`, `DEVICE`, `SCORING_SYSTEM` / `TIMING_SYSTEM`, `AI_PIPELINE` (+ `HISTORICAL_ARCHIVE`) | BRT-01 §2.1 |
| Visibility `PRIVATE` / `RESTRICTED` / `PUBLIC_METADATA` | Privacy class `PLATFORM_PRIVATE` (default) / `AUTHORITY_ONLY`; public exposure is metadata-only by construction (no `PUBLIC` raw release in BRT-06) | BRT-01 data boundaries §2, DB-5 |
| Availability `AVAILABLE` / `QUARANTINED` / `UNAVAILABLE` / `PURGED` | `AVAILABLE`, `RESTRICTED` (≈ quarantined / marked unavailable, bytes kept), `DELETED_BY_RETENTION` / `DELETED_BY_ERASURE` (≈ purged); `ARCHIVED` / `EXPIRED` exist in the vocabulary with no command yet | ADR-0018 §6, BRT-02 ingestion §2.4 |
| Claims `RESULT_CONFIRMATION` / `RESULT_DISPUTE` / `CONDITIONS_OBSERVATION` | `RESULT_ACCURATE` + `AFFIRM` / `RESULT_ACCURATE` + `DENY` / `CONDITIONS_COMPLIANT` (+ `AFFIRM`/`DENY`) with a bounded observation payload | BRT-01 §3.2 (polarity) |
| Retraction | Signed `AttestationRetraction` — the issuer-initiated form of BRT-01 A-2 revocation (the attestation's derived claim status reads `RETRACTED`) | BRT-01 A-2 |
| Events `EvidenceCreated`, `AttestationSubmitted` | `EvidenceAdded`, `AttestationIssued` (BRT-02 names); new: `EvidenceAttached`, `EvidenceDerived`, `EvidencePrivacyRaised`, `AttestationRetracted`, `AttestationSuperseded`, `PersonPrincipalMapped` | BRT-02 system architecture §11 |

A DENY attestation is a *dispute claim*, not a Dispute entity (ADR-0007 stays untouched).

## 3. EvidenceItem

An EvidenceItem is an **immutable provenance record over exact bytes** (`evidence.item`, class A):

| Column | Meaning | Time kind (BRT-02 §5.1) |
|---|---|---|
| `id` | UUIDv7 | — |
| `descriptor`, `descriptor_hash`, `descriptor_version = 1` | Normalized [descriptor](#4-evidencedescriptor) and its domain-separated hash | — |
| `content_hash`, `byte_length`, `media_type` | Server-computed plain SHA-256 of the raw bytes, length, allow-listed media type (FK to the blob registry, composite with the length) | — |
| `evidence_type` | BRT-01 §2.2 type | — |
| `source_kind`, `source_principal_id` | Where the bytes came from (data, not trust) | — |
| `submitted_by_account_id` | The authenticated account (never exposed publicly) | — |
| `captured_at` | **Source assertion** (`capturedAtAssurance = SOURCE_CLAIMED` only) | signer/source claim |
| `received_at` | **Platform-observed** receipt: the database clock read in its own transaction before the bytes are stored; stored verbatim, no ordering vs `recorded_at` is assumed (BRT-06R) | platform (DB clock, reading 1) |
| `recorded_at` | Database transaction time of the metadata transaction | DB clock, reading 2 |
| `initial_privacy_class` | `PLATFORM_PRIVATE` or `AUTHORITY_ONLY` | — |
| `provenance_key` | Natural key (below) | — |

A BEFORE INSERT trigger rejects any row whose columns disagree with its hashed descriptor, and rejects `AI_DERIVED` items without derivation inputs (BRT-01 E-4). UPDATE / DELETE / TRUNCATE are rejected for every role, including the owner.

**Natural key (BRT-02 persistence §7).** `provenance_key = digest(contentHash, evidenceType, descriptor.source, submittedBy)`. The *same* submitter registering the *same* bytes from the *same* source/capture/type gets the existing item back (`created: false`). **Different provenance over the same bytes always creates a new item** — two sources are two items over one blob. Idempotency keys (`Idempotency-Key`) are layered on top as usual.

**Timestamps are never used to resurrect anything.** `capturedAt` may not be after the receipt beyond the *existing* BRT-02 rule-7 tolerance for external clocks (5 min); `DEVICE_SIGNED` / `TRUSTED_TIMESTAMP` assurances are refused because nothing can verify them yet.

## 4. EvidenceDescriptor

`br:evidence-descriptor@1` (BR-JSON, closed schema):

```
{
  evidenceId, evidenceType,
  content:     { sha256, byteLength, mediaType },
  source:      { kind, principalId?, system?{id,version}, deviceId?, externalNamespace?, externalId?,
                 capturedAt?, capturedAtAssurance },
  acquisition: { method: REFERENCE_UPLOAD | PLATFORM_DERIVATION, receivedAt },
  derivation?: { generator{kind,systemId,version,configurationHash?}, generatedAt?, inputs[{evidenceId,contentHash}] (set) },
  lineage?:    [{ relation, evidenceId, descriptorHash }] (set, keyUnique on evidenceId+relation)
}
descriptorHash = SHA-256("BR" ‖ 0x01 ‖ "evidence-descriptor" ‖ 0x00 ‖ "br:evidence-descriptor@1" ‖ 0x00 ‖ "br-json/1" ‖ 0x00 ‖ JCS)
```

Same semantic descriptor → same canonical bytes → same hash (member order, set order, timestamp offsets and Unicode form normalize). Unknown members, a `TRUSTED` source kind, duplicate lineage edges, non-canonical hashes are **rejected**, never repaired. Test vectors: [`packages/evidence/test-vectors/brt-06.vectors.json`](../../packages/evidence/test-vectors/brt-06.vectors.json).

The descriptor deliberately excludes the submitting account (private) and the privacy class (a lifecycle fact that can be raised later).

## 5. Blob ≠ Item

`evidence.blob` is the registry of distinct byte sequences (content hash, length, opaque backend id, non-secret key reference). One blob may back many items; a blob row is written **only after** the storage adapter has durably stored and re-checked the bytes. See [storage](./BRT-06-EVIDENCE-STORAGE.md).

## 6. Source and machine-derived evidence

- Accounts may declare `HUMAN`, `ORGANIZATION` (must represent the named ORGANIZATION principal: OWNER/ADMIN) or `AI_PIPELINE` (no principal; generator required).
- `DEVICE`, `SCORING_SYSTEM`, `TIMING_SYSTEM`, `EXTERNAL_API`, `HISTORICAL_ARCHIVE` need a registered SYSTEM principal and an ingestion adapter (ADR-0017); they are refused from accounts until then.
- Machine-derived evidence records generator kind, system id, version, optional configuration hash, generation time and input evidence. **Machine-generated ≠ true**: nothing in BRT-06 weighs it; the bundle exposes `derivation` and lineage so BRT-07 can enforce E-4 (never sole primary evidence for V2+).

## 7. Lineage

`evidence.relation` (class A): `DERIVED_FROM`, `REDACTED_FROM`, `TRANSFORMED_FROM`, `SUPERSEDES`, child → parent. A crop/redaction/transcode/extraction is always a **new** item; the original is never touched. Each edge must be declared inside the child's hashed descriptor with the parent's exact descriptor hash (trigger BR064), parents predate children, so lineage is acyclic by construction. Parents must be citable by the submitter (no lineage to someone else's private evidence).

## 8. Availability lifecycle

`evidence.availability_change` (class A, trigger-enforced transitions): first fact `∅ → AVAILABLE`; `AVAILABLE ⇄ RESTRICTED`; `→ DELETED_BY_RETENTION | DELETED_BY_ERASURE` (terminal). Restrict/restore: submitter or source representative. Deletion ("purge"): INTERNAL only, with an opaque `basisRef`. After deletion the descriptor, content hash, lineage, attachments and citing attestations remain; the bytes are purged only when **no** other item over the same blob can still serve them; deleted/restricted evidence is never presented as inspectable (`EVIDENCE_NOT_AVAILABLE`). Legal hold and cold tiers are deferred.

## 9. Privacy and access

Default class `PLATFORM_PRIVATE`; `AUTHORITY_ONLY` may be chosen at ingestion or raised later (never lowered — trigger BR063). The centralized policy (`decideEvidenceAccess`, `packages/evidence/src/policy.ts`) is evaluated inside the transaction:

| Basis | May |
|---|---|
| Submitter | view, read bytes, cite, attach, restrict/restore, raise privacy |
| Source representative (org OWNER/ADMIN; SELF for a PERSON source) | same |
| Competition staff with `COMP_VIEW_PRIVATE` on a competition the item is attached to | view, read, cite — `PLATFORM_PRIVATE` only; external ids/device ids are stripped |
| Internal system | everything (no HTTP path except the INTERNAL purge route) |

`AUTHORITY_ONLY` needs an authority grant covering the purpose — not implemented, so it **fails closed** for staff. Denials return the same 404 as unknown ids and are audited. Minors/dependents: no BRT-06 path infers age or reads the PII vault; evidence metadata never carries names, DOB, contacts, guardians, wallets or private identifiers in public DTOs; a guardian's upload is simply the guardian's own evidence.

## 10. Attachments

`evidence.attachment` (class A): `RESULT_VERSION` (preferred — the exact immutable version), `CONTEST`, `EVENT`; roles `PRIMARY` / `SUPPORTING` / `CONTEXT`. The target's competition is resolved from the immutable hierarchy (`results.resolve_result_version` + `competition.resolve_scope_path`) and re-checked by a SECURITY DEFINER trigger (BR065), never taken from the client. **Attachment ≠ assertion.** Only the submitter/source representative may attach.

## 11. Tables (class)

| Table | Class |
|---|---|
| `evidence.blob`, `item`, `availability_change`, `privacy_change`, `relation`, `attachment` | A (append-only facts) |
| `evidence.v_availability_current`, `v_privacy_current` | views |
| `evidence_read.evidence_state` | B (rebuildable, internal) |

## 12. Deviations and open points (reported, not silently decided)

1. **Authority at acceptance.** BRT-02 system architecture lists "authority evaluated before acceptance" for attestations; BRT-02 identity §5 and the API surface say attestations are *stored even when unauthorized*, and BRT-01 A-4 says weight is determined at verification time. BRT-06 records the declared `authorityContext` and all key facts but stores **no** authority decision (it would freeze a verdict that grants, anchors and retroactive compromise can change). BRT-07 evaluates it. See [ADR-0029](../adr/ADR-0029-attestation-acceptance-without-authority-verdict.md).
2. **Evidence hashes in public DTOs.** BRT-02 data access model allows "PUBLIC hash plus type"; BRT-06 is stricter: public DTOs omit content and descriptor hashes (correlation risk); only authorized DTOs and the bundle carry them.
3. **Schema id spelling.** BRT-02 §4.1 writes `statement@1`; the registry requires `br:`-prefixed ids, so the attestation statement is `br:attestation-statement@1` (same domain tag `attestation-statement`).
