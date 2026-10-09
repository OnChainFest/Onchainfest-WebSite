# ADR-0044 — Comparative records consume a verified immutable Performance basis; RECORD_SET is the resulting Achievement

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-09 stop-gate decision (BRT-01 §8.2, §9.2, RC-4; ADR-0001)
- **Clarifies:** ADR-0001 decision 4 (narrowly)

## Context

ADR-0001 says "records, rankings, prizes and trophies derive from Achievements or FINAL classifications, never directly from raw submissions". BRT-01 §9.2 says a RecordMark's `achievementId` is "the RECORD_SET achievement; basis → result → verification", §8.2 says RECORD_SET is "created when a RecordMark is ratified", and RC-4 says records are "computed only over performances that match population.category and conditions".

No BRT-08 Achievement type can feed comparative records: PERSONAL_BEST is athlete-local (a competition record is often not the athlete's PB), and PERFORMANCE_THRESHOLD would need a meaningless always-true threshold. Inventing a "QUALIFYING_MARK" Achievement would add a type BRT-01 §8.2 does not have.

## Decision

1. **Record source = VERIFIED IMMUTABLE PERFORMANCE BASIS:** the exact Performance (participant + ordinal + Mark) inside an exact ResultVersion (content hash re-verified), its lifecycle status from append-only transitions (FINAL required), its CURRENT BRT-07 VerificationRun (freshness by hash; level ≥ the category floor), the run's Evidence Bundle commitment, the governing recognition pinned from the run's immutable trace, the participant → Athlete / Team resolution, the DisciplineVersion and metric, the contest occurrence (the sporting time), population / condition / membership facts, and hold state.
2. **Never raw submissions.** A SUBMITTED / PROVISIONAL / unverified / stale / superseded / revoked result can never establish a mark; the engine reports exact blockers.
3. **No intermediate Achievement.** No QUALIFYING_MARK type, no PERFORMANCE_THRESHOLD wrapper. The only record-related Achievement is **RECORD_SET**, created after valid ratification (ADR-0045).
4. **ADR-0001 clarification (narrow):** for comparative records, "derive from Achievements" is satisfied by the RECORD_SET Achievement that recognizes the record; the comparison itself is computed over verified Performances (BRT-01 §9.2 / RC-4). ADR-0001's intent — never from raw submissions, exact basis references, correction impact — is preserved: every mark pins its basis and the dependency index answers correction impact.
5. **Value integrity.** `RecordMark.value` is byte-equal to the canonical Performance Mark; the writer re-runs the engine and the database binds columns to the hashed candidate.

## Consequences

- Records are reachable without bending BRT-08 types; the record engine owns comparison semantics.
- Production today honestly produces zero marks (no FINAL / V3 / V4 / hold facts).

## Alternatives considered

- Source Achievement per performance (QUALIFYING_MARK) — rejected (not in BRT-01).
- PERFORMANCE_THRESHOLD or PERSONAL_BEST as source — rejected (wrong universe / meaningless).
