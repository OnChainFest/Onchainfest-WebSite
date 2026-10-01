# BRT-09 — Record Model

| Field | Value |
|---|---|
| Ticket | BRT-09 — Records & Record Hall of Fame |
| Implements | BRT-01 [verification model §7, §9](../domain/BRT-01-VERIFICATION-MODEL.md) (RecordCategory, RecordMark, RC-1…RC-4, naming), [disputes §5.3](../domain/BRT-01-DISPUTES-AND-CORRECTIONS.md), [bowling §8](../examples/BRT-01-BOWLING-WALKTHROUGH.md); ADR-0001 (clarified) |
| New ADRs | [0043](../adr/ADR-0043-record-category-versions-define-immutable-record-universes.md) · [0044](../adr/ADR-0044-records-consume-verified-performance-basis.md) · [0045](../adr/ADR-0045-record-set-via-append-only-recognition-linkage.md) · [0046](../adr/ADR-0046-record-hall-of-fame-is-a-projection.md) |
| Code | `packages/domain/src/records.ts`, `packages/schemas/src/records.ts`, `packages/records` (pure engine), `packages/persistence/src/record-*.ts`, `db/migrations/0019–0022`, `apps/api/src/v1-records.ts`, `apps/worker/src/main.ts`, `apps/web/app/{records,record-categories,hall-of-fame}` |

Companion documents: [categories](./BRT-09-RECORD-CATEGORIES.md) · [engine](./BRT-09-RECORD-ENGINE.md) · [ratification](./BRT-09-RATIFICATION.md) · [history & rescission](./BRT-09-RECORD-HISTORY-AND-RESCISSION.md) · [Hall of Fame](./BRT-09-HALL-OF-FAME.md) · [development](./BRT-09-DEVELOPMENT.md) · [threat review](../security/BRT-09-RECORD-THREAT-REVIEW.md).

## 1. Result ≠ Verification ≠ Achievement ≠ RecordCategory ≠ RecordMark ≠ Ranking ≠ Trophy

| Concept | Says | Where |
|---|---|---|
| Result | what happened | `results.*` |
| Verification | why that exact version satisfies a trust level | `verification.*` |
| Achievement | recognition derived by a rule (RECORD_SET is one) | `achievement.*` |
| **RecordCategory** | the exact comparison universe (metric, DisciplineVersion, scope, population, conditions, tie policy) + recognition policy | `record.category`, `record.category_version` |
| **RecordMark** | the historical fact that a verified Performance held record standing in that universe | `record.record_mark` + status history |

There is no `result.isRecord`, `worldRecord`, `nationalRecord` or `currentRecord` anywhere; record status is never a verification level (CANONICAL ≠ "V5"). `tooling/check-no-manual-record.mjs` fails on such shortcuts.

## 2. The RecordMark fact

```
RecordMark (record.record_mark, class A, immutable)
  id, identityHash          H(record-mark-identity, {categoryId, holder, value, basis{rv, contentHash, participant, ordinal}})  UNIQUE
  markHash / candidate      the exact br:record-mark@1 document the engine produced (columns bound by trigger BR150)
  category                  {categoryId, code, categoryVersionId, version, specHash}  (pinned forever)
  scopeType, tiePolicy, comparator, metric
  value                     byte-equal to the Performance Mark (value integrity)
  holder                    ATHLETE | TEAM (durable public identities; never Account / Person / Participant)
  memberCredits[]           TEAM only, from the credited lineup (provenance; never separate athlete marks)
  basis                     {resultVersionId, contentHash, resultStatus FINAL, verificationRunId, snapshot/outcome hashes,
                             level, participantId, performanceOrdinal, evidenceBundleHash, evidenceBundleAsOf}
  evidenceCommitment        BRT-08 commitment over the pinned run's Evidence Bundle
  governingRecognition?     pinned from the run trace (never today's authority state)
  effectiveFrom             the SPORTING time (contest start) — never ratification / insertion time
  comparison                {relation, currentMarks considered (ids, hashes, values)}
  provenance                CANONICAL_ASSEMBLY (normal-schema CHECK)
```

Append-only companions: `mark_status_entry` (statusHistory incl. effectiveTo), `mark_supersession`, `mark_dependency`, `mark_member_credit`, `evaluation` (every engine evaluation, reproducible).

## 3. Statuses

`PENDING_RATIFICATION → RATIFIED | CANONICAL → SUPERSEDED (effectiveTo) ⇄ restored (RC-3) … → RESCINDED`. Transitions are enforced by trigger BR155; CANONICAL requires an explicit non-PLATFORM canonical keeper (BR157); a ratification must bind the exact mark hash (BR156). "Current" = latest status RATIFIED / CANONICAL.

## 4. Scope taxonomy and floors (BRT-01 §7)

| Scope | Floor | Notes |
|---|---|---|
| PERSONAL | — | not a category in v1: personal bests are the BRT-08 PERSONAL_BEST Achievement |
| VENUE / COMPETITION / LEAGUE | FINAL · V3 · hold blocks | explicit RATIFY_RECORD ratification |
| PLATFORM | FINAL · V3, or V2 + REVIEW_COMPLETED (PLATFORM only, opt-in) | "Bragging Rights platform best"; never CANONICAL |
| NATIONAL / CONTINENTAL / WORLD | FINAL · V4 · hold blocks | human ratification; no PLATFORM_WITNESSED; V4 must count this category |

## 5. Production reachability today

| Blocker | Why |
|---|---|
| `RESULT_STATUS_BELOW_REQUIRED` | no T5/T6 producer (versions are SUBMITTED / PROVISIONAL) |
| `VERIFICATION_LEVEL_BELOW_REQUIRED` | BRT-07 ceiling is V1 (ADR-0035) |
| `HOLD_STATE_UNAVAILABLE` | no Dispute / hold producer |
| `POPULATION_FACT_UNAVAILABLE`, `CONDITIONS_FACT_UNAVAILABLE`, `VENUE/LEAGUE_MEMBERSHIP_UNAVAILABLE`, `REGION_ELIGIBILITY_UNAVAILABLE` | no canonical producer (the contest-schedule venue is operational; identity is private) |
| `RATIFICATION_UNAVAILABLE` | no RECORD_RATIFIED / REVIEW_COMPLETED producer (deferred BRT-06R) |

**Production honestly persists zero RecordMarks and zero ratifications.** The demo and the canonical tests prove a real verified Performance is evaluated against a published category with exact blockers, and every evaluation is logged.

## 6. Three lanes

| Lane | Facts | Persists? |
|---|---|---|
| CANONICAL PRODUCTION | real canonical facts (`RecordService`) | yes, normal DB (today: evaluations only) |
| REFERENCE ENGINE FIXTURE | `@br/records/fixtures` | never |
| REFERENCE PERSISTENCE FIXTURE | fixture snapshots → the same validated writer | only in throwaway `br_recfx_<hex>` DBs with the test-only overlays, dropped after use |

## 7. BRT-10 boundary

No ranking points, ranking snapshots, leaderboards, qualification, eligibility decisions, Prize Rail, PrizeEntitlement, payouts or Trophy / NFT. The guard, tests and demo assert this.
