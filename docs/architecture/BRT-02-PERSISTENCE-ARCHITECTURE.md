# BRT-02 — Persistence Architecture

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review |
| ADRs | [0011 PostgreSQL + append-only ledgers](../adr/ADR-0011-postgresql-system-of-record.md), [0012 outbox](../adr/ADR-0012-transactional-outbox.md), [0013 identifiers](../adr/ADR-0013-identifier-strategy.md), [0018 evidence storage](../adr/ADR-0018-evidence-object-storage.md) |

These are **conceptual** tables and constraints. They are **not migrations**, and their names are indicative.

---

## 1. Is PostgreSQL the right source of truth?

**Yes, for the first implementation** ([ADR-0011](../adr/ADR-0011-postgresql-system-of-record.md)).

| Requirement | PostgreSQL capability |
|---|---|
| Transactional consistency across result, attestation, status and outbox writes | ACID transactions |
| Append-only enforcement | Privilege model (no UPDATE/DELETE grants), BEFORE UPDATE/DELETE triggers, per-module schemas and roles |
| Temporal validity (memberships, grants, keys) | `tstzrange` columns plus exclusion constraints (no overlapping validity for the same key) |
| Typed, schema-validated sport content | `jsonb` storing canonical content validated in the application, plus a `content_hash` column |
| Row-level data protection | RLS as defense in depth |
| Graph queries (grant chains, dependency index) | Recursive CTEs over small graphs; closure caches |
| Familiarity | The OnChainFest ecosystem already uses Postgres (via Supabase) |

**Alternatives considered:**

| Alternative | Why not now |
|---|---|
| Dedicated event store (EventStoreDB and similar) | Adds a second system of record; the ledger tables give the needed history with less operational load |
| Kafka as the log of record | Premature; no multi-consumer high-throughput need |
| Document DB | Weak constraints, and the domain is relational |
| Ledger database (e.g. immudb, QLDB-like) | Its tamper evidence is achievable with per-stream hash chains plus external anchoring (§5.2–5.3); not worth a second store |

**Re-assessment triggers:** sensor or telemetry streams at high frequency (these would go to a time-series store *as evidence blobs or series*, never as canonical results); or the public read API exceeding what read replicas plus caches can serve.

---

## 2. Storage zones

| Zone | Content | Store | Access |
|---|---|---|---|
| **Operational** | Competitions, events, schedules, accounts, preferences, drafts | Postgres, schema per module | Module roles |
| **Truth ledger** | Result versions, transitions, evidence metadata, attestations, verifications, authority, corrections, disputes, achievements, record marks, prize entitlements | Postgres, append-only tables (§3.0 class A) | INSERT/SELECT only on these tables |
| **Projections** | Current pointers and current-state rows derived from ledgers (§3.4) | Postgres tables (§3.0 class B) | Updated only by the owning module, in the same transaction as the ledger fact; rebuildable |
| **PII vault** | Person PII, contact data, DOB, guardian consents, identity-document references | Postgres, separate schema, with field-level encryption for AUTHORITY-ONLY data (KMS data keys) | Vault role only; access-logged |
| **Blob store** | Evidence bytes, media derivatives, raw ingestion payloads, published metadata | S3-compatible object storage, private by default | Signed URLs issued by the Evidence module |
| **Read models** | Public profiles, leaderboards, search projections | Postgres materialized tables or views (later: a search index) | Public API |
| **Integration staging** | Raw ingestion envelopes, normalized candidates | Postgres staging schema (payload bytes in the blob store) | Integrations module |
| **Audit** | Audit events | Postgres append-only table, exported to external immutable storage later | Audit role; operators read-only |

---

## 3. Mutability classification

### 3.0 Three kinds of table (normative)

**Not every table is insert-only.** Only class A is.

| Class | What it is | Is it historical truth? | Who may write | Allowed operations | Recovery |
|---|---|---|---|---|---|
| **A. Ledger / history tables** (§3.1) | Facts, versions and status entries | **Yes, authoritative** | The owning module's runtime role | **INSERT and SELECT only.** No UPDATE, DELETE or TRUNCATE for any runtime role; triggers reject them. A change is always a newly appended fact, status entry or version. | Never rebuilt: this *is* the source |
| **B. Materialized projections and current pointers** (§3.4). Examples: `result.current_version_id`, `result_version_state.current_verification_id`, `achievement_state.status`, `record_mark_state` (current holder), `ledger_stream_head` | Current state *derived from* class A | **No.** Convenience for queries and constraints | The owning module only, **in the same transaction** as the class-A fact that changes it; or the audited rebuild job | INSERT and UPDATE on the specific projection tables granted to the module. Never on class A. | Rebuilt deterministically from class A; a drift check compares |
| **C. Caches and read models** (§3.5). Examples: authority closure cache, public profile and leaderboard read models, ranking views, search projections | Disposable accelerators | No | Worker jobs; the rebuild role | Any (including TRUNCATE by the rebuild role) | Discard and rebuild at any time |

Operational tables (§3.2) are a fourth, ordinary category: mutable business data outside the trust chain, with audit logging.

### 3.1 Append-only (truth ledgers — class A)

A row is never updated or deleted, and a "change" is a new row.

| Ledger | Conceptual table(s) |
|---|---|
| Result content | `result_version` |
| Result lifecycle | `result_status_transition` |
| Corrections | `correction` |
| Evidence metadata | `evidence_item`, `evidence_blob` (registry), `evidence_provenance_edge`, `evidence_subject_link`, `evidence_custody_event`, `evidence_availability_change` |
| Evidence findings | `evidence_assessment` |
| Attestations | `attestation`, `attestation_status_change`, `attestation_nonce` |
| Authorization proofs | `authorization_proof` (grant chain used at acceptance) |
| Verifications | `verification` |
| Authority | `principal`, `principal_key` (+ `principal_key_status_change`), `trust_anchor` (+ `trust_anchor_status_change`), `authority_grant` (+ `authority_grant_status_change`), `device_registration`, `system_configuration` |
| Disputes | `dispute`, `dispute_status_change` |
| Achievements | `achievement`, `achievement_status_change` |
| Records | `record_mark`, `record_mark_status_change` (RecordCategory is versioned catalog data) |
| Rankings | `ranking_snapshot`, `ranking_snapshot_entry` (published snapshots are immutable) |
| Prize | `prize_terms` (immutable once funded), `prize_entitlement`, `prize_entitlement_status_change`, `payout_instruction`, `payout_status_change`, `prize_adjustment` |
| Trophies | `trophy_issuance`, `trophy_status_change` |
| Catalog versions | `discipline_version`, `format_template_version`, `verification_policy_version`, `achievement_rule_version`, `json_schema_version` |
| Identity proofs | `wallet_link_proof`, `guardian_consent_record` (vault) |
| Anchoring | `anchor_batch`, `anchor_batch_leaf`, `external_chain_ref_event` |
| Integration | `raw_ingestion_envelope` |
| Platform | `outbox_event`, `audit_event`, `ledger_entry` (hash-chain index, §5.2) |

### 3.2 Mutable (operational)

These can be updated, and every update is audit-logged.

- Competition, Event, Round and Contest *configuration and schedule*, **until freeze points** (event start, contest start). After a freeze point, changes go through versioned amendments, which are append-only.
- Participant entry *before event start*.
- Account, AuthenticationIdentity, notification preferences and profile display settings.
- Organization profile (non-authority data).
- Drafts (`result_version` rows in DRAFT live in a **separate `result_draft` table**, so the immutable table never contains mutable rows).
- Job queue and outbox dispatch bookkeeping.

### 3.3 Derived

These are computed from other data and persisted for audit when they are themselves claims.

| Derived artefact | Persisted? | Why |
|---|---|---|
| Classification results (standings, final classification) | Yes, as `result_version` with `derived_from` | They are claims requiring authority and disputes (BRT-01 §6.1) |
| Verification | Yes, append-only | Explainability, and it can go down |
| Achievements | Yes, append-only | Consequences reference them |
| Record marks | Yes | Ratification is an authority act |
| Ranking snapshots | Yes, immutable | As-published history |
| Prize eligibility | Recomputed; entitlements persisted | Value-bearing |
| Downstream impact reports | Yes, stored with Correction | D-5 |

### 3.4 Materialized (class B: current-state projections of ledgers, maintained in the same transaction)

| Projection | Source ledger |
|---|---|
| `result.current_version_id` | transitions + corrections |
| `result_version_state.current_status`, `hold` flag | `result_status_transition`, dispute status |
| `result_version_state.current_verification_id`, `current_level` | `verification` |
| `attestation_state.current_status` | `attestation_status_change` |
| `authority_grant_state.status`, `effective_validity` | grant status ledger |
| `principal_key_state.status`, `compromised_since` | key status ledger |
| `achievement_state.status`, `record_mark_state.status`, `effective_to` | respective ledgers |
| `prize_entitlement_state.status` | entitlement ledger |
| `ledger_stream_head` (last sequence and hash per stream, §5.2) | `ledger_entry` |
| `evidence_item_state.availability`, `legal_hold` | `evidence_availability_change` ([Ingestion §2.4](./BRT-02-INGESTION-AND-ADAPTERS.md#24-evidence-availability-model)) |

**Rule:** a projection can always be rebuilt from its ledger. A rebuild job exists and runs in CI against fixtures to prove this.

### 3.5 Cached (class C: disposable)

- Authority closure cache (principal → reachable anchors per capability and scope), invalidated by grant, key and anchor events.
- Public profile, leaderboard and search read models.
- Signed-URL issuance cache.
- Verification input snapshots (by `inputsDigest`).

### 3.6 Content-addressed (identity = hash)

| Item | Hash covers |
|---|---|
| ResultVersion content | canonical content ([Signatures & hashing](./BRT-02-SIGNATURES-AND-HASHING.md)) |
| Evidence blob | raw bytes |
| Attestation statement | canonical signed statement |
| Catalog versions (DisciplineVersion, VerificationPolicy, AchievementRule, JSON schemas) | canonical definition |
| SystemConfiguration | canonical configuration document (`configHash`) |
| Raw ingestion payload | raw bytes |
| Anchor batch | Merkle root over leaf digests |
| Achievement `evidenceCommitment` | Merkle root per BRT-01 §8.1 |

These items also have UUIDv7 entity ids. The **hash is an integrity identity**, and the **UUID is the reference identity** ([ADR-0013](../adr/ADR-0013-identifier-strategy.md)).

### 3.7 Temporal history required (valid-time ranges)

- TeamMembership
- OrganizationMembership
- GuardianLink
- WalletLink (linked or unlinked)
- ExternalIdentifier validity
- PrincipalKey validity
- AuthorityGrant validity
- TrustAnchor recognition
- Participant eligibility attributes (e.g. handicap basis as of the entry date)
- DisciplineVersion effective dates

**Bitemporal where authority is involved.** Each of these rows has both `valid_during` (valid time) and `recorded_at` (transaction time). "What did we know at time X about validity at time T?" is answerable. That matters for compromise revocations, which are recorded later but effective earlier (BRT-01 §4.7).

---

## 4. Conceptual schema (key entities and constraints)

**Notation.** `PK` = primary key; `UQ` = unique; `FK` = foreign key; `CK` = check; `EX` = exclusion constraint. All ids are UUIDv7 unless stated otherwise.

### 4.1 Results

```
result                  PK id | scope_type CK in (CONTEST, ROUND_CLASSIFICATION, EVENT_CLASSIFICATION, COMPETITION_CLASSIFICATION)
                        | scope_target_id | current_version_id FK→result_version (nullable)
                        UQ (scope_type, scope_target_id)                  -- one logical result per target

result_draft            PK id | result_id FK | author_principal_id | content jsonb | updated_at      -- mutable

result_version          PK id | result_id FK | version_number | discipline_version_id FK
                        | content jsonb (canonical) | content_hash bytea(32) | canonical_schema_id
                        | created_by | submitted_by | submitted_at | supersedes_version_id FK (nullable)
                        | correction_id FK (nullable) | idempotency_key
                        UQ (result_id, version_number)
                        UQ (content_hash, result_id)          -- identical content cannot be submitted twice for one result
                        CK content_hash = recomputed hash (verified by app; DB trigger verifies length/format)
                        -- no UPDATE / DELETE privilege; trigger rejects both

result_status_transition PK id | result_version_id FK | from_status | to_status | transition_code (T2..T8)
                        | actor_principal_id | authorization_proof_id FK | attestation_id FK (nullable)
                        | reason | occurred_at | seq
                        UQ (result_version_id, seq)
                        UQ (result_version_id, to_status)      -- a version enters each status at most once (no backward moves, R-3)

result_version_state    PK result_version_id | current_status | hold boolean | current_verification_id | current_level
                        -- materialized; updated only by the Results / Verification modules in the same transaction as the ledger insert

result_derivation_input PK (result_version_id, input_result_version_id)   -- derivedFrom (R-6)
```

**Invariants enforced in the DB (defense in depth):**

- R-2 is enforced as a partial unique index. At most one version per result can have a current status in {PROVISIONAL, OFFICIAL, FINAL}. This is implemented on `result_version_state`.
- R-3 is enforced by the UQ on `(result_version_id, to_status)`, plus an allowed-transition check table.

### 4.2 Evidence

```
evidence_blob           PK content_hash (sha256) | byte_size | media_type | storage_key | storage_class | encryption_key_ref | created_at
evidence_item           PK id | evidence_type | blob_hash FK→evidence_blob | source_kind | source_principal_id FK (nullable)
                        | source_system | device_id FK (nullable) | system_configuration_id FK (nullable)
                        | captured_at | captured_at_assurance | submitted_at | submitted_by
                        | source_signature (envelope, nullable) | timestamp_proof_ref | privacy_class | retention_policy_id
                        | idempotency_key
                        UQ (blob_hash, source_principal_id, captured_at, evidence_type)   -- same capture cannot be registered twice
evidence_provenance_edge PK (evidence_id, derived_from_evidence_id) | transformation | tool | tool_version
evidence_subject_link   PK (evidence_id, subject_type, subject_id, role)
evidence_assessment     PK id | evidence_id | finding | assessed_by | authorization_proof_id | method | at | dispute_id
evidence_access_log     → audit_event (sensitive reads)
```

### 4.3 Attestations

```
attestation             PK id | subject_type | subject_id | subject_hash | claim_type | polarity | claim jsonb
                        | issuer_principal_id | key_id | acting_role | scope_ref | evidence_refs jsonb
                        | statement_hash | envelope jsonb (signature envelope) | signature_scheme | assurance
                        | signed_at | issued_at | not_before | not_after | supersedes_attestation_id
                        | authorization_proof_id FK
                        UQ (issuer_principal_id, nonce)                       -- replay guard
                        UQ (statement_hash)                                   -- same signed statement accepted once
attestation_status_change PK id | attestation_id | to_status (ACTIVE, REVOKED, SUSPECT, EXPIRED) | by | at | reason | dispute_id | cause_ref
authorization_proof     PK id | principal_id | capability | scope_ref | evaluated_at | as_of_time
                        | chain jsonb (anchor_id, [grant_id, grant_hash]…) | key_id | conflict_check jsonb | decision | policy_version
```

### 4.4 Authority

This is detailed in [Identity & authority](./BRT-02-IDENTITY-AND-AUTHORITY.md).

```
principal               PK id | principal_type (PLATFORM, ORGANIZATION, PERSON, SYSTEM) | subject_ref (org_id / person_id / system id) | created_at
principal_key           PK key_id | principal_id | key_kind (WALLET, PASSKEY, JWK, DEVICE, KMS) | algorithm | public_key | wallet_link_id
                        | valid_during tstzrange | recorded_at
                        EX (key_id WITH =, valid_during WITH &&)       -- no overlapping validity rows for one key
principal_key_status_change PK id | key_id | status (ACTIVE, ROTATED, REVOKED, COMPROMISED) | effective_from | compromised_since | recorded_at | by | reason
trust_anchor            PK id | principal_id | recognition_scope jsonb | basis_ref | governance_decision_id | valid_during | recorded_at
authority_grant         PK id | grantor_principal_id | grantee_principal_id | parent_grant_id | capabilities text[] | scope jsonb (normalized)
                        | valid_during | delegation jsonb | constraints jsonb | grant_hash | grantor_signature_envelope jsonb | recorded_at
authority_grant_status_change PK id | grant_id | status | effective_from | compromise boolean | recorded_at | by | reason
```

### 4.5 Verification

```
verification            PK id | result_version_id | content_hash | policy_id | policy_version | policy_hash | evaluated_at
                        | inputs_digest | level | criteria_met jsonb | criteria_missing jsonb | flags jsonb | method | reviewer_attestation_id
                        | supersedes_verification_id
                        UQ (result_version_id, policy_hash, inputs_digest)     -- idempotent recomputation
verification_dependency PK (input_type, input_id, result_version_id)          -- dependency index (see Verification engine)
```

### 4.6 Disputes and corrections

```
dispute                 PK id | subject_type | subject_id | subject_hash | grounds | filed_by | filed_by_role | window | appeal_of | filed_at
dispute_status_change   PK id | dispute_id | to_status | by | authorization_proof_id | at | resolution jsonb (on RESOLVED)
active_hold             (materialized) PK (subject_type, subject_id, dispute_id)
correction              PK id | result_id | superseded_version_id | new_version_id | correction_type | dispute_id | issued_by
                        | authorization_proof_id | attestation_id | effective_at | diff jsonb | downstream_impact jsonb
                        UQ (superseded_version_id)                          -- a version is superseded at most once
```

### 4.7 Consequences

```
achievement             PK id | achievement_type | rule_id | rule_version | holder_type | holder_id | scope_type | scope_id
                        | sport_id | discipline_id | period | basis jsonb | basis_hash | basis_level | governing_authority_id
                        | qualifying_value jsonb | evidence_commitment | supersedes_id | issued_at
                        UQ (achievement_type, rule_version, holder_type, holder_id, scope_type, scope_id, basis_hash)   -- AC-2
achievement_member_credit PK (achievement_id, athlete_id) | credit_role
achievement_status_change PK id | achievement_id | to_status | cause_ref | at

record_mark             PK id | record_category_id | category_version | value jsonb | holder | achievement_id | effective_from | previous_mark_id
                        UQ (record_category_id, achievement_id)
record_mark_status_change PK id | record_mark_id | to_status | ratification_attestation_id | at | cause_ref

prize_terms             PK id | competition_id | funder_principal_id | terms jsonb | terms_hash | min_level | required_status | funded_at | signature envelope
prize_entitlement       PK id | prize_terms_id | slot (e.g. EVENT evt_x rank 1) | basis_achievement_id | beneficiary_ref | amount | asset
                        -- partial UQ (prize_terms_id, slot) WHERE status not in (VOIDED): one live entitlement per prize slot
prize_entitlement_status_change PK id | entitlement_id | to_status | at | cause_ref
payout_instruction      PK id | entitlement_id | instruction_hash | rail (FIAT_PSP | CHAIN_SETTLEMENT) | created_at
                        UQ (entitlement_id) -- exactly one payout instruction per entitlement; retries reuse it
payout_status_change    PK id | payout_instruction_id | status (REQUESTED, SUBMITTED, CONFIRMED, FAILED, CANCELLED) | external_ref | at

trophy_issuance         PK id | trophy_class_id | achievement_id | credential_id (deterministic) | recipient_ref | issued_at
                        UQ (trophy_class_id, achievement_id)                 -- one trophy per class per achievement
trophy_status_change    PK id | trophy_issuance_id | to_status (PENDING, ISSUED, REVOKED, REPLACED) | external_chain_ref_id | at
```

### 4.8 Platform

```
outbox_event            PK id (UUIDv7) | aggregate_type | aggregate_id | event_type | event_version | payload jsonb | occurred_at | tx_id
                        | dispatched_at (bookkeeping, nullable)
audit_event             PK id | actor_account_id | actor_principal_id | action | target_type | target_id | outcome | authz_basis jsonb
                        | request_id | ip_hash | user_agent_hash | occurred_at          -- not hash-chained; batch-anchored (§5.3)
ledger_entry            PK (stream_id, sequence) | stream_type | previous_hash | entry_hash | entry_type | fact_table | fact_row_id
                        | fact_hash | recorded_at
                        UQ (entry_hash) | UQ (fact_table, fact_row_id)          -- one chain position per fact
ledger_stream_head      PK stream_id | stream_type | last_sequence | last_entry_hash | updated_at   -- class B projection
anchor_batch            PK id | root | leaf_count | previous_batch_root | created_at
anchor_batch_leaf       PK (batch_id, leaf_index) | leaf_kind (STREAM_HEAD | ROW) | stream_id | sequence | fact_table | fact_row_id | digest
external_chain_ref_event PK id | domain_ref_type | domain_ref_id | network (CAIP-2) | tx_hash | log_index | address (CAIP-10) | token_id | status | confirmations | at
```

---

## 5. Enforcing append-only, projections and atomicity

### 5.1 Layers of protection

1. **Privileges.** Runtime module roles hold `INSERT, SELECT` on their **class A** tables only, with no `UPDATE`, `DELETE` or `TRUNCATE`. They hold `INSERT, UPDATE` on their explicitly listed **class B** projection tables, and on their operational tables. Migrations run as a separate owner role that is never used at runtime. Projection rebuilds run under a dedicated, audited `rebuild` role that can write class B and C tables but has no write access to class A.
2. **Triggers.** `BEFORE UPDATE OR DELETE` triggers on class A tables raise exceptions. This catches owner-role mistakes.
3. **Per-stream hash chains** for lifecycle ledgers (§5.2).
4. **External anchoring** of stream heads and unchained rows (§5.3). Tampering becomes *detectable* by anyone holding a receipt ([Threat model T-13](../security/BRT-02-THREAT-MODEL.md)).

### 5.2 Hash-chain streams

**A stream is one aggregate's lifecycle.** It is the same unit that already serializes writes in the domain. There is **no global chain**.

| Stream type | `streamId` | Facts appended to the stream (in order) |
|---|---|---|
| `RESULT` | result id | result versions (creation), status transitions, corrections |
| `VERIFICATION` | result version id | successive verification assessments |
| `ATTESTATION` | attestation id | creation, status changes |
| `EVIDENCE_ITEM` | evidence item id | creation, assessments, custody events, availability changes |
| `PRINCIPAL_KEY` | key id | registration, status changes |
| `AUTHORITY_GRANT` | grant id | issuance, status changes |
| `TRUST_ANCHOR` | anchor id | recognition, changes |
| `DISPUTE` | dispute id | filing, status changes |
| `ACHIEVEMENT` | achievement id | issuance, status changes |
| `RECORD_CATEGORY` | record category id | record-mark creations and status changes. Lineage order matters, and volume is low. |
| `PRIZE_ENTITLEMENT` | entitlement id | creation, status changes, payout instruction, payout status changes |
| `TROPHY` | trophy issuance id | issuance, status changes |

**Deliberately not hash-chained.** These are covered by content hashes and batch anchoring as individual rows (§5.3):

| Table | Why chains are unnecessary |
|---|---|
| `audit_event`, `raw_ingestion_envelope` | High volume; no per-aggregate order semantics |
| `outbox_event` | Not truth |
| `evidence_blob`, catalog versions, ranking snapshots, `wallet_link_proof` | Already content-addressed and immutable; they have no lifecycle |

**Entry definition:**

```
ledger_entry {
  streamId, streamType
  sequence                  -- 1, 2, 3 … gap-free within the stream
  previousHash              -- entryHash of sequence−1; for sequence 1: H("ledger-genesis", "ledger-entry@1", JCS({streamType, streamId}))
  entryType                 -- e.g. RESULT_VERSION_CREATED, STATUS_TRANSITION, CORRECTION
  factTable, factRowId      -- the class-A row this entry commits
  factHash                  -- domain-separated hash of the fact row's canonical content
  recordedAt                -- DB transaction time
  entryHash = H("ledger-row", "ledger-entry@1", JCS({streamType, streamId, sequence, previousHash, entryType, factTable, factRowId, factHash, recordedAt}))
}
UNIQUE (streamId, sequence); UNIQUE (entryHash); UNIQUE (factTable, factRowId)
```

**Advancing the head** happens inside the same transaction as the fact:

1. Lock the stream head row (`ledger_stream_head` for `streamId`) with a row-level exclusive lock.
   - If no head row exists (a new aggregate), insert it at sequence 0 with the genesis hash.
   - A concurrent creator of the same new stream loses on the primary key, and its transaction retries.
2. Read `last_sequence` and `last_entry_hash`. Under PostgreSQL row locking, the waiting transaction sees the committed head after the lock is released.
3. Insert the class-A fact row(s) and one `ledger_entry` per fact, with consecutive sequence numbers.
4. Update the head (class B).

**Concurrency rules:**

- **Same stream.** Writers serialize on the head row lock. Contention is naturally low, because a stream is one result, grant, dispute or similar.
- **Different streams** append fully concurrently. There is no shared counter, sequence or lock.
- **Transactions touching several streams** acquire head locks in **sorted `streamId` order**, which avoids deadlocks.
- **Safety net.** `UNIQUE (streamId, sequence)` rejects any write that bypassed the lock.
- **Retries.** A unique violation, deadlock or serialization failure rolls back the whole transaction, which is retried with bounded attempts (e.g. 3, with jitter). Retries are safe because commands carry idempotency keys (§7).

**Verification.** A chain-verification job recomputes `factHash` and `entryHash` along each stream and compares the head with the latest anchored head. This detects deletion, reordering or edits of any anchored prefix.

### 5.3 Anchoring many streams without a global chain

- **Each anchor batch** (the worker's anchoring job) collects two kinds of leaf:
  - the **current heads** `(streamId, sequence, entryHash)` of every stream that advanced since the previous batch. One head commits that stream's whole prefix, through its chain.
  - the digests of **unchained rows** (audit events, ingestion envelopes, content-addressed items) not yet present in `anchor_batch_leaf` (an anti-join, not an UPDATE of the ledger rows).
- **The batch** builds a Merkle root (RFC 6962 prefixes), optionally links `previous_batch_root`, and submits the root through the AnchoringPort. The anchoring job is the single writer of batches, so linking batches creates no contention for domain writers.
- **The integrity window is bounded by the anchoring cadence.** Rows committed after the last anchor are protected only by DB controls until the next batch.

### 5.4 Atomicity: ledger fact, projection and outbox in one transaction

Every domain command that changes truth runs as **one PostgreSQL transaction**. Example: T5, declaring a result official.

```
BEGIN
  -- authority already evaluated (read-only) before or inside the transaction
  INSERT attestation (class A) + authorization_proof (class A)      → ledger_entry in ATTESTATION stream (lock head, append, update head)
  INSERT result_status_transition (class A)                          → ledger_entry in RESULT stream
  UPDATE result_version_state SET current_status = 'OFFICIAL' (class B, guarded: WHERE current_status = 'PROVISIONAL' AND hold = false)
  INSERT outbox_event (ResultDeclaredOfficial, AttestationIssued)
  INSERT audit_event
COMMIT
```

- **All or nothing.** Either every row exists, or none does. There is no state where a projection claims OFFICIAL without the ledger fact, or where an event was emitted for an uncommitted fact.
- **Guarded projection updates.** A `WHERE` clause on the expected prior state makes lost updates impossible. If zero rows are updated, the command aborts and is retried or rejected.
- **Projections are written outside such a transaction only by the rebuild job**, which recomputes class B from class A and reports drift, audited.
- **Isolation.** READ COMMITTED plus explicit row locks (head rows, the aggregate's projection row) is sufficient. Commands never rely on reading a projection without locking it when they intend to change it.

### 5.5 Erasure

**GDPR-style erasure** touches only the PII vault and identity links. Ledgers contain ids and hashes only (BRT-01 DB-1/R-9), so no ledger row needs deleting. Crypto-shredding of salts is described in [Data access model §6](../security/BRT-02-DATA-ACCESS-MODEL.md). Evidence bytes follow the availability model ([Ingestion §2.4](./BRT-02-INGESTION-AND-ADAPTERS.md#24-evidence-availability-model)).

---

## 6. Rankings persistence

- `ranking_system` (versioned definition: points table, decay, eligibility, owner authority).
- `ranking_run` (inputs digest, as-of time, trigger).
- `ranking_snapshot` and `ranking_snapshot_entry` (immutable once published).
- Corrections produce **new** runs and snapshots linked by `corrects_snapshot_id` (BRT-01 disputes §5.2).
- The "as-published" and "as-corrected" views are queries, not copies.

---

## 7. Idempotency model

**Principle:** every externally triggered write carries an **idempotency key**, and every derived write has a **natural uniqueness key**. Both are enforced by unique constraints, not only by application checks.

| Operation | Client idempotency | Natural key (DB-enforced) | Behavior on duplicate |
|---|---|---|---|
| Result submission | `Idempotency-Key` header, stored with `result_version` | `(result_id, content_hash)` | Returns the existing version |
| Evidence ingestion | Header | Blob: `content_hash`; item: `(blob_hash, source_principal_id, captured_at, evidence_type)` | Returns the existing item; the blob upload is skipped |
| Attestation creation | — (the envelope is self-identifying) | `(issuer_principal_id, nonce)` and `statement_hash` | Rejects a replay with a different statement; returns the existing one for an identical statement |
| Verification recomputation | Job key = `(result_version_id, policy_hash, inputs_digest)` | Same UQ | No new row if nothing changed |
| Achievement derivation | Job key = rule + basis | AC-2 unique key | No duplicate achievement |
| Record recognition | — | `(record_category_id, achievement_id)`; one current mark per category (materialized check) | No duplicate mark |
| Prize entitlement | — | One live entitlement per `(prize_terms_id, slot)` | Correction VOIDs the old one first, in the same transaction |
| Payout request | Header | `payout_instruction UQ (entitlement_id)`; `instruction_hash` is the external idempotency key sent to the PSP or chain | A retry reuses the same instruction and external key; the rail deduplicates |
| Trophy creation | — | `(trophy_class_id, achievement_id)`; `credential_id = H(domain ‖ trophy_class_id ‖ achievement_id)`, so a second on-chain mint of the same id fails at contract level | Structurally impossible to double-issue |
| Ingestion envelope | Adapter-computed `H(source_principal_id ‖ external_event_id ‖ payload_hash)` | UQ | Duplicate delivery is dropped |
| Outbox consumption | Consumer records `(consumer, event_id)` | UQ | At-least-once delivery, effectively-once processing |

**Duplicate payout and trophy protection is layered:**

1. a DB unique constraint;
2. a deterministic external idempotency key or credential id;
3. a contract-side or PSP-side deduplication (settlement adapters must support it);
4. the entitlement state machine, where `PAID` is terminal except through ADJUSTMENT.
