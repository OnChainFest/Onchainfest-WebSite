# BRT-10 — Ranking Engine

Status: engines implemented (Step 3); persistence, API and worker are later steps. Code: `packages/rankings` (`@br/rankings`, pure; no database, clock, network, filesystem, randomness or environment). Decision records: [ADR-0048](../adr/ADR-0048-ranking-systems-and-immutable-ranking-snapshots.md), [ADR-0049](../adr/ADR-0049-explicit-comparator-aggregation-and-shared-ties.md).

## 1. Interfaces

- `evaluateRankingRun(input, meta?) → { ok, inputHash, outcome, outcomeHash, meta }` (`src/ranking-engine.ts`). Input: `br:ranking-run-input@1`. Output: `br:ranking-run-outcome@1` with the ranked entries, every candidate's state and blockers, and the publication state (`PUBLISHABLE | BLOCKED`).
- `deriveClassification(input, meta?) → { ok, inputsDigest, outcome, outcomeHash, meta }` (`src/classification-engine.ts`). Input: `br:classification-derivation-input@1`. Output: `br:classification-derivation-outcome@1`, carrying the proposed `@2` content only when `PROPOSED`. See [BRT-10-CLASSIFICATIONS.md](BRT-10-CLASSIFICATIONS.md).
- An input that cannot be canonicalized returns `{ ok: false, issues }` (for example an unknown member such as `trigger` → `BRJ_UNKNOWN_FIELD`, or a deferred `AVERAGE` aggregation → `POLICY_UNSUPPORTED`). Nothing throws for bad input. A thrown error means an engine invariant was broken.
- `meta.trigger` is returned as is and is **never** hashed or part of the outcome, so the same input with different triggers gives the same `outcomeHash`.

Engine versions are the constants `RANKING_ENGINE_VERSION = 'ranking-engine/1'` and `CLASSIFICATION_ENGINE_VERSION = 'classification-engine/1'`, pinned in every outcome and in every `@2` derivation. Any semantic change requires `/2`. The versions are code constants and never depend on the environment.

Neither engine writes anything: no snapshot, achievement, ResultVersion, read model or event.

## 2. Engine inputs (not RankingSnapshots)

An engine input is the sealed, hashed input of one evaluation. A RankingSnapshot is the published output artefact (ADR-0048). Sets are canonicalized, so input order never changes a hash. The trigger and transaction time are never members.

`br:ranking-run-input@1` carries:

- provenance, assembler and the supported fact kinds;
- the system version: id, kind, lifecycle, embedded spec and spec hash;
- the DisciplineVersion: id, sport, discipline, and `metric = {key, valueType, unit, order?}`. This is the DV `MetricSpec` of the universe metric plus the order the DV comparator declares for it. A missing `order` means the DV declares none, which gives `METRIC_NOT_COMPARABLE`. (`metric` was added in Step 3 because the unit and precision gates need the DV facts.)
- the as-of sporting cutoff;
- the candidates: exact ResultVersion, content hash, status, supersession, membership path, resolved holder, Performance (participant, ordinal, Mark, valid), sporting time, BRT-07 verification summary, and optional hold and population facts;
- an optional OFFICIAL publication act. This has no producer.

## 3. BEST_MARK ordering

1. **Holder best.** Admissible candidates are grouped by holder. The best value under the pinned comparator is found with BRT-09 `compareUnder` (exact decimals via BRT-08 `compareDecimal`). **Every** candidate equal to that value is pinned as basis on the holder's single entry; none is chosen. Strictly worse candidates become `NOT_HOLDER_BEST`, with reason `NOT_HOLDER_BEST`. If one holder's equal best values have different canonical spellings (precision), one byte-equal entry value cannot exist without a choice. The holder is then not ranked, and those candidates get `METRIC_PRECISION_MISMATCH`.
2. **Global ranks.** Competition-style: `rank = 1 + number of strictly better holders`, and `tied` is true iff the rank is shared (1, 1, 3, 4). No identifier, timestamp or input order is ever consulted. The result is asserted with the shared tie validator `checkCompetitionRanking` (built on `checkSharedRanks`).
3. **Entry.** Each entry has `value` (the exact Performance Mark), `comparatorTrace = [{key, order, value}]` and `basis[]`. Each basis item carries: result and version, content hash, FINAL, competition / event / contest, participant + ordinal, verification run + snapshot / outcome hashes + level, evidence bundle hash + as-of, the evidence commitment (BRT-08 `evidenceCommitmentOf`), governing recognition, hold `ABSENT`, and sporting time.

## 4. Gates and outcome states

Candidate state precedence is INTEGRITY_FAILURE > INELIGIBLE > PENDING_REQUIRED_FACTS > NOT_HOLDER_BEST > INCLUDED. Every candidate appears in `outcome.candidates` with all of its reasons. The state of each code comes from `RANKING_BLOCKERS`. No new blocker codes were added in Step 3.

| Gate | Condition (fails closed) | Code | State |
|---|---|---|---|
| Run integrity | spec re-validates; hash = `specHash`; `system.kind` = spec kind | validator codes / `SPEC_HASH_MISMATCH` | INTEGRITY_FAILURE (every candidate) |
| | spec DV = pinned DV; recognition sport / discipline = DV | `DISCIPLINE_VERSION_MISMATCH`, `RECOGNITION_SPORT_MUST_BE_DISCIPLINE_SPORT`, `RECOGNITION_DISCIPLINE_MISMATCH` | INTEGRITY_FAILURE |
| | DV metric = universe metric; DV order comparable and equal to the spec key | `METRIC_UNKNOWN`, `METRIC_NOT_COMPARABLE`, `COMPARATOR_MISMATCH` | INTEGRITY_FAILURE |
| Holder | resolved; universe holder type; athlete = performance athlete | `HOLDER_UNRESOLVED` / `HOLDER_TYPE_NOT_IN_UNIVERSE` | INTEGRITY / INELIGIBLE |
| Result status | fact supported; not superseded / revoked / rejected; FINAL | `RESULT_STATUS_UNAVAILABLE`, `RESULT_SUPERSEDED`, `RESULT_REVOKED`, `RESULT_REJECTED`, `RESULT_STATUS_BELOW_REQUIRED` | PENDING / INELIGIBLE |
| Performance | valid; Mark metric = universe `markMetricId`; unit = DV unit; precision fits DV value type | `PERFORMANCE_INVALID`, `METRIC_MISMATCH`, `METRIC_UNIT_MISMATCH`, `METRIC_PRECISION_MISMATCH` | INELIGIBLE |
| Sporting time | known; ≥ `effectiveFrom` and `window.from`; < `window.to`; ≤ `asOf` | `OCCURRENCE_TIME_UNKNOWN`, `PERFORMANCE_OUTSIDE_WINDOW`, `PERFORMANCE_AFTER_AS_OF` | PENDING / INELIGIBLE |
| Membership | competition / event / contest known; in the explicit competition set | `COMPETITION_MEMBERSHIP_UNAVAILABLE`, `OUTSIDE_COMPETITION_SCOPE` | PENDING / INELIGIBLE |
| Population | each declared dimension has a typed fact equal to it | `POPULATION_FACT_UNAVAILABLE`, `POPULATION_MISMATCH` | PENDING / INELIGIBLE |
| Hold | fact supported and known; not active | `HOLD_STATE_UNAVAILABLE`, `HOLD_ACTIVE` | PENDING |
| Verification | supported; CURRENT (hash-fresh); run complete; level ≥ effective floor | `VERIFICATION_UNAVAILABLE`, `VERIFICATION_STALE`, `VERIFICATION_NOT_EVALUATED`, `VERIFICATION_POLICY_UNAVAILABLE`, `VERIFICATION_RUN_INCOMPLETE`, `VERIFICATION_LEVEL_BELOW_REQUIRED` | PENDING |
| Governing recognition (OFFICIAL only) | pinned with a known scope; not PLATFORM; covers level / sport / discipline / region (BRT-03 scope algebra) | `GOVERNING_RECOGNITION_UNAVAILABLE`, `RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM`, `RECOGNITION_*_NOT_COVERED` | PENDING / INELIGIBLE |

The evidence commitment needs the run's bundle hash and as-of, which the "run complete" gate requires.

Publication is `BLOCKED` when any of these apply: run integrity reasons; `NO_RANKED_ENTRIES` (the run ranked nobody — a run-level publication blocker, never a candidate reason; `br:ranking-snapshot@1` requires at least one entry); `SYSTEM_VERSION_NOT_PUBLISHED` / `SYSTEM_VERSION_RETIRED`; or, for OFFICIAL systems, `OWNER_PUBLICATION_UNAVAILABLE` (no `RANKING_PUBLICATION` producer exists).

## 5. Hashing and domain tags

Hashing is `hashCanonical` under BR-JSON / JCS with domain separation (`packages/schemas/src/rankings.ts`):

| Schema | Domain tag | Object |
|---|---|---|
| `br:result-version-content@2` | `result-version-content` (existing) | classification ResultVersion content + `derivation` |
| `br:classification-policy@1` | `classification-policy` | ClassificationPolicy spec |
| `br:ranking-system-version@1` | `ranking-system-version` | RankingSystemVersion spec |
| `br:ranking-universe@1` | `ranking-universe` | universe identity shared by all versions of a system |
| `br:ranking-run-input@1` | `ranking-run-input` | the ranking engine input (deliberately not called a snapshot) |
| `br:ranking-run-outcome@1` | `ranking-run-outcome` | entries + every candidate's state and reasons |
| `br:ranking-snapshot@1` | `ranking-snapshot` | the published, immutable RankingSnapshot content |
| `br:qualification-basis@1` | `qualification-basis` | the qualifying fact a QUALIFIED Achievement pins |
| `br:classification-derivation-input@1` | `classification-derivation-input` | the classification engine input (Step 3) |
| `br:classification-derivation-outcome@1` | `classification-derivation-outcome` | its outcome + optional `@2` proposal (Step 3) |

Entries are embedded in the outcome and the snapshot, so they need no tag of their own.

## 6. Determinism

Identical semantic inputs produce byte-identical canonical outcomes and the same hashes. This is proven by unit tests (`ranking-engine.test.ts`, `classification-engine.test.ts`, `staleness.test.ts`) and by the BRT-10 vectors (`packages/rankings/test-vectors/brt-10.vectors.json`, `pnpm vectors:generate:brt10`).

The independent Python checker (`packages/rankings/reference/check_brt10_vectors.py`) re-derives JCS and every hash, and checks:

- the input → outcome → content bindings;
- that every classification input's `@1` content re-hashes to its pin;
- holder-best selection (no equal best mark dropped);
- the SUM / MAX / MIN / outcome-points aggregation;
- the competition-style shared ranks;
- (Step 7) every `br:classification-staleness@1` document, recomputed from its content vector's pins and the committed observation (`notCurrent`, `added`, `removed`, reasons, version binding, no input status), and every fresh case recomputing to CURRENT. The staleDigest is the `ClassificationStale` idempotency key, so a second implementation must reproduce it.
