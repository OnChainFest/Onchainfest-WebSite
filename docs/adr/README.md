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
| [0021](./ADR-0021-account-person-control-and-person-keyed-membership.md) | Explicit Account→Person control; person-keyed memberships | Proposed | BRT-04 |
| [0022](./ADR-0022-athlete-passport-read-model.md) | Athlete Passport as a rebuildable, provenance-labelled read model | Proposed | BRT-04 |
| [0023](./ADR-0023-pii-vault-login-isolation.md) | PII vault behind a dedicated login and an envelope-encryption port | Proposed | BRT-04 |
| [0024](./ADR-0024-deterministic-format-engines-and-immutable-event-plans.md) | Deterministic, versioned format engines and immutable event plans | Proposed | BRT-05 |
| [0025](./ADR-0025-explicit-competition-hierarchy-resolution.md) | Explicit competition hierarchy resolution for authority and results | Proposed | BRT-05 |
| [0026](./ADR-0026-declared-lineups-are-operational.md) | Declared lineups are operational; the credited lineup stays in Result content | Proposed | BRT-05 |
| [0027](./ADR-0027-person-principal-and-issuer-representation.md) | Explicit Person ↔ PERSON Principal mapping and account → issuer representation | Proposed | BRT-06 |
| [0028](./ADR-0028-deterministic-evidence-bundle.md) | The deterministic Evidence Bundle is the BRT-07 input identity | Proposed | BRT-06 |
| [0029](./ADR-0029-attestation-acceptance-without-authority-verdict.md) | Attestation acceptance without an authority verdict; server-canonicalized ceremony; signed retraction | Proposed | BRT-06 |
| [0030](./ADR-0030-development-encrypted-evidence-store-and-fail-closed-production.md) | Development encrypted evidence store; production evidence ingestion fails closed | Proposed | BRT-06 |
| [0031](./ADR-0031-verification-is-an-immutable-assessment.md) | Verification is an immutable, append-only assessment; current state is a projection | Proposed | BRT-07 |
| [0032](./ADR-0032-declarative-verification-policies-bound-to-discipline-versions.md) | Declarative, versioned verification policies bound to exact DisciplineVersions | Proposed | BRT-07 |
| [0033](./ADR-0033-deterministic-verification-snapshot-and-hash-freshness.md) | The VerificationSnapshot is the deterministic Oracle input; freshness is hash-based | Proposed | BRT-07 |
| [0034](./ADR-0034-conservative-independence-and-structural-participation.md) | Conservative principal- and provenance-based independence over a structural participation resolver | Proposed | BRT-07 |
| [0035](./ADR-0035-unsupported-canonical-facts-and-unpersisted-fixtures.md) | Typed canonical facts without producers are INPUT_NOT_SUPPORTED; synthetic fixtures are never persisted | Proposed | BRT-07 |
| [0036](./ADR-0036-counterparty-deny-outranked-only-by-certification.md) | A counterparty DENY blocks V1 unless the same evaluation fully meets the V2 certification exception (BRT-01 §5.3 reconciliation) | Accepted | BRT-07 |
| [0037](./ADR-0037-reference-achievement-persistence-fixtures-in-throwaway-databases.md) | Reference Achievement persistence fixtures live only in throwaway databases (normal schema accepts CANONICAL_ASSEMBLY only) | Proposed | BRT-08 |
| [0038](./ADR-0038-declarative-achievement-rules-bound-without-retroactivity.md) | AchievementRules are immutable, declarative derivation policy with BRT-01 floors; bindings never apply retroactively | Proposed | BRT-08 |
| [0039](./ADR-0039-achievement-basis-pins-exact-current-verification.md) | An Achievement pins its exact basis, is issued only on CURRENT verification, and a team title is one TEAM Achievement with memberCredits | Proposed | BRT-08 |
| [0040](./ADR-0040-achievement-status-history-and-corrections-by-supersession.md) | Current Achievement support is an append-only status history; corrections supersede, never rewrite | Proposed | BRT-08 |
| [0041](./ADR-0041-achievement-evidence-commitment-and-governing-recognition.md) | Achievement evidenceCommitment (pinned runs' Evidence Bundles) and governingAuthority (pinned run trace) are explicit content; AC-4 naming scope | Proposed | BRT-08R |
| [0042](./ADR-0042-achievement-consumes-verification-read-only-and-live-current-support.md) | Achievement consumes Verification through a SELECT-only role; current support is assessed live at read time | Proposed | BRT-08R |
| [0043](./ADR-0043-record-category-versions-define-immutable-record-universes.md) | RecordCategory versions define immutable record universes (one universe per category; no backdating) | Proposed | BRT-09 |
| [0044](./ADR-0044-records-consume-verified-performance-basis.md) | Comparative records consume a verified immutable Performance basis; RECORD_SET is the resulting Achievement (clarifies ADR-0001) | Proposed | BRT-09 |
| [0045](./ADR-0045-record-set-via-append-only-recognition-linkage.md) | Pending RecordMarks and RECORD_SET connect through append-only recognition linkage; ratification consumer only (producer deferred) | Proposed | BRT-09 |
| [0046](./ADR-0046-record-hall-of-fame-is-a-projection.md) | The Record Hall of Fame is a rebuildable RecordMark-history projection, not canonical truth | Proposed | BRT-09 |
| [0047](./ADR-0047-classifications-are-derived-result-versions-submitted-through-the-ledger.md) | Classifications are derived ResultVersions (`derivedFrom` in content), proposed by a pure engine and submitted only through the ResultLedger; staleness is computed; replacement awaits a correction producer | Proposed | BRT-10 |
| [0048](./ADR-0048-ranking-systems-and-immutable-ranking-snapshots.md) | Ranking systems define immutable universes; rankings are immutable snapshots over a verified Performance basis; official publication fails closed (clarifies ADR-0001) | Proposed | BRT-10 |
| [0049](./ADR-0049-explicit-comparator-aggregation-and-shared-ties.md) | Ordering comes only from the DisciplineVersion comparator plus an explicit aggregation policy; exhausted ties are shared, never broken | Proposed | BRT-10 |
| [0050](./ADR-0050-qualification-is-a-qualified-achievement.md) | Cross-competition qualification is a QUALIFIED Achievement (BRT-08 engine/3); FINAL + V3 + no hold; fails closed without the target competition's authority | Proposed | BRT-10 |
| [0051](./ADR-0051-onchainfest-owns-the-sports-domain.md) | OnChainFest owns the sports domain; Bragging Rights is re-scoped to a future digital-artifact bounded context; hashed/persisted historical names are not renamed | Proposed | ONCF-00R |
