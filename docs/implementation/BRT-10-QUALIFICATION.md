# BRT-10 — Qualification (QUALIFIED Achievement)

Status: skeleton (Step 1). Decision record: [ADR-0050](../adr/ADR-0050-qualification-is-a-qualified-achievement.md).

## 1. Two notions of "qualified" (ADR-0008)

| Notion | Owner | BRT-10 |
|---|---|---|
| In-competition advancement (next round, bracket, heat, seeding) | Competition engine (operational, deferred) | Not implemented; never called "qualification" |
| **Cross-competition qualification** | QUALIFIED Achievement (recognition consequence) | Implemented (engine/3); fails closed in production |

## 2. Rule

A QUALIFIED rule declares:

- `targetCompetitionId`;
- a basis: `RANKING_SNAPSHOT_POSITION` (rank ≤ N in a published, non-stale snapshot of a pinned system version) or `CLASSIFICATION_POSITION` (rank ≤ N in a FINAL EVENT or COMPETITION classification);
- optional raised floor (V4);
- optional population or eligibility constraints, which fail closed.

Every holder whose shared rank is ≤ N qualifies.

_Step 9._

## 3. Gates

- FINAL basis, a CURRENT run at V3 or above, hold known and absent;
- the target-authority fact (`TARGET_QUALIFICATION_AUTHORITY`, not production-supported);
- eligibility and population facts, when declared.

_Step 9: blocker table._

## 4. Pins and identity

The candidate pins the target, the snapshot or classification (id + hash), the entry, the underlying basis and the run. The append-only link is `achievement.qualification_basis`.

_Step 5, Step 9._

## 5. Corrections

Re-assessment follows disputes §5.1 against the as-corrected view: still qualifies → SUPERSEDED by a new Achievement; no longer qualifies → REVOKED; temporarily below the floor → SUSPENDED.

_Step 9._

## 6. No side effects

QUALIFIED never creates entries, registrations, seeding or advancement, and never triggers prizes, trophies, NFTs or settlement.
