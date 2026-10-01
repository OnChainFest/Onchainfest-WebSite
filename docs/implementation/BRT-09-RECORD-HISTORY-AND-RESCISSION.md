# BRT-09 — Record History, Supersession, Rescission and Replay

Code: `packages/records/src/replay.ts`, `support.ts`; `packages/persistence/src/record-store.ts` (`replayCategory`, `rescindMark`).

## 1. Chronological replay (RC-1…RC-3)

Record state is a pure function of append-only facts: every validly ratified mark of a category, its exact value, its sporting `effectiveFrom`, its ratification order and validity (not RESCINDED, not replaced by a ratified correction). Replay orders valid marks by (sporting time, ratification order, id): better ⇒ previous holders end at its effectiveFrom; exact equal ⇒ SHARED co-holds, FIRST_ACHIEVED keeps the first; worse ⇒ never held.

After every ratification / rescission / correction, the category is replayed under a per-category lock; only differences are **appended**: SUPERSEDED (effectiveTo, successor, supersession link), a restoration entry that re-opens a ratified mark (`RESTORED_BY_REPLAY`; the closed effectiveTo stays in history), or a re-supersession when intermediate history changed. Nothing is updated or deleted (BR001 even for the owner).

Examples (tested): A→B→C, rescind C ⇒ B; rescind B ⇒ A. A,B,C,D with B and D invalid ⇒ C. A late-ratified intermediate mark is placed at its sporting time. SHARED A=B ⇒ both current; C better ⇒ both superseded.

## 2. Current support (temporary ≠ permanent)

`assessRecordSupport` (live at read; worker sweeps): CURRENT verification at the category floor ⇒ SUPPORTED; stale / below floor ⇒ **SUSPENDED (never rescinded)**; basis REVOKED ⇒ RESCIND; basis superseded by a correction whose performance no longer qualifies ⇒ RESCIND; still qualifies ⇒ AWAIT_REPLACEMENT (new mark, ratified again; then the old one is SUPERSEDED kind CORRECTION). An admitted hold adds UNDER_DISPUTE.

## 3. Correction

A mark established from a ResultVersion that corrects the basis of a mark of the same holder in the category records a `CORRECTS_MARK` dependency; on its ratification the old mark gains a CORRECTION supersession and is excluded from replay. The correction link is the upstream ResultVersion fact carried on the sealed snapshot (`performance.supersedesVersionId`, as BRT-08's `resultVersion.supersedesVersionId`): the canonical assembler loads it, so a canonical snapshot that omits or forges it fails re-assembly; absent means "not a correction" (no null encoding). Until the replacement is ratified the original stays current (support: SUSPENDED / AWAIT_REPLACEMENT, never rescinded). BRT-09 does not produce corrections (tested: `record-fixture.int.test.ts` §53).

## 4. Dependency index

`record.mark_dependency` (RESULT_VERSION, VERIFICATION_RUN (establishment + ratification), CATEGORY_VERSION, RATIFICATION, CORRECTS_MARK) + `achievement.record_basis`: which marks depend on ResultVersion X / run Y / category version C / ratification R, and which RECORD_SET represents mark M (`recordDependencyIndex`; `GET /v1/result-versions/:id/record-dependents`).

## 5. RECORD_SET

Derived only after ratification by the validated Achievement path; revoked when its mark is rescinded; a superseded record keeps its RECORD_SET (the record was set).
