# ADR-0073 — Scheduling Semantics Clarifications & Resource Occupancy Model

- **Status:** Proposed (frozen for ONCF-05E-C / 05E-D / 05E-E implementation once approved)
- **Date:** 2026-10-09
- **Origin:** ONCF-05E readiness audit after PR #9 (ONCF-05E-B merged at `cc2cf97`). Clarifies [ADR-0066](./ADR-0066-scheduling-boundary-and-competition-scope.md), [ADR-0067](./ADR-0067-generic-competition-scoped-resources.md), [ADR-0068](./ADR-0068-availability-and-scheduling-time-model.md), [ADR-0069](./ADR-0069-scheduling-profile-is-a-versioned-axis.md), [ADR-0070](./ADR-0070-schedule-versions-publication-and-history.md), [ADR-0071](./ADR-0071-conflict-semantics-and-deterministic-proposals.md) and [ADR-0072](./ADR-0072-scheduling-profile-spec-v1.md). Those ADRs are not edited. Where this ADR narrows or supersedes one of their statements, it says so explicitly (§ "Relationship to ADRs 0066–0072").

## Context

ONCF-05E-A (resources and availability) and ONCF-05E-B (SchedulingProfile v1) are implemented and merged. 05E-C (schedule model), 05E-D (conflict engine) and 05E-E (proposals) are next. The readiness audit found nine places where the frozen ADRs either leave two reasonable implementations possible, or state a rule that the implemented data cannot satisfy for every proof sport. These must be settled before any schedule code exists.

**Repository evidence this ADR rests on** (verified in code at `cc2cf97`, not only in documents):

| Area | What exists | Where |
|---|---|---|
| Resource | `{typeCode, label, attributes, capacity 1–100 000, exclusivityKeys[] (≤ 8), timezone?, status}`; append-only revisions | `packages/competition/src/resources/resource.ts`, migration `0035` |
| Occupancy label | `occupancyOf(r)` returns `EXCLUSIVE` iff `capacity === 1`, else `SHARED_CAPACITY`; exposed by the resource read API (`resource-store.ts`) | `resource.ts:180` |
| Physical overlap | `sharesSpace(a, b)`: same id, or the exclusivity-key sets intersect (full court `{a,b}` overlaps halves `{a}`, `{b}`; halves don't overlap) | `resource.ts:185` |
| Availability | WEEKLY / DATE_OPEN / DATE_CLOSED / BLACKOUT / MAINTENANCE facts; a layer with no WEEKLY window is **unrestricted** on dates without an exception | `resources/availability.ts` |
| Interval | Half-open `[start, end)` on epoch ms; one canonical primitive | `resources/interval.ts` |
| Profile spec v1 | `requirements[] {selector, resourceType, capacityUnit CONTEST\|ENTRANT, expectedDurationSeconds, changeoverSeconds, startSpacingSeconds?, concurrentStarts? (canonical default 1), rest?, dependencyLeadSeconds?, maxUnitsPerEntrantPerDay?}`, `regrouping?` | `scheduling/profile.ts` |
| Templates | Nine COMMON_PRACTICE templates (tennis, padel, road waves, pool heats, cycling, bowling, basketball, 3x3, golf) | `scheduling/templates.ts` |
| Plan v2 | Stages (`FIELD`/`HEATS`/`KNOCKOUT`/`ROUND_ROBIN`) with `partition {kind LOGISTIC\|COMPETITIVE, method}`; contests with `partitionKey`, `slots`, `entries[].startOffsetSeconds`; dynamic rounds (`dynamicEntry`) | `format/plan-v2.ts` |
| Grouped entrants | `multi-round` / `stableford` / `qualifying-knockout` build **per-entrant SERIES contests**; round 1 gets partition keys `t1…tn` in blocks of `groupSize` (default 4); **later non-dynamic rounds get no partition key**; dynamic rounds have no contests until 05D materializes them | `format/engines-v2.ts` (`buildMultiRound`) |
| Waves / heats | `wave-start`: one HEAT contest per wave (`w1…`), stage method `WAVE_START`; lane heats: one HEAT contest per heat, slots = lanes | `format/engines-v2.ts` |
| 05D | Field targets `(transition, ordinal)`; states RESOLVED / VACANT / HELD / STALE; `v_contest_occupant`; dynamic-round contests materialized "with no time, venue or grouping" | `advancement/resolve.ts`, ONCF-05D doc §"Known limitations" |
| Schedule today | `competition.contest_schedule` (one row per contest, `scheduled_start`, nullable `scheduled_end`, `court_label`), overwritten in place; written by `scheduleContest` under `COMP_MANAGE_SCHEDULE` | migration `0008`, `competition-structure-store.ts` |
| Permissions | `COMP_MANAGE_SCHEDULE` held by OWNER, ADMIN and SCHEDULER; `COMP_EDIT` by OWNER, ADMIN; `COMP_CANCEL` by OWNER, ADMIN | `permissions.ts` |
| Contest status | `PLANNED, SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED, VOID` | migration `0008` |
| Event time | `event.timezone` (IANA, NOT NULL), `event.starts_at` / `ends_at` (nullable) | migration `0008` |
| Participants | Individual athlete; team with a roster frozen at field lock (ADR-0057); declared contest lineups | ONCF-05B |

## Problem Statement

Nine ambiguities (B1–B9) would let two reasonable engineers build incompatible 05E-C/D/E systems:

| # | Ambiguity | Why it matters |
|---|---|---|
| B1 | Where 05E-C stops and 05E-D starts, and who may publish | ADR-0070 publication "requires zero hard conflicts", but the conflict engine is a later phase |
| B2 | Capacity vs exclusivity | ADR-0067 and `occupancyOf` equate `capacity = 1` with exclusive; the bowling template uses `ENTRANT` units on a lane pair whose capacity is > 1 |
| B3 | Changeover on shared and composite resources | ADR-0072 defines changeover only "on an exclusive resource" |
| B4 | Start spacing and concurrent starts | "consecutive unit starts" and "same instant" are undefined across units, requirements and ties |
| B5 | "Unrestricted" availability | Could be silently read as "open 24/7" |
| B6 | `maxUnitsPerEntrantPerDay` | "unit", "entrant" and "day" undefined |
| B7 | Conflict report shape and order | No stable sort keys; database order would leak |
| B8 | Possible occupants, lead, rest | Profile values vs concrete intervals; risk of collapsing durations into one interval |
| B9 | Grouped entrants and multi-resource claims | Squads larger than one resource, later rounds without groups, identity of 05E-formed groups |

## Decision

1. **Phase boundary and publication authority (B1).**
   - 05E-C owns the schedule representation, 05E-D owns conflict and feasibility semantics, and 05E-E owns proposals. Dependencies run C → D → E only.
   - Publication consumes a conflict report through a frozen contract, and every report declares which checks it covers.
   - Only a human actor holding `COMP_MANAGE_SCHEDULE` publishes, through the explicit publish command.
2. **Physical facts live on the resource; expected start behaviour lives on the profile (B2).**
   - A resource declares its **occupancy mode** (`EXCLUSIVE` or `SHARED`) explicitly, next to its capacity and exclusivity keys.
   - Capacity never decides exclusivity, and neither do profile start parameters.
   - SchedulingProfile spec v1, its hashes and its templates stay unchanged.
3. **Claims (B2, B9).**
   - An assignment claims exactly one identified resource per contest, with a derived consumption count.
   - A scheduling unit claims the set of resources its member contests use. It may span several resources only if every one of them is `EXCLUSIVE`.
   - Composite physical space is expressed only by exclusivity keys.
4. **Changeover belongs to sequential use (B3).** It extends a claim's blocking interval on an `EXCLUSIVE` resource and its key siblings. It has no effect on a `SHARED` resource.
5. **Start events (B4).** Spacing and concurrency apply to unit start events on one `SHARED` resource, with a deterministic order inside a start instant.
6. **Unrestricted is not open (B5).** It never produces `RESOURCE_UNAVAILABLE`, always produces a SOFT `AVAILABILITY_UNDECLARED` warning, and the proposal engine never places a unit in undeclared time.
7. **Daily limit (B6).** The limit counts scheduling units, per event entrant, per requirement, per local date of the unit's start in the event's timezone, within the one schedule version being evaluated.
8. **Conflict report (B7).** The report is canonical and hashed, records its inputs, and is totally ordered by frozen sort keys.
9. **Profile vs resource vs assignment (B8).**
   - The profile supplies expected values and constraints.
   - The resource supplies physical and operational facts.
   - The assignment stores the concrete claim, interval and changeover.
   - Possible occupants feed participant checks only. Lead and rest are independent lower bounds that are never summed.
10. **Grouped entrants (B9).** A unit is a contest, a plan partition, an **inherited** plan partition, or a profile regroup. Unit identity is derived deterministically. 05E never splits or merges plan partitions.
11. **No sport-name conditionals, anywhere (Phase 7).** Every behaviour above comes from catalog, plan, resource, profile or 05D data.

## Detailed Decisions

### Vocabulary used below

| Term | Meaning |
|---|---|
| **Place** | One entrant position of a contest: a plan slot, a field entry, or a 05D-materialized field place. Known before its occupant |
| **Entrant** | The event participant (individual or team) occupying a place. A team is one entrant |
| **Person** | An athlete. For a team entrant, the persons are its frozen roster (ADR-0057); ADR-0071 §2 identity |
| **Scheduling unit (unit)** | One or more contests of one round that start together (ADR-0072 §5, refined in B9) |
| **Member contest** | A contest belonging to a unit |
| **Requirement** | The SchedulingProfile requirement a contest resolves to (`resolveRequirement`, ADR-0072 §6) |
| **Assignment** | ADR-0070's append-only per-contest fact: start, expected end, changeover, resource, zone, flags |
| **Claim** | The occupancy one assignment places on one resource (§ B2) |
| **Occupancy interval O** | `[start, expectedEnd)` of an assignment |
| **Blocking interval B** | `O`, extended by changeover on an `EXCLUSIVE` resource (§ B3) |
| **Start event** | A unit's start instant on a resource (§ B4) |

---

### B1 — Phase boundary

**Problem.** ADR-0070 §4 makes publication require "zero hard conflicts", and ADR-0070 is scheduled for 05E-C. The conflict engine (ADR-0071) is 05E-D, which depends on 05E-C. Read literally, 05E-C cannot publish without 05E-D, and 05E-D cannot exist without 05E-C. The readiness audit also found earlier analysis describing conflict logic as part of "the schedule model".

**Competing interpretations.**

| Option | Consequence |
|---|---|
| (a) Move publication to 05E-D | 05E-C would switch `POST /v1/contests/:id/schedule` to draft-only editing (ADR-0070 §6) with no way to publish. That leaves a window in which the public schedule cannot change |
| (b) 05E-C publishes with no validation | Silently weakens ADR-0070 §4 |
| (c) **05E-C defines the report contract and the gate; the validator in force fills it** | No cycle, no unvalidated publication, and nothing in ADR-0070 is lost |

**Selected: (c).**

| Phase | Owns | Never does |
|---|---|---|
| **05E-C** — schedule model | Versions and statuses; append-only assignments (per contest); claims as stored data (resource, interval, changeover); unit key recorded on each assignment; locks; provisional flag; publication command, its gate and its authority (§ Publication authority); `contest_schedule` as the published projection; history; migration of existing rows; the resource `occupancyMode` column (§ B2); **the conflict-report contract** (types, codes vocabulary, canonical form, hash); write-time **integrity refusals** (unknown contest, resource of another competition, malformed or non-whole-second interval, writing to a RETIRED resource, moving a locked assignment without unlock) | Decide overlaps, capacity, spacing, rest, availability or dependency feasibility |
| **05E-D** — conflict / feasibility engine | The pure function `(schedule content, inputs) → ConflictReport` implementing ADR-0071 + this ADR; possible occupants; every HARD/SOFT code | Write schedules; read the database; propose placements; publish |
| **05E-E** — proposals | Deterministic candidate generation (ADR-0071 §5), preview hash, commit **into the draft only** | Mutate or publish a version; bypass the conflict engine; use randomness, wall-clock or AI |

**Dependency direction.**

```
05E-A resources/availability ─┐
05E-B SchedulingProfile ──────┼─▶ 05E-C schedule model ─▶ 05E-D conflict engine ─▶ 05E-E proposals
05B plan · 05D occupants ─────┘        ▲ (report contract)          │
                                       └──── report (data) ──────────┘
```

05E-C depends on the report **contract** (a type it defines), not on 05E-D code. 05E-D depends on 05E-C's schedule-content type. 05E-E depends on 05E-D. Nothing points backwards.

**Invariants.**
- **I-B1.1** Publication requires a conflict report, computed over exactly the draft content being published, with zero HARD conflicts. Its hash is recorded with the publication (ADR-0070 §4 unchanged).
- **I-B1.2** Every report declares its **coverage**: the set of conflict codes the validator evaluated, plus the validator's identity and version. A report with partial coverage never claims feasibility for codes outside its coverage.
- **I-B1.3** Until 05E-D lands, 05E-C's validator in force is a **baseline validator**. Its coverage is limited to checks decidable from 05E-A/B data without the 05E-D engine (for example `RESOURCE_TYPE_MISMATCH`). 05E-D replaces it without changing the contract.
- **I-B1.4** 05E-E output enters the draft only through a hash-confirmed commit (ADR-0071 §6). The published version changes only through publication.

**Example.** In 05E-C, an organizer moves a tennis match to court 3 and publishes. The baseline report covers `{RESOURCE_TYPE_MISMATCH}` and finds nothing, so publication records the report hash and coverage. After 05E-D ships, the same publication would also evaluate `RESOURCE_OVERLAP`, `PARTICIPANT_OVERLAP` and the other codes. Old publications stay honest because their recorded coverage says what was checked.

#### Publication authority (frozen for 05E-C)

ADR-0070 §11 set `COMP_MANAGE_SCHEDULE` as the publication permission and left a separate publish permission conditional on evidence. ONCF-05E-ARCHITECTURE §18.6 listed it as a product question with that default. No such evidence exists, and `permissions.ts` already grants `COMP_MANAGE_SCHEDULE` to OWNER, ADMIN and SCHEDULER (today's `scheduleContest` uses it). The question is closed:

| Question | Frozen answer |
|---|---|
| Permission | `COMP_MANAGE_SCHEDULE` on the competition, resolved server-side from the database (never from the request). No new permission and no publish-only role in v1 |
| Roles | Whoever holds it under `permissions.ts`: OWNER, ADMIN, SCHEDULER |
| Who acts | An authenticated **human account**, through the explicit publish command only |
| Never publishes | The proposal engine; committing a proposal; a draft edit; background jobs, timers or outbox consumers; catalog/operator roles (`br_catalog`); any automatic or scheduled publication |
| SOFT acknowledgement | Made by the publishing actor in the same command. It records the actor, the report hash and the acknowledged conflicts by their canonical keys (B7). An acknowledgement never carries over to a different report |
| Preconditions | Competition not COMPLETED or CANCELLED; the draft is the open draft; base-version check and idempotency key (ADR-0070 §9); the report is current for exactly the draft content (stale → refused) |
| Neighbouring acts | Draft edits, proposal commit, lock/unlock and discard: `COMP_MANAGE_SCHEDULE`. Resources, availability and profile pin: `COMP_EDIT`. Cancel/void: `COMP_CANCEL` (all ADR-0070 §11, unchanged) |
| Audit | Publication writes `platform.audit_event` plus an outbox event with actor, version, superseded version, report hash, coverage and acknowledgements (ADR-0070 §10) |
| Changing it | Splitting publication into its own permission requires a new ADR. It is not a configuration toggle |

---

### B2 — Capacity vs exclusivity / occupancy

**Problem.** ADR-0067 §3 and 05E-A's `occupancyOf` derive exclusivity from capacity (`capacity = 1` ⇒ exclusive). ADR-0072 §8 then gives capacity a unit (`CONTEST` or `ENTRANT`), and the canonical bowling template uses `ENTRANT` on `BOWLING_LANE_PAIR`. A lane pair that holds four bowlers therefore has capacity 4 and would be classified `SHARED_CAPACITY`. Two different squads could then overlap on one pair whenever their bowler counts fit (2 + 2 ≤ 4), which is physically wrong.

**Five concepts that must not be merged.**

| Concept | Question it answers | Declared on | Field |
|---|---|---|---|
| Physical exclusivity between resources | Do two **different** resources occupy the same space? | Resource | `exclusivityKeys` (05E-A) |
| Simultaneous occupancy | May two **independent units** be on **this** resource at once? | Resource | **`occupancyMode`** `EXCLUSIVE \| SHARED` (new, this ADR) |
| Capacity | How much does the resource hold? | Resource | `capacity` (05E-A) |
| Consumption unit | What does one unit consume of that capacity? | Profile requirement | `capacityUnit` (ADR-0072) |
| Start spacing | How far apart must consecutive starts be? | Profile requirement | `startSpacingSeconds` (ADR-0072) |
| Concurrent starts | How many units may start at one instant? | Profile requirement | `concurrentStarts` (ADR-0072) |

**Competing interpretations.**

| Option | Assessment |
|---|---|
| (a) Keep `capacity = 1 ⇔ exclusive` | Fails the bowling block (and any capacity-bounded exclusive use) |
| (b) Derive the mode from the requirement: shared iff `startSpacingSeconds` or `concurrentStarts > 1` *(this ADR's first draft)* | **Rejected on review.** It reads a physical fact off start-process parameters. It happens to fit the nine current templates, but: a resource that is genuinely shared without start constraints (a multi-court hall declared as one resource, open-water free starts) would need a fictitious 1 s spacing; editing a template's spacing would silently change physical exclusivity; and one profile pinned against two physically different venues could not differ. ADR-0072 §7 itself speaks of an "exclusive **resource**" and a "shared-capacity **resource**" |
| (c) Explicit `occupancy` field in the profile (spec v2) | Puts a physical fact into "expected characteristics". It also costs new spec hashes, template versions and 05E-B rework |
| (d) Derive from `capacityUnit` | Fails: the bowling block is `ENTRANT` yet exclusive, while the road course is `ENTRANT` and shared |
| (e) **Explicit `occupancyMode` on the resource** | The physical fact is declared where the other physical facts are (capacity, keys). It matches ADR-0072 §7's wording. Profile spec v1 is untouched |

**Selected: (e).**

- **The field.** `occupancyMode: EXCLUSIVE | SHARED` is part of every resource revision (append-only, like capacity). 05E-C adds the column by additive migration, accepts it on the existing create/revise routes (`COMP_EDIT`) and returns it on reads.
- **Defaults are data, applied at write time only.** When a caller omits the field, the server stores a per-type default from a catalog vocabulary table next to `RESOURCE_TYPE_ATTRIBUTES`:
  - `EXCLUSIVE`: TENNIS_COURT, PADEL_COURT, BASKETBALL_COURT, BASKETBALL_HALF_COURT, BOWLING_LANE_PAIR, POOL, TRACK;
  - `SHARED`: ROAD_COURSE, OPEN_WATER_COURSE, CYCLING_COURSE, GOLF_COURSE.

  Existing revisions are backfilled from the same table. The stored value is always explicit. Conflict and proposal engines read **only** the stored per-resource value, never the type table.
- **The existing label.** 05E-A's capacity-derived `occupancy` read-API label is replaced by the declared mode in 05E-C (a documented API change). Until then it is descriptive only.
- **One physical space used both ways** (for example a cycling course shared by a mass stage, but exclusive for a time-trial day) is declared as **two resources sharing an exclusivity key**: one `SHARED`, one `EXCLUSIVE`. R4 then forbids any overlap between their claims. No per-use mode and no profile involvement are needed.

**How profile start parameters relate to the mode.**

| Requirement field | On an `EXCLUSIVE` resource | On a `SHARED` resource |
|---|---|---|
| `startSpacingSeconds`, `concurrentStarts` | No effect. Sequencing is occupancy + changeover (ADR-0072 §7, literally) | Govern start events (B4) |
| `changeoverSeconds` | Blocks the resource after the unit (B3) | No effect (B3) |
| `capacityUnit` | Consumption bounds the single occupying unit (R3) | Consumption is summed across concurrent units (R2) |

A parameter that has no effect on the resource used is not a conflict.

**Validation against the requested resources.**

| Physical thing | Is it a resource? | Mode | Capacity (unit from requirement) | Start rules |
|---|---|---|---|---|
| Tennis court | Yes, TENNIS_COURT | EXCLUSIVE | 1 (CONTEST) | — |
| Padel court | Yes, PADEL_COURT | EXCLUSIVE | 1 (CONTEST) | — |
| Basketball court | Yes, BASKETBALL_COURT; halves are separate resources linked by keys | EXCLUSIVE | 1 (CONTEST) | — |
| Wheelchair basketball court | The **same** BASKETBALL_COURT resource. No separate type. Accessibility is suitability, not occupancy (§ Frozen vs Deferred, C) | EXCLUSIVE | 1 (CONTEST) | — |
| Swimming lane | **No.** A plan slot inside a heat (ADR-0067, 05B). Lanes are consumed as the pool's capacity when the requirement counts ENTRANT (B9) | — | — | — |
| Swimming pool | Yes, POOL | EXCLUSIVE (booked one heat at a time) | 1 (CONTEST), or lanes (ENTRANT: heat places ≤ lanes) | — |
| Running start / wave | The start happens on the course resource: a ROAD_COURSE, or TRACK for heats. A wave is a unit, not a resource. A start line shared by several courses is **one** resource | SHARED (road) / EXCLUSIVE (track) | Runners on course (ENTRANT) | Spacing (e.g. 900 s), concurrency 1 |
| Cycling start | On the CYCLING_COURSE resource. An exclusive time-trial use is a second resource sharing a key | SHARED (or EXCLUSIVE twin) | Riders (ENTRANT) | Spacing per requirement |
| Golf tee / course | The course is the resource. Tees are concurrent start points, not resources | SHARED | Players on course (ENTRANT) | Spacing 600 s, concurrency 2 |
| Bowling lane pair | Yes, BOWLING_LANE_PAIR. Keys = its two physical lanes | EXCLUSIVE | Bowlers (places) per pair (ENTRANT) | — |

**Generic resource occupancy model.**

```
Resource R:  occupancyMode M(R) ∈ {EXCLUSIVE, SHARED}   (declared)
             capacity C(R)                               (declared amount)
             exclusivityKeys K(R)                        (declared composition)

Claim  c = (assignment a of one contest, resource R, consumption n, O = [start, expectedEnd), B)
       n = 1                                  if capacityUnit = CONTEST
         = number of non-VACANT places of the contest   if capacityUnit = ENTRANT
       B = [start, expectedEnd + changeover)   if M(R) = EXCLUSIVE
         = O                                   if M(R) = SHARED
```

**Rules (05E-D evaluates them; 05E-E must satisfy them).**

| Rule | Definition | Violation code |
|---|---|---|
| **R1 Exclusive occupancy** | On an EXCLUSIVE resource, no claim of a *different unit* has a blocking interval overlapping `B(c)`. Claims of the same unit may coexist | `RESOURCE_OVERLAP` (HARD) |
| **R2 Shared capacity** | On a SHARED resource, at every instant, Σ `n` of claims whose `B` contains the instant ≤ `C(R)` | `CAPACITY_EXCEEDED` (HARD) |
| **R3 Exclusive bound** | On an EXCLUSIVE resource, Σ `n` of one unit's claims ≤ `C(R)` | `CAPACITY_EXCEEDED` (HARD) |
| **R4 Physical overlap** | Claims of different units on **different** resources R ≠ R' with `sharesSpace(R, R')` must have non-overlapping blocking intervals, whatever their modes | `EXCLUSIVITY_CONFLICT` (HARD) |
| **R5 Type** | R's `typeCode` equals the requirement's `resourceType` | `RESOURCE_TYPE_MISMATCH` (HARD) |

**Capacity units are fungible counts.** Capacity has no unit identities: "3 of 4 used" never says *which* 3. Anything that needs an identity (a specific lane pair, a specific court, a half court) is a **resource**. Anything that is only counted (runners on a course, bowlers on a pair, swimmers in a pool's lanes) is **capacity**. Lane identity inside a heat remains the plan's sporting slot.

**Composite / multi-unit resources.** Physical composition is expressed only by **exclusivity keys**, as 05E-A already implements. There is no composite-resource entity, parent pointer or resource hierarchy:

| Physical situation | Declaration |
|---|---|
| Full basketball court and its two halves | full `{c1-a, c1-b}`, half A `{c1-a}`, half B `{c1-b}` |
| Lane pair 11–12 (two physical lanes) | `BOWLING_LANE_PAIR` with keys `{lane-11, lane-12}` |
| A different session pairs lanes 12–13 | Second resource `{lane-12, lane-13}`: it overlaps pair 11–12 through `lane-12` |
| Pool re-divided into two short-course pools | Each sub-pool's keys ⊂ the long-course pool's keys |
| One course, shared for a stage and exclusive for a time trial | Two resources with a common key, modes SHARED and EXCLUSIVE |
| Marathon and 10K sharing one start line | **One** `ROAD_COURSE` resource used by both events (start events are per resource, § B4) |

**Invariants.**
- **I-B2.1** No engine derives the occupancy mode from `capacity`, from a profile parameter, from the resource type or from the sport. The mode is the resource revision's stored `occupancyMode`.
- **I-B2.2** Identified physical space is a resource. Overlap between resources is only `sharesSpace`. Counted use is only capacity.
- **I-B2.3** Profile start parameters (spacing, concurrency) never change whether a resource admits concurrent units. They only constrain starts where the resource already admits them.

---

### B3 — Changeover and shared resources

**Problem.** ADR-0072 §7: "a unit occupies its resource … then for `changeoverSeconds` on an exclusive resource". The audit asked what changeover means on a resource with capacity > 1, on a shared resource, and across exclusivity-key siblings.

**Competing interpretations.**

| Option | Assessment |
|---|---|
| (a) Changeover blocks the whole resource after every unit, in every mode | On a shared course, each wave's changeover would stop the next wave. That contradicts spacing |
| (b) Changeover holds the releasing claim's consumption | Meaningless for fungible counts, and it does not model a reset either. A course needing a reset is not "30 runners still on it" |
| (c) **Changeover is a sequential-use concept: it applies on EXCLUSIVE resources only, and to their key siblings** | Matches ADR-0072 §7 literally and has a clear physical meaning |

**Selected: (c).**

| Situation | Effect of changeover |
|---|---|
| A claim on an EXCLUSIVE resource ends at `e` | The resource is blocked for **any** other unit until `e + changeover` (R1). The changeover is the **releasing** claim's own stored value |
| Sibling R' shares a key with the EXCLUSIVE resource | The block extends to R' (R4 uses blocking intervals). Example: a full-court game's changeover also blocks both halves |
| EXCLUSIVE resource with capacity > 1 (lane pair, capacity 4) | Capacity bounds the single occupant's size (R3). Changeover blocks the whole resource, because exclusive use is whole-resource use |
| Claims on a SHARED resource | Changeover has **no effect**. Turnaround that one unit needs belongs in its occupancy (`expectedDurationSeconds`). Throughput between starts is `startSpacingSeconds` |
| SHARED sibling followed by an EXCLUSIVE sibling (or the reverse) | R4: the later claim waits for the earlier claim's blocking interval (which includes changeover only if the earlier one is on the EXCLUSIVE resource) |

**Invariants.**
- **I-B3.1** `B = O + changeover` on EXCLUSIVE resources and `B = O` on SHARED resources. All occupancy rules use `B`.
- **I-B3.2** The changeover used is the one **stored on the assignment** (ADR-0070 §3), defaulted at write time from the requirement. Organizers may adjust it with a reason. The engine never re-reads it from the profile.
- **I-B3.3** Changeover is never part of a participant's time, a dependency gap or rest (§ B8).

**Consequence for current data.** CYCLING_COURSE defaults to SHARED, so the `cycling-course-stage` changeover values have no effect unless the organizer declares an EXCLUSIVE course resource (for example the time-trial twin). Their daily limit (1/day, HARD) already prevents a second stage the same day. No template changes now.

---

### B4 — Start spacing and concurrent starts

**Problem.** ADR-0072 defines `startSpacingSeconds` as the "minimum gap between consecutive unit starts on a shared-capacity resource" and `concurrentStarts` as "units allowed to start at the same instant on one resource". It is undefined which event is spaced, across which units, under which requirement when requirements differ, at what time resolution "the same instant" holds, and how ties are ordered.

**Selected semantics.**

| Concept | Frozen meaning |
|---|---|
| **Start event** | A unit's start instant on a resource: one event per (unit, resource). Per-entrant plan offsets inside a contest (`startOffsetSeconds`, time-trial riders) are **not** start events; they are inside the unit's occupancy |
| **Scope** | Start events on the **same SHARED resource**. Not across key siblings, not across resources, and not on EXCLUSIVE resources |
| **Time resolution** | Assignment instants are whole seconds (epoch seconds, stored as UTC). "Same instant" means equal instants |
| **Start slot** | All start events on R at one instant `t` |
| **Concurrency** | At slot `t`, the number of distinct units ≤ min(`concurrentStarts`) over those units. Violation: `CONCURRENT_STARTS_EXCEEDED` (HARD, new code) |
| **Spacing** | For consecutive distinct slots `t1 < t2` on R: `t2 − t1 ≥ max(startSpacingSeconds)` over all units in both slots (absent = 0). Checking consecutive slots is sufficient because gaps add up. Violation: `START_SPACING` (HARD, new code) |
| **Capacity** | Independent of spacing and concurrency: R2 still applies at every instant |
| **EXCLUSIVE resources** | No start-event rules. Sequencing is occupancy plus changeover (ADR-0072 §7) |
| **Order inside a slot** | Units at the same instant are totally ordered by (event id, stage sequence, round sequence, lowest member-contest sequence, unit key). This order is used for display, reports and proposals; it never assigns an identified sub-resource |

**Examples.**

| Case | Data | Result |
|---|---|---|
| Running waves | ROAD_COURSE (SHARED), spacing 900, concurrent 1 | w1 07:00, w2 07:15, w3 07:30 are valid. w2 at 07:10 → `START_SPACING`. w1 and w2 both at 07:00 → `CONCURRENT_STARTS_EXCEEDED` |
| Swimming heats | POOL (EXCLUSIVE) | Heat 2 starts at ≥ heat 1's end + 60 s (R1). Spacing does not apply |
| Golf tee groups | GOLF_COURSE (SHARED), spacing 600, concurrent 2 | 08:00 t1, t2 (two tees); 08:10 t3, t4. Three groups at 08:00 → concurrency violation |
| Bowling squads | BOWLING_LANE_PAIR (EXCLUSIVE) | Squad A on pairs 1–6 09:00–11:30 (+ 15 min). Squad B on the same pairs at ≥ 11:45. B on pairs 7–12 may also start at 09:00 |
| Tennis | TENNIS_COURT (EXCLUSIVE) | One match after another on each court, each after the previous end + 600 s |
| Time trial | One SESSION contest on CYCLING_COURSE | One unit. Riders start at plan offsets inside it, and occupancy = start + latest offset + 3 600 s |

**Invariants.**
- **I-B4.1** Spacing and concurrency are HARD, are evaluated per resource, and only between start events on a SHARED resource.
- **I-B4.2** When units with different requirements share a resource, the stricter value governs: max spacing, min concurrency.
- **I-B4.3** Tie order inside a start slot is the frozen tuple above, never insertion or database order.
- **I-B4.4** Which physical starting point (tee 1 vs tee 10) a unit uses is not a scheduling semantic in v1. The `GOLF_COURSE.startingTees` attribute is descriptive. `concurrentStarts` is the only source for concurrency.

---

### B5 — "Unrestricted" availability

**Problem.** 05E-A deliberately evaluates a layer with no WEEKLY window as **unrestricted**: no constraint has been declared. Read naively, a scheduler would treat such a resource as open at 03:00 on every day.

**Competing interpretations.**

| Option | Assessment |
|---|---|
| (a) Unrestricted = available (no signal) | Silently turns "nobody said" into "open". Rejected |
| (b) Unrestricted = unavailable (hard) | Contradicts 05E-A's frozen semantics. A competition with no declared hours could not publish anything |
| (c) Profile-dependent | Spec v1 has no such field. Adding one is a spec change for a policy that is not sport-specific |
| (d) **Unrestricted is a distinct, visible state: SOFT for manual schedules, not proposable** | Keeps 05E-A's meaning and makes the organizer confirm. The machine never invents hours |

**Selected: (d). It belongs to 05E-D (evaluation) and 05E-E (proposal); 05E-A is unchanged.**

| Coverage of an assignment's blocking interval | Meaning | Conflict engine (05E-D) | Proposal engine (05E-E) |
|---|---|---|---|
| **DECLARED-OPEN**: inside effective availability, and at least one layer (resource or competition) declares a WEEKLY or DATE_OPEN window for each local date touched | Someone declared it open | Nothing | May place |
| **DECLARED-CLOSED**: outside declared windows, DATE_CLOSED, blackout or maintenance, or a RETIRED resource | Someone declared it closed | `RESOURCE_UNAVAILABLE` (HARD) | Never places |
| **UNRESTRICTED**: no layer declares a window for a touched local date, and no closure applies | Nobody declared anything | `AVAILABILITY_UNDECLARED` (**SOFT**, new code), which must be acknowledged at publication | **Never places**. Reports the unit unplaceable with reason `AVAILABILITY_UNDECLARED` |

The same principle applies to an event window: when `event.starts_at` / `ends_at` are null, `OUTSIDE_EVENT_WINDOW` is not evaluated, and the proposal engine's horizon comes only from declared availability.

**Invariants.**
- **I-B5.1** No engine converts "no declaration" into "available at all times". Unrestricted time is never silently accepted (SOFT warning) and never machine-chosen (proposals).
- **I-B5.2** `RESOURCE_UNAVAILABLE` is raised only by a declared restriction or the resource lifecycle.
- **I-B5.3** Telling DECLARED-OPEN from UNRESTRICTED uses only the current availability facts. 05E-D adds a pure classification helper alongside `effectiveAvailability`, and 05E-A's semantics do not change.

---

### B6 — `maxUnitsPerEntrantPerDay`

**Problem.** "Unit", "entrant", "day", grouped entrants, midnight crossings, cancelled contests and which schedule counts are all undefined.

**Selected semantics.**

| Question | Frozen answer |
|---|---|
| What is counted | **Scheduling units** (B9), not contests. A grouped unit counts once for each entrant in it |
| Per whom | Per **entrant** (event participant; a team is one entrant), **within the event** whose profile declares the limit. Persons across events are protected by overlap and rest (B8), not by this limit |
| Which units | The entrant's units in the same event that resolve to **the same requirement** as the limit. A golf qualifying round (default requirement) and a match (`{MATCH}`) are counted against their own limits |
| Day | The **local calendar date of the unit's start instant in the event's IANA timezone** (`event.timezone`). It is never the server's zone, the viewer's zone or UTC |
| Crossing midnight | The unit counts on its start date only |
| Cancelled / void | `CANCELLED` and `VOID` contests do not count. `COMPLETED` and `IN_PROGRESS` do |
| Which schedule | Only the schedule version being evaluated (the draft being checked or published). Draft and published content are never added together |
| Provisional assignments | Count, using **possible occupants** (B8), as ADR-0071 §3 requires for participant checks |
| Severity | The requirement's `enforcement` (HARD or SOFT) |
| Code | ADR-0071's `MAX_CONTESTS_PER_DAY`. The name is historical; it counts units |

**Invariant.** **I-B6.1** For a fixed schedule version, plan, occupants, profile versions and event timezones, the count `(event, entrant, requirement, local date)` is a pure function with one answer.

**Examples.**
- Golf, 1/day HARD. Rounds 1 and 2 on 2026-11-14 (America/Costa_Rica) → HARD conflict for every entrant of both rounds. A post-cut round 3 placed on the same day as round 2 → HARD conflict for every possible occupant (all round-2 entrants).
- Tennis, 2/day SOFT. A player's R16 at 23:30 local (ending after midnight) and QF at 10:00 the next day count on different dates.

---

### B7 — Deterministic conflict report

**Architecture-level (frozen).** A report MUST identify:

| Element | Content |
|---|---|
| Subject | Competition id; schedule version id; content watermark (the set of current assignment fact ids it evaluated) |
| Inputs | Per event: `(eventId, profileVersionId, specHash)` or "no profile"; resource revision ids (which carry capacity, mode and keys); current availability fact ids; the 05D occupancy digest used; event timezones and windows; contest statuses |
| Validator | Identity and version; **coverage** (codes evaluated, I-B1.2) |
| Each conflict | `code`; `severity` (HARD / SOFT, after profile enforcement); `certainty` (`CERTAIN`, or `POSSIBLE` when it depends on possible occupants); involved unit keys; involved contest ids; involved assignment fact ids; resource id(s) and, for capacity conflicts, the consumption per claim; person or entrant ids for participant conflicts; the anchoring interval `[start, end)`; the governing requirement `(eventId, profileVersionId, canonical requirement index)`; expected vs actual values (e.g. required vs actual gap in seconds) |
| Integrity | `reportHash` = SHA-256 over the canonical JSON (ADR-0014, RFC 8785) with a domain tag, as `catalogSpecHash` does for specs |

**Stable total order (frozen).**
1. severity: HARD before SOFT;
2. anchoring interval start, then end (epoch seconds, ascending);
3. code (ASCII ascending);
4. primary resource id (ascending; absent first);
5. involved unit keys, sorted, compared lexicographically;
6. person / entrant id (ascending; absent first);
7. involved assignment fact ids, sorted, compared lexicographically.

Every list inside a conflict is sorted ascending. A pairwise conflict (A overlaps B) is reported **once**, with its members sorted, never as A/B and B/A. The canonical key of a conflict is its tuple (2–7) plus its code; publication acknowledgements reference it.

**Invariants.**
- **I-B7.1** The same schedule content and the same inputs yield a byte-identical canonical report and the same hash. Database row order, insertion order, hash-map iteration and wall-clock time never influence it.
- **I-B7.2** The anchoring interval is the earliest involved blocking interval.

**Deferred to 05E-D implementation:** field names, the `details` payload per code, the domain-tag string, report size limits and pagination.

---

### B8 — Possible occupants, dependency lead, rest

**Principle (frozen).** **The profile describes expected scheduling characteristics. The resource declares physical and operational facts. The assignment determines the concrete claim and interval. Conflicts are evaluated against the concrete schedule.**

**Layer responsibilities.**

| Layer | Declares | Never declares |
|---|---|---|
| Resource (05E-A, + `occupancyMode`) | Identity, type, attributes, capacity, occupancy mode, exclusivity keys, zone, lifecycle | Durations, rest, spacing, which contest uses it |
| Availability (05E-A) | When the resource or competition is declared usable | Occupancy, reservations |
| SchedulingProfile (05E-B) | Expected per-unit characteristics: required resource type, consumption unit, expected duration, default changeover, start spacing, concurrent starts, rest, dependency lead, daily limit, regrouping | Physical mode, capacity, instants, concrete resources |
| Plan (05B) / 05D | Contests, places, partitions, offsets, edges, occupants, ordinals | Time or resources |
| Assignment (05E-C) | The concrete claim: contest → resource, start, expected end, changeover, unit key, flags, reason | Profile or resource facts |
| Conflict engine (05E-D) | Nothing. It evaluates assignments against resources, availability, profile constraints and 05D facts | — |

**Two kinds of profile quantity.**

| Quantity | Kind | Source of truth for the conflict engine | Applies to |
|---|---|---|---|
| Expected duration | Interval | **Assignment** `expectedEnd` (defaulted at write time to start + latest plan offset + `expectedDurationSeconds`) | The contest's occupancy `O` |
| Changeover | Interval | **Assignment** `changeover` (defaulted from the requirement) | EXCLUSIVE resources only (B3) |
| Dependency lead | Constraint | Profile: the **dependent** unit's requirement | Between units joined by a plan edge |
| Rest | Constraint | Profile: the **later** unit's requirement | Between a person's consecutive units |
| Spacing / concurrency | Constraint | Profile | Start events on SHARED resources (B4) |
| Daily limit | Constraint | Profile | Entrant-day counts (B6) |

These are never folded into one interval:

```
unit start                  expectedEnd        expectedEnd + changeover
    │◀──────── O (occupancy) ───────▶│◀─ changeover ─▶│      (EXCLUSIVE resource only)
    │                                 │
    │                                 ├──── dependencyLead ────▶ earliest dependent start
    │                                 ├──── rest (per person) ──▶ earliest next unit for that person
```

**Frozen rules.**

| Rule | Definition | Code |
|---|---|---|
| Dependency | For each plan edge feeder → dependent (slot sources, transitions, dynamic-round source round): `dependent.start ≥ max(feeder.expectedEnd) + dependencyLead`. **Changeover is not added**: it is enforced through the resource if both use one | `DEPENDENCY_ORDER` (HARD) |
| Rest | For each person and consecutive units u1, u2 (by start): `u2.start ≥ u1.personEnd + rest(u2)`, where `personEnd` = the expected end of the person's own member contest | `SHORT_REST` (severity = enforcement) |
| Lead vs rest | Independent lower bounds. The binding one is the larger; they are never summed | — |
| Overlap | ADR-0071 §2 identity, competition-wide, on occupancy intervals `O` (never `B`) | `PARTICIPANT_OVERLAP` / `TEAM_OVERLAP` (HARD) |
| Round sequence | For one entrant, within one stage, units must follow round sequence. This covers multi-round stages whose later rounds have no plan edge (golf round 2, bowling block 2) | `ROUND_SEQUENCE` (SOFT, new code) |

**Possible occupants (resolves ONCF-05E architecture open decision §18.4).** They are computed as a **full transitive closure** over the plan graph, bounded by the event field:

| Place source | Possible occupants |
|---|---|
| PARTICIPANT slot / field entry | That participant (CERTAIN) |
| Current 05D fact RESOLVED (not STALE) | Its occupant (CERTAIN) |
| VACANT | Nobody |
| WINNER / LOSER_OF_CONTEST (unresolved, HELD or STALE) | Union of the possible occupants of every place of that contest |
| RANK_FROM_STAGE, BEST_RANKED_FROM_STAGE, QUALIFIER, dynamic-round field place (unresolved, HELD or STALE) | Union over the source stage (or group, or source round) entrants |

**Purpose of possible occupants.**

| Used for | Not used for |
|---|---|
| Participant overlap, rest and daily-limit checks on provisional assignments (conservative, ADR-0071 §3), with `certainty: POSSIBLE` | Capacity (consumption counts **places**, B2) |
| Constraining proposals exactly as the conflict engine would | Precomputing capacity, inventing durations or choosing occupants |

**Invariants.**
- **I-B8.1** The conflict engine reads intervals and changeover from assignments, physical facts from resource revisions, and constraints from profiles. It never recomputes an interval from the profile, and never reads a physical fact from the profile.
- **I-B8.2** Severity follows ADR-0071 and profile enforcement. `certainty` is reported but never downgrades severity.
- **I-B8.3** An assignment without an expected end (legacy rows), or without a resource in an event whose profile names a resource type, is never treated as conflict-free. It yields `INCOMPLETE_ASSIGNMENT` (SOFT, new code), and the checks it cannot support are skipped and listed.

**Relationship note.** ONCF-05E-ARCHITECTURE §11 writes "feeders' expected end + changeover + profile spacing". ADR-0071 (`DEPENDENCY_ORDER`) and ADR-0072 (`dependencyLeadSeconds`) do not add changeover. This ADR freezes the ADR wording: changeover does not enter dependency gaps.

---

### B9 — Grouped entrants and multi-resource claims

**Problem.** ADR-0072 §5 says the unit is a contest, or the contests sharing a partition key in a `GROUPED_ENTRANTS` stage. The code adds three gaps:
1. a later **non-dynamic** round of such a stage has no partition keys;
2. a squad may be larger than one resource's capacity, while ADR-0072 says "one resource per unit";
3. units formed by 05E (`regrouping`) need a stable identity.

**Selected: the unit derivation (pure, plan + 05D + profile data only).**

| Case | Unit | Identity components |
|---|---|---|
| Contest not in a `GROUPED_ENTRANTS` stage (match, heat, wave, mass start, time-trial session, stage race) | The contest | `(contestId)` |
| `GROUPED_ENTRANTS` stage, contest with a plan `partitionKey` | All contests of the round with that key | `(roundId, partitionKey)` |
| `GROUPED_ENTRANTS` stage, **non-dynamic** round, contest without a key | **Inherited partition:** the key of the same entrant's contest (same PARTICIPANT slot) in the nearest earlier round of the stage that has one. If none exists, a singleton | `(roundId, inheritedKey)` or `(contestId)` |
| `GROUPED_ENTRANTS` stage, **dynamic** round (05D-materialized field) and the profile declares `regrouping` | Blocks of `groupSize` over 05D field ordinals, in `order` (ADR-0072 §7, unchanged) | `(roundId, regroupOrdinal)` |
| Dynamic round, no `regrouping` declared | Each contest is a singleton unit | `(contestId)` |

#### What a unit claims

| Candidate abstraction | Role in this model |
|---|---|
| **Resources** | **What is claimed.** Each member contest's assignment claims exactly one identified resource. A unit's claim set = the distinct resources of its members' claims |
| Resource units (capacity) | Not identified. A claim carries a **consumption count** `n`, derived from `capacityUnit` and places (B2), never declared |
| Occupancy / exclusivity keys | Not claimed. They describe physical composition, and overlap between claims is derived from them (R4) |
| Composite resource | Not an entity. Composition is keys |
| Quantity (k resources) | Not declared (ADR-0072 has no quantity). k is **emergent**: the number of distinct resources the unit's members use, bounded below by ⌈Σn / capacity⌉ through R3 |

**Rules.**

| Question | Frozen answer |
|---|---|
| Who declares grouping | Intrinsic grouping comes from the **plan** (05B: `partitionKey`, `groupSize`, stage method), inheritance is derived from the plan, and result-dependent grouping comes from the **profile** `regrouping` over 05D ordinals (ADR-0066 §4) |
| One start time | Every member contest of a unit has the same start instant. A violation is `UNIT_SPLIT` (HARD, new code) |
| Spanning resources | A unit may use **several** resources of the required type only if **every** one of them is EXCLUSIVE. A unit that uses a SHARED resource uses that one resource only (one start event on one resource). A violation is `UNIT_SPLIT` |
| Capacity consumption | Per claim, as in B2. On EXCLUSIVE resources, R3 bounds the unit's total per resource. On a SHARED resource, R2 sums across units |
| Choosing k and the distribution | The proposal engine places members in member-contest sequence over compatible resources in stable resource order, filling each to its capacity (05E-E). An organizer may distribute differently with a reason. Any distribution satisfying R1–R5 is valid |
| Same requirement | Members of a unit are in one round with one contest type, so they resolve to the same requirement by construction |
| Later stages | Each new round forms new units by the derivation table. A knockout match after qualifying is its own contest unit |
| Split / merge | 05E never splits or merges a plan partition or an inherited one, and never edits a regroup in v1. Spreading a unit over several EXCLUSIVE resources is not a split (one unit, one start) |
| Identity stability | Unit identity is a pure function of plan, 05D facts and profile version. Each assignment records the unit key it was made under. If occupants change (STALE, re-commit), the recomputed key differs, and 05E-D reports it (`STALE_OCCUPANT` or `UNIT_SPLIT`) instead of silently re-grouping |

**One generic mechanism, five cases.**

| Case | Unit | Member claims | Resulting claim set | Consumption | Rules that bite |
|---|---|---|---|---|---|
| Bowling squad on k lane pairs | `(r1, t1)`, 24 per-entrant SERIES contests | Each contest → one BOWLING_LANE_PAIR (EXCLUSIVE) | Pairs 1–6 (k = 6, emergent) | ENTRANT: 4 per pair | R3 ≤ 4 per pair; R1 keeps other squads off; R4 catches re-paired lanes; `UNIT_SPLIT` if starts differ |
| Tennis match | The MATCH contest | One TENNIS_COURT (EXCLUSIVE) | 1 court | CONTEST: 1 | R1 + changeover |
| Basketball game | The MATCH contest | One BASKETBALL_COURT (EXCLUSIVE) | 1 court | CONTEST: 1 | R1; R4 blocks both half courts |
| Swimming heat "using 8 lanes" | The HEAT contest | One POOL (EXCLUSIVE) | 1 pool | CONTEST: 1, or ENTRANT: 8 places ≤ pool capacity (lanes) | R1; R3 if ENTRANT. Lanes are fungible pool capacity; lane identity is the plan slot |
| Golf tee group | `(r1, t3)`, 4 per-entrant contests | Each contest → the same GOLF_COURSE (SHARED) | 1 course | ENTRANT: 4 | R2 players on course; B4 spacing and concurrency; `UNIT_SPLIT` if a member uses another course |

**Composition of the 05E-C assignment.** ADR-0070 §3 records "resource(s)" per assignment. In v1 this means **exactly one resource per contest assignment**, or none for legacy or manual time-only rows (I-B8.3). A unit spans several resources only through its member contests. This narrows ADR-0072 §7's "one resource per unit" to "**one resource per contest**" (see Relationship).

**Not supported in v1: a single contest occupying several resources at once.** No v1 format needs it: squads are per-entrant contests, team bowling matches use one pair, and team ties are separate contests. Supporting it would need a requirement quantity (a spec version) and a plan change under a new ADR (§ Frozen vs Deferred, C).

**Example: a bowling squad on six pairs.** `qualifying-knockout`, `groupSize` 24, singles. Round 1 creates a unit `(r1, t1)` of 24 per-entrant SERIES contests. The requirement is the block (ENTRANT, 9 000 s, changeover 900), and the lane pairs are declared EXCLUSIVE with capacity 4. The proposal places members on pairs 1–6, four per pair. R3 passes for each pair, and R1 keeps every other squad off pairs 1–6 until 11:45. With `groupSize` 4, the same field becomes six units of four that may start at the same instant on six pairs. Both configurations are valid; the plan's data decides.

---

## Generic Resource Occupancy Model (summary)

```
            ┌──────────── plan (05B) + 05D occupants ────────────┐
            │  contests · places · partitions · edges · ordinals │
            └──────────────────────┬─────────────────────────────┘
                                   ▼
        unit derivation (B9) ──▶ units ──▶ requirement per unit (ADR-0072 §6)
                                   │             └─▶ expected values + constraints
                                   │                 (duration, changeover default, lead,
                                   │                  rest, spacing, concurrency, daily)
   resources (05E-A): mode · capacity · keys · availability
                                   ▼
   assignments (05E-C): per contest → resource?, [start, expectedEnd), changeover, unitKey
                                   ▼
   claims: (resource, n, O, B by resource mode) ──▶ R1–R5 · start events (B4) · participants (B8) · B5 · B6
                                   ▼
                     ConflictReport (B7), canonical, hashed, ordered
```

## Scheduling Unit Semantics

See B9. In short: **a unit is the set of contests that start together.** Its members share a start instant and a requirement. On a SHARED resource they also share that one resource. Its identity is derived, never typed in.

## Grouped Entrants

Grouping is plan data (05B), inherited plan data, or profile regrouping over committed 05D ordinals. The scheduler never decides **who** is grouped with whom beyond those rules (ADR-0066 §4).

## Composite / Multi-Unit Resource Claims

- **Composite space** is expressed by exclusivity keys (B2).
- **Multi-resource claims:** one identified resource per member contest. The unit's claim set is the union, allowed beyond one resource only when every resource is EXCLUSIVE (B9).
- **Within one resource**, consumption is a fungible count bounded by capacity (R2/R3).

## Capacity vs Exclusivity

Capacity is an amount. Simultaneous occupancy is the resource's declared `occupancyMode`. Physical overlap between resources is exclusivity keys. Start spacing and concurrency are profile constraints that act only on SHARED resources (B2).

## Changeover

EXCLUSIVE resources only. It belongs to the releasing claim, is stored on the assignment, and blocks the resource and its key siblings. It is never part of participant time (B3).

## Start Spacing

Applies between consecutive distinct start slots on one SHARED resource, using the max spacing (B4).

## Concurrent Starts

At most min(`concurrentStarts`) units per start slot on one SHARED resource, with a frozen tie order (B4).

## Availability / Unrestricted Resources

DECLARED-OPEN / DECLARED-CLOSED / UNRESTRICTED. Unrestricted time is SOFT `AVAILABILITY_UNDECLARED` and never proposed (B5).

## Daily Limits

Units per event entrant per requirement per local start date in the event's timezone, within the evaluated version only (B6).

## Dependency / Rest Semantics

The lead uses the dependent's requirement. Rest uses the later unit's requirement, per person. They are independent and never summed, and changeover is excluded from both. Possible occupants come from a full transitive closure (B8).

## Conflict Report Determinism

A canonical hashed report with recorded inputs and coverage, totally ordered by a frozen seven-key sort (B7).

## Conflict vocabulary after this ADR

ADR-0071's codes are unchanged. ADR-0071 §1 allows additions, and this ADR adds:

| Code | Severity | Rule |
|---|---|---|
| `START_SPACING` | HARD | B4 spacing |
| `CONCURRENT_STARTS_EXCEEDED` | HARD | B4 concurrency |
| `UNIT_SPLIT` | HARD | B9 one start / spanning only EXCLUSIVE resources |
| `AVAILABILITY_UNDECLARED` | SOFT | B5 |
| `ROUND_SEQUENCE` | SOFT | B8 |
| `INCOMPLETE_ASSIGNMENT` | SOFT | I-B8.3 |

`SHORT_REST` and `MAX_CONTESTS_PER_DAY` take the severity of the requirement's `enforcement`.

## Cross-Sport Validation

The model was checked against the project's established **3 modalities × 3 formats** per sport (ONCF-05A §6–§13). Every row is expressed only by plan, resource, profile and 05D data. "Mode" is the resource's declared `occupancyMode` (per-type default shown). "n" is consumption per claim.

| Sport | Modality / format | Unit | Resource · mode | n · capacity | Start rules | Changeover | Rest / lead / day |
|---|---|---|---|---|---|---|---|
| **Tennis** | Singles · single elimination | Match | TENNIS_COURT · EXCL | 1 · 1 | — | 600 s blocks court | Rest 3 600 SOFT per person; lead 900 after feeder; 2/day SOFT |
| | Doubles · round robin | Match (pair = 1 entrant, 2 persons) | same | same | — | same | Rest per **person**: a player in singles and doubles is one person (ADR-0071) |
| | Mixed · RR → knockout | Match; KO matches depend on group ranks | same | same | — | same | `DEPENDENCY_ORDER` from group stage; possible occupants = group entrants |
| **Padel** | Men's / women's / mixed doubles · SE, groups → KO, RR | Match | PADEL_COURT · EXCL | 1 · 1 | — | 600 s | Rest 3 600 SOFT; 3/day SOFT; group → KO edges |
| **Running** | Road race · mass start | One HEAT contest | ROAD_COURSE · SHARED | entrants · runners on course | One start event | None (SHARED) | 1/day HARD |
| | Road race · wave start | One unit per wave (`w1…`, not GROUPED_ENTRANTS) | ROAD_COURSE · SHARED | wave size | Spacing 900, concurrent 1 | None | 1/day HARD |
| | Track / relay · heats → final | Heat; final depends via QUALIFIER | TRACK · EXCL *(needs a template: data gap only)* | 1 or lanes | — (EXCL) | Template value | Lead after heats; relay team = 1 place, 4 persons |
| **Swimming** | Individual · timed finals | Heat | POOL · EXCL | 1 (CONTEST) · 1 | — | 60 s | Rest 1 800 SOFT per person across events |
| | Relay · heats → final | Heat; final via QUALIFIER | POOL · EXCL | 1 · 1 | — | 60 s | Lead 1 800; lanes stay slots |
| | Open water · mass start | One contest | OPEN_WATER_COURSE · SHARED *(no template yet: data gap)* | entrants | One start | None | — |
| **Cycling** | Gran Fondo · mass start | One HEAT contest | CYCLING_COURSE · SHARED | entrants | One start | None (B3) | 1/day HARD |
| | Time trial · interval start | One SESSION contest; riders at plan offsets | CYCLING_COURSE · SHARED, or an EXCL twin with a common key when exclusivity is wanted | riders ≤ capacity | — | 900 s only on the EXCL twin | O = start + latest offset + 3 600 |
| | MTB / GC · multi-stage | One contest per stage-round; dynamic after ELIMINATE | CYCLING_COURSE · SHARED | entrants | Per requirement | None | 1/day HARD; `ROUND_SEQUENCE` for stage order; lead via dynamic edge |
| **Bowling** | Singles · qualifying → stepladder | Squad unit (plan partition); ladder match | LANE_PAIR · EXCL | bowlers per pair ≤ capacity; match 1 | — | 900 s / 300 s | Ladder via WINNER edges, lead 300 |
| | Doubles · aggregate pinfall (multi-round) | Squad r1; **inherited** squad in later blocks | LANE_PAIR · EXCL | pair entrants (places) | — | 900 s | Rest 1 800 SOFT; `ROUND_SEQUENCE` |
| | Team · round-robin match play | Match (team vs team) | LANE_PAIR · EXCL | 1 · capacity | — | 300 s | Team = 1 entrant; persons = roster |
| **Basketball** | 5v5 · pools → KO | Game | BASKETBALL_COURT · EXCL | 1 · 1 | — | 900 s, also blocks key-sharing halves | Rest 10 800 SOFT; 1/day SOFT |
| | 3x3 · round robin | Game | BASKETBALL_HALF_COURT · EXCL | 1 · 1 | — | 300 s | Halves `{c1-a}`, `{c1-b}` run concurrently; the full court blocks both (R4) |
| **Wheelchair basketball** | IWBF · single elimination (also pools → KO, RR) | Game | The same BASKETBALL_COURT resources · EXCL | 1 · 1 | — | Profile value (same template as 5v5) | Same rules. Variant behaviour is discipline and profile data, never a branch. Court accessibility is suitability (out of 05E) |
| **Golf** | Stroke play · multi-round + cut | Tee group (plan) r1; **inherited** r2; **regrouped** {3, DESC} after cut | GOLF_COURSE · SHARED | players (places) on course | Spacing 600, concurrent 2 | None | 1/day HARD; cut round lead via dynamic edge |
| | Four-ball · Stableford | Tee group of pairs | GOLF_COURSE · SHARED | pairs (places) | same | None | Pair = 1 place (see Open question 1) |
| | Scramble · match-play bracket from qualifying | Match unit (2 places) | GOLF_COURSE · SHARED | 2 | Spacing 600 | None | Lead 1 800; 2/day SOFT |

**Holes found and how they are resolved.**

| Hole | Exposed by | Resolution |
|---|---|---|
| H1 Capacity ⇒ exclusivity is wrong | Bowling block (ENTRANT, capacity 4) | Declared resource `occupancyMode` (B2) |
| H2 Start parameters ⇒ exclusivity is wrong *(first-draft rule, found on review)* | A shared hall without spacing; spacing edits changing physics | Physical mode on the resource; start parameters act only on SHARED resources (B2) |
| H3 A squad larger than one resource | Bowling squad of 24 | One resource per contest; multi-resource units across EXCLUSIVE resources (B9) |
| H4 Later rounds have no groups | Golf r2, bowling block 2 (`buildMultiRound`) | Inherited partitions (B9) |
| H5 Post-cut round without regrouping | Bowling with a cut (template has no `regrouping`) | Singleton units: safe, if inefficient. A template version with `regrouping` is a data-only follow-up |
| H6 Shared start line across courses | Marathon + 10K | One resource for the shared start (B2) |
| H7 One course used both shared and exclusive | Cycling stage vs time trial | Two resources with a common key (B2) |
| H8 Round order without plan edges | Multi-round stages | SOFT `ROUND_SEQUENCE` (B8) |
| H9 Changeover on shared resources | Cycling template | No effect on SHARED resources (B3) |
| H10 Publication before the conflict engine; publication authority open | Phase order, architecture §18.6 | Report contract plus declared coverage; `COMP_MANAGE_SCHEDULE`, human actor only (B1) |
| H11 Track and open-water templates absent | Running track / relay, open water | Catalog data gap, not a model gap. TRACK and OPEN_WATER_COURSE exist as resource types |

**No sport required a sport-name conditional.**

## Bowling Validation

| Concept | Representation |
|---|---|
| Lane | Not a resource type. It appears only as an exclusivity key (`lane-11`) |
| Lane pair | `BOWLING_LANE_PAIR` resource, `occupancyMode` EXCLUSIVE. Keys = its two lanes. Capacity = bowlers (places) the pair seats in a block |
| Player / member | Person. For team modalities: the frozen roster, used for overlap and rest |
| Entrant | Individual, doubles pair or team: one place |
| Contest | Per-entrant SERIES (a block of games) or MATCH (stepladder, match play) |
| Game / series | Ruleset content (games per block). It is folded into `expectedDurationSeconds` by the template, never read by the scheduler |
| Round | Qualifying block (round of the FIELD stage) or a ladder step |
| Squad | Plan partition (`t1…`) of `groupSize` → **one scheduling unit** |
| Resource capacity | The bound on one squad's bowlers per pair (R3) |
| Resource occupancy | EXCLUSIVE: one squad per pair at a time, plus 900 s changeover. Lane re-pairing is caught through keys (R4) |
| Claim | One lane pair per member contest. The squad's claim set is k pairs, k emergent |

**Conclusion.** What is scheduled is the **squad unit**. Its member contests claim one or more lane pairs at one common start. No two units can occupy the same physical lane: same-pair overlap is R1, and a re-paired lane sharing a key is R4. A squad can never exceed a pair's seats (R3). Stepladder and match-play matches are CONTEST units on one pair, ordered by WINNER edges. Bowling is one instance of "one scheduling unit requiring a declared set of resource units". It needs no bowling code, no new resource type and no profile spec change.

## Golf Validation

| Concept | Representation |
|---|---|
| Course | `GOLF_COURSE` resource, `occupancyMode` SHARED. Capacity = players (places) on course |
| Holes | Resource attribute (descriptive). Not a resource |
| Tee / starting tee | Not a resource. A start event on the course, with `concurrentStarts` = tees used. `startingTees` stays descriptive (I-B4.4) |
| Starting interval | `startSpacingSeconds` |
| Players per group | Plan `groupSize` (r1), inherited (non-dynamic rounds), or profile `regrouping.groupSize` (post-cut) |
| Tee group | **One scheduling unit**, with a common start and one shared course claim |
| Round | Plan round. Round order for an entrant is `ROUND_SEQUENCE`. A post-cut round depends on the cut transition (`DEPENDENCY_ORDER` + lead) |
| Round duration | `expectedDurationSeconds` → each member's occupancy |

**Conclusion.** A tee group emerges from plan partition data and is one unit on a SHARED course. Starts are spaced and bounded by concurrency, players on course are bounded by capacity, the same-day rule is the HARD daily limit, and post-cut groups come from regrouping over committed 05D ordinals. There is no `if sport == golf`. Shotgun starts are profile data (`concurrentStarts` = number of starting holes, all units in one slot).

## No Sport-Specific Branches

**Scheduling semantics are determined by declared catalog, competition, resource, availability, 05D and SchedulingProfile data, never by sport-name conditionals.** No 05E-C/D/E code may branch on a sport, discipline code, format engine id or resource type code to decide scheduling behaviour. Examples of forbidden code:

```ts
if (sport === 'bowling') …       if (discipline.code.startsWith('golf')) …
if (resource.typeCode === 'POOL') …   // to change semantics, not to validate the declared type
```

Two kinds of type-keyed code are allowed, because neither is branching:
- comparing a resource's `typeCode` with a requirement's declared `resourceType` (R5), which is data matching;
- per-type write-time defaults (`occupancyMode`, attribute schemas), which are vocabulary data that engines never consult.

If a sport needs a behaviour the model cannot express, the answer is new **versioned declarative data**: catalog vocabulary, discipline capabilities, resource attributes, plan structure, or a profile spec version, introduced by an ADR.

## Relationship to ADRs 0066–0072

| ADR | Relationship |
|---|---|
| 0066 | Unchanged. B9 applies its §4 grouping ownership, and inheritance is plan-derived intrinsic grouping |
| 0067 | **Supersedes §3's equations "Exclusive (`capacity = 1`)" and "Shared capacity (`capacity = N`)".** The three semantics remain, but the mode becomes an explicit resource declaration (`occupancyMode`, added to the §1 resource shape by 05E-C) instead of being read from capacity. §3's exclusivity group is realized as 05E-A's key sets (unchanged). §6 "quantity" is not introduced (B9) |
| 0068 | Unchanged. B5 adds evaluation semantics for unrestricted layers without changing availability. B4 fixes whole-second assignment instants |
| 0069 | Unchanged |
| 0070 | Clarified: §3 "resource(s)" = one resource per contest (or none, I-B8.3); §4's gate operates on a report with declared coverage (B1); §11's publication authority is confirmed and frozen (B1). Statuses, publication and locks are unchanged |
| 0071 | Unchanged codes and split. Adds six codes (allowed by §1). §3 conservative possible occupants are frozen as a full transitive closure (B8) |
| 0072 | **Not modified.** §7's "exclusive resource" and "shared-capacity resource" are read literally as the resource's declared `occupancyMode`. Two narrowings: "one resource per unit" (§7, `resourceType` row) becomes "**one resource per contest**", with units spanning EXCLUSIVE resources (B9); §5 units are extended by inherited partitions for non-dynamic rounds. §7 `regrouping` scope, spec v1, spec hashes and templates are unchanged |
| ONCF-05E-ARCHITECTURE §6, §11, §18.4, §18.6 | §6's capacity-based mode table is superseded by B2. §11's "+ changeover" in dependency spacing is superseded by B8. §18.4 is resolved by B8 and §18.6 by B1 |
| ONCF-05E-A implementation doc | Its "`occupancyOf` (capacity 1 = EXCLUSIVE, N = SHARED_CAPACITY)" description is superseded as a scheduling semantic. The function and label remain until 05E-C replaces the label |

Compatibility preserved: v1 catalog and spec hashes; SchedulingProfile spec v1 and its nine template versions; resource identity and `exclusivityKeys`; 05E-A availability semantics; all existing routes. The only planned schema change is the additive `occupancyMode` column, with a deterministic backfill (05E-C).

## Frozen vs Deferred

**A. Frozen now (05E-C/D/E must follow).**
- Phase boundary and dependency direction; report contract with coverage; publication authority (B1).
- Declared resource `occupancyMode`, its per-type write-time defaults and backfill; claims and rules R1–R5; fungible capacity; composition by keys only; start parameters inert on EXCLUSIVE resources (B2).
- Changeover: EXCLUSIVE resources only, releasing claim, stored on the assignment, propagates to key siblings (B3).
- Start events, scope, whole-second instants, max-spacing, min-concurrency, tie order (B4).
- DECLARED-OPEN / DECLARED-CLOSED / UNRESTRICTED and their effects (B5).
- Daily-limit counting key and every listed answer (B6).
- Report elements, certainty, the seven-key sort, once-only pairwise conflicts, canonical hash and canonical conflict key (B7).
- Layer responsibilities; profile = expected, resource = physical, assignment = concrete; lead and rest sources; no summing; changeover excluded; full-closure possible occupants; `INCOMPLETE_ASSIGNMENT` (B8).
- Unit derivation table; inheritance; one start; one resource per contest; spanning only EXCLUSIVE resources; emergent k; no split or merge; recorded unit key (B9).
- New codes and severities. The no-sport-branch rule.

**B. Deferred to implementation.**
- **05E-C:** table and column names (including `occupancy_mode`); storage of the unit key; how legacy `contest_schedule` rows with null `scheduled_end` migrate (within I-B8.3); baseline validator's exact coverage (within I-B1.3); whether a discarded draft may be reopened (architecture §18.3); optional display labels on assignments (e.g. a tee label).
- **05E-D:** report field names and `details` payloads; the domain-tag string; the DECLARED/UNRESTRICTED classification helper's API; performance strategy (sweep lines, indexes); possible-occupant caching.
- **05E-E:** placement order by dependency depth vs by day (architecture §18.5); unplaceable-report format.
- **Catalog data:** track and open-water templates; a bowling template version with `regrouping`; cycling template changeover values.

**C. Not part of 05E.**
- Requirement → resource **attribute** matching (e.g. "accessible court", "lights after sunset"): suitability, not occupancy. It would be a generic future spec addition, never a branch.
- A single contest occupying several resources at once (requirement quantity).
- Identified sub-resource allocation inside capacity (which lane, which tee); two-tee crossover timing.
- Cross-resource start constraints (separate resources sharing a start line), travel time, conflicts across competitions, optimization and solvers (ADR-0071, architecture §3).
- Organizer-edited regroups and score-ordered regrouping of non-dynamic rounds.

## Non-Goals

This ADR implements nothing. It adds no migration, route, UI, test or catalog row, and it does not change existing scheduling behaviour. It does not start 05E-C, D or E, and does not edit ADRs 0066–0072.

## Consequences

- 05E-C/D/E can be built by different engineers and produce compatible data, reports and proposals.
- 05E-C adds one additive resource column (`occupancyMode`) with a deterministic backfill. The resource create/revise/read routes gain the field, and 05E-A's capacity-derived `occupancy` label is replaced by it.
- The bowling lane pair is correctly exclusive by declaration. Squads of any `groupSize` are representable.
- Template authors cannot change physical exclusivity by editing spacing.
- Multi-round grouped stages schedule rounds 2+ as groups, not as hundreds of singletons.
- Organizers must declare operating hours before the proposal engine will place anything, and confirm manual placements in undeclared time.
- Publication authority is settled: no new permission, and no machine publication.
- Six new conflict codes enter ADR-0071's vocabulary.
- Three catalog-data follow-ups are identified. None is required for correctness.

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Capacity decides exclusivity (status quo of ADR-0067 §3) | Fails bowling blocks and any capacity-bounded exclusive use |
| Mode derived from profile start parameters (first draft of this ADR) | Derives a physical fact from start-process parameters; forces fictitious spacing for shared resources without start constraints; makes template edits change physics |
| Explicit `occupancy` field in profile spec v2 | Places a physical fact in "expected characteristics"; costs new hashes, template versions and 05E-B rework |
| Per-use mode on the resource or the assignment | One space used both ways is already expressed by two resources sharing a key |
| Composite-resource entity / resource hierarchy | Exclusivity keys already express composition (ADR-0067 alternatives) |
| Identified capacity units | Anything identified is a resource. Identified units would duplicate resources |
| Requirement `quantity` (k resources per contest) in v1 | No v1 format needs it; grouped units already span EXCLUSIVE resources |
| Changeover on shared resources | No consistent physical meaning; turnaround belongs in occupancy |
| Unrestricted = available, or = unavailable | Silent invention, or contradiction of 05E-A |
| Daily limit per person across events | Mixes profiles of different events. Persons are protected by overlap and rest |
| "Day" in UTC or the server zone | Non-local and non-deterministic across deployments |
| Bounded-depth possible occupants | Depth is arbitrary. The full closure is bounded by the field and is conservative |
| Lead + rest + changeover summed | Double counting; three different physical facts |
| 05E may split or merge plan groups | Contradicts ADR-0066 §4 (05E never decides who) |
| Publication moved to 05E-D | Freezes the public schedule between phases |
| A separate publish permission, or system/automatic publication | No evidence that SCHEDULER must not publish (ADR-0070 §11); automatic publication would bypass acknowledgement |

## Implementation Constraints

1. The occupancy mode is read only from the stored resource revision. No engine computes it.
2. One pure unit-derivation function over plan, 05D facts and profile version.
3. The conflict engine stays pure (ADR-0071 §4): no database, clock, randomness or environment.
4. All interval arithmetic uses 05E-A's half-open `interval.ts`. Instants are whole seconds.
5. All local-date logic uses 05E-A's `zoned.ts` with the event's IANA zone.
6. Reports and proposals are canonicalized and hashed (ADR-0014), and record the profile version ids and spec hashes they used (ADR-0072 §10).
7. Source-level guard tests keep 05E code free of sport identity (as the 05E-B tests already do).
8. No column, view or field names matching the existing guard patterns (`rank`, `position`, `points`, `qualif`, `standing`); use `start_order`, `ordinal` (architecture §17).
9. Publication checks `COMP_MANAGE_SCHEDULE` server-side and requires an authenticated human actor. No code path publishes on behalf of the system.

## Dependency on 05E-C / 05E-D / 05E-E

| Phase | Must implement from this ADR |
|---|---|
| 05E-C | B1 contract, gate, coverage and publication authority; integrity refusals; the `occupancyMode` column, defaults and backfill; per-contest single-resource assignments; whole-second instants; stored expected end and changeover defaulted from the requirement; recorded unit key; legacy migration within I-B8.3 |
| 05E-D | Unit derivation; R1–R5 by declared mode; B3; B4; B5 classification; B6; B8 rules and possible occupants; B7 report; new codes |
| 05E-E | Never places in UNRESTRICTED or DECLARED-CLOSED time; satisfies every 05E-D rule; deterministic member distribution; commits into the draft only; never publishes |

## Open Questions

None of these blocks 05E-C or 05E-D, and none allows incompatible implementations.

1. **Places vs persons for ENTRANT capacity on SHARED resources.** ENTRANT counts places, which is deterministic before lineups. A shared course used by events whose entrants differ in size (singles and four-ball pairs) counts each pair as one. Spacing is the binding throughput constraint in every current template. A future `PERSON` capacity unit would be a spec-version change under a new ADR.
2. **Template follow-ups** (track, open water, bowling `regrouping`, cycling changeover) are catalog data decisions for the operator.

## Decision Summary / Invariants

| # | Invariant |
|---|---|
| 1 | 05E-C models, 05E-D judges, 05E-E proposes; dependencies run C → D → E only |
| 2 | Every conflict report declares its coverage; publication needs zero HARD conflicts in a report over exactly the published content |
| 3 | Only an authenticated human holding `COMP_MANAGE_SCHEDULE` publishes, through the publish command, acknowledging SOFT conflicts in the same act |
| 4 | Capacity is an amount; simultaneous occupancy is the resource's declared `occupancyMode`; physical overlap is exclusivity keys; start spacing and concurrency are profile constraints acting only on SHARED resources |
| 5 | Identified space is a resource; composition is exclusivity keys; counted use is fungible capacity |
| 6 | EXCLUSIVE resource: one unit at a time (and on its key siblings), plus the releaser's changeover; capacity bounds that unit |
| 7 | SHARED resource: Σ consumption ≤ capacity at every instant; no changeover; start spacing and concurrency per resource |
| 8 | One resource per contest; a unit's claim set spans several resources only if all are EXCLUSIVE; every member of a unit shares one start |
| 9 | Unit = contest · plan partition · inherited partition · profile regroup; identity derived; never split, merged or hand-edited |
| 10 | Unrestricted ≠ open: SOFT when placed manually, never proposed; HARD only for declared closure |
| 11 | Daily limit = units per (event, entrant, requirement, local start date in the event zone), in one evaluated version, excluding cancelled and void |
| 12 | Profile = expected; resource = physical; assignment = concrete interval, claim and changeover; lead and rest are independent and never summed; changeover never enters participant time |
| 13 | Possible occupants = full plan-graph closure; used for participant checks only; certainty reported, never downgrading severity |
| 14 | Reports are canonical, hashed, input-recording and totally ordered by the frozen seven-key sort |
| 15 | No scheduling behaviour depends on a sport, discipline, engine or resource-type conditional; new behaviour is new versioned data |
