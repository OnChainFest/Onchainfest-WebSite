# ADR-0010 — Modular monolith with isolated key boundaries

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

The BRT-01 trust chain needs transactional consistency across several things:

- result versions and status transitions;
- attestations and authorization proofs;
- outbox events.

The team is small and early volumes are modest. BRT-00 showed fragmentation as the main legacy failure: duplicated repositories, 27 overlapping SQL scripts and unwired services. Some concerns are genuine trust boundaries: KMS signing, the PII vault, chain credentials and future value settlement.

## Decision

1. **One codebase, one primary database, three processes.**
   - `api`: stateless HTTP.
   - `worker`: outbox dispatch, jobs, ingestion, anchoring.
   - `web`: a UI that calls `api` only.
2. **Bounded contexts are modules** with public interfaces, per-module DB schemas and roles, and lint-enforced import boundaries.
3. **Trust boundaries are isolated by IAM and DB roles, not by the network:**
   - only the Crypto module can use KMS signing keys;
   - the witness key is usable only via the MFA-bound flow;
   - the PII vault is accessible only through its own role;
   - chain credentials live only in worker jobs.
4. **Extraction triggers** (not before):
   - value settlement above a threshold, which extracts Prize settlement;
   - ingestion throughput;
   - external parties needing to run the verifier. That is already possible, because the engines are pure packages.

## Consequences

**Benefits:**

- Simple operations.
- ACID across the trust chain.
- Fast iteration.

**Costs:**

- Discipline is needed to keep module boundaries. Mitigation: CI boundary rules and schema-per-module.
- One deployable means shared release cadence.

## Alternatives considered

- **Microservices per bounded context:** rejected for now. It needs distributed transactions or sagas for the trust chain, with high operational load.
- **Serverless functions only:** rejected. Long-running jobs, KMS isolation and rate-limit state are all awkward, and the legacy serverless assumptions broke (BRT-00 L-2).
