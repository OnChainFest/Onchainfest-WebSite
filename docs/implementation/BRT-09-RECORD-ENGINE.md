# BRT-09 — Record Engine

Code: `packages/records/src/engine.ts` (`evaluateRecord`), `snapshot.ts`, `replay.ts`, `support.ts`; schemas `br:record-evaluation-snapshot@1`, `br:record-evaluation-outcome@1`, `br:record-mark@1`, `br:record-mark-identity@1`. Engine version **`record-engine/1`** (any semantic change ⇒ `/2`).

## 1. Interface

`evaluateRecord(snapshot) → { snapshotHash, outcome, outcomeHash }` — pure: no database, clock, network, filesystem, randomness or environment (authority evaluation uses the BRT-03 engine with `evaluatedAt = issuedAt`).

Mode is decided by the snapshot: **ESTABLISH** (no `pendingMark`) or **RATIFY** (`pendingMark` + `ratification`).

## 2. Snapshot (`br:record-evaluation-snapshot@1`)

`provenance`, `assembler`, `supportedFactKinds`, `category {id, code, versionId, version, specHash, spec, lifecycle}`, `discipline {dv, sport, discipline, metrics+order}`, `performance {rv, result, contentHash, scopeType, status, supersedes?, supersededBy?, competition/event/contest, participant, kind, athlete/team, performanceAthlete?, ordinal, mark, valid, occurredAt?}`, `verification` (BRT-07 summary + `ratifiedRecordCategoryIds?`), `hold?`, `memberships?`, `population?`, `conditions?`, `creditedLineup?`, `currentMarks` (the record **standing at the sporting time**, replayed), `pendingMark?`, `ratification?`, `keys?`, `authority?`, `participation?`. No PII. Sets ⇒ order-independent hash (vector `snapshot/establish-qualifies-reordered`).

Supported kinds in production: RESULT_STATUS, VERIFICATION, CONTEST_OCCURRENCE, COMPETITION_MEMBERSHIP. Not produced: HOLD_STATE, POPULATION, CONDITIONS, VENUE/LEAGUE_MEMBERSHIP, REGION_ELIGIBILITY, CREDITED_LINEUP, RATIFICATION, PARTICIPATION.

## 3. Gates and outcome states

| State | Meaning | Examples |
|---|---|---|
| INTEGRITY_FAILURE | snapshot contradicts itself | `CATEGORY_HASH_MISMATCH`, `METRIC_MISMATCH`, `HOLDER_MISMATCH`, `RECOGNITION_SPORT_MISMATCH`, `PENDING_MARK_BASIS_MISMATCH`, `STANDING_MARKS_NOT_EQUAL`, `STANDING_MARKS_VIOLATE_RC1` |
| INELIGIBLE | outside the universe | `HANDICAP_VALUE_IN_SCRATCH_CATEGORY`, `POPULATION_MISMATCH`, `CONDITION_LIMIT_EXCEEDED`, `OUTSIDE_COMPETITION_SCOPE`, `PERFORMANCE_BEFORE_CATEGORY_EFFECTIVE_FROM`, `CATEGORY_VERSION_RETIRED`, `RESULT_REVOKED` |
| DOES_NOT_QUALIFY | not better than the standing record | `NOT_BETTER_THAN_CURRENT_RECORD`, `EQUALS_CURRENT_RECORD_FIRST_ACHIEVED` |
| PENDING_REQUIRED_FACTS | a fact missing / below floor | `VERIFICATION_LEVEL_BELOW_REQUIRED`, `RESULT_STATUS_BELOW_REQUIRED`, `HOLD_STATE_UNAVAILABLE`, `HOLD_ACTIVE`, `POPULATION_FACT_UNAVAILABLE`, `RATIFICATION_MISSING`, `RATIFICATION_NOT_AUTHORIZED` |
| QUALIFIES | `PENDING_RATIFICATION` (ESTABLISH) / `RATIFIED` / `CANONICAL` (RATIFY) | |

Precedence: INTEGRITY > INELIGIBLE > DOES_NOT_QUALIFY > PENDING > QUALIFIES. No probability or score.

## 4. Comparison

Comparator from the DisciplineVersion metric order (HIGHER_IS_BETTER / LOWER_IS_BETTER, never assumed); exact decimal arithmetic (scaled BigInt, BRT-08 `compareDecimal`). Against the standing record at the performance's time: better ⇒ qualifies and displaces; equal ⇒ SHARED co-holds, FIRST_ACHIEVED does not qualify; worse ⇒ does not qualify. A pending mark never stands (RC-2).

## 5. Candidate (`br:record-mark@1`) and identity

Pins category version + hash, scope, tie policy, comparator, metric, exact value, holder (+ member credits), full basis, evidence commitment, governing recognition, context, sporting `effectiveFrom`, comparison basis. Identity: `{categoryId, holder, value, basis{rv, contentHash, participant, ordinal}}` — one logical mark per category regardless of version or re-verification.

## 6. Determinism / properties (fast-check)

Input order never changes the hash; SHARED holders share one exact value; FIRST_ACHIEVED ≤ 1 holder; a worse value is never current; invalidating a non-current mark never changes the current record; replay is deterministic. 22 committed vectors re-checked by an independent Python checker (`packages/records/reference/check_brt09_vectors.py`).
