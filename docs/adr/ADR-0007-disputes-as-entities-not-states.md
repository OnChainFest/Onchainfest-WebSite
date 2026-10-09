# ADR-0007 — Disputes as entities with holds, not lifecycle states

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

A "DISPUTED" result state would erase whether the result was PROVISIONAL, OFFICIAL or FINAL, and could not represent concurrent disputes, appeals, or disputes on non-result subjects (evidence, attestations, record marks, grants).

## Decision

1. A **Dispute** is its own entity with this lifecycle:
   - `FILED → ADMITTED | INADMISSIBLE → UNDER_REVIEW → RESOLVED → (APPEALED) → CLOSED`;
   - WITHDRAWN is possible along the way.
2. The Dispute records subject (with hash), grounds, standing, window (`ORDINARY | LATE | EXTRAORDINARY`), adjudicator and an attested resolution.
3. **Admitted** disputes put a **hold** on their subject and on dependents. A hold blocks unexecuted consequences whose permission row says so, and blocks T5 and T6. It changes neither status nor level.
4. Resolutions act only through Corrections, Revocations, EvidenceAssessments or Rescissions.
5. Adjudicators must be non-conflicted and must not be the author of the disputed act. Appeals go to a higher authority in the chain.

## Consequences

**Benefits:**

- Multiple concurrent disputes are supported.
- Precise freezing of downstream effects.
- A clean appeal chain.

**Costs:**

- Consumers must check `hold` in addition to status and level. The permission matrix centralizes this.
