# ADR-0011 — PostgreSQL as system of record with append-only ledgers

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

BRT-01 requires the following:

- immutable result versions;
- append-only histories for evidence, attestations, verifications, authority, disputes and consequences;
- temporal validity for grants, keys and memberships;
- strong constraints for idempotency (duplicate payouts and trophies).

## Decision

1. **PostgreSQL** (managed, with PITR) is the single system of record. Supabase-hosted Postgres is acceptable, subject to the access constraints in the Data Access Model.
2. **Truth data lives in append-only ledger tables.** They are enforced by:
   - runtime roles with INSERT/SELECT only;
   - triggers that reject UPDATE and DELETE;
   - per-stream hash chaining;
   - periodic external anchoring of Merkle roots.
3. **Current state is materialized** in separate projection tables. They are *not* truth, and are updated by the owning module only in the same transaction as the ledger fact (with guarded updates). They can always be rebuilt from ledgers. Caches and read models are disposable. Runtime roles are therefore INSERT-only on ledger tables, but may UPDATE their projection tables ([Persistence §3.0, §5.4](../architecture/BRT-02-PERSISTENCE-ARCHITECTURE.md#30-three-kinds-of-table-normative)).
3a. **Hash chains are per aggregate stream**, not global. Stream heads advance under a row lock with `UNIQUE (streamId, sequence)`. High-volume, order-free tables (audit, ingestion envelopes) are anchored as rows instead of chained ([Persistence §5.2–5.3](../architecture/BRT-02-PERSISTENCE-ARCHITECTURE.md#52-hash-chain-streams)).
4. **Temporal and bitemporal validity** uses `tstzrange` plus exclusion constraints, together with `recorded_at` (transaction time) for authority data.
5. **Idempotency and uniqueness are enforced by DB constraints**, not only by application code.

## Consequences

**Benefits:**

- One store.
- Transactional integrity.
- Mature tooling.
- Tamper evidence without a separate ledger database.

**Costs:**

- Ledger growth. Acceptable, because result data is small; blobs live in object storage.
- The owner role is powerful. Mitigated by break-glass procedures plus anchoring.

## Alternatives considered

- **Event store as system of record:** rejected; it adds a second source of truth.
- **Document DB:** rejected; weak constraints.
- **Ledger DB products:** rejected; hash chains plus anchoring give tamper evidence.
- **On-chain storage:** rejected; privacy and cost (ADR-0009).
