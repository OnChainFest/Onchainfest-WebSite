# ADR-0074 — Conflict / Feasibility Engine v1 Semantics

- **Status:** Proposed (frozen for ONCF-05E-D implementation once approved)
- **Date:** 2026-10-11
- **Origin:** ONCF-05E-D-0 architecture and readiness audit, after PR #10 (ONCF-05E-C merged at `34f0ff8`). Builds on [ADR-0066](./ADR-0066-scheduling-boundary-and-competition-scope.md)–[ADR-0073](./ADR-0073-scheduling-semantics-clarifications-resource-occupancy-model.md). None of them is edited. Where this ADR narrows or extends one of their statements it says so explicitly (§ "Relationship to ADRs 0066–0073").
- **Amended by:** ONCF-05E-F-6 (2026-10-13), D12 only: explicit unlock is not a publication-time exemption, and the moved-then-started recovery path ([ONCF-05E-F architecture](../implementation/ONCF-05E-F-ARCHITECTURE.md) Part III, findings C-1 and G-8). The amendment has this ADR's status.

## Context

ADR-0071 and ADR-0073 froze the conflict vocabulary, the occupancy model (R1–R5), start events, availability classes, daily limits, the report's elements and order, possible occupants and the unit derivation. 05E-C implemented the report **contract** (`packages/competition/src/scheduling/report.ts`), the unit derivation (`units.ts`), stored claims (`schedule_assignment`, migration `0037`) and a three-code baseline validator (`assignment.ts`), wired into `ScheduleStore.validate` / `publish` through one private loader (`schedule-store.ts`, `report()`).

The readiness audit compared that code with ADR-0066–0073 and found that the frozen semantics are sufficient for **most** of the engine, but that two engineers could still build incompatible 05E-D engines in the places listed below. Each is a gap between the frozen text and the implemented data or contract, not a disagreement with a frozen decision.

**Repository evidence** (verified in code at `34f0ff8`):

| Area | What exists | Where |
|---|---|---|
| Occupancy mode | Declared `occupancy_mode` `EXCLUSIVE \| SHARED`, NOT NULL, on every resource revision; backfilled per type; exposed by `v_resource_current` with `revision_id`. The capacity-derived `occupancy` label survives as legacy descriptive data | `0037`, `resources/resource.ts`, `resource-store.ts` |
| Physical overlap | `sharesSpace(a, b)`: same id or intersecting `exclusivityKeys` | `resources/resource.ts` |
| Intervals | Half-open `[start, end)` in epoch **milliseconds**; touching intervals do not overlap | `resources/interval.ts` |
| Availability | `effectiveAvailability` treats a layer with no WEEKLY fact as open all day (unrestricted); no DECLARED/UNRESTRICTED classifier yet. Resource layer zone = resource `timezone`, else the competition zone, else `UTC` | `resources/availability.ts`, `resource-store.ts` |
| Assignment | One row per fact; at most one `resource_id`; `starts_at`; nullable `expected_end` (`> starts_at`); stored `changeover_seconds` (0–86 400); `unit_key` (NULL for `MIGRATED` rows); `provisional`, `locked`, `removed`; whole seconds enforced for `MANUAL` facts only (`CARRIED` copies of migrated rows may keep sub-second instants) | `0037` |
| Blocking | `blockingEnd`: `expectedEnd + changeover` on EXCLUSIVE, `expectedEnd` otherwise, computed, never stored | `scheduling/assignment.ts` |
| Report contract | 22 codes with fixed or `ENFORCEMENT` severity; conflict fields `code, severity, certainty, interval (epoch s), unitKeys, contestIds, assignmentIds, resourceIds, consumption?, personIds?, entrantIds?, requirement?, expected?, actual?` — **no free `details` payload**; inputs `events[], resourceRevisionIds, availabilityFactIds, occupancyDigest, contestStatuses`; `validator {id, version}`; `coverage`; seven-key order; `conflictKey` hashes code + sort keys 2–7; `reportVersion: 1`; no timestamp | `scheduling/report.ts` |
| Sort key 6 | One value: the smallest of `personIds ∪ entrantIds` | `report.ts` (`participant`) |
| Baseline | Coverage `INCOMPLETE_ASSIGNMENT`, `OUTSIDE_EVENT_WINDOW`, `RESOURCE_TYPE_MISMATCH`; evaluates every live fact whatever the contest status | `assignment.ts` |
| Loader | One private `report()` used by both `validate` and `publish`; occupancy digest = `(contestId, place, participantId ?? '')` from `v_contest_occupant` | `schedule-store.ts` |
| 05D states | Target states `UNRESOLVED · RESOLVED · VACANT · STALE · OVERRIDDEN`, **computed on read** by `AdvancementStore.compute` (not in any SQL view); `v_contest_occupant` returns NULL for both unresolved and decided-vacant places | `advancement-store.ts`, `0034` |
| Dynamic rounds | Materialized per field place (`SERIES`, one `QUALIFIER` slot with the ordinal) or as one field contest; no time, venue or grouping | `advancement-store.ts` `materialize` |
| Identity | Participant `INDIVIDUAL` (athlete) or `TEAM` (team + frozen `participant_roster_member`); declared lineups exist per contest | `0008`, `0032` |
| Time zones | `event_profile.timezone` and `competition_profile.timezone` are both editable while the competition/event is editable | `competition-store.ts` |
| Profile | Spec v1 (`profile.ts`); `concurrentStarts` canonical default 1; `rest` and `maxUnitsPerEntrantPerDay` carry `enforcement`; no field for long waits, under-use or sequencing efficiency | `scheduling/profile.ts` |

## Problem Statement

| # | Gap | Why it matters |
|---|---|---|
| G1 | The engine's entry point, inputs and relationship to the baseline are not frozen | 05E-E must call the same judge; publication must not choose a weaker validator |
| G2 | Which contests are judged (cancelled, void, started, completed) | A HARD conflict between two completed contests could never be cleared (they cannot be moved), so the competition could never publish again |
| G3 | Instants in milliseconds vs whole seconds; legacy sub-second rows | "Same instant", overlap and report anchoring must not depend on rounding choices |
| G4 | Unit membership edge cases: recorded vs derived key, unscheduled members | ADR-0073 B9 says a key change is reported "as `STALE_OCCUPANT` or `UNIT_SPLIT`" without saying when which |
| G5 | Consumption without a governing requirement (profile-less events with resources) | R2/R3 need `n`, which needs `capacityUnit` |
| G6 | A unit spanning two key-sharing resources | R4 applies only to claims of *different* units, so one squad on lane pairs 11–12 and 12–13 at once is not caught |
| G7 | Exact DECLARED-OPEN / UNRESTRICTED algorithm across two layers in two zones | "declares a window for each local date touched" is ambiguous per layer and per zone |
| G8 | Possible occupants inside one round | Without a rule, every place of a post-cut round "possibly" holds every entrant, so every pair of simultaneous places becomes a POSSIBLE `PARTICIPANT_OVERLAP` and every entrant "possibly" plays dozens of units a day |
| G9 | Rest "consecutive units" with possible occupants; TEAM vs PARTICIPANT overlap; roster vs lineup | Duplicate or missing participant conflicts |
| G10 | Dependency edges with unscheduled or completed feeders; `OVERRIDDEN` targets | Missing information must not be silently treated as satisfied |
| G11 | `ROUND_SEQUENCE` exact condition | "units must follow round sequence" admits several readings |
| G12 | `LOCKED_ASSIGNMENT_VIOLATION` and `STALE_OCCUPANT` triggers | Integrity refusals already block most lock violations at write time |
| G13 | Emission granularity and `conflictKey` uniqueness | Sort key 6 merges person and entrant ids, so two persons overlapping between the same two team entrants could produce equal keys; acknowledgement is by key |
| G14 | Report inputs omit facts the engine reads | The competition time zone (availability layers) and 05D target states (STALE) are not in the hashed inputs, so a report could stay "current" after they change |
| G15 | Codes with no declarative input in spec v1 | `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` would need invented thresholds |
| G16 | Invalid input vs conflict | Malformed state must never be reported as a scheduling conflict, nor a conflict as an error |

## Decision

The 05E-D engine is the pure function `evaluateSchedule(input) → ScheduleConflictReport` in `@br/competition` (scheduling). It implements ADR-0071 and ADR-0073 exactly, plus the decisions D1–D16 below. Everything not listed here is frozen by ADR-0066–0073 and is not reopened.

### D1 — Engine boundary and API (G1)

| Question | Frozen answer |
|---|---|
| Signature | `evaluateSchedule(input: ScheduleEvaluationInput): ScheduleConflictReport`. **No options argument** in v1: no check subsets, no severity overrides, no "fast mode". A caller can never obtain a report with narrower coverage than the engine's |
| Validator identity | `{ id: 'br:schedule-conflict-engine', version: 1 }`. Any semantic change to a rule bumps `version` |
| Coverage | Every code of ADR-0071 + ADR-0073 **except** `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` (D15). It is a superset of the baseline's coverage |
| Purity | No database, clock, randomness, environment, locale or I/O. Input is plain data; output is the canonical report (`canonicalScheduleReport` applied) |
| Read-only | The engine never modifies its input, never writes, never publishes, never proposes. It creates no persisted report; persistence stays 05E-C's `schedule_publication` at publication only |
| Who calls it | 05E-C's `ScheduleStore` loader (`validate` and `publish`, one shared code path), and later 05E-E for previews. There is exactly **one validator in force**: once 05E-D lands it replaces the baseline at that single call site. No route, request field or configuration selects a validator |
| Who loads inputs | The persistence loader, server-side, inside the same transaction as the command (I-B1.1). The engine never trusts a value supplied by a client (§ D14) |
| Baseline after 05E-D | `baselineScheduleReport` stays in the code base only as the historical validator of earlier publications (their recorded `validator` and `coverage` remain honest). It is not called by any command |

### D2 — Evaluation input (G1, G14)

`ScheduleEvaluationInput` (field names are implementation detail; the content is frozen):

| Part | Content | Source |
|---|---|---|
| Competition | id; **time zone** (the zone the competition availability layer and zone-less resources use) | `competition_profile` (default `UTC` exactly as `resource-store.ts` resolves it) |
| Version | schedule version id; every current fact id (watermark, removals included); the live (non-removed) assignments; the **base PUBLISHED version's** live assignments (for D12) | `v_schedule_assignment_current` |
| Assignment | fact id, contest id, resource id?, start, expected end?, changeover seconds, recorded unit key?, provisional, locked | 05E-C |
| Contest | id, event, round (id, sequence, dynamic?), stage (id, partition method), contest type, round type, stage primitive, plan sequence, partition key, status | plan (05B) + 05D materialization |
| Places | per contest: place number, source kind, **05D target state** (`UNRESOLVED/RESOLVED/VACANT/STALE/OVERRIDDEN`, or `FIXED` for `PARTICIPANT` slots and field entries), current occupant id?, current fact id?, and the feeder references (source contest, source stage/group, source transition) | 05B contestants + `contest_entry` + `AdvancementStore.compute` |
| Plan edges | per dependent contest, the set of feeder contests, exactly as 05D's structure defines them (slot sources, transitions, dynamic-round source) | 05D structure — never re-derived by 05E-D |
| Entrants | participant id, kind (`INDIVIDUAL`/`TEAM`), persons (the athlete; or the frozen roster athletes) | `participant`, `participant_roster_member` |
| Events | id, time zone, window (event, else competition), pinned profile version id + spec hash + spec, or none | as in today's loader |
| Resources | current revision: resource id, revision id, type, `occupancyMode`, capacity, exclusivity keys, resolved zone, status | `v_resource_current` |
| Availability | per resource and competition-wide: the current facts (with ids) | `v_resource_availability_current` |

**Report inputs (hashed).** The report must record every input the engine reads. Two are missing from the 05E-C contract and are added **additively** (D13): the competition time zone, and an occupancy digest whose rows include the 05D target state and current fact id of every place (not only the occupant). Everything else the engine reads is already identified by a recorded id (schedule version → base version and content; revision ids → mode, capacity, keys, zone, status; availability fact ids; profile version id + spec hash; contest statuses, which also enumerate materialized contests) or is immutable after field lock (plan, rosters, fixed entries).

### D3 — Instants and intervals (G3)

| Rule | Frozen answer |
|---|---|
| Arithmetic | Epoch **milliseconds**, exact, using `resources/interval.ts`. No rounding before judgment |
| Occupancy O | `[start, expectedEnd)`. Undefined when `expectedEnd` is null |
| Blocking B | `[start, expectedEnd + changeover)` on an EXCLUSIVE resource; `O` on a SHARED resource (ADR-0073 I-B3.1). Computed, never stored |
| Overlap | `a.start < b.end && b.start < a.end`. Touching intervals (`a.end = b.start`) never overlap. An empty interval overlaps nothing |
| Same instant | Equal milliseconds. New placements are whole seconds (05E-C), so this is equal seconds for every non-legacy fact |
| Report anchoring | `interval` = the earliest involved blocking interval (I-B7.2), converted with `floor(ms / 1000)` for start and end, as the baseline does. Rounding affects only how the report displays an instant, never a verdict |
| Missing end | The assignment yields `INCOMPLETE_ASSIGNMENT` (reason `expectedEnd`). Every check that needs `O` or `B` skips that assignment: R1–R4, availability, the window's end bound, participant overlap, rest (as either appearance) and dependency (as a feeder). Checks that need only the start still run: start events (B4), the window's start bound, daily limits, round sequence, and dependency as the dependent |

### D4 — Judged population (G2)

| Contest status | Claims, appearances, counts | Conflicts reported |
|---|---|---|
| `CANCELLED`, `VOID` | **Excluded entirely**: no claim, no participant appearance, no daily count, imposes no dependency constraint as a feeder | None |
| `PLANNED`, `SCHEDULED` (*unsettled*) | Included | Yes |
| `IN_PROGRESS`, `COMPLETED` (*settled*) | Included as **context**: they occupy resources and persons, count for daily limits, and constrain unsettled contests | Only when **at least one involved contest is unsettled**, except `LOCKED_ASSIGNMENT_VIOLATION` (D12) |

A `COMPLETED` feeder imposes no `DEPENDENCY_ORDER` constraint (its result exists). An `IN_PROGRESS` feeder does (its expected end still bounds the dependent).

Removed facts (`removed = true`) are excluded from every check but their ids stay in the watermark.

### D5 — Scheduling units (G4)

1. The engine **recomputes** every contest's unit key with 05E-C's `deriveUnitKeys` over the input plan, 05D and profile data. The recomputed key is authoritative for every rule.
2. A recorded key that is NULL (migrated or carried-from-migrated facts) is not a conflict.
3. A recorded key that differs from the recomputed one is `UNIT_SPLIT` (reason `unit-key`). A STALE place additionally yields `STALE_OCCUPANT` (D12); the two are independent.
4. The unit's start is the **earliest** start among its scheduled members.
5. `UNIT_SPLIT` (HARD, one conflict per unit, `actual` = its sorted reasons joined by `,`) has exactly four reasons:
   - `start`: scheduled members do not all share one start instant;
   - `shared-multi-resource`: members use more than one resource and at least one of them is SHARED (ADR-0073 B9);
   - `unit-key`: rule 3;
   - `unscheduled-member`: a member contest that is neither CANCELLED/VOID nor entirely VACANT has no live assignment while another member has one.
6. A unit's requirement is its members' requirement (identical by construction, ADR-0073 B9).

### D6 — Resource occupancy (G5, G6)

ADR-0073 R1–R5 apply exactly, with these clarifications:

| Rule | Clarification |
|---|---|
| Mode | Only the stored `occupancyMode` of the resource revision in force. Never capacity, never a profile parameter, never the type table (I-B2.1). The prompt-era rule "SHARED iff the requirement has spacing or concurrency" was ADR-0073's **rejected** first draft and is not implemented |
| Consumption `n` | `CONTEST` → 1. `ENTRANT` → the number of the contest's places whose state is not `VACANT` (fixed, resolved, overridden-with-occupant, unresolved and STALE places all count: capacity counts places, never possible occupants, ADR-0073 B8) |
| No governing requirement | A claim in an event without a pinned profile has unknown `n`. R1 and R4 (which need no `n`) still apply and R5 has nothing to compare; **R2 and R3 skip that claim**, and the assignment yields `INCOMPLETE_ASSIGNMENT` (reason `consumption`). Nothing invents a consumption |
| R2 sweep | At every instant (half-open boundaries): Σ `n` over SHARED claims whose `B` contains the instant ≤ capacity |
| **R4, same unit (extension)** | R4 also applies between claims **of the same unit** on two **different** resources that `sharesSpace`. A unit occupying lane pairs `{lane-11, lane-12}` and `{lane-12, lane-13}` at once uses lane 12 twice. Same-unit claims on **one** EXCLUSIVE resource still coexist (R1, R3) |
| Changeover | The releasing claim's stored `changeover_seconds` (I-B3.2). It extends `B` on EXCLUSIVE resources and therefore propagates to key siblings through R4. It never enters participant time, dependency gaps or rest |
| Availability window vs changeover | Availability is judged on `B` (ADR-0073 B5). A last unit whose changeover runs past closing time is `RESOURCE_UNAVAILABLE`; the organizer resolves it by storing a smaller changeover with a reason on that assignment (ADR-0072 §4). No rule change |

### D7 — Start events (B4)

ADR-0073 B4 applies exactly. Clarifications:

- A start event is `(unit, resource, instant)`. A unit split across instants (reason `start`) yields one event per distinct instant; pairs of events of the **same unit** are never compared with each other.
- Spacing: for consecutive distinct slots `t1 < t2` on one SHARED resource, `t2 − t1 ≥ max(startSpacingSeconds)` over the units of both slots; absent = 0. Example: A requires 300 s, B 600 s, C 900 s at 08:00, 08:10, 08:25 is valid (gaps 600 ≥ max(300, 600), 900 ≥ max(600, 900)). Checking consecutive slots suffices because gaps add and every pair's requirement is bounded by the adjacent ones.
- Concurrency: at slot `t`, distinct units ≤ `min(concurrentStarts)` over those units; a requirement without the field contributes its canonical default 1.
- A unit **without a governing requirement** contributes no spacing and no concurrency bound. If no unit of a slot has a requirement, the slot has no concurrency limit.
- Ordering inside a slot is the frozen tuple of I-B4.3.

### D8 — Availability classification (G7)

For one claim on resource R with blocking interval `B`:

1. If R's revision is `RETIRED`, all of `B` is **closed**.
2. **Closed part** = `B − effectiveAvailability(R, B)` (05E-A, unchanged). Non-empty → `RESOURCE_UNAVAILABLE` (HARD), one per assignment.
3. **Declared part.** A layer (resource, competition) *declares* time as follows, in that layer's zone:
   - a layer with **at least one WEEKLY fact** declares **all** time (05E-A then governs every date by its weekly rules, including dates where no window applies or the validity range has ended — such time is closed, not unrestricted);
   - otherwise the layer declares exactly the local days (`[d 00:00, d+1 00:00)`, converted by ADR-0068's recurring rule) of the dates that carry a `DATE_OPEN` fact.
   The declared set is the union of both layers' declarations.
4. **Undeclared part** = `(B ∩ effectiveAvailability) − declared`. Non-empty → `AVAILABILITY_UNDECLARED` (SOFT), one per assignment.
5. Both may be reported for one assignment (distinct codes, distinct keys).
6. A time-only assignment (no resource) has no availability evaluation; its gap is `INCOMPLETE_ASSIGNMENT` where the profile requires a resource.
7. Crossing midnight and DST are handled only by 05E-A's `zoned.ts` and the interval primitives; the engine never computes local dates itself.

### D9 — Event window

Unchanged from the baseline: `start < windowStart` or `O.end > windowEnd` → `OUTSIDE_EVENT_WINDOW` (HARD), window = the event's, else the competition's; a null bound is not evaluated (ADR-0073 B5). An assignment without an end is checked on its start only.

### D10 — Participants (G8, G9)

**Identity.** Entrant = participant id. Persons = the athlete (`INDIVIDUAL`) or the frozen roster's athletes (`TEAM`, ADR-0057). Declared lineups are **not** used in v1: the roster is the conservative superset, deterministic before lineups exist.

**Appearances.** For each live assignment of a non-excluded contest and each place, the occupant set:

| Place | Occupants | Certainty |
|---|---|---|
| `PARTICIPANT` slot or field entry | that entrant | CERTAIN |
| 05D `RESOLVED`, or `OVERRIDDEN` with an occupant | that entrant | CERTAIN |
| `VACANT`, or `OVERRIDDEN` with no occupant | nobody | — |
| `UNRESOLVED` or `STALE` | the **full transitive closure** of possible occupants over the plan graph (ADR-0073 B8 table), computed with a visited set | POSSIBLE |

**Same-round rule (new).** One entrant occupies at most one place of one round (05B plan, 05D's "already placed in the same round / field" refusal). Therefore:
- two appearances in the **same round** of the same event are compared for overlap only when **both are CERTAIN**, and never for rest;
- for daily limits, an entrant's appearances in one round count **once per local date** on which any of them starts.

**Overlap** (on `O`, competition-wide, ADR-0071 §2):
- `TEAM_OVERLAP` when the shared identity is a **team entrant** appearing in both contests. Fields: `entrantIds = [team]`, no `personIds`.
- `PARTICIPANT_OVERLAP` when the shared identity is a **person** not explained by one common team entrant (an individual entrant, or an athlete appearing through two different entrants). Fields: `personIds = [person]`, no `entrantIds`.
- One conflict per (identity, unordered assignment pair). Certainty POSSIBLE if either appearance is POSSIBLE.

**Rest** (per person, ADR-0073 B8). For an appearance `a2` whose requirement declares `rest`: its predecessor `a1` is the person's appearance in a **different round** (or another event) with `O.end(a1) ≤ start(a2)` and the **latest** `O.end`; ties prefer CERTAIN, then the frozen contest order. Violation iff `start(a2) − O.end(a1) < rest(a2).minimumSeconds`. For certain-only sequences this is exactly "consecutive units". Overlapping appearances are not rest-checked (overlap already reports them). Severity = `rest.enforcement`; `expected` = required seconds, `actual` = gap seconds; `personIds = [person]`.

**Daily limit** (ADR-0073 B6, unchanged key). Count = distinct units per (event, entrant, requirement, local date of the unit start in the event zone), with the same-round collapse. Certainty is CERTAIN iff the CERTAIN appearances alone exceed the limit. Severity = the limit's `enforcement`; `expected` = limit, `actual` = count; `entrantIds = [entrant]`.

### D11 — Dependencies and round sequence (G10, G11)

**`DEPENDENCY_ORDER` (HARD).** For each dependent contest D with a live assignment and a defined start, over its feeders F (D2 plan edges) that are not CANCELLED, VOID or COMPLETED:
- feeders with `O` defined: `required = max(O.end(f)) + dependencyLeadSeconds(D's requirement, absent or no profile = 0)`; `start(D) < required` → one conflict per dependent, `contestIds`/`assignmentIds` = D and the violating feeders, `expected` = `required` (epoch s), `actual` = `start(D)` (epoch s). Changeover is never added (ADR-0073 B8). Certainty CERTAIN: edges are plan structure, not occupants;
- feeders with a live assignment but no end: skipped (they carry their own `INCOMPLETE_ASSIGNMENT`);
- feeders with **no live assignment** in the evaluated version: the dependent yields `INCOMPLETE_ASSIGNMENT` (reason `feeder`, feeder contest ids in `contestIds`). Missing order information is never treated as satisfied, and never invented as a violation.

Dependency lead and rest are independent lower bounds and are never summed (ADR-0073 B8).

**`ROUND_SEQUENCE` (SOFT).** Per entrant, per stage, over the rounds in which the entrant has **CERTAIN** appearances, ordered by round sequence: for consecutive such rounds `r < r'`, violation iff `start(r') < O.end(r)` (or `start(r') < start(r)` when `O(r)` is undefined). Possible appearances are excluded: rounds whose field is unresolved are dynamic rounds and already have plan edges (`DEPENDENCY_ORDER`). `entrantIds = [entrant]`, CERTAIN.

### D12 — Staleness and locks (G12)

- **`STALE_OCCUPANT` (HARD)**: an unsettled contest with a live assignment where any place it reads is STALE (its own dependent slot, the transition field place its `QUALIFIER` slot reads, or its dynamic round's field) — the same scope as 05D's start guard (`contestBlockers`). One per assignment, CERTAIN.
- **`LOCKED_ASSIGNMENT_VIOLATION` (HARD)**: a settled contest (`IN_PROGRESS`, `COMPLETED`) whose live placement in the evaluated version (resource, start, expected end, changeover, or presence) differs from its live placement in the **base PUBLISHED version**. This is the case 05E-C's write-time refusal cannot see: a contest moved in the draft and started afterwards under the published schedule. An explicit unlock gives no exemption: an unlocked assignment of a settled contest is judged exactly like any other (amended by ONCF-05E-F-6, below). One per assignment.

**D12 amendment — explicit unlock and moved-then-started contests** (ONCF-05E-F-6, findings C-1 and G-8):

- **Why it was needed.** The original text ended with: "Explicitly unlocked assignments are legitimate moves and are not violations." The engine never applied that exemption, and its input has no data to apply it with: D2 gives it live placements, not lock or unlock history. The written rule and the engine therefore disagreed (ONCF-05E-F-5, C-1). The sentence is withdrawn; the engine behaviour already matches the amended text.
- **Two separate questions.**

  | Question | Decided by | When |
  |---|---|---|
  | 1. May this assignment be edited manually? | The lock flag (ADR-0070 §8) and the contest's status (05E-C write-time refusals) | When the edit is written |
  | 2. Can the resulting draft be published? | This engine (D12, D15), over live placements only | At validation and publication |

  - **Lock** blocks ordinary manual moves of the assignment.
  - **Unlock** (with a reason, ADR-0070 §8) allows a later manual edit of that assignment.
  - Neither answers question 2. Lock state is **not an input** to `LOCKED_ASSIGNMENT_VIOLATION`.
- **The rule.** A settled contest (`IN_PROGRESS`, `COMPLETED`) is always compared with its live placement in the base PUBLISHED version. Unlocking, moving or locking it again, in any order and at any time, never removes it from that comparison. An unlocked assignment whose contest then settles under a different published placement **is** a `LOCKED_ASSIGNMENT_VIOLATION`.
- **The rule does not reach** unsettled contests. Their draft placements are never compared with the base, whatever their lock state. For them, unlock simply permits the edit.
- **Moved-then-started contests (G-8).** The scenario:
  1. contest X has published assignment A;
  2. an organizer moves X to B in the draft;
  3. X starts under A;
  4. the draft is now unpublishable (`LOCKED_ASSIGNMENT_VIOLATION`, HARD);
  5. X can no longer be edited, because a started contest is immutable for scheduling (`CONTEST_STARTED_OR_CLOSED`, 05E-C § 3; ADR-0070 §8 as amended).

  This is an **intended, hard publication boundary**. Once a contest has started, its published assignment is the operational truth. No draft may weaken that, and no command may edit a started contest to make a draft publishable again.
- **Recovery in v1.** Use the existing ADR-0070 commands:
  1. discard the conflicting draft (`DRAFT → DISCARDED`, with a reason);
  2. open a new draft. It is based on the current PUBLISHED version and carries the started contest's published placement unchanged (05E-C § 3, `openDraft`).

  The organizer then redoes the other draft edits that are still wanted. Losing those edits is a known v1 cost. **No repair command exists, and none may be added** without a new ADR that preserves this rule.
- **What it leaves unchanged.** The code, its severity, its scope (settled contests only), one conflict per assignment, the D4 exception and D13's field usage. No report-contract change, no new input, no engine change, no migration.

### D13 — Report contract and emission (G13, G14)

**Contract.** 05E-C's report contract is kept: shape, codes, severities, canonical form, seven-key order, `conflictKey`, hash, no timestamp. One **additive** revision, `reportVersion: 2`, is authorized by this ADR and implemented in 05E-D:
- `inputs.competitionTimezone` (string);
- the occupancy digest's rows become `(contestId, place, sourceKind, targetState, occupantId | '', currentFactId | '')`, sorted, under a new digest schema id.

Version-1 reports already stored in `schedule_publication` stay valid: they are verified against their own recorded content and hash, never recomputed.

**No `evaluatedAt`.** The canonical report and its hash contain no wall-clock value. The time a report was produced is metadata of the act that used it (`schedule_publication.recorded_at`, the audit event, the HTTP response), never hash material.

**Field usage.** All explanation fits the existing fields; there is no free-form `details` payload in v1:

| Code | One conflict per | `resourceIds` | Identity fields | `requirement` | `expected` / `actual` |
|---|---|---|---|---|---|
| `RESOURCE_OVERLAP` | resource × unordered unit pair | [R] | — | — | — |
| `EXCLUSIVITY_CONFLICT` | unordered resource pair × unordered unit pair (or one unit, D6) | [R, R'] | — | — | — |
| `CAPACITY_EXCEEDED` (R2) | SHARED resource × maximal over-capacity interval | [R] | — | — | capacity / peak Σn; `consumption` per claim |
| `CAPACITY_EXCEEDED` (R3) | EXCLUSIVE resource × unit | [R] | — | — | capacity / Σn; `consumption` |
| `RESOURCE_TYPE_MISMATCH` | assignment | [R] | — | yes | required type / actual type |
| `RESOURCE_UNAVAILABLE` | assignment | [R] | — | — | — / closed seconds |
| `AVAILABILITY_UNDECLARED` | assignment | [R] | — | — | — / undeclared seconds |
| `START_SPACING` | SHARED resource × consecutive slot pair | [R] | — | governing (max) | required s / actual s |
| `CONCURRENT_STARTS_EXCEEDED` | SHARED resource × slot | [R] | — | governing (min) | limit / units |
| `UNIT_SPLIT` | unit | all used | — | — | — / sorted reasons |
| `PARTICIPANT_OVERLAP` | person × assignment pair | — | `personIds=[p]` | — | — |
| `TEAM_OVERLAP` | team entrant × assignment pair | — | `entrantIds=[t]` | — | — |
| `SHORT_REST` | person × appearance | — | `personIds=[p]` | later unit's | required s / gap s |
| `DEPENDENCY_ORDER` | dependent assignment | — | — | dependent's | earliest start / start (epoch s) |
| `ROUND_SEQUENCE` | entrant × consecutive round pair | — | `entrantIds=[e]` | — | — |
| `MAX_CONTESTS_PER_DAY` | entrant × requirement × local date | — | `entrantIds=[e]` | the limit's | limit / count (the date is identified by the counted units and the anchoring interval) |
| `INCOMPLETE_ASSIGNMENT` | assignment | as stored | — | if resolvable | — / sorted reasons from {`consumption`, `expectedEnd`, `feeder`, `resource`} joined by `,` |
| `OUTSIDE_EVENT_WINDOW` | assignment | as stored | — | — | — |
| `STALE_OCCUPANT` | assignment | as stored | — | — | — |
| `LOCKED_ASSIGNMENT_VIOLATION` | assignment | as stored | — | — | — |

**Key uniqueness invariant.** Within one report no two conflicts share a `conflictKey`. Each participant conflict carries exactly one identity (person *or* entrant), which makes sort key 6 unambiguous. The engine asserts this invariant and treats a violation as an engine defect (D16), never as two acknowledgeable conflicts.

### D14 — Trust boundary

Every input of D2 is loaded server-side from canonical state inside the command's transaction. A client supplies only identifiers and the publication confirmation (`versionId`, `baseVersionId`, `reportHash`, acknowledged keys); the server recomputes the report and compares. Client-provided conflicts, coverage, profile hashes, capacities, modes, occupants, assignment status or unit keys are never accepted. Organizer-adjustable values (expected end, changeover) are trusted only as **stored assignment facts** written through 05E-C's authorized, reasoned, audited commands.

### D15 — Hard / soft and coverage

- **Feasible** ⇔ zero HARD conflicts in a report whose validator is the 05E-D engine. SOFT conflicts never make a schedule infeasible; they stay in the report and must be acknowledged at publication (unchanged).
- Fixed severities: ADR-0071 + ADR-0073 table, unchanged. `SHORT_REST` and `MAX_CONTESTS_PER_DAY` take the requirement's enforcement. `INCOMPLETE_ASSIGNMENT`, `AVAILABILITY_UNDECLARED`, `ROUND_SEQUENCE` are SOFT. `START_SPACING`, `CONCURRENT_STARTS_EXCEEDED`, `UNIT_SPLIT` are HARD. Certainty never changes severity (I-B8.2).
- `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` are **outside v1 coverage**: spec v1 declares no threshold for them, and an engine constant would violate ADR-0069 §3 ("no universal constants"). They enter coverage only with a profile spec version that declares their data.

### D16 — Invalid input vs conflicts

| Situation | Outcome |
|---|---|
| Valid state that violates a rule (overlap, capacity, spacing, rest, dependency, availability, daily limit, …) | A conflict in the report |
| Valid but incomplete state (no end, no resource where required, unscheduled feeder, unknown consumption) | `INCOMPLETE_ASSIGNMENT` (SOFT); unsupported checks skip that assignment |
| State that breaks a database or domain invariant: two current facts for one contest; an assignment for a contest or resource outside the competition or absent from the input; a resource revision without a valid mode; a pinned profile whose requirement resolution is `NO_MATCH` or `AMBIGUOUS` for a contest (pin-time validation forbids it); `expected_end ≤ start`; a cycle in the plan graph; a conflict-key collision | `ScheduleEvaluationError`, thrown; **no report**. The command fails as an internal error and nothing is published |

The engine never converts malformed data into a conflict and never hides a conflict behind an error.

## Relationship to ADRs 0066–0073

| ADR | Relationship |
|---|---|
| 0066–0070, 0072 | Unchanged |
| 0071 | Unchanged codes and split. D15 states which codes v1 covers. §3's "re-checked whenever occupants change" is realized by the occupancy digest (D13) making the report stale |
| 0073 | Applied as written. **Extensions:** R4 also binds claims of the same unit on two key-sharing resources (D6); `INCOMPLETE_ASSIGNMENT` gains the reasons `feeder` and `consumption` (D3, D6, D11); settled-only conflicts are not reported (D4); the same-round rule for possible occupants (D10). **Precisions:** B4 split units (D7); B5 declared-set algorithm (D8); B8 rest predecessor, TEAM vs PARTICIPANT overlap, roster over lineup (D10); B8 `ROUND_SEQUENCE` condition (D11); B9 key mismatch and unscheduled members as `UNIT_SPLIT` reasons (D5); B7 per-code emission and key uniqueness, and the additive `reportVersion: 2` inputs (D13) |
| 05E-C implementation | Report contract revised additively (D13) inside 05E-D. The baseline is retired from the command path (D1). No migration |

## Consequences

- One judge for validation, publication and (later) proposals; no caller can narrow coverage.
- Completed history can never block publication; a moved-then-started contest always does.
- Post-cut and other unresolved fields produce conservative but not absurd participant warnings.
- Reports become stale when 05D staleness or the competition time zone change, as they must.
- 05E-D touches three places: the pure engine (new), `report.ts` (additive v2 inputs) and the `ScheduleStore` loader (inputs, validator swap). No migration, no route and no response-shape change other than larger coverage and `reportVersion`.

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| `evaluate(schedule, options)` with selectable checks | A caller could publish with a narrower validator; coverage must be the engine's, not the caller's |
| Keep the baseline selectable after 05E-D | Two validators in force make feasibility depend on the call path |
| Report every conflict, including settled-only ones | Permanent, unclearable HARD conflicts on completed history |
| Ignore cancelled contests only for daily limits (ADR-0073 B6 literal) | A cancelled contest occupies no court and no athlete |
| Possible occupants compared within one round | One entrant cannot hold two places of a round; quadratic false warnings |
| Lineups as person identity | Not present before lineup declaration; roster is the deterministic superset |
| Unscheduled feeder = satisfied, or = `DEPENDENCY_ORDER` | Silent acceptance, or an invented violation that blocks partial drafts |
| A free `details` JSON per conflict | Unbounded, schema-less hash material; the existing typed fields suffice |
| `evaluatedAt` inside the report | Breaks byte-identical reproduction (I-B7.1) |
| Engine constants for long waits / under-use | ADR-0069 §3: values come only from the pinned profile |

## Frozen vs Deferred

**Frozen now:** D1–D16 (D12 as amended by ONCF-05E-F-6).

**Deferred to the 05E-D implementation:** TypeScript names of the input type and error class; the occupancy-digest schema id string; internal indexing (sweep lines, per-person indexes); possible-occupant caching; exact test file layout.

**Deferred beyond 05E-D:** lineup-based person identity; `LONG_WAIT` / `UNDERUSED_RESOURCE` / `SEQUENCING_INEFFICIENCY` (spec version); a `PERSON` capacity unit (ADR-0073 open question 1); persisted or content-addressed reports outside publication; 05E-E's use of the engine for previews (synthetic, unique assignment ids).

## Non-Goals

This ADR implements nothing. It adds no migration, route, UI, test or catalog row; it does not change 05E-C behaviour; it does not start 05E-D implementation or 05E-E; it does not edit ADRs 0066–0073.
