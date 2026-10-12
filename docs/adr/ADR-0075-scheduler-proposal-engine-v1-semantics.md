# ADR-0075 — Scheduler / Proposal Engine v1 Semantics

- **Status:** Proposed (frozen for ONCF-05E-E implementation once approved)
- **Date:** 2026-10-11
- **Origin:** ONCF-05E-E-0 architecture and readiness audit, after PR #11 (ONCF-05E-D merged at `39c0583`). Builds on [ADR-0066](./ADR-0066-scheduling-boundary-and-competition-scope.md)–[ADR-0074](./ADR-0074-conflict-feasibility-engine-v1-semantics.md). **None of them is edited, and no clause of them is superseded.** Each ADR-0071 proposal semantic is reconciled explicitly in § 23.

Decision references `E1`–`E20` are this ADR's; `D1`–`D16` are ADR-0074's; `B1`–`B9` and `R1`–`R5` are ADR-0073's.

## 1. Context

ADR-0071 §5–6 froze the proposal engine's outline:
- deterministic and greedy;
- contests placed in a total order;
- each gets the earliest feasible interval on the first compatible resource, in a stable resource order;
- locked assignments are never moved;
- anything unplaceable is reported with its blocking conflicts;
- no randomness, wall-clock or AI;
- proposals are previews with a canonical hash that a commit must present.

ADR-0073 added three rules:
- 05E-E commits into the draft only and never publishes (B1);
- it never places in UNRESTRICTED or DECLARED-CLOSED time (B5);
- it distributes grouped members over EXCLUSIVE resources in member sequence and stable resource order (B9).

ADR-0074 made `evaluateSchedule` the single judge. Its architecture §24 states the handoff: a candidate is feasible iff the judge reports zero HARD conflicts for the draft with the candidate applied, evaluated with synthetic, unique, deterministic assignment ids.

The readiness audit found that outline sufficient for **what** the proposal engine is, but not for **how** two engineers would build it compatibly.

**Repository evidence** (verified in code at `39c0583`):

| Area | What exists | Where |
|---|---|---|
| Judge | `evaluateSchedule(input) → ScheduleConflictReport`; one argument, no options; whole-schedule; pure; `ScheduleEvaluationError` for malformed input | `scheduling/engine.ts` |
| Assignment seen by the judge | `{id, contestId, resourceId, startMs, expectedEndMs, changeoverSeconds, recordedUnitKey}`. **No `locked`, `provisional`, `source` or `removed`**; the id is opaque | `engine.ts` `EvaluationAssignment` |
| Report identity | `scheduleVersionId`, the watermark (assignment ids) and `inputs`. Conflict keys hash assignment ids, so synthetic ids enter preview keys and the report hash | `engine.ts`, `report.ts` |
| Stored assignment | `schedule_assignment`: ≤ 1 `resource_id`, `starts_at`, `expected_end`, `changeover_seconds`, `zone`, `unit_key`, `provisional`, **`locked`**, `removed`, `reason` (≤ 500 chars), `replaces_assignment_id`, `source IN ('MANUAL','CARRIED','MIGRATED')`, actor | migration `0037` |
| Write path | `ScheduleStore.setAssignment`, one fact per call, with structural refusals (locked; contest not PLANNED/SCHEDULED; event not FIELD_LOCKED/IN_PROGRESS; RETIRED or mismatched resource; missing resource under a profile; non-whole seconds; reason for moves). There is **no batch write**. One open DRAFT per competition; per-competition advisory lock; idempotency keys. Staleness is checked only at publish | `persistence/src/schedule-store.ts` |
| Write-time defaults | `defaultExpectedEnd(start, requirement, latestOffset)`; changeover = the requirement's `changeoverSeconds`; zone = event zone; unit key = `deriveUnitKeys`; provisional = an unresolved place | `scheduling/assignment.ts`, `units.ts` |
| Windows | `event_profile.starts_at/ends_at`, else `competition_profile.starts_at/ends_at`, bound by bound. **No stage, round or session window** | `0008`, `schedule-store.ts` |
| Contest universe | Contests are append-only rows. 05D `materialize` **adds** contests to dynamic rounds after a cut | `advancement-store.ts` |
| Availability helpers | `expandAvailability` / `classifyExpanded`, the functions the judge uses for D8 | `resources/availability.ts` |
| Profile spec v1 | Integer-second durations, changeover, spacing, concurrency, rest, lead; daily limit. **No** granularity, preference, fairness, utilization or session field | `scheduling/profile.ts` |
| Cost of one judgment | Measured at `39c0583`: **≈ 0.3–0.5 s for 5 000 assignments** (50 courts, 500 entrants); **≈ 15 ms for a 128-entrant knockout** | `engine-sports.test.ts` performance cases |

**Gaps this ADR closes:**

| # | Gap |
|---|---|
| E-G1 | What a proposal is, and whether it is stored |
| E-G2 | Which existing assignments E may touch, architecturally vs in v1 |
| E-G3 | What E chooses, and what it never touches |
| E-G4 | Which instants are candidates, without a granularity constant (ADR-0069 §3) |
| E-G5 | "Earliest feasible interval on the first compatible resource": time-major or resource-major |
| E-G6 | Tie-breakers of ADR-0071 §5's total order; architecture §18.5 ("dependency depth vs day by day") |
| E-G7 | How SOFT conflicts relate to "earliest feasible" |
| E-G8 | How E searches efficiently without a second rule engine |
| E-G9 | Partial results, budgets, termination |
| E-G10 | Proposal hash vs report hash; staleness |
| E-G11 | Commit, provenance without a migration, concurrency |
| E-G12 | Cost of whole-schedule judging per candidate |

## 2. D/E boundary (E1)

**05E-D is the authoritative feasibility judge. 05E-E proposes.**

| 05E-E may | 05E-E may not |
|---|---|
| Order the work (§ 9) | Create a second conflict engine, or a local copy of any rule of ADR-0071/0073/0074 |
| Generate candidates (§ 5, § 10) | Redefine HARD/SOFT semantics or any severity |
| Prune candidates **conservatively** (§ 8) | Declare a candidate feasible on its own |
| Call `evaluateSchedule` | Accept a candidate the judge rejects |
| Choose among feasible candidates by the frozen order (earliest instant, then resource tie-break) | Rank by objectives that are not frozen (§ 11) |

- **Shared construction helpers.** These are the functions 05E-C and 05E-D already use to *build* content, never to judge it:
  - `deriveUnitKeys` (units);
  - `resolveRequirement` (requirement);
  - `defaultExpectedEnd` and the requirement's `changeoverSeconds` (write-time defaults);
  - `expandAvailability` (candidate time domain);
  - ADR-0073 B2 consumption (member packing).

  A wrong helper result can only lose a candidate. The judge still rejects every infeasible one.
- **Purity:** no database, clock, randomness, environment, locale or I/O.
- **Never:** writes, publishes, validates for publication, or edits plan, results, advancement, occupants, profiles, resources or availability.

## 3. Proposal definition (E2)

A **proposal** is an immutable, content-addressed **change set** of placements against an identified base state, together with the judge's report over *base ⊕ change set* and the units it could not place.

- It is **not** a schedule version, **not** an assignment, and **not** published.
- It is the smallest deterministic representation: a delta, never a copy of the base. The base is identified by the base-state identity (§ 15).
- **v1: ephemeral.** It is returned by preview and never stored. Commit recomputes it (§ 16).

## 4. Scheduler input (E15)

| Input | Class |
|---|---|
| The judge's full input for the open draft (ADR-0074 D2): competition zone, draft and base PUBLISHED assignments and watermark, contests with statuses and feeders, places with 05D states, entrants and rosters, events (zone, window, pinned profile, lifecycle state), resource revisions, availability facts | **Authoritative.** Loaded server-side by the **same loader** `validate` uses |
| `scope = {eventIds?, roundIds?}` | **Optional request.** Narrows the *targets* only; the judgment stays competition-wide (ADR-0066 §3) |
| `from` (whole-second instant) | **Optional request.** Earliest start considered; E never reads the clock |
| Strategy identity and budget | **Server configuration** (§ 12) |
| Units, requirements, expected ends, changeovers, candidate instants, packings | **Derived** |

A caller never supplies a second representation of authoritative state (D14): no resources, availability, profiles, occupants, placements, feasibility or scores.

## 5. Candidate model (E4, E12)

- **Choices per unit:** a candidate is `(unit, start instant, one resource per member contest)`. E chooses **only** the start (whole epoch seconds, shared by every member) and the resources.
- **Derived values**, exactly as 05E-C's write defaults:
  - expected end = `defaultExpectedEnd(start, requirement, latest plan offset)`;
  - changeover = the requirement's `changeoverSeconds`;
  - zone = the event zone;
  - unit key = `deriveUnitKeys`;
  - provisional = an unresolved place.
- **Never changed:** E never shortens or extends an interval, and never changes grouping, occupants, entrant order, contests, stages, rounds, rulesets, scoring, advancement, entrants, profiles, resources or availability.
- **Evaluation:** a candidate is evaluated as synthetic assignments with id `proposal:<contestId>`, one per member. The ids are unique (one live assignment per contest), deterministic, and disjoint from stored fact ids (UUIDs).

## 6. Existing assignment semantics (E3) — architectural

These are scheduler invariants, independent of version:

1. **Locked assignments never move** (ADR-0070 §8).
2. **Settled contests never move** (`IN_PROGRESS`, `COMPLETED`; ADR-0070 §8). CANCELLED/VOID contests are never placed (ADR-0074 D4).
3. **Immutable facts are respected:** plan, 05D facts, occupants, resources, availability, profiles.
4. **Movement of other assignments is controlled, never silent.** A future strategy may move unlocked, unsettled assignments only under a rule frozen by its own ADR. That rule must make movable assignments distinguishable from organizer overrides, so a manual override never disappears silently on regeneration.

## 7. V1 additive-only scope (E3) — v1 constraint, not an invariant

**v1 places only units with no live assignment in the open draft. It moves, re-times, re-resources and removes nothing.**

- **Why only v1:** nothing in the v1 data distinguishes an organizer override from a machine-placed assignment (both are `MANUAL`, § 17). Moving either would risk § 6.4. `removeAssignment` refuses published contests, and every manual move needs a human reason (ADR-0070 §3).
- **How v1 treats every assignment:** each live assignment (locked, `MANUAL`, `CARRIED`, `MIGRATED`-derived) is **fixed for the v1 run**. No new `fixed` field is introduced. `locked` keeps its meaning, which is protection against manual moves.
- **Re-proposing a contest:** the organizer removes its draft-only assignment explicitly, then runs E again.
- This narrows nothing in ADR-0070 §8. That clause forbids moving locked and started assignments; v1 additionally moves none. Lifting the v1 constraint requires a new ADR satisfying § 6.4, not an edit of this one.

**Targets of a run.** These are units in scope whose every member contest is `PLANNED` with no live draft assignment, in an event that pins a profile and is `FIELD_LOCKED` or `IN_PROGRESS`. Other units are reported unplaced with a reason (§ 13):
- `NO_PROFILE`;
- `EVENT_NOT_SCHEDULABLE`;
- `PARTIALLY_PLACED` (some members placed; v1 does not complete them);
- `ALL_VACANT`;
- `STALE_OCCUPANT`.

**Multi-stage.**
- E places exactly the contests that exist. An unmaterialized dynamic round has none.
- A materialized contest with unresolved places is placed **provisionally**, and the judge applies possible occupants (ADR-0071 §3, D10).
- E never invents an occupant.
- Rolling use means the organizer runs E again after 05D commits more facts.

## 8. Search strategy (E8, E9, E11)

**Deterministic greedy, time-major, single pass, no backtracking.** Strategy identity: `{ id: 'br:schedule-proposal-greedy', version: 1 }`. A future strategy is a different id behind the same proposal contract (ADR-0071 §5).

**Per unit**, in the order of § 9:
- for each candidate instant `t` ascending (§ 10);
- for each candidate resource or packing at `t`, in the order of § 9:
  - evaluate `base ⊕ accepted placements ⊕ candidate` with `evaluateSchedule`;
  - accept the first candidate that passes the acceptance test (§ 10).

**Grouped units (B9).**

| Unit | Resource rule at instant `t` |
|---|---|
| Single contest | Each compatible resource, in tie-break order |
| Grouped, SHARED resource | All members on **one** resource (never two SHARED resources: `UNIT_SPLIT shared-multi-resource`) |
| Grouped, EXCLUSIVE resources | Members in member order, packed by B2 consumption up to each resource's capacity, over resources in tie-break order. Resources the judge names in resource-scoped conflicts are excluded at `t` and the packing rebuilt (each rebuild excludes ≥ 1 resource, so the loop is bounded) |

E never creates, splits, merges, reorders or edits groups. Units come only from `deriveUnitKeys`: plan partitions, inheritance, and the pinned profile's `regrouping`.

**Conservative pruning and search guidance.** Pruning outside the judge is limited to building the domain. Each rule is the same rule the judge applies, using the same helper:
- resource type match (R5 data);
- the horizon (window, D9);
- declared-open time (`expandAvailability`, B5).

Within the domain, conflict codes are classified **only to skip candidates the judge would reject anyway**:

| Class | Codes | Skip |
|---|---|---|
| Unit-scoped | `STALE_OCCUPANT` | The whole unit (no instant or resource can clear it) |
| Time-scoped (judged on the interval `O` and the start only, which do not depend on the resource) | `PARTICIPANT_OVERLAP`, `TEAM_OVERLAP`, `SHORT_REST`, `DEPENDENCY_ORDER`, `MAX_CONTESTS_PER_DAY`, `ROUND_SEQUENCE`, `OUTSIDE_EVENT_WINDOW` | Every other resource at the same instant |
| Resource-scoped | `RESOURCE_OVERLAP`, `EXCLUSIVITY_CONFLICT`, `CAPACITY_EXCEEDED`, `RESOURCE_TYPE_MISMATCH`, `RESOURCE_UNAVAILABLE`, `AVAILABILITY_UNDECLARED`, `START_SPACING`, `CONCURRENT_STARTS_EXCEEDED`, `UNIT_SPLIT` | The named resources at this instant |

- Skipping applies only to a candidate whose conflicts make it unacceptable (§ 10).
- It never accepts anything: a misclassification can only skip a candidate the judge would have accepted (lost completeness), never accept one it rejects.
- The table must stay exhaustive over the judge's codes, and a new code defaults to resource-scoped, the class that skips least.
- **Backtracking:** none in v1. A unit with no accepted candidate is unplaced, and its dependents become `FEEDER_UNPLACED`. There is no reordering, no domain expansion beyond the horizon, and no undo.

## 9. Deterministic ordering (E6, E7)

| Order of | Key (ascending) |
|---|---|
| Units | 1. stage sequence · 2. round sequence · 3. dependency depth (longest feeder chain over plan edges, in units) · 4. lowest member-contest plan sequence · 5. event id · 6. unit key |
| Instants | `T` ascending (§ 10) |
| Resources at an instant | Resource id (UTF-16) — a **tie-break**, see below |
| Members in a packing | Stage, round, plan sequence, contest id |

- **Unit order:** this is ADR-0071 §5's tuple ("stage and round order, dependency depth, contest sequence, then id"), with its tie-breakers made explicit. It is competition-wide.
- **Not day by day:** day-by-day placement (architecture §18.5) is not adopted, because spec v1 has no session concept (ADR-0072). "One stage per day" is `maxUnitsPerEntrantPerDay`, judged by D.
- **Resource order is a tie-break, not a preference.** Ordering by canonical resource id makes the choice reproducible. It does **not** mean a lower id is a better resource. v1 has no resource preference: no quality, proximity, organizer-preferred or utilization ranking. Any future preference mechanism is separate data under a new ADR.
- **Compatible resources:** ACTIVE current revisions whose `typeCode` equals the requirement's `resourceType` (R5 data matching, as 05E-C refuses mismatched writes). E never infers availability from names or type from sport.
- **No database order anywhere:** every collection is sorted by these keys before use.

## 10. Earliest-feasible semantics (E8, E10) — ADR-0071 §5 preserved

**Acceptance test.** A candidate is **feasible for E** iff none of the conflicts that list one of its synthetic ids is:
- (a) a HARD conflict — feasibility = zero HARD, ADR-0074 D15; or
- (b) `AVAILABILITY_UNDECLARED` — ADR-0073 B5 forbids E to place in undeclared time. DECLARED-CLOSED time is already HARD `RESOURCE_UNAVAILABLE`.

Conflicts that list no candidate id are pre-existing problems of the preserved content. They never affect acceptance.

**Selection — the frozen ADR-0071 §5 order, unchanged:**

```
HARD FEASIBILITY (+ B5)  →  EARLIEST FEASIBLE INTERVAL  →  DETERMINISTIC RESOURCE TIE-BREAK
```

- "Earliest feasible interval on the first compatible resource" means **time-major**: the earliest instant at which any candidate is feasible, then the first resource or packing in tie-break order at that instant. Resource-major reading is rejected: it would never use a second resource while the first has any later free time.
- **SOFT conflicts do not change the selection.** Other SOFT conflicts (`SHORT_REST` or `MAX_CONTESTS_PER_DAY` with SOFT enforcement, `ROUND_SEQUENCE`) of the selected candidate are **reported** in the proposal, to be acknowledged at publication as always (ADR-0070 §4).
- They are not used to compare alternatives. At the earliest feasible instant they could only distinguish resources, and every such SOFT code is time-scoped (independent of the resource). So they cannot tell same-instant candidates apart, and a later instant is never chosen to avoid them. A profile that wants rest honoured strictly declares it `HARD` (ADR-0071 §1, ADR-0072).

**Monotonicity (why one-at-a-time is sound).**
- Units are added whole, so `UNIT_SPLIT unscheduled-member` never arises from a candidate.
- Beyond that, adding assignments only adds conflicts. A HARD-free prefix therefore stays HARD-free as later units are added.
- The final report over base ⊕ all placements is computed once more and recorded.
- E's placements never carry `INCOMPLETE_ASSIGNMENT`: each has an end and a resource, and units with unplaced feeders are not placed (`FEEDER_UNPLACED`, because the judge cannot evaluate a dependency on an unscheduled feeder, D11).

**Time domain.**
- **Horizon per unit:** `[max(window start, from), window end)`, with window = event, else competition, bound by bound (D9). Without a finite end the unit is `NO_HORIZON`. No stage or round window exists, and none is invented.
- **Candidate instants** (no granularity constant, ADR-0069 §3) are the sorted, de-duplicated whole-second **breakpoints** within the horizon:

  ```
  T = { horizon start }
    ∪ { starts of the resource's effective and declared intervals }          (expandAvailability)
    ∪ { x + c :  x ∈ {start, O.end, B.end} of every live or accepted assignment,
                 c ∈ {0} ∪ every lead, rest minimum and start spacing declared by any pinned requirement }
  ```

- **Why `T` is complete:** every lower bound the judge enforces is "an anchor plus a declared constant" or "a declared window opens"; upper bounds only remove instants. So the earliest feasible instant, given the fixed content, belongs to `T`, and **the greedy search returns exactly ADR-0071's earliest feasible interval within the horizon**.
- **Sub-second anchors:** legacy sub-second anchors round up to the next whole second.
- **Arithmetic:** integer milliseconds on `interval.ts` (D3).
- **Local time:** all local-time logic is 05E-A's (`zoned.ts`, `expandAvailability`, layer zones). Daily limits are judged by D in the event zone. Nothing uses a server or browser zone.

## 11. Hard/soft conflict treatment (E18)

| Conflict | E |
|---|---|
| Any HARD code | Never acceptable for a candidate |
| `AVAILABILITY_UNDECLARED` | Never acceptable (B5) |
| Other SOFT codes | Allowed at the earliest feasible instant; reported per placement; acknowledged at publication |
| `INCOMPLETE_ASSIGNMENT` | Never produced by E's placements |
| `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` | Outside the judge's coverage (D15); not considered |

- **No objective function in v1:** no weighted score, and no optimization of span, gaps, utilization, idle time or fairness. Spec v1 declares no data for them, and an engine constant would violate ADR-0069 §3.
- **Metrics are reported, never optimized:** makespan, busy seconds per resource, and placements carrying SOFT conflicts.
- Preserving existing content is a rule (§ 6–7), not an objective.

## 12. Search budget (E12)

- The budget is **logical**: it counts `evaluateSchedule` calls, never time. Canonical results never depend on wall-clock, machine speed or Node version.
- **v1 operational defaults (guardrails, not architectural constants):**

  | Limit | v1 default | When reached |
  |---|---|---|
  | Judge calls per run | 10 000 | Undecided units become `BUDGET_EXHAUSTED`; run status `SEARCH_EXHAUSTED` |
  | Judge calls per unit | 500 | That unit becomes `BUDGET_EXHAUSTED` (per unit); the run continues |

- The values are server configuration of the strategy and are recorded in every proposal's canonical body (§ 14). They may be tuned in a later version without changing these semantics. A tuned value changes the proposal (it is part of the input identity), never the meaning of a status.
- Callers cannot set the budget in v1.
- A wall-clock guard may exist **only** in the application layer. Hitting it returns an error and **no** proposal.
- No random or stochastic search.

## 13. Termination (E11)

The domain is finite (finite `T` × bounded resources and packings), each unit is visited once, packing rebuilds shrink the resource set, and the budget is logical. **Every run terminates with the same result for the same input.**

**Per-unit outcome:** `PLACED`, or `UNPLACED` with exactly one reason:

| Reason | Meaning |
|---|---|
| `NO_PROFILE` | The event pins no profile (ADR-0069: profile-less events are manually schedulable only) |
| `EVENT_NOT_SCHEDULABLE` | The event is not FIELD_LOCKED / IN_PROGRESS |
| `PARTIALLY_PLACED` | Some members already placed (v1 does not complete them) |
| `ALL_VACANT` | Every place is VACANT |
| `STALE_OCCUPANT` | A place reads STALE |
| `NO_COMPATIBLE_RESOURCE` | No ACTIVE resource of the required type |
| `NO_HORIZON` | No finite window end |
| `NO_DECLARED_TIME` | No declared-open time on any compatible resource within the horizon (B5) |
| `FEEDER_UNPLACED` | A feeder target stayed unplaced |
| `NO_FEASIBLE_CANDIDATE` | Every candidate in the finite domain was rejected. Recorded with the **blocking conflicts**: the canonical keys of the conflicts of the first candidate tried (earliest instant, first resource) (ADR-0071 §5) |
| `BUDGET_EXHAUSTED` | The run or unit budget ended before the unit was decided |

**Run status:**

| Status | Meaning |
|---|---|
| `SUCCESS` | Every target placed |
| `NOTHING_TO_PLACE` | No target in scope |
| `INFEASIBLE` | The search completed within budget, and ≥ 1 unit is unplaced for a non-budget reason. Scoped to the v1 greedy space given the preserved content — **never** a claim that no schedule exists |
| `NO_CANDIDATES` | Every target's domain was empty |
| `SEARCH_EXHAUSTED` | The run budget ended. Decided units stay in the proposal |

**Refusals, with no proposal:**
- `INVALID_INPUT`: malformed request, foreign scope ids, `from` not whole seconds, or the judge's `ScheduleEvaluationError` on the base state (D16).
- `INCOMPLETE_STATE`: no open draft, or the competition is COMPLETED/CANCELLED.

## 14. Proposal result (E13)

**Semantic proposal (canonical, hashed):**
- `proposalVersion: 1`;
- `strategy {id, version}` and the budget values in force;
- `baseStateIdentity` (§ 15);
- `scope`, `from`;
- `placements`: sorted by contest id. Each has `contestId, unitKey, resourceId, start, expectedEnd` (epoch s), `changeoverSeconds, zone, provisional`, and the keys of SOFT conflicts involving it;
- `unplaced`: sorted by unit key. Each has the unit key, member contest ids, reason and blocking conflict keys;
- `status`;
- the final judge report's `reportHash`, `validator`, `coverage` and HARD count;
- `metrics`: placed/unplaced counts, makespan, busy seconds per resource, pre-existing base HARD conflicts.

**Execution metadata (returned for humans and logs, never hashed):**
- search diagnostics: judge calls, candidates tried, skips per class, packings rebuilt;
- runtime, timestamps, request or process identifiers.

The canonical body contains no timestamp, runtime, actor, database order or process identifier.

## 15. Hashing (E14)

- **Canonical form:** `@br/canonical` RFC 8785 JCS + SHA-256, domain-separated, exactly as `scheduleReportHash` (`report.ts`). Domain tags: `br:schedule-proposal-base` and `br:schedule-proposal`. No second canonicalization system.
- **`baseStateIdentity`** = hash of:
  - competition id and draft version id;
  - draft watermark (current fact ids, removals included: every edit, lock or removal changes it);
  - base PUBLISHED version id;
  - the judge's `inputs` over the unmodified draft: event profile versions, spec hashes, zones and windows; competition zone; resource revision ids; availability fact ids; occupancy digest with 05D states; contest statuses, which also enumerate contests, so newly materialized contests are included;
  - scope, `from`, strategy and budget.
- **`proposalHash`** = hash of the semantic proposal (§ 14).

| Change | Effect |
|---|---|
| Any authoritative input, scope, `from`, strategy or budget | `baseStateIdentity` changes, and so does `proposalHash` |
| Any placement, resource, start, unplaced reason or status | `proposalHash` changes |
| Row order, insertion order, evaluation time, runtime, diagnostics | Neither changes |

- **Report hash vs proposal hash:** the preview report covers synthetic ids, so its hash and conflict keys identify the *preview* only. After commit, the facts get real ids, and publication recomputes and acknowledges its own report (ADR-0073 B1). The preview report hash is never presented to `publish`.

## 16. Preview / commit (E16)

```
PREVIEW   COMP_MANAGE_SCHEDULE · read-only · no audit
            load authoritative state → baseStateIdentity → proposal → proposalHash
            ↓
          human / application inspects and accepts
            ↓
COMMIT    COMP_MANAGE_SCHEDULE · authenticated human · idempotency key · {versionId, proposalHash}
            under the per-competition advisory lock:
            reload authoritative state
            recompute the proposal (same loader, same engine)
            recomputed proposalHash ≠ presented → CONCURRENCY_CONFLICT PROPOSAL_STALE (nothing written)
            otherwise apply atomically: every placement as a draft fact, in ONE transaction,
              through the ScheduleStore per-fact write path (all 05E-C structural refusals apply)
            audit + outbox: schedule.proposal_committed
            ↓
          draft schedule  →  validate (unchanged)  →  publish (unchanged; human; separate command)
```

- **Commit never trusts the preview.** It never writes a client-supplied placement list. It writes only what it has itself recomputed and found identical.
- **Stale rule:** if any authoritative state changed since preview, commit rejects the proposal as stale and writes nothing. Authoritative state means any draft fact, lock or removal, resource revision, availability fact, profile pin, event or competition zone or window, 05D state, contest status, or a newly materialized contest. The organizer previews again. Commit never regenerates silently against new state.
- **05D states are read just before the command transaction,** as in `validate` / `publish` (ONCF-05E-D known limitation). Their digest is part of the base identity.
- **All or nothing.** A commit writes every placement or none. Unwanted placements are removed afterwards with the existing `removeAssignment`.
- Each fact still emits its existing `ScheduleAssignmentChanged` outbox event. 05E-C has no batch write, so the commit loops the per-fact insert inside one transaction.
- **Never:** publish, validate for publication, auto-commit, commit-on-preview, background commit, or a `generateAndPublish` path (ADR-0073 B1). A commit never opens a draft. A draft that is no longer open is `INCOMPLETE_STATE`.

## 17. Provenance (E16)

- **The fact.** Committed facts use `source = 'MANUAL'`, by the committing human, with `reason = 'proposal <proposalHash>'`, which is deterministic and within the 500-character CHECK. No migration is made and no new `source` value is added.
- **What `MANUAL` means here.** The assignment entered through the normal draft-assignment mechanism under a human actor's authority. **It does not claim that a human chose each placement.**
- **How the origin is recovered.** It is reconstructible from:
  - the reason, which carries the proposal hash;
  - the `schedule.proposal_committed` audit and outbox entry: version, proposal hash, base-state identity, strategy, budget, counts and final report hash;
  - determinism: the same base state and strategy recompute the same proposal.
- A dedicated persisted origin value (`PROPOSED`/`GENERATED`) is **not** introduced in 05E-E. It is a prerequisite of any future move-capable strategy (§ 6.4) and needs its own ADR and migration.

## 18. Concurrency / idempotency (E17)

- **Preview** is a pure read: no lock, no write. Concurrent previews do not interfere, and identical inputs give identical proposals. Retries, refreshes and background recomputation are safe, and duplicate work is harmless.
- **Commit** is serialized by the existing per-competition advisory lock. Staleness is detected by recomputation (§ 16). This also covers ADR-0070 §9's base check for proposals, which 05E-C applies only at publish.
- **Idempotency** reuses the 05E-C keys: a retry returns the first response.
- No new lock, table or queue.

## 19. Performance (E-G12)

- **Measured judge cost** at `39c0583`: ≈ 0.3–0.5 s per `evaluateSchedule` at 5 000 assignments, and ≈ 15 ms for a 128-entrant knockout.
- **v1 cost model:** E judges the **whole competition** for every candidate. The total cost is units × candidates per unit × one competition-wide judgment.
  - Small and medium competitions are interactive.
  - **Large competitions can become expensive:** thousands of judge calls at hundreds of milliseconds each is minutes. 10 000 full evaluations is never cheap, and the run budget may end with `SEARCH_EXHAUSTED`.
  - Commit's recomputation doubles the preview cost.
- **Mitigation:** conservative skipping (§ 8) reduces candidates without weakening the judge.
- **Future optimization, under a separate ADR:** an incremental or prepared evaluation API in 05E-D, proven by property tests to return the same report as `evaluateSchedule`. It is not introduced now: correctness first, and ADR-0074 D1 freezes one entry point.

## 20. Security (E15, E19)

- **Server-side state only:** every authoritative value is loaded server-side (D14).
- **Clients send only** `versionId`, `scope`, `from`, `proposalHash` and an idempotency key. Client resources, availability, profiles, feasibility, objective scores, placements and hashes-as-truth are never accepted.
- **Permissions:** `COMP_MANAGE_SCHEDULE` (OWNER, ADMIN, SCHEDULER), resolved server-side. Commit requires an authenticated human account. No machine path publishes.
- **Logging:** diagnostics and logs carry counts. They carry no person or entrant ids beyond the report's, and are never persisted as schedule state.

## 21. Cross-sport implications (E20)

- **No sport branches:** no E code branches on a sport, discipline, format engine or resource-type code.
- **Same algorithm everywhere:** tennis, padel, marathon, swimming, cycling, ten-pin bowling, basketball (wheelchair = same discipline data and template) and golf use the same ordering, domain, acceptance test and packing. Differences come only from plan, 05D, profile, resource and availability data.
- **Bowling:**
  - squads are plan-partition units with one start;
  - members are packed over EXCLUSIVE lane pairs in tie-break order;
  - R1, R3 and R4 (re-paired lanes) are judged by D.
- **Golf:**
  - tee groups (plan, inherited, regrouped after the cut) go on one SHARED course;
  - 600 s spacing, 2 concurrent starts and the 1/day HARD limit are judged by D;
  - tees are not resources.
- **Source guard:** the source-level guard test extends to the E modules.

## 22. Relationship to ADRs 0066–0074

| ADR | Relationship |
|---|---|
| 0066, 0067, 0068, 0069, 0072 | Unchanged. § 7 applies 0069's "profile-less events are not proposable"; § 8 applies 0066 §4 (E never decides who) |
| 0070 | Unchanged. §2 "proposals are previews that become draft content only on commit" → § 3, § 16. §8 locks and started contests → § 6 (architectural); v1 is additionally additive-only (§ 7), a scope constraint that edits nothing. §9 preview → hash → commit → § 16; §10 audit → `schedule.proposal_committed` |
| 0071 | Unchanged; every proposal semantic reconciled in § 23 |
| 0073 | Applied: B1 (draft-only commit, never publish), B5 (never undeclared or closed time), B9 (member distribution). Resolves "05E-E: placement order by dependency depth vs by day" (§ 9) and "unplaceable-report format" (§ 13) |
| 0074 | Unchanged. E consumes `evaluateSchedule` as the only judge (D1), with synthetic ids; Q6 incremental evaluation stays deferred (§ 19) |
| ONCF-05E-ARCHITECTURE §16 | 05E-E row honoured: `competition` + `persistence`, **no migration** |

## 23. Explicit ADR-0071 reconciliation

| ADR-0071 semantic | ADR-0075 treatment | Status |
|---|---|---|
| §5 Deterministic greedy proposal engine (05A §27) | Greedy, time-major, single pass, no backtracking; strategy id for future engines (§ 8) | **UNCHANGED** |
| §5 Total contest order: stage and round order, dependency depth, contest sequence, then id | Same tuple at unit level, with event id and unit key as explicit final tie-breakers; competition-wide (§ 9) | **CLARIFIED** |
| §5 Earliest feasible interval | Feasible = zero HARD (ADR-0074 D15) and no undeclared time (ADR-0073 B5); earliest instant first over a complete breakpoint domain; SOFT conflicts never change the choice (§ 10) | **CLARIFIED** |
| §5 First compatible resource, stable resource order | Time-major: first resource at the earliest feasible instant; stable order = canonical resource id as a deterministic tie-break, not a preference (§ 9, § 10) | **CLARIFIED** |
| §5 Locked assignments are never moved | Architectural invariant kept, together with ADR-0070 §8's started contests (§ 6). v1 additionally moves nothing (§ 7) | **UNCHANGED** + **V1 SCOPED** |
| §5 Anything unplaceable is reported with the blocking conflicts | Per-unit reasons; `NO_FEASIBLE_CANDIDATE` carries the blocking conflict keys of the first candidate; run statuses separate `INFEASIBLE` from `SEARCH_EXHAUSTED` (§ 13) | **EXTENDED** |
| §5 No randomness, no wall-clock time, no AI/LLM | Kept; budgets are logical (judge calls); wall-clock guard only in the application layer and never yields a proposal (§ 12) | **UNCHANGED** |
| §5 "An optimizer may come later behind the same proposal contract" | Strategy identity in the proposal (§ 8, § 14) | **UNCHANGED** |
| §6 Proposals are previews with a canonical hash; commit requires the hash | Ephemeral content-addressed preview; commit presents the hash, and the server recomputes and compares; stale → rejected (§ 3, § 15, § 16) | **CLARIFIED** |
| Draft-only commit (ADR-0073 B1, I-B1.4) | Commit writes into the open draft only, atomically; never publishes (§ 16) | **UNCHANGED** |
| Unrestricted availability never proposed (ADR-0073 B5) | `AVAILABILITY_UNDECLARED` is unacceptable for E even though the judge rates it SOFT; closed time is HARD (§ 10) | **UNCHANGED** |
| Grouped members over EXCLUSIVE resources in member sequence and stable resource order (ADR-0073 B9) | Packing by B2 consumption up to capacity, resources excluded on resource-scoped conflicts and repacked; one resource for SHARED units (§ 8) | **CLARIFIED** |
| §3 Unresolved places: provisional assignments, possible occupants | E places materialized contests provisionally; the judge applies possible occupants (§ 7) | **UNCHANGED** |
| §4 Conflict engine is pure; §1 hard/soft split | E never redefines severity or feasibility; the judge is the only source (§ 2, § 11) | **UNCHANGED** |

**No ADR-0071 clause is superseded, and no ADR-0075 statement contradicts ADR-0071.**

## 24. Deferred work

**Deferred to the 05E-E implementation:**
- TypeScript names;
- route paths, under `/v1/schedule-versions/:versionId/` following 05E-C;
- the response envelope;
- diagnostic field names;
- internal indexing of `T`;
- the test file layout;
- deliberately revising the 05E-B/05E-C route-inventory tests, which today forbid proposal URLs.

**Deferred beyond 05E-E (each needs its own ADR):**
- controlled movement of unlocked, unsettled assignments (§ 6.4), with a persisted origin distinction;
- persisted proposals;
- partial commit;
- completing partially-placed units;
- backtracking or other strategies;
- objectives (span, gaps, utilization, idle time, fairness) and organizer or resource preferences;
- incremental or prepared evaluation in 05E-D;
- live rescheduling after results;
- stage, round or session windows.

**Not part of 05E-E v1 at all:**
- optimization frameworks, genetic algorithms, ILP/SAT/SMT, random or beam search;
- persistent proposal tables, new assignment source enums, resource preference systems;
- organizer UI (05E-G).

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Local feasibility pre-checks in E | A second copy of R1–R4 that can drift from the judge |
| "Avoid SOFT first, then earliest" (audit draft) | Would replace ADR-0071 §5's earliest feasible interval; a strict rule is declared `HARD` in the profile instead |
| Moving or removing assignments in v1 | No persisted origin distinguishes overrides (§ 7) |
| Proposal as a new DRAFT version, or persisted in v1 | One open draft (ADR-0070); recomputation gives the same guarantee without a table |
| Full-snapshot proposals | Duplicates the base |
| Resource-major reading of "first compatible resource" | Never uses a second resource while the first has later time |
| Fixed time grid | A universal constant (ADR-0069 §3); `T` is complete without one |
| Day-by-day placement | Needs a session concept spec v1 lacks |
| Lower resource id as preference | Ids carry no quality meaning; order is only a tie-break |
| Wall-clock search timeout inside the engine | Results would depend on machine speed |
| New `source` value or migration in 05E-E | Not needed: reason + audit + determinism reconstruct provenance |
| Commit trusting the preview's placements | The client could replay obsolete or altered content |
| An incremental judge API now | ADR-0074 D1; correctness first |

## Non-Goals

This ADR implements nothing. It adds no migration, route, UI, test or catalog row; it does not change 05E-A/B/C/D behaviour; it does not start 05E-E implementation; it does not edit ADRs 0066–0074.
