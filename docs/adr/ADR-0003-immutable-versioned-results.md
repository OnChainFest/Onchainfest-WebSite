# ADR-0003 — Immutable, versioned results; corrections by supersession

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

- Legacy results were mutable rows. padelflow's permissive RLS let anyone rewrite scores (BRT-00 C-3).
- Legacy contracts had no notion of correction.
- The requirement: a result must never silently mutate after becoming verified, and corrections must preserve history.

## Decision

1. **Identity and content are separated.** A **Result** is a logical identity that points to its current **ResultVersion**. Each version's content is canonicalized and hashed at SUBMITTED, and is immutable from then on.
2. **Lifecycle:** `DRAFT → SUBMITTED → PROVISIONAL → OFFICIAL → FINAL`, with the terminal states `REJECTED`, `SUPERSEDED` and `REVOKED`.
   - No backward transitions.
   - ATTESTED and VERIFIED are *not* states (ADR-0005).
   - DISPUTED is not a state (ADR-0007).
3. **Corrections** create a new version (`supersedes`, `correctionId`). The old version becomes SUPERSEDED at the same moment the new one becomes current. Attestations never carry over, because they bind to the content hash.
4. **Revocation** annuls without replacement. Reinstatement is a new version created by a `REINSTATEMENT` correction.
5. **Classifications are Results too.** Standings and final rankings pin their input versions (`derivedFrom`) and become stale when an input is superseded.

## Consequences

**Benefits:**

- Tamper evidence (the hashes can be anchored).
- Full audit trail.
- Downstream impact is computable.
- Historical "as-published" views stay possible.

**Costs:**

- Re-attestation is needed after every correction. Mitigation: the correcting authority's attestation travels with the correction.
- Storage grows with versions (negligible for result data).

## Alternatives considered

- **Mutable rows with an audit log:** rejected. The log is secondary, attestations could silently apply to changed content, and anchoring is meaningless.
- **Full event sourcing of every field edit:** deferred. It is compatible with this ADR as an implementation strategy (BRT-02 may choose it), but the domain contract is versioned snapshots.
