# ONCF-05E-E — Scheduler / Proposal Engine: architecture and readiness

| | |
|---|---|
| Status | **Readiness audit (ONCF-05E-E-0).** Architecture frozen by [ADR-0075](../adr/ADR-0075-scheduler-proposal-engine-v1-semantics.md) once approved. Pure engine implemented (PR #13); read-only preview integration in § 35 (ONCF-05E-E-2). Commit **not started** |
| Baseline | `39c0583` on `main` (PR #11, ONCF-05E-D merged) |
| Contract | [ONCF-05E architecture](./ONCF-05E-ARCHITECTURE.md) · ADR-0066–0074 (unchanged) · ADR-0075 (new) · [ONCF-05E-D architecture §24](./ONCF-05E-D-ARCHITECTURE.md) (handoff) |
| Migration | None required (§ 24) |
| Not in this phase | operations API (05E-F) · organizer UI (05E-G) · public schedule (05E-H) · any optimizer |

Decision references `E1`–`E20` are ADR-0075's (each appears in the heading of the ADR-0075 section that freezes it); `D1`–`D16` are ADR-0074's; `B1`–`B9` and `R1`–`R5` are ADR-0073's. **ADR-0075 is the single source of truth: where this document and ADR-0075 differ, ADR-0075 governs.**

## 1. Objective

Given a competition's open draft schedule, propose placements (start + resource) for the contests that have none. The proposal must be:
- feasible according to the one 05E-D judge;
- deterministic and reproducible;
- explainable, including for what it could not place;
- committed into the draft only by an explicit human command.

## 2. Scope

- **Pure engine** `proposeSchedule(input) → ScheduleProposal` (`@br/competition`, scheduling).
- **Persistence:**
  - a loader that reuses `ScheduleStore.report`'s input assembly;
  - a **preview** command (read-only);
  - a **commit** command (writes draft facts in one transaction).
- **API:** two routes under `/v1/schedule-versions/:versionId/` (preview, commit), `COMP_MANAGE_SCHEDULE`.
- **Tests:** unit, property, cross-sport, integration and golden fixtures (§ 31).

## 3. Non-goals

- Moving, re-timing or removing any existing assignment (E3).
- Publishing, validating for publication, or auto-committing.
- Optimizing span, gaps, utilization, idle time or fairness, and organizer preferences (E18).
- Backtracking, beam search or constraint solving; randomness, including seeded randomness.
- Changing 05E-D (no incremental API), the profile spec, templates, resources, availability, plan, 05D, rulesets, scoring or advancement.
- Live rescheduling after results.
- Any sport-specific code.

## 4. 05E-D vs 05E-E boundary

```
 canonical state (loader, server-side, D2/D14)
        │
        ▼
 ┌──────────────── 05E-E proposeSchedule ────────────────┐
 │ targets (E3)   → order (E6) → per unit:                 │
 │   domain: T (E10) × resources/packings (E7, E9)       │
 │   for each candidate (time-major):                    │
 │       evaluateSchedule(base ⊕ accepted ⊕ candidate) ──┼──▶ 05E-D (the only judge)
 │       ◀── report ─────────────────────────────────────┤
 │       acceptance test on the candidate's conflicts    │
 │       (E8); conservative class-guided skipping        │
 │ final evaluateSchedule(base ⊕ all placements) ────────┼──▶ 05E-D
 └──────────────────────────┬────────────────────────────┘
                            ▼
                ScheduleProposal (E13) + proposalHash (E14)
```

- **E proposes and D judges.** E has no local copy of any rule (E1). The helpers E shares with 05E-C/D only **construct** content: unit keys, requirement resolution, write-time defaults, availability expansion and B2 consumption for packing.
- **What E adds that D never decides:**
  - never placing in undeclared or closed time (B5, enforced by excluding `AVAILABILITY_UNDECLARED` from acceptance);
  - preserving all existing content (E3);
  - order (earliest feasible instant, then resource tie-break) and budget.

## 5. Scheduler input

| Input | Class | Source |
|---|---|---|
| Competition id, zone | Authoritative | `competition_profile` (loader) |
| Open draft version id, its live assignments, its watermark | Authoritative | `v_schedule_assignment_current` |
| Base PUBLISHED version's live assignments | Authoritative | Same |
| Contests (plan + 05D-materialized), statuses, feeders | Authoritative | Plan tables, `contest_status_change`, loader edges |
| Places with 05D target states | Authoritative | `contestant`, `contest_entry`, `AdvancementStore.targetStates` |
| Entrants and frozen rosters | Authoritative | `participant`, `participant_roster_member` |
| Events: zone, window (event else competition), pinned profile + spec hash + spec, lifecycle state | Authoritative | `event_profile`, `competition_profile`, `v_event_scoring_current`, event status |
| Resource revisions (mode, capacity, keys, zone, status, type) | Authoritative | `v_resource_current` |
| Availability facts | Authoritative | `v_resource_availability_current` |
| Locks, provisional flags, sources | Authoritative (read only to classify targets; every live assignment is fixed, E3) | `schedule_assignment` |
| `scope {eventIds?, roundIds?}` | Optional request | Client, validated against the competition |
| `from` (whole-second instant) | Optional request | Client |
| Strategy id/version, budget | Server constants (E11, E12) | Code |
| Units, requirements, expected ends, changeovers, candidate instants, packings | Derived | `deriveUnitKeys`, `resolveRequirement`, `defaultExpectedEnd`, `expandAvailability` |

- **No second representation of authoritative state is accepted from a caller** (E15, D14).
- **One loader.** The judge's input is exactly the one `validate` builds. The implementation factors `ScheduleStore.report`'s assembly into a shared private loader used by `validate`, `publish`, preview and commit, and does not copy it.

## 6. Proposal model

- **What it is:** an immutable change set of new placements, plus the judge's report over base ⊕ placements, plus the unplaced units with reasons (E2, E13).
- **What it is not:** a version, an assignment, or published state.
- **Lifetime:** ephemeral, content-addressed by `proposalHash` (E14), recomputed at commit (E16).

| Representation considered | Verdict |
|---|---|
| Full schedule snapshot | Rejected: duplicates the base; the input identity already pins the base |
| **Assignment delta (additions only)** | **Chosen**: the smallest deterministic form, auditable via `baseStateIdentity` + placements |
| Patch with moves/removals | Not in v1 (E3) |
| Candidate ScheduleVersion | Rejected: one open draft per competition (ADR-0070); a proposal is not a version |
| Persisted immutable proposal object | Deferred (§ 24) |

## 7. Candidate model

- A **candidate** is `(unit, instant t, member → resource map)`.
- It is materialized as synthetic `EvaluationAssignment`s, one per member:
  - `id = proposal:<contestId>`;
  - `resourceId` from the packing;
  - `startMs = t`;
  - `expectedEndMs = defaultExpectedEnd(t, req, latestOffset)`;
  - `changeoverSeconds = req.changeoverSeconds`;
  - `recordedUnitKey = derived key`.
- It is evaluated together with the draft's live assignments and the run's accepted placements.

## 8. Existing assignment treatment

| Category | Exists in data as | E |
|---|---|---|
| Fixed / locked | `locked = true` | Not touched |
| Manually placed | `source = MANUAL` | Preserved |
| Previously generated (committed proposal) | `source = MANUAL`, reason `proposal <hash>` | Preserved (indistinguishable by design in v1) |
| Published (carried into draft) | `source = CARRIED` | Preserved |
| Immutable historical | Contest IN_PROGRESS / COMPLETED | Not touched; context for D |
| Legacy migrated | `MIGRATED` / carried-from-migrated (may lack end, resource, unit key, whole seconds) | Preserved; D reports its gaps |
| Draft-only, unlocked | `MANUAL` in the draft, absent from the base | Preserved (the organizer may remove it explicitly, then re-propose) |
| Removed in the draft | Latest fact `removed = true` | Treated as unplaced: may be placed |

- **E only places** (MAY PLACE). It never moves, never removes, and never touches anything else.
- **Architectural vs v1 (ADR-0075 §6–7).** The scheduler invariants are:
  - locked and settled assignments never move;
  - immutable facts are respected;
  - any future movement of other assignments is controlled and must keep manual overrides distinguishable.

  **Additive-only is a v1 scope constraint, not an invariant.** v1 has no persisted origin to tell an override from a machine placement (both `MANUAL`), so it moves nothing. ADR-0070 §8 is unchanged; v1 simply does less than it permits.

## 9. Search space

| E may choose | E never changes |
|---|---|
| Unit start instant (shared by members) | Duration / expected end (derived), changeover (derived), zone |
| Resource per member contest (one; packing for EXCLUSIVE grouped units) | Groups (create / split / merge / reorder), occupants, entrant order |
| — | Stage or round sequence, plan graph, contest set, rulesets, scoring, advancement, entrants, profiles, resources, availability |

## 10. Time domain

- **Horizon:** `[max(window start, from), window end)`, where window = event, else competition, bound by bound (E10). No finite end → `NO_HORIZON`.
- **Granularity:** none. Candidates are the **breakpoint set** `T` (E10):
  - the horizon start;
  - availability interval starts from `expandAvailability`;
  - anchors `{start, O.end, B.end}` of live and accepted assignments, plus `{0, every declared lead, rest minimum and start spacing}`;
  - when the unit's requirement declares `maxUnitsPerEntrantPerDay`: the local start of every calendar date intersecting the horizon, in the **event** zone (05E-A `zoned.ts`, recurring-rule DST resolution). These are derived boundaries, not a grid (ADR-0075 § 10 amendment).

  All values are integer seconds.
- **Completeness argument:** every lower bound the judge enforces has one of these forms.

  | Rule | Lower bound |
  |---|---|
  | R1/R4 | `B.end` |
  | R2 | claim end |
  | Participants | `O.end` |
  | Rest | `O.end + rest` |
  | Dependency | `O.end + lead` |
  | Spacing | slot `+ spacing` |
  | Concurrency | slot instant |
  | Availability | declared-open interval start |
  | Daily limit | local start of each calendar date in the event zone |
  | Window | horizon start |

  Upper-bound constraints only remove instants. So the earliest acceptable instant, given the fixed content, belongs to `T`.
- **Instants:** whole seconds. Legacy sub-second anchors round up. Arithmetic is in milliseconds on `interval.ts`.
- **Timezone:** availability expansion uses each layer's zone (resource zone, else competition zone; 05E-A). Daily limits are judged by D in the event zone, and E adds the event zone's local-date starts as breakpoints (above). Placement zone = event zone. E has no other local-time logic, and never uses a server or browser zone.
- **Why the daily-limit row was added:** with continuous availability (for example 00:00–24:00 every day), the merged interval has no start at local midnight. The earliest start a daily limit allows (local midnight of the next date) was then missing from `T`. The exhaustive property test (§ 31) and a dedicated regression test cover the case.

## 11. Resource domain

- **Compatible resources:** ACTIVE, with `typeCode = requirement.resourceType` (R5 data match).
- **Order:** resource id, UTF-16 ascending. This is a **deterministic tie-break, not a preference**: a lower id is not a better resource. v1 has no resource preference (quality, proximity, organizer choice, utilization); any future preference is separate data under its own ADR.
- `occupancyMode`, capacity and keys are read only to build packings (§ 12). Acceptance is always the judge's.
- No name, label or sport inference.

## 12. Group domain

| Unit | Members | Resources |
|---|---|---|
| Single contest | 1 | One compatible resource |
| Plan partition / inherited partition / regroup on SHARED type | Many | **One** resource for all members (else `UNIT_SPLIT shared-multi-resource`) |
| Same on EXCLUSIVE type | Many | Members in member order, packed by B2 consumption up to capacity, over resources in stable order; resources named by resource-scoped conflicts are excluded and the packing rebuilt; k is emergent (B9) |

- E schedules existing grouping only, from `deriveUnitKeys` (plan, inheritance, the pinned profile's `regrouping` over 05D ordinals).
- It never creates, splits, merges or edits groups.

## 13. Candidate ordering

- **Units:** `(stageSequence, roundSequence, dependency depth, min member plan sequence, eventId, unitKey)` (E6, ADR-0071 §5). Competition-wide.
- **Time:** `T` ascending.
- **Resource:** id ascending, at each instant (time-major, E10).
- **Members inside a packing:** `(stage, round, plan sequence, contest id)`.
- **No database order anywhere:** every collection is sorted by these keys before use.

**Critical path.** Dependency depth (longest feeder chain) is computable deterministically from the plan DAG (the judge already asserts acyclicity). It is used only as the third key. Downstream-impact or constrained-resource priority is deferred, because it is optimization.

## 14. Search strategy

| Strategy | Determinism | Explainability | Complexity | Fits sizes (§ 29) | Extensibility | Verdict |
|---|---|---|---|---|---|---|
| A. Greedy earliest-fit (time-major) | Total order + sorted domains | "Earliest acceptable slot, in this order" | Low | Small/medium comfortably; large bounded by budget | Strategy id allows replacement | **Chosen (v1)** — also ADR-0071 §5 |
| B. Greedy resource-first | Yes | Yes | Low | Poor: piles onto the first resource | — | Rejected (E10) |
| C. Constraint propagation | Possible | Low (propagation traces) | High | Good | Needs a second rule model: duplicates D | Rejected for v1 |
| D. Backtracking | Possible with ordered choices | Medium | Medium | Exponential worst case | Behind the same contract | Deferred |
| E. Beam search | Needs a score | Low-medium | Medium | Good | Needs an objective (E18) | Deferred |
| F. Hybrid deterministic search | Possible | Medium | High | Good | — | Deferred |

The proposal contract (E13: `strategy {id, version}`) lets a later strategy replace A without changing callers.

## 15. Objective hierarchy

The frozen ADR-0071 §5 order, unchanged (ADR-0075 §10):

```
HARD FEASIBILITY (zero HARD listing the candidate; no undeclared time, B5)
    → EARLIEST FEASIBLE INTERVAL (earliest instant in T)
    → DETERMINISTIC RESOURCE TIE-BREAK (resource id at that instant)
```

- **SOFT conflicts never change the selection.** They are reported per placement. They could only separate same-instant candidates, and every SOFT code E can meet is resource-independent. A profile that needs strict rest declares it `HARD`.
- **No weighted score; no optimization** of span, gaps, utilization, idle time or fairness. Makespan and busy seconds are reported, never optimized.
- **Preserving existing content is a rule, not an objective.**

## 16. Hard feasibility

- A placement is never accepted with a HARD conflict that lists its synthetic ids (E8).
- The final report over base ⊕ placements is recorded. Its HARD count can be non-zero **only** from pre-existing conflicts of preserved content, reported as `metrics.baseHardConflicts`.
- Publication remains the judge's verdict over the real committed facts (ADR-0073 B1).

## 17. Soft warnings

| Code | E's treatment |
|---|---|
| `AVAILABILITY_UNDECLARED` | **Never acceptable** (B5): part of the acceptance test |
| `SHORT_REST` (SOFT), `MAX_CONTESTS_PER_DAY` (SOFT), `ROUND_SEQUENCE` | Allowed at the earliest feasible instant; never used to pick a later instant; reported per placement |
| `INCOMPLETE_ASSIGNMENT` | Never produced by E's placements (end + resource always set; units with unplaced feeders are not placed) |
| `LONG_WAIT`, `UNDERUSED_RESOURCE`, `SEQUENCING_INEFFICIENCY` | Outside D's coverage (D15); not considered |

The SOFT keys involving placements are listed in the proposal so the organizer sees them before commit. Acknowledgement still happens at publication, over real fact ids.

## 18. Backtracking

- None in v1.
- **Partial-schedule failure:** the unit is `UNPLACED` with a reason, and its dependents become `FEEDER_UNPLACED`. Independent later units continue.
- There is no reordering, no domain expansion beyond the horizon, and no undo of accepted units.

## 19. Search budget

| Limit | v1 | Effect |
|---|---|---|
| Judge calls per run | 10 000 (v1 default) | Undecided units `BUDGET_EXHAUSTED`, status `SEARCH_EXHAUSTED` |
| Judge calls per unit | 500 (v1 default) | That unit `BUDGET_EXHAUSTED`; the run continues |
| Wall clock | Application-layer guard only | Error, **no** proposal; never changes a canonical result |

- The budget is measured in judge calls, never time.
- **The values are v1 operational defaults (guardrails), not architectural constants.** They are server configuration of the strategy, recorded in each proposal's canonical body and base identity, and may be tuned later without changing any status meaning.
- Callers cannot set them in v1.
- No random search.

## 20. Termination

The domain is finite (finite `T` × bounded resources/packings), each unit is visited once, the packing loop shrinks the resource set on every rebuild, and the budget is logical. Termination is guaranteed and identical on every machine.

| Status | Meaning |
|---|---|
| `SUCCESS` | All targets placed |
| `NOTHING_TO_PLACE` | No targets in scope |
| `INFEASIBLE` | Search completed within budget; ≥ 1 unit unplaced for a non-budget reason. Scoped to the v1 greedy space — **not** a proof that no schedule exists |
| `NO_CANDIDATES` | Every target's domain is empty |
| `SEARCH_EXHAUSTED` | The budget ended |

Refusals produce no proposal:
- `INVALID_INPUT`: malformed request, foreign scope, or a judge `ScheduleEvaluationError` on the base;
- `INCOMPLETE_STATE`: no open draft, or the competition is closed.

Per-unit unplaced reasons are listed in E11.

## 21. Proposal result

See E13. Canonical:
- version, strategy and budget;
- `baseStateIdentity`, scope and `from`;
- sorted placements (each with the keys of SOFT conflicts involving it);
- sorted unplaced units (reason, blocking conflict keys);
- status;
- final report hash, validator, coverage and HARD count;
- metrics.

Non-canonical execution metadata, returned for humans and logs but never hashed: search diagnostics, runtime, timestamps, request and process ids.

## 22. Canonicalization

- `@br/canonical` RFC 8785 JCS, using the same `hashOf` pattern as `report.ts` (`buildPreimage('ledger-fact', tag, 1, serializeJcs(value))` → SHA-256 content hash).
- Domain tags: `br:schedule-proposal-base` and `br:schedule-proposal`.
- Every list is sorted (contest id, unit key, UTF-16) before hashing.
- Instants are epoch seconds.
- No second canonicalization system.

## 23. Hashing

| Change | `baseStateIdentity` | `proposalHash` |
|---|---|---|
| Any assignment fact, lock, removal (watermark) | changes | changes |
| Resource revision, availability fact, profile pin/spec, event/competition zone or window, 05D state, contest status or new materialized contest | changes | changes |
| Scope, `from`, strategy/budget | changes | changes |
| Selected resource, start, unplaced reason, status | — | changes |
| Row order, insertion order, evaluation time, runtime, diagnostics, process ids | same | same |

- The preview report's hash covers synthetic ids. It is evidence of the preview only, and is never presented to `publish` (E14).
- Conflict keys in the preview are likewise preview-scoped, because keys hash assignment ids.

## 24. Persistence

- **v1:** none. No table, no migration. Preview is read-only. Commit writes ordinary `MANUAL` assignment facts by the committing human, with reason `proposal <hash>`, plus one audit/outbox entry `schedule.proposal_committed`.
- **What `MANUAL` means here:** the assignment entered through the normal draft-assignment mechanism under a human's authority. It does **not** claim that a human chose each placement. Provenance is reconstructible from:
  - the reason (proposal hash);
  - the audit entry (version, proposal hash, base-state identity, strategy, budget, counts, final report hash);
  - determinism (the same base state recomputes the same proposal).
- No `PROPOSED`/`GENERATED` source value is introduced in 05E-E.
- **Minimum future schema**, if persistence is ever required (deferred, new ADR):

```
competition.schedule_proposal (
  proposal_hash   text PRIMARY KEY,             -- content address
  competition_id  uuid NOT NULL,
  version_id      uuid NOT NULL,                -- the draft it was computed against
  input_identity  text NOT NULL,
  strategy_id     text NOT NULL, strategy_version int NOT NULL,
  proposal        jsonb NOT NULL,               -- canonical E13 body
  created_by_account_id uuid NOT NULL, recorded_at timestamptz NOT NULL
)  -- append-only; plus schedule_assignment.source += 'PROPOSAL' and a proposal_hash FK on facts
```

## 25. Apply / accept lifecycle

```
preview  →  inspect  →  commit (hash, idempotency key; recompute & compare; one transaction)
         →  draft facts (MANUAL, reason "proposal <hash>")  →  validate  →  publish (human, unchanged)
```

- **Stale rule (ADR-0075 §16):**
  - At preview, `baseStateIdentity` hashes the authoritative state: draft facts, locks and removals; resource revisions; availability facts; profile pins and spec hashes; event and competition zones and windows; 05D occupancy states; contest statuses, including newly materialized contests.
  - At commit, the server reloads that state and recomputes the whole proposal.
  - Any difference in `proposalHash` → `CONCURRENCY_CONFLICT PROPOSAL_STALE`, nothing written. The organizer previews again. Commit never regenerates silently against new state and never trusts a client placement list.
- **Atomic apply:** all placements in one transaction through the existing per-fact write path. Each fact keeps its `ScheduleAssignmentChanged` event.
- There is no hidden side effect: preview never writes, commit never publishes, and no path runs `generateAndPublish`.
- Discarding a proposal is not an operation: an unused ephemeral preview simply expires. After a commit, the organizer removes unwanted draft-only placements individually (existing `removeAssignment`).

## 26. Concurrency

- **Preview** is lock-free and pure. Concurrent runs cause no interference and produce identical results for identical inputs.
- **Commit** uses the existing per-competition advisory lock and recomputation. Any intervening change of authoritative state changes `baseStateIdentity` → `CONCURRENCY_CONFLICT PROPOSAL_STALE`.
- **Discrepancy noted:** ADR-0070 §9 promises a base-version / last-fact check on edits; 05E-C checks staleness only at publish. Commit's recomputation provides the check for proposals without changing 05E-C.

## 27. Idempotency

- Same input + same strategy ⇒ same proposal ⇒ same hash. Retries, UI refreshes and background workers are safe.
- Commit reuses 05E-C idempotency keys (`identityIdempotency`): a retry returns the first response.

## 28. Observability

- **Exposed** (`search` part, server log): units in scope, targets, placed/unplaced per reason, judge calls, candidates tried, rejections per class (unit/time/resource), packings rebuilt, status.
- **Never logged:** person or entrant ids beyond the report's. Diagnostics are never persisted as schedule state.

## 29. Performance

**Measured judge cost at `39c0583`:**

| Case | Time per evaluation |
|---|---|
| 5 000 assignments (50 courts, 500 entrants) | ≈ 0.3–0.5 s |
| 128-entrant knockout (127 matches) | ≈ 15 ms |

**Estimates (greedy, whole-schedule evaluation per candidate):**

| Scenario | Contests / units | Resources | Judge calls (typical) | Cost per call | Expected |
|---|---|---|---|---|---|
| Small | 10–20 | 2–4 | ~50–200 | ≤ 5 ms | < 1 s |
| Medium | 50–100 | 4–16 | ~500–2 000 | 5–20 ms | seconds to ~30 s |
| Large | 250+ (or ≥ 2 000 assignments, e.g. 300 bowlers × 6 blocks) | 16–50 | ~2 000–10 000 (budget) | 50–400 ms | minutes; `SEARCH_EXHAUSTED` possible |

- **Branching factor:** greedy has none across units. Within a unit the worst case is `|T| × |R|`, reduced by class-guided skipping:
  - a time-scoped rejection skips every resource at that instant;
  - a resource-scoped rejection excludes the resource.
- **Where naive fails:** the total cost is `O(U · K · N log N)`: units × candidates per unit × one competition-wide judgment. Beyond a few thousand assignments, each judgment costs hundreds of ms, and with ≥ 1 000 units the run reaches the budget.
- **Commit cost:** recomputation doubles the preview's cost.
- **Mitigation path (deferred, ADR required):** a 05E-D "prepared input / evaluate many" or delta API, proven by property tests to return the same report as `evaluateSchedule`; or proposal persistence to avoid recomputation at commit. Neither is introduced now (correctness first, ADR-0074 D1).

**Measured proposal-engine cost (05E-E implementation, `proposeSchedule`, real canonical plans and templates, about 11 ms per judge call at these sizes):**

| Case | Judge calls | Time | Status |
|---|---|---|---|
| 31-match knockout, 8 courts | 798 | ≈ 8.8 s | `SUCCESS` |
| 28-match round robin, 4 courts | 598 | ≈ 6.3 s | `SUCCESS` |
| 127-match knockout, 16 courts | 10 000 (run budget) | ≈ 143 s | `SEARCH_EXHAUSTED` |
| 120-match round robin, 4 courts | 10 000 (run budget) | ≈ 81 s | `SEARCH_EXHAUSTED` |

**Known v1 limitation (accepted).** v1 proposal search is correctness-first and bounded by judge-call budgets. A sufficiently large competition may return `SEARCH_EXHAUSTED` even when a feasible schedule exists.

- **Why it happens:** a resource-scoped rejection excludes only the named resource at the current instant (ADR-0075 § 8). So each unit re-tries every busy resource at every intermediate breakpoint, and the call count grows roughly quadratically with the number of resources.
- **Why the result stays honest:** budget exhaustion is reported as such and never as infeasibility.
- **Future work** (each gets its own ADR when chosen; neither is part of v1):
  - (a) judge-guided candidate skipping, using information the judge already returns (for example a conflict's `expected` earliest start), removing only candidates the judge rejects;
  - (b) an incremental or prepared judge API.

**`SEARCH_EXHAUSTED` is never `INFEASIBLE`:**

| Status | Meaning |
|---|---|
| `INFEASIBLE` | The search completed within budget and established that no acceptable placement exists for at least one unit within the v1 greedy search space (given the preserved content and earlier placements) |
| `SEARCH_EXHAUSTED` | The search was stopped because its permitted judge-call budget was exhausted. Nothing is concluded about the units it did not finish deciding |

## 30. Security

- The server loads every authoritative value (E15, D14).
- Clients send only `versionId`, `scope`, `from`, `proposalHash` and an idempotency key. Client resources, availability, profiles, hashes-as-truth, feasibility, objective scores and placements are never accepted.
- Commit recomputes, and never trusts a presented placement list.
- Permissions: `COMP_MANAGE_SCHEDULE` (OWNER, ADMIN, SCHEDULER) for preview and commit, resolved server-side. Commit requires an authenticated human account, like other draft edits.
- No machine path publishes.

## 31. Test matrix

**Rule for every suite: the main integration path uses the real `evaluateSchedule`, never a mock.** Every accepted placement must pass the judge. A property test asserts that the final report over base ⊕ placements has no HARD conflict listing a placement id.

| Area | Cases |
|---|---|
| Basic | One contest / one resource; many contests; many resources; no compatible resource (`NO_COMPATIBLE_RESOURCE`); no declared time (`NO_DECLARED_TIME`); no horizon (`NO_HORIZON`); profile-less event (`NO_PROFILE`); event not FIELD_LOCKED (`EVENT_NOT_SCHEDULABLE`); nothing to place |
| Resource | EXCLUSIVE sequencing with changeover; SHARED capacity (ENTRANT sums); R3 capacity bound on an EXCLUSIVE lane pair; key siblings (full vs half court, re-paired lanes); RETIRED excluded; type mismatch never proposed; changeover past closing time is not proposed |
| Time | Earliest valid start; window start/end boundaries (touching = valid); `from` respected; candidate instants all whole seconds; legacy sub-second anchor rounds up; DST: New York spring-forward/fall-back windows; America/Costa_Rica; window crossing midnight |
| Availability | Undeclared time never proposed (B5), even when it is the only free time (→ `NO_DECLARED_TIME` / `NO_FEASIBLE_CANDIDATE`); declared closure (blackout, DATE_CLOSED) avoided |
| Participants | Cross-event person overlap avoided; team vs person; rest SOFT accepted at the earliest feasible instant and reported (never delays the placement); rest HARD never violated; dependency lead respected; daily limit HARD respected in the event zone; daily limit SOFT reported, not avoided; possible occupants (provisional placement of a materialized contest with unresolved places) |
| Groups | Grouped unit, common start; squad packed over k EXCLUSIVE pairs in member/resource order; SHARED grouped unit on one resource; inherited round-2 groups; regroup after cut (`{3, DESC}`); `PARTIALLY_PLACED`; `ALL_VACANT`; no split/merge ever |
| Existing schedule | Locked preserved; manual preserved; carried published preserved; migrated preserved; removed-in-draft re-placed; **no accidental deletion or move** (diff of live facts before/after commit = additions only); pre-existing HARD conflicts reported in `baseHardConflicts`, never attributed to placements |
| States | STALE place → `STALE_OCCUPANT`; feeder unplaced → `FEEDER_UNPLACED`; settled and cancelled contests never targeted |
| Search | Time-major (second court used at the same instant); class-guided skipping equals a brute-force search (property, small inputs); packing rebuild bounded; the greedy result equals the earliest feasible instant found by exhaustive whole-second search on small inputs (property); unit-budget and run-budget exhaustion report `BUDGET_EXHAUSTED`/`SEARCH_EXHAUSTED`, never `INFEASIBLE`; budget values recorded in the proposal; no infinite loop (finite domain property) |
| Determinism | Same input ⇒ byte-identical proposal and hash; shuffled input arrays ⇒ same; repeated runs ⇒ same; fake clock / no clock access; fixed locale |
| Hash | Same semantic input ⇒ same `baseStateIdentity`/`proposalHash`; each meaningful change (fact, lock, resource revision, availability, profile, zone, window, 05D state, new contest, scope, `from`) ⇒ different; diagnostics/evaluation time ⇒ same |
| Commit | Stale (a draft edit, a 05D commit, a resource revision between preview and commit) ⇒ `PROPOSAL_STALE`; all-or-nothing; idempotent replay; facts are MANUAL with reason `proposal <hash>`; audit + outbox; never publishes; permission (stranger, registration manager refused; SCHEDULER allowed) |
| API | Route inventory updated: the 05E-B and 05E-C inventory regexes (`schedul\w*-proposal`, `schedule-proposal`) must be revised deliberately to admit exactly the two new routes; no `generate-schedule`, `auto-publish` or optimizer route |
| Sport | All eight sports (§ 32) from real format-engine plans and canonical templates; source guard: no sport, discipline, engine or resource-type branch in E modules |

## 32. Cross-sport validation

Every row is expressed only by plan, 05D, profile, resource and availability data. "Unit" comes from `deriveUnitKeys`; "packing" is E9.

| Sport | Unit | Resource · mode | What E chooses | What binds (judged by D) | Sport code? |
|---|---|---|---|---|---|
| Tennis | Match | TENNIS_COURT · EXCL | Start + court (time-major across courts) | R1 + 600 s changeover; rest 3 600 SOFT (reported); lead 900; 2/day SOFT | No |
| Padel | Match | PADEL_COURT · EXCL | Start + court | Same family; 3/day SOFT | No |
| Marathon (running.road) | Race contest or wave contest | ROAD_COURSE · SHARED | Start on the one course | R2 runners on course; spacing 900; concurrency 1; 1/day HARD | No |
| Swimming | Heat | POOL · EXCL | Start + pool | R1 + 60 s; rest 1 800 SOFT; lead 1 800 heats → final | No |
| Cycling | Race / time-trial session / stage | CYCLING_COURSE · SHARED (EXCL twin by keys) | Start + course | R2; spacing 300; 1/day HARD; R4 between twins | No |
| Bowling (ten-pin) | Squad (plan partition), inherited squad, ladder match | BOWLING_LANE_PAIR · EXCL | Start + packing over k pairs | R1 + 900/300 s; R3 bowlers per pair; R4 re-paired lanes; WINNER edges + lead 300 | No |
| Basketball (incl. wheelchair) | Game | BASKETBALL_COURT / HALF_COURT · EXCL | Start + court | R1 + 900/300 s; R4 full vs halves; rest SOFT; 1/day SOFT. Wheelchair = same discipline data, same template | No |
| Golf | Tee group (plan), inherited group, regroup after cut, match | GOLF_COURSE · SHARED | Start on the course | R2 players; spacing 600; concurrency 2; 1/day HARD; cut lead | No |

**Catalog gaps carried in** (data, not engine): track and open-water templates; a bowling template with `regrouping`. These units are `NO_PROFILE` (no pinned template), or schedule as singletons, which is safe but inefficient.

### Bowling

| Requirement | Representation |
|---|---|
| Squad scheduling unit | `partition:<round>:<tN>` (plan) |
| Common start | One `t` for every member (E4); `UNIT_SPLIT start` impossible by construction |
| Lane-pair resources, exclusive occupancy | BOWLING_LANE_PAIR, stored `occupancyMode` EXCLUSIVE |
| Multi-resource squad assignment | E9 packing: members in member order onto pairs in id order, Σ places ≤ capacity per pair; pairs named by R1/R4/unavailability conflicts excluded and the packing rebuilt |
| Capacity | R3 judged by D; packing uses the same B2 consumption only to construct |
| Later-round inherited groups | Inherited `partition:` keys (non-dynamic rounds); post-cut blocks = singletons until a template declares `regrouping` |
| Bowling-specific code | None |

### Golf

| Requirement | Representation |
|---|---|
| Tee groups | Plan partitions round 1, inherited round 2, `regroup:` after the cut |
| Shared course | GOLF_COURSE SHARED: all members on one course |
| 600 s spacing, 2 concurrent starts | Profile data, judged by D (B4). `T` contains `slot + 600`, and the same slot instant twice is allowed until concurrency rejects a third |
| Daily limit | 1/day HARD in the event zone, judged by D |
| Tees | Not resources; `startingTees` descriptive (I-B4.4) |
| Golf-specific code | None |

## 33. Deferred features

- Move-capable mode (persisted origin, movable set).
- Persisted proposals and partial commit.
- Completing partially-placed units.
- Backtracking, beam, CP and optimizers (new strategy ids).
- Objectives (span, gaps, utilization, idle time) and fairness: no product requirement, no profile data.
- Organizer preferences (preferred resource or window, avoid times): no data model. They must not be ad-hoc metadata.
- Incremental or prepared evaluation in 05E-D.
- Seeded randomness (only as explicit hashed input).
- Live rescheduling after results.
- Stage, round or session windows.
- Lineup-based identity, `PERSON` capacity unit and the three uncovered codes (ADR-0074 deferrals).

**Golden vectors — decision.**
- Scheduling and the competition package have no vectors today. `pnpm vectors:check` covers canonical, evidence, verification, achievements, records and rankings, each with a Python reference checker.
- 05E-E adds **golden proposal fixtures** as vitest tests with pinned hashes: input, expected placements, expected report hash, expected `proposalHash`. Representative fixtures:
  - tennis knockout on 2 courts;
  - golf tee groups;
  - bowling squad over pairs;
  - waves on a road course;
  - an INFEASIBLE case;
  - a SEARCH_EXHAUSTED case.
- CI runs them on Node 22 and 24 (the `foundation` matrix), with shuffled input order.
- Adding scheduling to `vectors:check` with an independent reference checker is deferred. It would require a second-language implementation of the judge, which is out of scope.

### Architectural gaps

| Area | Frozen? | Implemented? | Ambiguous before this audit? | Decision |
|---|---|---|---|---|
| Proposal definition | ADR-0070 §2, ADR-0071 §6 (outline) | No | Snapshot vs delta; storage | E2 |
| Candidate representation | ADR-0074 §24 (synthetic ids) | No | Id form | E12, § 7 |
| Scheduler input | ADR-0074 D2 (judge input) | Loader exists | Request vs authoritative parts | E15, § 5 |
| Existing assignment treatment | ADR-0070 §8 (locks only) | No | Unlocked manual / carried | E3 |
| Fixed assignments | `locked` column exists | Yes (05E-C) | Fixed vs locked | E3 (all live = fixed; no new field) |
| Candidate time generation | — | No | Grid constant forbidden | E10 |
| Candidate resource generation | ADR-0071 §5 | No | Time- vs resource-major | E7, E10 |
| Grouping | ADR-0073 B9 | `deriveUnitKeys` | Packing loop | E9 |
| Objective hierarchy | ADR-0071 §5 (earliest feasible) | No | SOFT handling | E8/E10: ADR-0071 order unchanged; SOFT reported only |
| Soft warnings | ADR-0073 B5 (undeclared only) | No | Other SOFT codes | E18: reported, never change the selection |
| Hard feasibility | ADR-0074 D15 | Judge | — | E8 |
| Search strategy | ADR-0071 §5 (greedy) | No | — | E11 |
| Deterministic ordering | ADR-0071 §5 (partial) | No | Tie-breakers; §18.5 | E6 |
| Backtracking | — | No | Not addressed | E11 (none) |
| Search budget | — | No | Not addressed | E12 |
| Infeasibility | ADR-0071 §5 ("reported") | No | Statuses vs reasons | E11 |
| Proposal result | ADR-0074 §24 (records) | No | Shape | E13 |
| Proposal hash | ADR-0071 §6 | No | Content; vs report hash | E14 |
| Proposal persistence | — | No | — | E2 (ephemeral) |
| Apply/accept semantics | ADR-0070 §9, ADR-0073 B1 | No | Provenance without migration | E16 |
| API boundary | Architecture §14 | No | Paths | E15/E16 (paths deferred) |
| Concurrency | ADR-0070 §9 | Publish only | Draft-edit staleness | E17 |
| Idempotency | ADR-0070 §9 | 05E-C keys | — | E17 |
| Observability | — | No | — | E19 |
| Performance | ADR-0074 Q6 deferred | Judge measured | Whole-schedule cost | § 29, deferred API |

### Discrepancies found (documents vs code)

1. **ADR-0070 §9** (version check on edits) vs code (checked at publish only). Proposal commit compensates by recomputing (§ 26).
2. **ADR-0070 §8** permits the engine to move unlocked, unstarted assignments. ADR-0075 keeps that as architecture (§ 6), and **v1 scopes it** to additive-only (§ 7). ADR-0070 is not edited.
3. **ONCF-05E-ARCHITECTURE §16** lists 05E-E as "no migration". This holds only because commit writes `MANUAL` facts; `source` has no proposal value (`0037` CHECK).
4. **Contest universe:** ADR-0054 / plan docs describe an immutable plan, but 05D `materialize` adds contests after a cut. E treats the contest set as input (in `baseStateIdentity`).
5. **Name collision:** `unit_key` means a 05D advancement unit in `advancement_decision` and a 05E occupancy unit in `schedule_assignment`. E uses only the latter.
6. **Timezone comment:** the `competition_profile.timezone` comment says "display context only", but scheduling uses it semantically. Separately, the store's `UTC` fallback is unreachable (the column is NOT NULL). Both are harmless and noted.
7. **ONCF-05E-C doc** still describes the baseline validator as in force; ONCF-05E-D retired it from commands.
8. **Report and conflict keys hash assignment ids,** so preview keys and hashes cannot be reused after commit (E14).
9. **Existing inventory tests** (`apps/api/src/oncf05e-b.int.test.ts`, `oncf05e-c.int.test.ts`) forbid `schedule-proposal` / `schedul\w*-proposal` URLs. 05E-E must revise them deliberately.
10. **ADR-0071 reconciliation:** ADR-0075 §23 classifies every ADR-0071 proposal semantic as UNCHANGED, CLARIFIED, EXTENDED or V1 SCOPED. Nothing is superseded. An audit draft's "avoid SOFT first" rule was withdrawn because it would have replaced the earliest feasible interval.

## 34. Handoff to implementation

05E-E must:
1. Factor `ScheduleStore.report`'s input assembly into one shared loader. Keep `validate` and `publish` byte-identical in behaviour (their reports and hashes unchanged).
2. Implement `proposeSchedule` (pure) per E1–E20.
   - It calls `evaluateSchedule` with no modification to 05E-D.
   - It contains no rule copy and no sport branch.
   - Classifying conflict codes for search guidance is the only code-keyed table. It is exhaustive over `CONFLICT_CODES`, with resource-scoped as the default class.
3. Add preview and commit to `ScheduleStore`.
   - Commit: recompute, compare, then write all placements inside one transaction through the existing per-fact insert path.
   - Facts are `MANUAL`, reason `proposal <hash>`, by the human actor.
   - Emit one `schedule.proposal_committed` audit and outbox entry.
4. Add two routes (`COMP_MANAGE_SCHEDULE`) and revise the two inventory tests deliberately.
5. Add the § 31 matrix, the § 32 cross-sport suite and the golden fixtures (§ 33). Extend the sport-identity source guard.
6. No migration, no package change, no change to 05E-A/B/C/D semantics. If implementation finds that any of these is required, stop and raise an ADR.

## 35. Preview integration (ONCF-05E-E-2)

The pure engine (PR #13) is connected to authoritative state through one read-only path. Commit, persistence of proposals, UI and any background execution are **not** part of this slice.

```
POST /v1/schedule-versions/:versionId/proposals/preview      (COMP_MANAGE_SCHEDULE · read-only)
  → ScheduleStore.previewProposal
      05D target states (read just before the transaction, as validate)
      authorize (COMP_MANAGE_SCHEDULE; closed competitions refused as for validate)
      SET TRANSACTION READ ONLY                       ← PostgreSQL refuses any write from here
      evaluationInput(version)                        ← the SAME loader validate / publish use (§ 34.1)
      + event lifecycle states, latest plan offsets, base PUBLISHED version id
      → proposeSchedule(input)                        ← the only search; evaluateSchedule the only judge
  ← { versionId, competitionId, proposal: <canonical body + proposalHash>, diagnostics }
```

| Concern | Decision |
|---|---|
| Route | Under `/v1/schedule-versions/:versionId/` as ADR-0075 § 24 defers it. The version is the open draft; another status is `INCOMPLETE_STATE`. More than one open draft (a schema invariant) fails closed (`AMBIGUOUS_DRAFT`) |
| Shared loader | `ScheduleStore.report`'s input assembly is factored into `evaluationInput`, with no behaviour change: `validate` / `publish` reports and hashes are byte-identical |
| Request | Closed JSON object body (`{}` at minimum, as for the other closed-body commands): optional `scope {eventIds?, roundIds?}` (UUIDs, unique) and optional `from` (ISO-8601 instant, whole seconds). Any other field is a 400. `from` never defaults to the clock. No idempotency key: nothing is written |
| Scope | Validated against the loaded competition (its events, the rounds of its contests). A foreign or unknown id is `INVALID_INPUT` `FOREIGN_SCOPE`, with a fixed message that never echoes the id |
| Response | `proposal` is the engine's canonical body with its `proposalHash` (no API-side hashing or serialization); `diagnostics` (judge calls, skips, rebuilds) are returned beside it and never hashed |
| Read-only | Authorization first (a denial may audit, as everywhere), then `SET TRANSACTION READ ONLY`. No lock, audit, outbox or idempotency record. Proved by a byte-level snapshot of every scheduling, resource, availability, pin, projection, audit and outbox row of the competition before and after, and by a probe that attempts a write inside the transaction and is refused by PostgreSQL |

**Error mapping** (existing HTTP conventions, `errorBody`):

| Condition | Domain error | HTTP |
|---|---|---|
| Malformed body, unknown field, bad `from`, foreign scope, engine `INVALID_INPUT` | `INVALID_INPUT` | 400 |
| No authentication | `UNAUTHENTICATED` | 401 |
| No `COMP_MANAGE_SCHEDULE` on the version's competition | `FORBIDDEN` | 403 |
| Unknown version | `NOT_FOUND` | 404 |
| Version not the open draft (engine `INCOMPLETE_STATE`), closed competition, ambiguous draft | `INVALID_TRANSITION` (message names `INCOMPLETE_STATE`) | 409 |
| `SUCCESS`, `NOTHING_TO_PLACE`, `INFEASIBLE`, `NO_CANDIDATES`, `SEARCH_EXHAUSTED` | — (a proposal) | 200 |

**Interpretations recorded (no ADR change):**
- `NO_PROFILE` and `EVENT_NOT_SCHEDULABLE` stay per-unit reasons (ADR-0075 § 13). They are not targets, so they never make a run `INFEASIBLE`; a run with only such units is `NOTHING_TO_PLACE` with the reasons listed.
- A preview of a large competition runs inside one read-only transaction for as long as the engine needs (bounded by the logical budget, § 29). No wall-clock guard is added in this slice.

**Tests:** `packages/persistence/src/oncf05e-e.int.test.ts` (statuses, refusals, authorization, scope, `from`, read-only proofs, determinism, one event per sport through the same loader with grouped / shared / exclusive resources, and a source guard on the preview path) and `apps/api/src/oncf05e-e.int.test.ts` (HTTP authorization, closed body, response shape, observable read-only, byte-identical repeats, route inventory). The 05E-B / 05E-C inventory tests list the preview route.
