# ADR-0012 — Transactional outbox with a Postgres-backed job queue

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

Many reactions depend on trust-chain changes: re-verification, achievement derivation, holds, anchoring and notifications. Lost events would leave consequences inconsistent with truth.

## Decision

1. **Outbox rows are written in the same transaction as domain changes.** They go to `outbox_event`, keyed by a UUIDv7 event id, with a versioned event type, an aggregate id and a payload that contains no PII.
2. **A dispatcher in the worker** moves outbox rows into a **Postgres-backed job queue**.
3. **Delivery guarantees:** delivery is at least once. Consumers are idempotent, via a `(consumer, eventId)` table and natural keys. Ordering holds per aggregate.
4. **No external broker now.** An outbox → broker relay can be added later without changing producers.

## Consequences

**Benefits:**

- Exactly-once *effects* with simple infrastructure.
- Replayable history for rebuilding read models.

**Costs:**

- Throughput is bounded by Postgres. That is ample for the expected scale; the evolution path is documented.

## Alternatives considered

- **Kafka:** premature.
- **NATS:** premature.
- **Redis Streams:** weaker durability than the DB of record.
- **Dual writes to DB and broker:** rejected (lost-event risk).
