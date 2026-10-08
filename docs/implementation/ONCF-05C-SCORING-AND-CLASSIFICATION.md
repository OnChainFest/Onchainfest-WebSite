# ONCF-05C — Scoring, classification and competition outcomes

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local, uncommitted; on top of `1800e07`, ONCF-05B) |
| Design | [ONCF-05A](../architecture/ONCF-05A-SPORTS-AND-COMPETITION-ENGINE.md) §§ ruleset, classification, outcomes |
| ADRs | [0062](../adr/ADR-0062-ruleset-execution-and-canonical-score-content.md) ruleset execution · [0063](../adr/ADR-0063-classification-engine-v2-on-read.md) classification-engine/2 (builds on 0047, 0059 and 0060) |
| Migration | `0033_oncf05c_scoring_catalog.sql` (additive; 0001–0032 untouched) |
| Out of scope (by design) | Result-entry UI, timing import, advancement / slot resolution, submitted classifications, recorded lots (05D); scheduling and resources (05E); notifications; payments |

**What this slice delivers.**

- **Ruleset execution.** A score sheet is validated under the event's pinned RulesetVersion and normalized into the exact canonical content the ResultLedger stores.
- **Classification on read.** classification-engine/2 computes explainable group, stage and multi-round classifications from stored results, re-validating each result first.

**Binding rule.** Sport is data. Executors are per ruleset family and templates are catalog rows. No code path branches on sport identity; the `scoring` sources grep clean for sport codes.

## 1. Domain (`@br/domain`, `@br/competition`, `@br/rankings`, `@br/schemas`)

| Piece | File | What it is |
|---|---|---|
| Outcomes | `domain/src/results.ts` | `ResultOutcome` gains `NOT_PLACED` and `PULLED`. Achievement exclusions are unchanged (neither outcome is a win) |
| Ruleset parameters | `competition/src/ruleset.ts` | Team derivation is data: `TIMED_PERIODS.defaultScoreFor`, `ELAPSED_TIME.teamTime`, `FRAMES_PINFALL.handicapAverageAttribute`, `STROKES.teamFormat` / `teamAllowancePercents`, `STABLEFORD.teamFormat`. 23 templates (+5: Baker bowling, golf gross, four-ball net 85 %, scramble (COMMON_PRACTICE), relay team finish) |
| Executor | `competition/src/scoring/execute.ts` | `scoreContest(ctx, sheet)` validates and normalizes with one function per family. It exports the arithmetic helpers `officialTime`, `pinfallHandicap`, `playingHandicap` and `strokesReceived` |
| Read-back | `competition/src/scoring/read.ts` | `readContestContent(ctx, content)` re-derives the sheet from stored content, re-scores it and requires an identical canonical hash (`CONTENT_NOT_CANONICAL` otherwise) |
| Engine | `rankings/src/classification-engine-v2.ts` | `classifyStage(input)` → `br:stage-classification@1` + hash. It covers STANDINGS (points, criteria, H2H mini-tables, tied subsets) and METRIC (aggregation over rounds, tie-breaks, non-finisher order, attribute subsets, team derivation). Arithmetic is exact |
| Policy v2 | `rankings/src/classification-policy-v2.ts` | `subsetsByAttribute` replaces the unused category subsets (ADR-0063 §3). `CANONICAL_CLASSIFICATION_TEMPLATES` |
| Schema | `schemas/src/competition-v2.ts` | `br:stage-classification@1` (entries, statuses incl. `PENDING`, values, decidedBy, explanations, inputs with result version ids + content hashes) |

### Content layout (ADR-0062 §3)

Per-unit measurements are Performances at fixed ordinals. The primary mark is the family's contest metric.

| Family | Primary mark | Performances (ordinal) |
|---|---|---|
| SETS_OF_GAMES | `sog.sets_won` | `sog.set_games` i · `sog.tiebreak_points` 10+i · `sog.match_tiebreak_points` 20 |
| TIMED_PERIODS | `tp.points` | `tp.period_points` i · `tp.overtime_points` 10+j · `tp.defaulted` 30 |
| TIMED_OR_TARGET | `tot.points` | `tot.regulation_points` 1 · `tot.overtime_points` 2 · `tot.ended_by` 3 |
| ELAPSED_TIME / FINISH_ORDER_WITH_TIME / LAPS_AND_TIME | `time.elapsed_ms` | `time.raw_ms` 1 · `time.net_ms` 2 · `finish.position` 3 · `laps.completed` 4 · `laps.down` 5 · `laps.pull_order` 6 · `time.leg_ms` 11+ |
| FRAMES_PINFALL | `pins.total` | `pins.game` g · `pins.member_game` 100·m+g · `pins.handicap_per_game` 90 |
| STROKES / STABLEFORD | `golf.strokes` / `golf.stableford_points` | `golf.hole_strokes` h · `golf.member_hole_strokes` 1000·m+h · `golf.par` 201+ · `golf.stroke_index` 301+ · `golf.course_handicap` 400 (members 400+m) |
| MATCH_PLAY_HOLES | `mp.holes_up` | `mp.hole` h (2 won / 1 halved / 0 lost) · `mp.conceded` 99 |

## 2. Persistence (migration `0033`)

| Object | Purpose |
|---|---|
| `sports.ruleset`, `ruleset_version`, `ruleset_version_status_change` (+ `v_ruleset_version_current`) | Ruleset axis: immutable, hashed versions with a basis; DRAFT → PUBLISHED → RETIRED as append-only facts; `br_catalog` is the only writer |
| `sports.classification_template*` (+ current view) | ClassificationPolicy v2 versions (STANDINGS / METRIC). Separate from BRT-10's authority-owned `ranking.classification_policy` |
| `competition.event_scoring` (+ `v_event_scoring_current`) | The event's pinned ruleset + template (+ per-stage overrides). Append-only; frozen at field lock by the store |

- **Catalog provisioning** (`CatalogStore.provision`) creates rulesets and templates lookup-first with version histories, and reports conflicts. The CLIs pass the canonical sets.
- **`ScoringStore`** (`persistence/src/scoring-store.ts`) provides:
  - `pinScoring`: COMP_EDIT; checks capability fit (the discipline provides the ruleset family; the template family matches head-to-head vs field); refused after lock.
  - `scoring`: read access.
  - `validateScoreSheet`: pure; no writes.
  - `classify`: reads structure as `br_competition` and results as `br_results` in separate transactions, then re-validates every result and classifies.
  - It **never** writes results or classifications.
- **Readiness** gains `stageList` (stage keys, labels and group keys) for the classification view.

## 3. API (`apps/api/src/v1-competition.ts`)

| Route | Who | What |
|---|---|---|
| `PUT /v1/events/:eventId/scoring` | COMP_EDIT | Pin ruleset (+ template). 400 incompatible · 409 after field lock |
| `GET /v1/events/:eventId/scoring` | COMP_STAFF | Pinned versions with spec, basis, `frozen` |
| `POST /v1/contests/:contestId/score-sheets/validate` | COMP_STAFF | `{ok, result, content, contentHash}` or `{ok:false, issues}`; writes nothing |
| `GET /v1/events/:eventId/stages/:stageKey/classification?group=&throughRound=` | COMP_STAFF | Proposal document + hash + pending contests |

`GET /v1/catalog` adds `rulesetVersions`, `classificationTemplateVersions` and per-discipline `compatibleRulesetVersionIds`.

No route name contains "ranking". The classification route is read-only, which is what the ranking guard allows.

## 4. Web (minimal)

The organizer Structure page has two new panels:

- **Scoring.** It shows the pinned ruleset and template with their basis; COMMON_PRACTICE is labelled as such. A form offers only catalog-compatible versions, and the form is disabled once the field is locked.
- **Classification (proposal).** It has per-stage and per-group links and a table with position (`=` marks a shared position), values and "decided by". The panel states that the table is not official until an authority submits it. Entrant names come from the locked field the organizer can already see; no private attribute is shown.

## 5. Proof cases (`packages/persistence/src/oncf05c.int.test.ts`)

Every case runs through the real stores: provision → pin → lock / seed / plan → validate → ResultLedger submit + accept (authority-granted referee) → classify.

| Case | Sport / format | What is proven |
|---|---|---|
| A | Tennis singles, SE | A valid score decides the winner. An impossible set (6-5) is refused. Validation writes nothing. Capability mismatch is refused, the pin is frozen after lock, and v1 events cannot pin |
| B | Padel doubles, groups → KO | A genuine three-way cycle is resolved by the tied-subset rule. Classification is deterministic, other groups are pending, and the group parameter is required. A tampered stored result → `CONTEST_RESULT_INVALID` |
| C | Running road, wave start | 120 runners across three waves classified by time. DNF entrants go last. Subsets by the declared `ageBand` |
| D | Swimming, heats → final | Heats classified by time across heats. The final stays pending: qualifiers are resolved in 05D |
| E | Golf stroke play, multi-round + cut | Rounds 1–2 cumulative (`throughRound`). An equal total is separated by count-back |
| F | Basketball 3x3, pools → KO | Team scores to target. The pool is classified with wins and points criteria. A negative score is refused |
| Wheelchair | Wheelchair basketball | The same TIMED_PERIODS family and FIBA template, purely by catalog data |

## 6. Tests

| Suite | Count | Notes |
|---|---|---|
| `competition/src/scoring/scoring.test.ts` | 27 | Every family, read-back round trips, tampering, handicap arithmetic, property checks, v1 compatibility |
| `rankings/src/classification-engine-v2.test.ts` | 16 | Standings criteria, mini-tables, tied subsets, shared positions, lots, METRIC aggregation and tie-breaks, non-finisher order, subsets, team derivation, hash determinism |
| `apps/web/app/_lib/scoring.test.ts` | 3 | Catalog-driven choices, basis labels |
| `persistence/src/oncf05c.int.test.ts` | 9 | Proof cases A–F + wheelchair (above) |
| `apps/api/src/oncf05c.int.test.ts` | 1 | Routes, permissions, incompatibility, freeze, validation, pending proposal |

`pnpm vectors:check` is unchanged: every existing golden vector reproduces, and no v1 hash moved.

**Two BRT-10 inventory tests were scoped, not loosened.** Both matched by name ("classification") and therefore counted 05C additions:

- `apps/api/src/rankings.int.test.ts` keeps the exact nine BRT-10 routes. It now also pins 05C's single in-event route as `GET … COMP_STAFF`, so it can never become a write surface unnoticed.
- `persistence/src/rankings-foundation.int.test.ts` counts `classification_%` append-only triggers in the `results` schema only (still 12). The three new `sports.classification_template*` tables are 05C catalog tables.

**Intermittent failures (pre-existing, outside 05C, code untouched).** `verification.int.test.ts` fails a different test on each run, always with a clock error (`VERIFICATION_TIME_INCONSISTENT`, "asOf cannot be in the future", `KEY_NOT_VALID` at a validity boundary). It passed 20/20 in isolation once. The host clock runs about 20–40 ms ahead of Postgres. The same timing class showed up once each in `achievement.int.test.ts` (asOf in the future) and `server.int.test.ts` (`/ready` observed migrations mid-reset during the serial run); both pass in isolation. These match the time-dependent flakes recorded in ONCF-04.

## 7. Known limitations and deliberate deviations

- **The ledger does not validate content on submit.** `br_results` cannot read competition tables. Classification re-validates and fails closed instead (ADR-0062). Wiring the ruleset into the submission path is 05D's result entry.
- **Classifications are never persisted** (ADR-0047). Submitting a classification as a derived ResultVersion is 05D.
- **ORGANIZER_LOT** separates entrants only with an explicit lot order. Recording lots as facts is 05D; until then, tied entrants share a position.
- **Golf course data** (par, stroke index) travels on the scorecard. There is no course catalog, and course handicap is declared, not computed from slope.
- **v1 events** have no ruleset family and cannot pin scoring. Their results and hashes are untouched.
