# ONCF-05E-D — Conflict / Feasibility Engine: architecture and readiness contract

| | |
|---|---|
| Status | **Architecture / readiness only (ONCF-05E-D-0).** No engine, migration, route or test exists yet |
| Baseline | `34f0ff8` (`main`, PR #10, ONCF-05E-C merged) |
| Contract | [ADR-0066](../adr/ADR-0066-scheduling-boundary-and-competition-scope.md) – [ADR-0073](../adr/ADR-0073-scheduling-semantics-clarifications-resource-occupancy-model.md) (unchanged) · **[ADR-0074](../adr/ADR-0074-conflict-feasibility-engine-v1-semantics.md)** (new, this audit) · [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) · [05E-A](./ONCF-05E-A-RESOURCES-AND-AVAILABILITY.md) · [05E-B](./ONCF-05E-B-SCHEDULING-PROFILE.md) · [05E-C](./ONCF-05E-C-SCHEDULE-VERSIONS.md) |
| Not in this phase | proposals (05E-E) · operations API (05E-F) · organizer UI (05E-G) · public UI (05E-H) |

Decisions are cited as **ADR-0073 Bx / Rx / I-Bx.y** and **ADR-0074 Dx**. This document explains them for implementers; where it and an ADR differ, the ADR wins.

## 1. Objective

Answer one question, deterministically:

> Given the concrete content of one schedule version, and the competition state it refers to, is it feasible under the frozen scheduling semantics — and if not, which canonical conflicts explain why?

```
schedule version content  ─┐
plan · 05D states · rosters ├─▶  evaluateSchedule  ─▶  ScheduleConflictReport (canonical, hashed)
resources · availability    │                              ├── HARD conflicts  → infeasible
profiles · events · zones  ─┘                              └── SOFT conflicts  → visible, acknowledged at publication
```

05E-D is a **judge**. It never schedules, moves, optimizes, ranks, proposes, applies or publishes.

## 2. Scope

- The pure function `evaluateSchedule(input) → ScheduleConflictReport` in `@br/competition` (scheduling), validator `br:schedule-conflict-engine` v1 (D1).
- A pure DECLARED / UNRESTRICTED availability classifier next to `effectiveAvailability` (ADR-0073 I-B5.3, D8).
- Possible-occupant closure over the 05D plan graph (ADR-0073 B8, D10).
- The additive `reportVersion: 2` inputs (`competitionTimezone`, richer occupancy digest) in `report.ts` (D13).
- Replacing the baseline validator at the one call site inside `ScheduleStore`'s private `report()` loader, and loading the extra inputs there (D1, D2).

## 3. Non-goals

- Choosing resources or times; moving, splitting or merging units; ranking alternatives; generating or committing proposals (05E-E).
- Publication, its gate, authority, acknowledgement and persistence (05E-C, unchanged).
- Migrations, new routes, new permissions, UI.
- `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` (D15: no declarative input in spec v1).
- Lineup-based identity, travel time, cross-competition conflicts, solvers.

## 4. Architectural boundary

| Phase | Owns | Never |
|---|---|---|
| 05E-C (done) | Versions, drafts, assignments as facts, integrity refusals, unit key recorded at write, publication command and gate, `schedule_publication`, `contest_schedule` projection, **the report contract** | Judge feasibility |
| **05E-D** | Interpreting the concrete schedule; R1–R5; start events; availability classes; participant, rest, dependency, round-sequence, daily-limit, staleness and lock checks; the canonical report; feasibility | Write schedules; read the database (the engine); propose; publish |
| 05E-E | Candidate generation that satisfies 05E-D; preview hash; commit into the draft | Bypass or weaken 05E-D; publish |

Dependencies run C → D → E only (ADR-0073 B1). 05E-C depends on the report *type*, not on 05E-D code; the store loader is the only place that calls the engine.

### Audit findings on the boundary

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | **The occupancy rule stated in the ONCF-05E-D-0 brief ("SHARED iff the requirement sets start spacing or concurrent starts") is ADR-0073's rejected first draft.** The frozen and implemented rule is the declared resource `occupancyMode` | ADR-0073 B2 option (b) "Rejected on review", H2; `0037` `occupancy_mode`; `resource.ts` `OccupancyMode` | 05E-D reads only the stored per-revision mode (D6). No requirement-derived mode exists anywhere |
| F2 | The concurrency code is `CONCURRENT_STARTS_EXCEEDED`, not `CONCURRENT_STARTS` | `report.ts` | Use the implemented code |
| F3 | The report contract has no free `details` payload; ADR-0073 B7 deferred "details" to 05E-D but 05E-C's `canonicalConflict` rebuilds conflicts field by field | `report.ts` | All explanation fits existing typed fields (D13 table); no `details` |
| F4 | Sort key 6 is the smallest of `personIds ∪ entrantIds`, so two different persons overlapping between the same two team entrants could share a `conflictKey` | `report.ts` `participant` | Each participant conflict carries exactly one identity; key uniqueness asserted (D13) |
| F5 | The competition time zone (availability layer zone, default resource zone) is read but not in the hashed inputs, and is editable | `resource-store.ts`, `competition-store.ts` | Added additively (`reportVersion: 2`, D13) |
| F6 | The occupancy digest hashes `(contest, place, participant)` only; STALE is computed on read by `AdvancementStore` and is invisible to it; NULL conflates unresolved with decided-vacant | `schedule-store.ts`, `advancement-store.ts`, `0034` | Digest rows gain source kind, target state and current fact id (D13) |
| F7 | The baseline evaluates every live fact regardless of contest status, so a HARD conflict between settled contests could never be cleared | `assignment.ts` | Settled-only conflicts are not reported; cancelled/void contests are excluded (D4) |
| F8 | R4 binds only claims of *different* units | ADR-0073 B2 | Extended to the same unit on two key-sharing resources (D6) |
| F9 | Possible occupants inside one round would make every simultaneous place a POSSIBLE overlap | ADR-0073 B8 + `materialize` | Same-round rule (D10) |
| F10 | `CARRIED` copies of migrated rows may keep sub-second instants and NULL unit keys | `0037` CHECKs | Millisecond arithmetic, NULL key tolerated (D3, D5) |
| F11 | `OVERRIDDEN` is a 05D target state not listed in ADR-0073 B8's table | `advancement-store.ts` | Treated as CERTAIN occupant or VACANT (D10) |

None of these requires changing 05E-C behaviour now. F3–F6 are absorbed by ADR-0074 and implemented in 05E-D; F7 is a semantic refinement the 05E-D validator applies (the baseline remains the historical validator).

## 5. Inputs

The persistence loader builds `ScheduleEvaluationInput` server-side, in the command's transaction (ADR-0074 D2). The engine receives plain data:

| Group | Fields (content frozen; names implementation detail) |
|---|---|
| Competition | `competitionId`, `timeZone` |
| Version | `scheduleVersionId`, `watermark` (every current fact id), `assignments` (live), `baseAssignments` (live facts of the base PUBLISHED version) |
| Assignment | `id`, `contestId`, `resourceId?`, `startMs`, `expectedEndMs?`, `changeoverSeconds`, `recordedUnitKey?`, `provisional`, `locked` |
| Contest | `id`, `eventId`, `roundId`, `roundSequence`, `dynamic`, `stageId?`, `grouped`, `contestType`, `roundType`, `stagePrimitive?`, `sequence`, `partitionKey?`, `status` |
| Place | `contestId`, `place`, `sourceKind`, `state` (`FIXED · UNRESOLVED · RESOLVED · VACANT · STALE · OVERRIDDEN`), `occupantId?`, `factId?`, feeder reference |
| Edges | dependent contest → feeder contests (05D structure) |
| Entrant | `participantId`, `kind`, `personIds` (athlete or frozen roster) |
| Event | `eventId`, `timeZone`, `windowStartMs?`, `windowEndMs?`, `profile? {versionId, specHash, spec}` |
| Resource | `resourceId`, `revisionId`, `typeCode`, `occupancyMode`, `capacity`, `exclusivityKeys`, `zone` (resolved), `status` |
| Availability | resource-scoped and competition-wide current facts with ids |

**Where each value comes from.**

| Value | Loaded from | Never from |
|---|---|---|
| Occupancy mode, capacity, keys, status | `v_resource_current` (stored revision) | capacity, profile, type table, client |
| Interval, changeover, resource | stored assignment fact | profile recomputation, client at validate time |
| Requirement values | pinned profile version spec | event overrides (none exist), client |
| Occupants, states, edges | 05B plan + `AdvancementStore.compute` | 05E re-derivation |
| Persons | participant / frozen roster | lineups (v1), client |
| Zones | event / competition profile, resource revision | server or viewer zone |

## 6. Outputs

The 05E-C `ScheduleConflictReport`, canonicalized (`canonicalScheduleReport`), with `reportVersion: 2` (D13):

```
{ reportVersion: 2, competitionId, scheduleVersionId,
  assignmentIds,                       // watermark
  inputs: { events[], competitionTimezone, resourceRevisionIds, availabilityFactIds,
            occupancyDigest, contestStatuses },
  validator: { id: 'br:schedule-conflict-engine', version: 1 },
  coverage: [ ...19 codes ],           // ADR-0071 + ADR-0073 minus the three of D15
  conflicts: [ ...canonical, totally ordered ] }
```

Feasible ⇔ `reportVerdict(report).hard === 0` with this validator. There is no `feasible` boolean in the payload (derived, not stored) and no `evaluatedAt`.

## 7. Conflict taxonomy

| Code | Severity | Check group | Rule |
|---|---|---|---|
| `RESOURCE_OVERLAP` | HARD | RESOURCE_OVERLAP | R1 |
| `EXCLUSIVITY_CONFLICT` | HARD | RESOURCE_OVERLAP | R4 (+ same unit, D6) |
| `CAPACITY_EXCEEDED` | HARD | CAPACITY | R2 (SHARED), R3 (EXCLUSIVE) |
| `RESOURCE_TYPE_MISMATCH` | HARD | ASSIGNMENT_INTEGRITY | R5 |
| `RESOURCE_UNAVAILABLE` | HARD | RESOURCE_AVAILABILITY | B5 declared closure, RETIRED |
| `AVAILABILITY_UNDECLARED` | SOFT | RESOURCE_AVAILABILITY | B5 unrestricted |
| `START_SPACING` | HARD | START_SPACING | B4 |
| `CONCURRENT_STARTS_EXCEEDED` | HARD | CONCURRENT_STARTS | B4 |
| `UNIT_SPLIT` | HARD | UNITS | B9, D5 |
| `PARTICIPANT_OVERLAP` | HARD | PARTICIPANT_OVERLAP | ADR-0071 §2, D10 (person) |
| `TEAM_OVERLAP` | HARD | PARTICIPANT_OVERLAP | D10 (team entrant) |
| `SHORT_REST` | enforcement | REST | B8, D10 |
| `DEPENDENCY_ORDER` | HARD | DEPENDENCY | B8, D11 |
| `ROUND_SEQUENCE` | SOFT | ROUND_SEQUENCE | B8, D11 |
| `MAX_CONTESTS_PER_DAY` | enforcement | DAILY_LIMIT | B6, D10 |
| `OUTSIDE_EVENT_WINDOW` | HARD | EVENT_WINDOW | D9 |
| `STALE_OCCUPANT` | HARD | STALENESS | D12 |
| `LOCKED_ASSIGNMENT_VIOLATION` | HARD | LOCKS | D12 |
| `INCOMPLETE_ASSIGNMENT` | SOFT | ASSIGNMENT_COMPLETENESS | I-B8.3 + D3/D6/D11 reasons |
| `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` | SOFT | — | **not covered in v1** (D15) |

"Check groups" are documentation names. The report's `coverage` is, as frozen by 05E-C, the list of **codes** evaluated; a code in coverage means every rule producing it ran over every eligible subject. "CHANGEOVER" is not a separate check: changeover is part of `B` and therefore of R1, R4 and availability.

Per-code emission granularity and field usage: ADR-0074 D13 table.

## 8. Severity model

- Severity is fixed per code (`CONFLICT_SEVERITY`) except `SHORT_REST` and `MAX_CONTESTS_PER_DAY`, which take the governing requirement's `enforcement`.
- `certainty` (`CERTAIN` / `POSSIBLE`) is reported and never downgrades severity (I-B8.2). A POSSIBLE HARD conflict blocks publication.
- Answers requested by the brief, from ADR-0073 (not intuition): `INCOMPLETE_ASSIGNMENT` **SOFT**; `AVAILABILITY_UNDECLARED` **SOFT**; `ROUND_SEQUENCE` **SOFT**; `START_SPACING`, `CONCURRENT_STARTS_EXCEEDED` **HARD**; daily-limit violations take the limit's enforcement (HARD in the road, cycling and golf templates; SOFT in tennis, padel, basketball, golf matches).

## 9. Resource semantics

### 9.1 Interval model (D3)

All arithmetic is in exact epoch milliseconds on half-open intervals via `resources/interval.ts`:

```
O(a) = [start, expectedEnd)                          occupancy (participants, window, dependency)
B(a) = [start, expectedEnd + changeover)  if mode(R) = EXCLUSIVE
     = O(a)                               if mode(R) = SHARED
overlap(X, Y)  ⇔  X.start < Y.end ∧ Y.start < X.end       touching never overlaps
```

`expectedEnd` is the **stored** contest end; "blocked until" is computed (`blockingEnd`) and never persisted. No new field is needed.

### 9.2 Claims and rules

```
claim c = (assignment a, resource R, n, O, B)
n = 1                                   capacityUnit = CONTEST
  = #places of the contest not VACANT   capacityUnit = ENTRANT
  = unknown                             no governing requirement  → R2/R3 skip, INCOMPLETE(consumption)
```

| Rule | Condition for a conflict |
|---|---|
| R1 | Same EXCLUSIVE resource, different units, `overlap(B1, B2)` |
| R2 | SHARED resource, some instant where Σ n of claims whose B contains it > capacity |
| R3 | EXCLUSIVE resource, one unit, Σ n of its claims on R > capacity |
| R4 | R ≠ R′, `sharesSpace(R, R′)`, `overlap(B, B′)`, different units **or the same unit** (D6) |
| R5 | `typeCode(R) ≠ requirement.resourceType` |

### 9.3 Composite resources

| Question | Answer |
|---|---|
| Schedulable identity | The resource id (one per contest assignment, ADR-0073 B9) |
| Capacity | `capacity` of the revision: a fungible count; never an identity |
| Exclusivity key | Each of `exclusivityKeys`; two resources physically overlap iff `sharesSpace` |
| Overlap detection | Same resource → R1/R2/R3; different key-sharing resources → R4, always on blocking intervals |
| Shared unit consumption | Its claim's `n` adds to the instant sum (R2) |
| Exclusive blocking | Any other unit's claim on R, or any claim on a key sibling, during `B` |
| Two rows, same physical capacity | Yes: e.g. lane pairs 11–12 and 12–13, or a SHARED and an EXCLUSIVE twin of one course. Keys make them conflict (R4); capacity is never summed across rows |
| Sport knowledge needed | None: mode, capacity and keys are data |

### 9.4 Start spacing and concurrency (B4, D7)

Start event = (unit, resource, instant), SHARED resources only. Same instant = equal ms (whole seconds for new facts).

```
slots(R) = distinct start instants t1 < t2 < … on R
spacing:     ∀ consecutive (ti, ti+1):  ti+1 − ti ≥ max spacing over units in both slots   (absent = 0)
concurrency: ∀ ti:  #distinct units at ti ≤ min concurrentStarts over those units          (absent field = 1;
                                                                                             no requirement = no bound)
```

Example (brief): A 300 s, B 600 s, C 900 s. A 08:00, B 08:10, C 08:25 → valid. B at 08:05 → `START_SPACING` (300 < 600). A and B both at 08:00 with concurrency 1 → `CONCURRENT_STARTS_EXCEEDED`. Spacing and concurrency are per resource, never per exclusivity key, and independent of capacity (R2 still applies). Database order never orders a slot: the frozen tuple of I-B4.3 does.

### 9.5 Changeover (B3)

Belongs to the releasing assignment (stored `changeover_seconds`), extends `B` on EXCLUSIVE resources only, reaches key siblings through R4, has no effect on SHARED resources, never enters rest, lead or participant time. Availability is judged on `B`; an organizer can store a smaller changeover with a reason on a day's last unit (D6).

## 10. Participant semantics (D10)

| Question | Answer |
|---|---|
| Entrant | The event participant (individual or team); a team is one entrant |
| Member / person | An athlete: the individual's athlete, or a team's frozen roster athletes (ADR-0057) |
| Level of reasoning | **Both**: persons for overlap and rest (an athlete in two events is one person); entrants for daily limits and round sequence; team entrants for `TEAM_OVERLAP` |
| Team as one entrant | Always for counting (daily limits, consumption); persons only for overlap and rest |
| Possible occupants | Full transitive closure over the plan graph for UNRESOLVED/STALE places (ADR-0073 B8) |
| Closure | Recursive union over feeder places with a visited set; terminates at fixed, resolved, overridden or vacant places |

Checks: overlap on `O` (one conflict per identity × assignment pair; TEAM vs PARTICIPANT by identity); rest per person using the latest-ending earlier appearance in another round (equal to "consecutive units" for certain sequences); daily limit per (event, entrant, requirement, local start date) with the same-round collapse. Same-start contests overlap; zero-length or end-less appearances are skipped with `INCOMPLETE_ASSIGNMENT`.

**Rest arithmetic.** Previous `[sA, eA)`, next `[sB, eB)` of one person, `eA ≤ sB`: violation iff `sB − eA < rest(next).minimumSeconds`. Rest comes from the **later** unit's requirement, is HARD or SOFT by its enforcement, and is assignment-specific only through the stored intervals.

## 11. Group semantics

| Case | Unit key (05E-C `deriveUnitKeys`) | Common start enforced by |
|---|---|---|
| Ordinary contest | `contest:<id>` | — |
| Plan partition in a `GROUPED_ENTRANTS` stage | `partition:<round>:<key>` | `UNIT_SPLIT` (`start`) |
| Later non-dynamic round | `partition:<round>:<inherited key>` (same entrant's nearest earlier key) | same |
| Dynamic round with profile `regrouping` | `regroup:<round>:<n>` (blocks over 05D ordinals) | same |
| Dynamic round without regrouping | `contest:<id>` | — |

The engine recomputes keys; recorded ≠ recomputed is `UNIT_SPLIT` (`unit-key`); a NULL recorded key (legacy) is accepted. Membership comes only from plan partition keys, plan slots, 05D ordinals and the profile — never names or sport identity. A unit may span several resources only if all are EXCLUSIVE.

## 12. Dependency semantics (D11)

| Item | Rule |
|---|---|
| Edge source | 05D's structure: winner/loser slots, rank/best-ranked stage sources, qualifier transitions, dynamic-round source |
| Predecessor completion | Feeder's stored `O.end` |
| Required lead | Dependent's requirement `dependencyLeadSeconds` (absent / no profile = 0); never + changeover, never + rest |
| Condition | `start(D) ≥ max feeder O.end + lead`, else `DEPENDENCY_ORDER` (HARD, CERTAIN) |
| Completed / cancelled / void feeder | No constraint |
| Unscheduled feeder | `INCOMPLETE_ASSIGNMENT` (`feeder`) on the dependent |
| Possible occupants | Do not affect the edge (structure, not occupants); they affect participant checks only |

Examples: tennis final at 15:00 with semifinals expected to end 14:40, lead 900 s → required 14:55, valid; final at 14:50 → `DEPENDENCY_ORDER` (expected 14:55, actual 14:50). Bowling stepladder match 2 depends on match 1 by a WINNER edge with lead 300 s.

**Round sequence** (no edges, e.g. golf round 2, bowling block 2): per entrant and stage, consecutive rounds with certain appearances, violation iff `start(r′) < O.end(r)` → `ROUND_SEQUENCE` (SOFT). An unscheduled predecessor round is simply not one of the entrant's appearances; incomplete brackets have plan edges and are handled by dependency.

## 13. Availability semantics (D8)

```
closed     = B − effectiveAvailability(R, B)                 → RESOURCE_UNAVAILABLE (HARD)
declared   = ⋃ layers: all time if the layer has ≥ 1 WEEKLY fact,
                       else the local days of its DATE_OPEN dates (layer zone)
undeclared = (B ∩ effectiveAvailability(R, B)) − declared   → AVAILABILITY_UNDECLARED (SOFT)
```

| Case | Result |
|---|---|
| Inside a weekly window | Nothing |
| Outside the weekly windows of a weekly-ruled layer | `RESOURCE_UNAVAILABLE` |
| `DATE_CLOSED`, blackout, maintenance | `RESOURCE_UNAVAILABLE` |
| `DATE_OPEN` exception on a date | Its windows replace weekly ones (05E-A); inside → nothing |
| `RETIRED` resource | `RESOURCE_UNAVAILABLE` for all of `B` |
| No layer declares anything for the time | `AVAILABILITY_UNDECLARED` — never treated as open |
| Crossing midnight / DST | 05E-A `zoned.ts` and the recurring rule (ADR-0068); the engine never computes local dates itself |

## 14. Daily-limit semantics (ADR-0073 B6, D10)

Count distinct units per (event, entrant, requirement, local date of the **unit start** in the **event** zone), in the evaluated version only, excluding cancelled/void; a multi-contest unit counts once per entrant in it; a unit crossing midnight counts on its start date; an entrant's appearances within one round count once per date. Violation when the count exceeds `value`; severity = `enforcement`; CERTAIN iff certain appearances alone exceed.

## 15. Possible-occupant semantics

| Place state | Occupants | Certainty |
|---|---|---|
| FIXED (plan slot, field entry) | the entrant | CERTAIN |
| RESOLVED, OVERRIDDEN with occupant | the entrant | CERTAIN |
| VACANT, OVERRIDDEN without occupant | nobody | — |
| UNRESOLVED (incl. HELD ties), STALE | closure over feeders | POSSIBLE |

Guaranteed predecessor/successor = a CERTAIN appearance in an earlier/later unit; possible predecessor/successor = a POSSIBLE one. Possible occupants feed overlap, rest and daily limits only — never capacity. Same-round pairs are compared only when both CERTAIN. Uncertainty is never collapsed into certainty and never dropped.

## 16. Determinism

No result depends on row order, insertion order, UUID generation, process timing, `Map`/object iteration, concurrency, current time, environment, locale or Node version. Every internal collection is sorted by an explicit key before iteration:

| Collection | Order |
|---|---|
| Assignments | contest id (UTF-16), then fact id |
| Contests | event id, stage sequence, round sequence, plan `sequence`, contest id |
| Units | event id, stage sequence, round sequence, lowest member sequence, unit key (I-B4.3 tuple) |
| Resources | resource id |
| Persons / entrants | id |
| Start slots | resource id, instant, then the I-B4.3 tuple inside the slot |
| Checks | fixed order of D-sections; irrelevant to the output, which is re-sorted |
| Conflicts | the frozen seven-key order (ADR-0073 B7) with full-content JCS as final tie-break (`compareConflicts`) |

Comparisons use `compareUtf16` (code-unit order, locale-free), never `localeCompare`. All numbers are safe integers.

## 17. Canonicalization

`canonicalScheduleReport` (05E-C) is the only canonicalizer: de-duplicated, sorted lists; absent optionals omitted (JCS has no null); pairwise conflicts collapse (A/B = B/A); inputs sorted; coverage sorted. 05E-D adds the two `reportVersion: 2` input members and nothing else.

## 18. Hashing

`reportHash = SHA-256(preimage('br:schedule-conflict-report', JCS(canonical report)))` (RFC 8785, ADR-0014), unchanged.

| Hashed | Not hashed |
|---|---|
| Schedule version id; every current assignment fact id (immutable facts: the id determines the content) | Wall-clock evaluation time |
| Per event: profile version id, spec hash, time zone, window | Row order, query order |
| Competition time zone (v2) | Labels-only display text not read by rules (it changes a revision id only when a new resource revision is written — a deliberate, safe over-approximation) |
| Resource revision ids; availability fact ids | Database sequence numbers, `recorded_at` |
| Occupancy digest (place, source kind, state, occupant, fact id) (v2) | Actor ids |
| Contest statuses | |
| Validator id + version; coverage; conflicts | |

Properties: same semantic input → same hash; any change to a judged input → new hash (and `REPORT_STALE` at publication); reordered rows or arrays → same hash; a different evaluation time → same hash. The hash is **identity-bound** (it names the version and fact ids it judged), as ADR-0073 B7 requires; two versions with equal content have different report hashes by design.

## 19. Publication integration

```
Draft (05E-C) ──validate──▶ loader ──▶ evaluateSchedule (05E-D) ──▶ report + hash
                                                                        │
publish {baseVersionId, reportHash, ackKeys} ──▶ loader ──▶ evaluateSchedule ──▶ same hash? zero HARD? acks exact?
                                                                        │
                                                         PUBLISHED (05E-C), report + coverage recorded
```

- 05E-C calls 05E-D through its loader; 05E-D never calls 05E-C. No cycle.
- 05E-D is **not optional** once merged: it replaces the baseline at the single call site; there is no flag (D1).
- The "minimum validator" in 05E-C after 05E-D is the set of write-time integrity refusals (unknown/cross-competition contest or resource, retired resource, malformed or non-whole-second instants, locks, reasons). The baseline function remains only as the historical validator id of earlier publications.
- Coverage is the report's `coverage` (codes) plus `validator`; publications made before 05E-D keep their three-code coverage.
- Publication gate, authority, acknowledgement and idempotency: unchanged (ADR-0073 B1).

## 20. Test matrix

All engine tests are pure unit/property tests in `@br/competition`; integration tests cover the loader and the publication path.

| Area | Case | Expected |
|---|---|---|
| Resource | Two units, one EXCLUSIVE court, overlapping B | `RESOURCE_OVERLAP` once (A/B = B/A) |
| | Touching `[9,10)` + `[10,11)` with changeover 0 | Nothing |
| | Second unit starts inside the first's changeover | `RESOURCE_OVERLAP` |
| | Full court vs half court overlapping | `EXCLUSIVITY_CONFLICT`; full court's changeover blocks both halves |
| | One squad on pairs `{11,12}` and `{12,13}` | `EXCLUSIVITY_CONFLICT` (same unit, D6) |
| | Squad of 5 on a 4-seat EXCLUSIVE pair | `CAPACITY_EXCEEDED` (R3) with consumption |
| | Profile-less claim on SHARED course | R2 skips it; `INCOMPLETE_ASSIGNMENT` (`consumption`) |
| | Mode read from revision, capacity varied | Verdict independent of capacity for exclusivity |
| Shared | Waves 900 s apart, concurrency 1 | Nothing |
| | Waves 600 s apart | `START_SPACING` (900 / 600) |
| | Two tee groups at one instant, concurrency 2 | Nothing; three → `CONCURRENT_STARTS_EXCEEDED` |
| | Mixed 300/600/900 spacing | Max-of-adjacent rule (§ 9.4 example) |
| | Spacing ok but players on course > capacity | `CAPACITY_EXCEEDED` (R2) only |
| | Spacing on an EXCLUSIVE resource | No start-event conflict |
| | Changeover on SHARED | No effect |
| Availability | Inside weekly window | Nothing |
| | Outside weekly window | `RESOURCE_UNAVAILABLE` |
| | DATE_CLOSED; blackout; maintenance | `RESOURCE_UNAVAILABLE` |
| | DATE_OPEN on an otherwise unruled layer | Inside → nothing; next day → `AVAILABILITY_UNDECLARED` |
| | Retired after assignment | `RESOURCE_UNAVAILABLE` |
| | No facts at all | `AVAILABILITY_UNDECLARED`, never open |
| | Midnight-crossing window; spring-forward; fall-back; Costa Rica | Same results as 05E-A expansion |
| | Changeover past closing | `RESOURCE_UNAVAILABLE`; changeover 0 stored → nothing |
| Participants | Athlete in two events at once | `PARTICIPANT_OVERLAP` (person) |
| | Team in two overlapping matches | `TEAM_OVERLAP` once, not per member |
| | Rest 3 600 s, gap 3 000 s, SOFT | `SHORT_REST` SOFT (3600 / 3000); HARD template → HARD |
| | Rest met | Nothing |
| | Final before semis end + lead | `DEPENDENCY_ORDER` |
| | Final with an unscheduled semi | `INCOMPLETE_ASSIGNMENT` (`feeder`) |
| | Completed feeder | No constraint |
| | Provisional final, possible occupant overlaps elsewhere | POSSIBLE `PARTICIPANT_OVERLAP`, still HARD |
| | Post-cut round: all places "possibly" everyone | No same-round POSSIBLE overlaps; daily count once per round |
| | Two units on one local date, limit 1 HARD | `MAX_CONTESTS_PER_DAY` HARD; unit crossing midnight counts on start date |
| | Cancelled contest | Excluded everywhere |
| Groups | 24-entrant squad on six pairs, one start | Nothing |
| | Member started 1 s later | `UNIT_SPLIT` (`start`) |
| | Member on a second SHARED course | `UNIT_SPLIT` (`shared-multi-resource`) |
| | Member unscheduled | `UNIT_SPLIT` (`unscheduled-member`) |
| | Recorded key ≠ derived | `UNIT_SPLIT` (`unit-key`); NULL recorded key → nothing |
| | Inherited round-2 group; regroup after cut (ASC/DESC) | Units as derived; common start checked |
| | Round 2 before round 1 for an entrant | `ROUND_SEQUENCE` SOFT |
| Publication | Draft with only SOFT conflicts | Publishable with exact acknowledgements |
| | Draft with a HARD conflict | `HARD_CONFLICTS` |
| | Settled-only overlap in history | Not reported; publication possible |
| | Contest moved in draft then started | `LOCKED_ASSIGNMENT_VIOLATION` |
| | STALE upstream after validate | Hash changes → `REPORT_STALE`; re-validate → `STALE_OCCUPANT` |
| | Competition zone edited after validate | `REPORT_STALE` |
| | Coverage | Exactly the 19 codes; validator `br:schedule-conflict-engine` v1 |
| Determinism | Same input twice | Byte-identical canonical report |
| | Shuffled assignments, resources, places, facts (property test) | Same report and hash |
| | Shuffled database rows (integration) | Same hash |
| | Run under a different `TZ` env / locale | Same hash |
| Hash | Same semantic input | Same hash |
| | Changed start, end, changeover, resource, mode, capacity, key, availability fact, profile, occupant, state, status, zone | Different hash |
| | Evaluation at a different wall-clock time | Same hash |
| Keys | Two persons overlapping between the same two teams | Distinct `conflictKey`s |
| | Forced key collision (fixture) | `ScheduleEvaluationError` |
| Errors | Assignment for an unknown contest/resource; ambiguous requirement; graph cycle | `ScheduleEvaluationError`, no report |
| Sport identity | Source guard over the new modules | No sport, discipline, engine or resource-type branch |

## 21. Performance considerations

Realistic upper bounds per competition: ≤ ~10 000 live assignments (e.g. 300 bowlers × 6 blocks, multi-event golf/tennis), ≤ ~500 resources, ≤ ~5 000 persons, plan graphs of ≤ ~10 000 places, possible-occupant sets bounded by the event field (05D ordinals ≤ 20 000).

| Check | Naive | Required strategy |
|---|---|---|
| R1/R2/R3 | O(n²) | Group claims by resource; sort by start; sweep line — O(n log n) |
| R4 | O(n²) | Group resources by key; compare only claims on key-sharing pairs, sorted sweep |
| Start events | — | Per resource, sorted slots — O(n log n) |
| Availability | Per claim expansion | Expand each resource's effective/declared sets once over the competition horizon, then interval lookups |
| Overlap / rest | O(a²) over appearances | Per person, sort appearances; neighbour scan |
| Possible occupants | Exponential if recomputed | Memoized closure per place (DAG), shared across contests |
| Daily limits | — | Hash buckets keyed by (event, entrant, requirement, date) |

Pairwise comparison is acceptable inside one bucket (one resource, one person, one slot). The engine is synchronous and runs inside the publish transaction; its cost should be measured in the 05E-D integration suite on the largest fixture. No optimizer, cache store or background evaluation is introduced.

## 22. Security / trust boundary

- Every judged value is loaded server-side from canonical tables in the command's transaction (D14). The engine has no network, database or clock access.
- Clients supply only ids, `baseVersionId`, `reportHash` and acknowledged keys. A client hash is compared, never trusted; client conflicts, coverage, capacities, modes, profile hashes, occupants, statuses or unit keys are never read.
- Organizer-adjusted intervals and changeovers are trusted only as stored facts written by `COMP_MANAGE_SCHEDULE` commands with reasons and audit.
- Reports contain ids and numbers only; no personal data beyond person/entrant ids already used across the competition API.

## 23. Deferred questions

| # | Question | Owner |
|---|---|---|
| Q1 | Lineup-based person identity (narrower than rosters) | future ADR |
| Q2 | Thresholds for `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` | profile spec version + ADR |
| Q3 | `PERSON` capacity unit (ADR-0073 open question 1) | profile spec version + ADR |
| Q4 | Persisted / content-addressed reports outside publication; report history UI | 05E-G or later |
| Q5 | Catalog data gaps: track and open-water templates; bowling template with `regrouping`; cycling changeover values; a template allowing simultaneous multi-event mass starts (`concurrentStarts > 1`) | catalog operator |
| Q6 | Incremental evaluation for 05E-E candidate search (the engine is whole-schedule in v1) | 05E-E |
| Q7 | Operational policy for the day's last changeover past closing (store 0 vs extend hours) | product, no rule change |

## 24. Explicit handoff to 05E-E

05E-E consumes **only** `evaluateSchedule` and the report contract:

- A candidate is feasible iff the engine reports zero HARD conflicts for the draft content with the candidate applied. 05E-E never re-implements a rule.
- 05E-E evaluates hypothetical content with synthetic, unique, deterministic assignment ids; the engine treats ids as opaque.
- 05E-E never places a unit in UNRESTRICTED or DECLARED-CLOSED time, even though the engine reports UNRESTRICTED only as SOFT (ADR-0073 B5).
- 05E-E distributes grouped members over EXCLUSIVE resources in member sequence and stable resource order (ADR-0073 B9); the engine accepts any distribution satisfying R1–R5.
- 05E-E records the engine's validator id/version and the profile versions it used with every preview.

## Appendix A — Gap table

| Area | Frozen by ADR? | Implemented? | Ambiguous? | 05E-D decision needed? |
|---|---|---|---|---|
| Interval semantics | ADR-0068, ADR-0073 B4 (whole s) | `interval.ts` (ms, half-open) | ms vs s for legacy rows | **D3** |
| Occupancy | ADR-0073 B2 | `occupancy_mode` column | No (brief cites rejected draft, F1) | Confirmed only |
| Exclusivity | ADR-0073 R1, R4 | `sharesSpace` | Same unit on key-sharing resources | **D6** |
| Capacity | ADR-0073 R2, R3 | capacity column; consumption not stored | Profile-less consumption | **D6** |
| Changeover | ADR-0073 B3 | stored, `blockingEnd` | Changeover vs closing time | D6 (no rule change) |
| Spacing | ADR-0073 B4 | profile field | Split units; no-requirement units | **D7** |
| Concurrency | ADR-0073 B4 | profile field (default 1) | Same | **D7** |
| Availability | ADR-0068, ADR-0073 B5 | `effectiveAvailability` only | DECLARED algorithm per layer/zone | **D8** |
| Daily limit | ADR-0073 B6 | profile field | Possible occupants inside one round | **D10** |
| Rest | ADR-0073 B8 | profile field | Consecutive with possible occupants | **D10** |
| Dependency | ADR-0071, ADR-0073 B8 | 05D structure | Unscheduled / completed feeders | **D11** |
| Possible occupants | ADR-0073 B8 | 05D states on read | OVERRIDDEN; same-round | **D10** |
| Groups | ADR-0073 B9 | `deriveUnitKeys` | Key mismatch; unscheduled member | **D5** |
| Round sequence | ADR-0073 B8 | — | Exact condition | **D11** |
| Conflict taxonomy | ADR-0071, ADR-0073 | 22 codes | Three codes lack inputs | **D15** |
| Severity | ADR-0071, ADR-0073 | `CONFLICT_SEVERITY` | No | Confirmed only |
| Determinism | ADR-0073 B7 | `report.ts` | Internal iteration orders | § 16 |
| Canonical ordering | ADR-0073 B7 | `compareConflicts` | Key 6 merges identities | **D13** |
| Hashing | ADR-0014, ADR-0073 B7 | `scheduleReportHash` | Missing inputs (zone, 05D states) | **D13** |
| Report schema | ADR-0073 B7 | `reportVersion: 1` | No `details`; emission granularity | **D13** |
| Publication integration | ADR-0073 B1 | baseline at one call site | Optional vs mandatory engine | **D1** |
| Invalid input | — | — | Not addressed | **D16** |
| Persistence | ADR-0070, ADR-0073 B1 | `schedule_publication` | Reports outside publication | D1 (ephemeral), Q4 |
| Settled contests | — | baseline judges all | Unclearable history | **D4** |
| Locks / staleness | ADR-0070, ADR-0071 | write-time refusals; 05D on read | What 05E-D checks | **D12** |

## Appendix B — Cross-sport matrix

Formats are the catalog's 3 × 3 design matrix (`catalog-manifest.ts`). Wheelchair basketball is the `basketball.wheelchair` discipline of the basketball sport, using the same resource types, template and engine as 5v5. "Marathon" is the `running.road` discipline. Ten-pin bowling terminology throughout (squads, blocks, lane pairs, stepladder).

| Sport | Formats | Unit | Resource · mode | Constraints that bite | Grouped entrants | Progression | Sport-specific code? |
|---|---|---|---|---|---|---|---|
| Tennis | single-elimination · round-robin · groups-knockout | Match | TENNIS_COURT · EXCL | R1 + 600 s changeover; rest 3 600 SOFT per person; lead 900; 2/day SOFT | — | WINNER edges; RANK_FROM_STAGE → possible occupants | No |
| Padel | single-elimination · groups-knockout · round-robin | Match (pair = 1 entrant, 2 persons) | PADEL_COURT · EXCL | R1; rest 3 600 SOFT; 3/day SOFT | — | Group → KO edges | No |
| Running / marathon | mass-start · wave-start · heats-final | Race contest; wave contest (`w1…`); heat | ROAD_COURSE · SHARED; TRACK · EXCL | R2 runners on course; spacing 900, concurrency 1; 1/day HARD; heats R1 | Waves are contests, not GROUPED_ENTRANTS | Heats → final via QUALIFIER | No (track template: data gap Q5) |
| Swimming | timed-finals · heats-final · mass-start (open water) | Heat; open-water race | POOL · EXCL; OPEN_WATER_COURSE · SHARED | R1 + 60 s; rest 1 800 SOFT; lead 1 800; lanes are plan slots | Heats are contests | QUALIFIER edges | No (open-water template: Q5) |
| Cycling | mass-start · interval-start · multi-round (GC) | Race; one SESSION per time trial; one contest per stage | CYCLING_COURSE · SHARED (EXCL twin with a common key for exclusive TT) | R2; spacing 300; 1/day HARD; changeover only on the EXCL twin | — | `ROUND_SEQUENCE` between stages; dynamic edges after elimination | No |
| Bowling (ten-pin) | multi-round · qualifying-knockout · round-robin | Squad (plan partition); inherited squad in later blocks; match | BOWLING_LANE_PAIR · EXCL | R1 + 900 s / 300 s; R3 bowlers per pair; R4 re-paired lanes; rest 1 800 SOFT | Squads `t1…` as units spanning k pairs | Stepladder WINNER edges, lead 300; block order `ROUND_SEQUENCE` | No |
| Basketball (5v5, 3x3, wheelchair) | groups-knockout · round-robin · single-elimination | Game | BASKETBALL_COURT / HALF_COURT · EXCL | R1 + 900 s / 300 s; R4 full vs half courts; rest 10 800 / 1 200 SOFT; 1/day SOFT | — | Pools → KO edges | No; wheelchair = same data |
| Golf | multi-round · stableford · qualifying-knockout | Tee group (plan); inherited group; regroup after cut; match | GOLF_COURSE · SHARED | R2 players on course; spacing 600; concurrency 2 (tee groups), 1 (matches); 1/day HARD | Tee groups; regroup `{3, DESC}` over 05D ordinals | CUT dynamic edge + lead; `ROUND_SEQUENCE` r1→r2 | No |

Every row is expressed by plan, resource, availability, profile and 05D data. **Sport identity is data, not engine logic.**

## Appendix C — Bowling findings

| Check | Finding |
|---|---|
| Squad as grouped unit | `GROUPED_ENTRANTS` + plan partition `t1…` (`buildMultiRound` / qualifying blocks) → `partition:<round>:<key>`; tested in 05E-C (24-entrant squad) |
| Common start | `UNIT_SPLIT` (`start`) |
| Lane-pair resource | `BOWLING_LANE_PAIR`, `occupancyMode` EXCLUSIVE (declared, default), keys = its two lanes |
| Exclusive blocking | R1 + stored changeover (900 s blocks, 300 s matches); R4 for re-paired lanes, including within one squad (D6) |
| Capacity | Bowlers (places) per pair, ENTRANT consumption, bounded by R3 per unit per pair |
| Multiple lane pairs | Emergent k = distinct pairs used by members; allowed because all are EXCLUSIVE |
| Later-round inheritance | Non-dynamic later blocks inherit `t<n>` per entrant (tested in 05E-C for golf; same function) |
| Sport branches | None; source guard tests exist and extend to 05E-D modules |
| Catalog-data gap (not engine) | The bowling template has no `regrouping`, so a post-cut block is singleton units (safe, inefficient); a template version with `regrouping` is a catalog follow-up (Q5) |

## Appendix D — Golf findings

| Check | Finding |
|---|---|
| Tee group as unit | Plan partition (round 1), inherited (non-dynamic rounds), `regroup` (dynamic post-cut rounds, `{groupSize 3, FIELD_ORDINAL_DESC}`) |
| Start spacing | 600 s between consecutive slots on the GOLF_COURSE |
| Concurrent starts | 2 for tee groups; matches default to 1, so a match and a tee group in one slot violate min-concurrency (correct by B4) |
| Round inheritance / regroup | `deriveUnitKeys`; recorded vs derived mismatch reported (D5) |
| Daily limits | 1/day HARD per entrant per requirement, local date in the event zone; post-cut round on round 2's day → HARD for every possible occupant, counted once per round (D10) |
| Event time zone | `event_profile.timezone` (in the report inputs) |
| Tee / start point | Not a resource; `startingTees` stays descriptive (I-B4.4); `concurrentStarts` is the only concurrency source. Shotgun starts = `concurrentStarts` = starting holes, all units in one slot |
| Sport branches | None |
