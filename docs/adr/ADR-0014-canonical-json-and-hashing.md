# ADR-0014 — Canonical JSON (RFC 8785 + BR-JSON profile) and SHA-256 with domain separation

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02 (resolves the choice BRT-01 verification model §2.4 deferred)

## Context

- **The requirement.** Two semantically identical ResultVersions must hash identically in any implementation (BRT-01 R-1, R-5).
- **Where plain JCS falls short:**
  - it formats numbers via IEEE-754, so decimals are lossy;
  - it does not normalize Unicode;
  - it knows nothing about set semantics or absent-versus-null.

## Decision

1. **Canonical form:** RFC 8785 JCS serialization over the **BR-JSON v1 profile**:
   - NFC strings;
   - `null` forbidden;
   - empty optional collections omitted;
   - integers only within the safe range;
   - decimals as canonical strings (`Mark.value` keeps its declared precision);
   - RFC 3339 UTC millisecond timestamps;
   - lowercase UUIDs;
   - schema-declared sets sorted;
   - closed schemas.
1a. **The normative details** are in [Signatures & hashing §2.2a](../architecture/BRT-02-SIGNATURES-AND-HASHING.md#22a-normative-details-br-json-v1). They cover:
   - object members, absent vs null, and the removal of defaults;
   - ordered versus set arrays (byte-wise sort-key ordering, and reject-on-duplicate);
   - integers, decimals, negative zero, and exact `Mark.value` precision;
   - timestamps, UUIDs, and NFC;
   - closed schemas and schema-id binding.

   "Reject" cases are never silently repaired.
2. **Pipeline:** validate → normalize → assert canonical → JCS → hash. The normalized content is what gets stored.
3. **Hash:** SHA-256 with preimage `"BR" ‖ 0x01 ‖ domainTag ‖ 0x00 ‖ schemaId@version ‖ 0x00 ‖ profileId ‖ 0x00 ‖ JCS(payload)`. Evidence blobs are the exception: plain SHA-256 of the raw bytes, so external verifiers can use standard tools.
4. **Merkle trees:** RFC 6962-style leaf and node prefixes.
5. **Published cross-language test vectors** are mandatory.

## Consequences

**Benefits:**

- Deterministic, human-auditable, standards-based hashing.
- Domain separation prevents cross-type confusion.

**Costs:**

- A custom normalization layer must be specified precisely and tested.
- A profile change requires a new profile id.

## Alternatives considered

- **Deterministic CBOR:** accepted only for device-native payloads, not as the canonical platform form.
- **EIP-712 as canonical:** EVM-bound.
- **Protobuf:** not canonical.
- **BLAKE3 / Keccak as the primary hash:** less universal support.
