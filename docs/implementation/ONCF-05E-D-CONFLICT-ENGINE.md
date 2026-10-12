# ONCF-05E-D — Conflict / feasibility engine v1

| | |
|---|---|
| Branch | `feat/oncf-05e-d-conflict-engine` (local; on top of `34f0ff8`) |
| Contract | [ADR-0074](../adr/ADR-0074-conflict-feasibility-engine-v1-semantics.md) (approved) · [ONCF-05E-D architecture](./ONCF-05E-D-ARCHITECTURE.md) · ADR-0066–0073 (unchanged) |
| Migration | None |
| Not in this phase | proposals (05E-E) · operations API (05E-F) · organizer UI (05E-G) · public UI (05E-H) |

**What this phase answers.** Given one schedule version's concrete content and the competition state it refers to, is it feasible — and if not, which canonical conflicts explain why. It judges; it never schedules, moves, proposes, writes or publishes.

## 1. Domain (`@br/competition`)

| Module | Content |
|---|---|
| `scheduling/engine.ts` | `evaluateSchedule(input) → ScheduleConflictReport` (pure, one argument, no options); `CONFLICT_ENGINE` (`br:schedule-conflict-engine` v1); `ENGINE_COVERAGE` (19 codes); `ScheduleEvaluationError`; the `ScheduleEvaluationInput` types |
| `scheduling/report.ts` | Additive `reportVersion: 2`: `inputs.competitionTimezone` (required in v2, forbidden in v1). Version-1 reports canonicalize and hash exactly as before |
| `resources/availability.ts` | `expandAvailability` (effective + declared time over a horizon, once), `classifyExpanded` (binary-search lookup), `classifyAvailability`. `effectiveAvailability` is unchanged |
| `scheduling/engine.fixture.ts` | Test-only input builder (not exported by the package) |

### Rules implemented (ADR-0074, by decision)

| Decision | Implementation |
|---|---|
| D3 | Exact epoch-millisecond arithmetic on half-open intervals; report instants `floor(ms / 1000)`; a missing end yields `INCOMPLETE_ASSIGNMENT` (`expectedEnd`) and skips R1–R4, availability, the window's end bound, participant overlap, rest and feeder use, while start events, the window start, daily limits, round sequence and dependent use still run |
| D4 | CANCELLED / VOID excluded everywhere; a conflict whose contests are all IN_PROGRESS / COMPLETED is not emitted (except `LOCKED_ASSIGNMENT_VIOLATION`) |
| D5 | Units recomputed with 05E-C's `deriveUnitKeys`; `UNIT_SPLIT` reasons `start`, `shared-multi-resource`, `unit-key`, `unscheduled-member`, one conflict per unit |
| D6 | Mode = the stored `occupancyMode` only; `n` = 1 (CONTEST) or non-VACANT places (ENTRANT); no requirement ⇒ R2/R3 skip the claim and `INCOMPLETE_ASSIGNMENT` (`consumption`); R1 per resource × unit pair; R2 incremental sweep line (maximal over-capacity windows); R3 per resource × unit; R4 over key-sharing resource pairs, **including the same unit** |
| D7 | Start events per SHARED resource; max spacing over both slots, min concurrency in a slot (default 1); same-unit events never compared; requirement-less units add no bound |
| D8 | `closed = B − effective` → `RESOURCE_UNAVAILABLE`; `undeclared = (B ∩ effective) − declared` → `AVAILABILITY_UNDECLARED`; declared = all time for a layer with any WEEKLY fact, else its DATE_OPEN local days |
| D9 | Event window exactly as the 05E-C baseline |
| D10 | Persons = athlete or frozen roster; possible occupants = memoized closure over the plan DAG; same-round rule; `TEAM_OVERLAP` (one team entrant) vs `PARTICIPANT_OVERLAP` (one person, not explained by a common team); rest against the latest-ending earlier appearance in another round; daily limit per (event, entrant, requirement, local start date) with one count per round |
| D11 | `DEPENDENCY_ORDER` per dependent (COMPLETED / CANCELLED / VOID feeders impose nothing; unscheduled feeders ⇒ `INCOMPLETE_ASSIGNMENT` `feeder`; changeover never added); `ROUND_SEQUENCE` over CERTAIN appearances, consecutive rounds of one stage |
| D12 | `STALE_OCCUPANT` per assignment reading a STALE place; `LOCKED_ASSIGNMENT_VIOLATION` when a started contest's placement differs from the base PUBLISHED version |
| D13 | Per-code emission granularity; each participant conflict carries exactly one identity; a duplicate `conflictKey` throws `ScheduleEvaluationError` |
| D15 | `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` are outside coverage (no profile input exists) |
| D16 | Unknown contest / resource / feeder / entrant, duplicate current facts, end ≤ start, invalid mode or capacity, unresolvable requirement, a cycle in the plan graph ⇒ `ScheduleEvaluationError`, never a report |

The occupancy digest (`br:schedule-occupancy-states`) hashes every place as `(contest, place, source kind, state, occupant, 05D fact id)`, so STALE is distinguishable from UNRESOLVED and from decided-VACANT in the hashed inputs.

## 2. Persistence

| Change | Purpose |
|---|---|
| `ScheduleStore.report` | The single private path used by `validate` and `publish`. It loads every input server-side (assignments, base version, plan graph and feeders, places with 05D states, entrants and rosters, events and profiles, resource revisions, availability, competition zone) and calls `evaluateSchedule`. The baseline validator is no longer called by any command |
| `ScheduleStore.contestRows` | One query feeding both the unit key recorded at write time and the engine's unit derivation |
| `AdvancementStore.targetStates` | Read-only: every 05D target's state computed on read, exactly as `state` does (staleness included) |
| `resource-store.ts` | Exports `availabilityFactOfRow` / `AvailabilityFactRow` (the existing row mapper) for the loader |

Constructor signatures are unchanged (`new ScheduleStore(db)`); no route, response shape or permission changes beyond `reportVersion: 2`, the engine's validator identity and its coverage.

## 3. Behaviour changes visible to callers

| Surface | Before (05E-C) | Now |
|---|---|---|
| `validate` / `publish` report | `reportVersion 1`, baseline, 3 codes | `reportVersion 2`, `br:schedule-conflict-engine` v1, 19 codes |
| Overlaps, capacity, spacing, participants, rest, dependencies, availability, daily limits | Recorded, never judged | Recorded at write time (unchanged), judged at validation and publication |
| Undeclared operating hours | Not reported | `AVAILABILITY_UNDECLARED` (SOFT), acknowledged at publication |
| Past publications | — | Unchanged: they keep their recorded `reportVersion 1` report, coverage and hash |

## 4. Tests

| Suite | Count | Covers |
|---|---|---|
| `competition/src/scheduling/engine.test.ts` | 91 | Every rule with a conflicting, a clean and a boundary case; changeover propagation; same-unit lane re-pairing; consumption by place state; start events (300/600/900 example, concurrency, missing end); units; availability (weekly, closures, DATE_OPEN, RETIRED, undeclared, midnight in Costa Rica, New York DST, changeover past closing); window; participants (person, team, roster-less team, two persons between two teams with distinct keys, possible vs certain, same-round rule); rest; daily limits in the event zone; dependencies; round sequence; statuses; locks; STALE; sub-second legacy instants; malformed input; determinism (shuffled inputs, fake clock), ordering, key uniqueness, hash sensitivity; sport-identity guard |
| `competition/src/scheduling/engine-sports.test.ts` | 70 | All 61 compatible sport × modality × format cells of the catalog design matrix, from real format-engine plans and canonical templates: a feasible layout is clean, a collision is caught; ten-pin bowling squads over lane pairs, re-pairing, post-cut singletons; golf tee groups, two tees, 600 s spacing, `{3, DESC}` regroup, same-day post-cut round; performance (5 000 assignments; a 128-entrant knockout) |
| `persistence/src/oncf05e-d.int.test.ts` | 2 | Engine wiring end to end: version-2 report, identity, coverage, competition zone; HARD blocks and SOFT acknowledgement; a zone edit makes a report stale; official results → 05D commit → correction ⇒ STALE in the hashed inputs, `STALE_OCCUPANT`, `REPORT_STALE` |
| `persistence/src/oncf05e-c.int.test.ts`, `apps/api/src/oncf05e-c.int.test.ts` | updated | The tennis fixtures declare court hours; the report assertions now state the engine's verdict (the same-court semifinals are a HARD `RESOURCE_OVERLAP`) |

## 5. Known limitations

- **05D states are read just before the command transaction.** They are computed by `AdvancementStore` under 05D's module roles (results are read as `br_results`), so they cannot share the schedule transaction. The read follows the same authorization, and its digest is hashed into the report: any change between `validate` and `publish` makes the report stale. A change inside the milliseconds between that read and the publication transaction is not detected, as with 05D's own start guard.
- **Teams without a frozen roster** (team events locked before ADR-0057 rosters existed) get entrant-level checks only (`TEAM_OVERLAP`, daily limits, round sequence); no person-level overlap or rest.
- **v1 rank sources without a stage reference** take every earlier round of the event as feeders (conservative).
- **Codes outside v1 coverage:** `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY`.
- **Whole-schedule evaluation** only; incremental evaluation for 05E-E candidate search is deferred (architecture Q6).
- **Catalog data gaps** (track and open-water templates, bowling `regrouping`) are unchanged: those cells evaluate without a profile and report `INCOMPLETE_ASSIGNMENT` (`consumption`) rather than inventing a consumption.
