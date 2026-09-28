# Architecture Decision Records

The format is lightweight MADR: Context → Decision → Consequences → Alternatives considered. All records are **Proposed** until reviewed.

| ADR | Title | Status | Origin |
|---|---|---|---|
| [0001](./ADR-0001-separate-result-and-achievement.md) | Separate Result from Achievement | Proposed | BRT-01 |
| [0002](./ADR-0002-separate-evidence-attestation-verification.md) | Separate Evidence, Attestation and Verification | Proposed | BRT-01 |
| [0003](./ADR-0003-immutable-versioned-results.md) | Immutable, versioned results; corrections by supersession | Proposed | BRT-01 |
| [0004](./ADR-0004-scoped-authority-and-delegation.md) | Scoped authority grants with trust anchors and delegation | Proposed | BRT-01 |
| [0005](./ADR-0005-criteria-based-verification-levels.md) | Criteria-based verification levels V0–V4 | Proposed | BRT-01 |
| [0006](./ADR-0006-chain-agnostic-domain-core.md) | Chain-agnostic domain core | Proposed | BRT-01 |
| [0007](./ADR-0007-disputes-as-entities-not-states.md) | Disputes as entities with holds, not lifecycle states | Proposed | BRT-01 |
| [0008](./ADR-0008-operational-progression-decoupled-from-verification.md) | Operational progression decoupled from verification | Proposed | BRT-01 |
| [0009](./ADR-0009-no-pii-on-chain.md) | No PII on-chain; crypto-shreddable commitments | Proposed | BRT-01 |
| [0010](./ADR-0010-modular-monolith.md) | Modular monolith with isolated key boundaries | Proposed | BRT-02 |
| [0011](./ADR-0011-postgresql-system-of-record.md) | PostgreSQL as system of record with append-only ledgers | Proposed | BRT-02 |
| [0012](./ADR-0012-transactional-outbox.md) | Transactional outbox with a Postgres-backed job queue | Proposed | BRT-02 |
| [0013](./ADR-0013-identifier-strategy.md) | Identifier strategy: UUIDv7 entities, content hashes for integrity | Proposed | BRT-02 |
| [0014](./ADR-0014-canonical-json-and-hashing.md) | Canonical JSON (RFC 8785 + BR-JSON profile) and SHA-256 with domain separation | Proposed | BRT-02 |
| [0015](./ADR-0015-signature-envelope.md) | Multi-scheme signature envelope over a canonical Statement | Proposed | BRT-02 |
| [0016](./ADR-0016-key-management.md) | Key management: KMS for platform keys, never custody for third parties | Proposed | BRT-02 |
| [0017](./ADR-0017-external-ingestion-boundary.md) | External ingestion boundary: adapters never write canonical tables | Proposed | BRT-02 |
| [0018](./ADR-0018-evidence-object-storage.md) | Private, content-addressed object storage for evidence | Proposed | BRT-02 |
| [0019](./ADR-0019-blockchain-adapter-boundary.md) | Blockchain adapter boundary; no chain selected yet | Proposed | BRT-02 |
| [0020](./ADR-0020-three-layer-authorization.md) | Three-layer authorization with a bitemporal domain authority engine | Proposed | BRT-02 |
