# ADR-0045 — Pending RecordMarks and RECORD_SET connect through append-only recognition linkage

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-09 stop gates 0A / 0B (BRT-01 §3.2, §8.2, §9.2, V4; disputes D-1)

## Context

BRT-01 §9.2 lists `RecordMark.achievementId` (the RECORD_SET Achievement) and status PENDING_RATIFICATION; §8.2 creates RECORD_SET only when the mark is ratified. A pending mark cannot point at an Achievement that must not exist yet, and installing the id later would mutate an immutable fact (D-1). The BRT-06 attestation layer admits only RESULT_ACCURATE and CONDITIONS_COMPLIANT claims on RESULT_VERSION subjects: there is no canonical RECORD_RATIFIED / REVIEW_COMPLETED producer.

## Decision

1. **The mark never points at the Achievement.** `record.record_mark` is immutable and has no achievement column. A mark starts PENDING_RATIFICATION; ratification appends a RATIFIED / CANONICAL status entry that pins a `br:record-ratification@1` document (mark id + hash, ratification ref, subject hash, kind, standing, authority proof digest, evaluation snapshot / outcome hashes, ratification-time run).
2. **RECORD_SET points at the mark.** RECORD_SET is derived by the **existing validated Achievement engine** (`achievement-engine/2` = `/1` for every `/1` criterion + `RECORD_MARK_RATIFIED`), from a derivation snapshot that carries the mark facts, through the existing validated writer. Its candidate pins `record` {mark id + hash, category version + hash, ratification entry + hash, standing, recognition level}; the append-only link row `achievement.record_basis` (UNIQUE mark) is an element of that candidate (trigger BR134) and a RECORD_SET must commit with it (BR135). A PENDING or RESCINDED mark never yields a RECORD_SET; the rule floor is raised to the mark's category floor. BRT-01's `achievementId` is exposed as a read-only projection (`record_read.v_record_set_link`).
3. **One-way, least-privileged dependency.** Records never write Achievements: the RECORD_SET is derived by the Achievement module (its worker reacts to `RecordMarkRatified`; idempotent per mark). The record transaction itself is consistent (status entry, supersessions, effective history, dependency index, projections, outbox); RECORD_SET follows asynchronously through its own validated transaction. A rescinded mark revokes its RECORD_SET via current support (`RECORD_MARK_RESCINDED`); a superseded record still WAS set.
4. **Ratification is consumed, not produced.** BRT-09 implements the consumer: typed ratification facts (subject = RECORD_MARK + exact mark hash), `RATIFY_RECORD` authority evaluated by the BRT-03 engine over the category's structural recognition scope (sport, discipline, recognition level, region, competition), human issuers only, no PLATFORM_WITNESSED for V4, conflict-of-interest fail closed. The normal schema accepts only `CANONICAL_ATTESTATION` ratifications naming an `attestation.attestation` row of claim type RECORD_RATIFIED / REVIEW_COMPLETED about the mark (BR156) — which BRT-06 cannot hold, so the honest production ceiling is zero ratified marks. Typed ratifications exist only in engine fixtures and throwaway overlay databases. **The canonical producer is deferred (BRT-06R).**
5. **Applicability without retroactivity.** RECORD_SET rules are those bound at the instant the mark was ratified (the creating fact).

## Consequences

- No circular or mutable reference; the link is hash-bound and auditable from both sides.
- Exactly one RECORD_SET per mark, even under 20 concurrent deliveries.
- Until BRT-06R, production has no ratified marks and no RECORD_SET.

## Alternatives considered

- Mutating the mark to add `achievementId` — rejected (D-1).
- A manual insertAchievement / awardRecordAchievement — rejected (no manual award, BRT-08).
- Extending BRT-06 inside BRT-09 — rejected by decision (producer deferred).
