# ADR-0033 — The VerificationSnapshot is the deterministic Oracle input; freshness is hash-based

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-07 (ADR-0014, ADR-0028; BRT-02 verification §1.1 `inputsDigest`, §5)

## Context

A verification must be reproducible from its inputs, and "is the stored assessment still current?" must not depend on timestamps.

## Decision

1. The pure engine's only input is `br:verification-snapshot@1`: ids, hashes, codes and platform/effective timestamps of the exact facts known at a cutoff — no display labels, PII or bytes. Sets are canonically sorted.
2. The **cutoff is evaluation metadata, not a member**: identical facts assembled at different cutoffs have one `snapshotHash` (BRT-02: the digest excludes evaluation timestamps). For the same reason the BRT-06 bundle hash (which embeds its asOf) is run metadata.
3. The engine is pure (no DB, network, filesystem, clock, randomness, environment); outcome and trace are canonical documents with domain-separated hashes.
4. **Freshness** = compare the current snapshot hash with the latest run's (and its policy version / engine version): CURRENT, STALE or NOT_EVALUATED. Freshness is not a level; STALE ≠ FAILED; a stale level is never presented as current.
5. Assembly reads under REPEATABLE READ with one database-time cutoff; facts recorded after a CURRENT cutoff fail closed (`VERIFICATION_TIME_INCONSISTENT`) — no clamping.

## Consequences

Re-evaluation over unchanged facts is a no-op; any relevant change (evidence, attestation, retraction, compromise, grant revocation, status transition, policy binding) stales the run. Costs: freshness reads re-assemble a snapshot.

## Alternatives considered

- **Timestamp-based freshness:** rejected (clock-dependent, misses retroactive facts).
- **Including the cutoff in the hash:** rejected (every evaluation would look new; freshness impossible).
