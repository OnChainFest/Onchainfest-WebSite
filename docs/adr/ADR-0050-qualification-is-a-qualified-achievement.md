# ADR-0050 — Cross-competition qualification is a QUALIFIED Achievement derived by the BRT-08 engine; it fails closed without the target competition's authority

- **Status:** Proposed
- **Date:** 2026-10-01
- **Origin:** BRT-10 read-first decision 4 (BRT-01 verification model §7, §8.2–8.3; disputes §5.1–5.2; ADR-0008; ADR-0038–0040; ADR-0045 recipe)

## Context

BRT-01 §8.2 lists **`QUALIFIED`** as an Achievement type, *"a qualification rule of a target competition"*, with its minimum level set *"per target"*.

The permission matrix row "Qualification / eligibility for another sanctioned competition" is: FINAL, V3 ("or as set by the target competition, never below V2"), hold blocks.

ADR-0008 separates in-competition advancement, which is operational, from cross-competition qualification, which is gated by verification. It requires the two to be named distinctly.

BRT-08 lists QUALIFIED as deferred (`DEFERRED_ACHIEVEMENT_TYPES`). BRT-09 showed how to enable a deferred type without bending BRT-08 (RECORD_SET: new engine version, new criterion, an unproduced fact kind, a pinned snapshot member, an ALTER migration and a link table).

Two pieces are missing:

- No fact connects a target competition's authority to a qualification rule.
- No target-competition governance fact can lower the floor to V2.

## Decision

1. **Qualification is an Achievement, not a new entity.** QUALIFIED is derived by the existing validated Achievement engine, writer, status history and support assessment.
   - The engine becomes `achievement-engine/3`, identical to `/2` for every existing criterion.
   - It adds one criterion kind, `QUALIFYING_POSITION`.
   - No `QualificationDecision` table, `qualified` flag or `isQualified` column exists anywhere.
2. **The rule names a target and a basis.** A QUALIFIED rule declares:
   - `targetCompetitionId`;
   - a basis, which is either:
     - `RANKING_SNAPSHOT_POSITION`: rank ≤ N in a **published, non-stale** snapshot of a pinned ranking system version (ADR-0048), or
     - `CLASSIFICATION_POSITION`: rank ≤ N in a **FINAL** EVENT or COMPETITION classification (ADR-0047).

   Shared ranks follow ADR-0049: every holder whose shared rank is ≤ N qualifies. A policy cannot choose a different tie rule in v1.
3. **Floor: FINAL + V3 + no hold, raise-only.** The qualifying basis must be FINAL. Its pinned BRT-07 run must be CURRENT at V3 or above, even when the ranking system's own floor is V2. Hold must be known and absent.
   - A rule may raise the floor to V4.
   - The matrix's "target may lower to V2" option is **not** available, because no target-governance fact exists.
4. **The target authority is required and fails closed.** A new `DerivationFactKind.TARGET_QUALIFICATION_AUTHORITY` stands for the target competition's authority adopting the rule. It is **not** production-supported, so every canonical evaluation is PENDING `TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE`. The platform never decides qualification for another authority's competition.
5. **Eligibility is never manufactured.** If a rule declares population or eligibility constraints, they need typed facts (`POPULATION`, `ELIGIBILITY`). Those have no producer, so the result is PENDING with `ELIGIBILITY_UNKNOWN` or `POPULATION_FACT_UNAVAILABLE`. Names, labels, declared registration text and catalog state are never used.
6. **Pinned and hash-bound.** The candidate pins:
   - the target competition;
   - the snapshot (id + hash) and entry, or the classification version (id + content hash) and entry;
   - the underlying performance or result basis and its run.

   The pins are part of the candidate hash and therefore of its identity (AC-2). An append-only link table (`achievement.qualification_basis`, UNIQUE per achievement) records them, using the RECORD_SET pattern.
7. **Corrections follow disputes §5.1 against the as-corrected view.**
   - The holder still qualifies under the correcting snapshot or classification: a new Achievement is issued and the old one is SUPERSEDED.
   - The holder no longer qualifies: REVOKED.
   - Support temporarily below the floor: SUSPENDED, never revoked.
8. **No side effects and no progression.**
   - QUALIFIED never creates an entry, registration, contestant, seeding, slot resolution or advancement in any competition.
   - It never triggers a prize, trophy, NFT or settlement.
   - UI and API name it *"Qualified for ⟨target⟩ (cross-competition)"*. In-competition advancement is not implemented by BRT-10 and is never called qualification.

## Consequences

- Production derives **zero** QUALIFIED Achievements today. There is no FINAL, V3 or hold state, and no target authority. Each candidate shows its exact blockers.
- The full path (ranking or classification → QUALIFIED → correction → supersede/revoke) is exercised in throwaway fixture databases only.

## Alternatives considered

- **Separate QualificationDecision entity.** Rejected: not in BRT-01, and it would be a parallel truth.
- **Qualification as a classification Result.** Rejected: qualification is a recognition consequence, not an outcome of a contest.
- **Platform-authored rules taking effect without the target authority.** Rejected: the platform would be acting outside PLATFORM scope.
