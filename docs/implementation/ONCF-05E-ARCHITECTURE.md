# ONCF-05E — Scheduling, resources and competition operations: architecture contract

| | |
|---|---|
| Status | **Frozen for implementation (ONCF-05E-0).** Changes require a new ADR. |
| Baseline | `b38d7e2` (ONCF-05D) on `feat/oncf-01-auth-wiring` |
| Design source | [ONCF-05A §27–28](../architecture/ONCF-05A-SPORTS-AND-COMPETITION-ENGINE.md) (approved) |
| ADRs | [0066](../adr/ADR-0066-scheduling-boundary-and-competition-scope.md) boundary · [0067](../adr/ADR-0067-generic-competition-scoped-resources.md) resources · [0068](../adr/ADR-0068-availability-and-scheduling-time-model.md) availability and time · [0069](../adr/ADR-0069-scheduling-profile-is-a-versioned-axis.md) SchedulingProfile · [0070](../adr/ADR-0070-schedule-versions-publication-and-history.md) versions, publication and history · [0071](../adr/ADR-0071-conflict-semantics-and-deterministic-proposals.md) conflicts and proposals |
| Related | ADR-0008 (operations decoupled from verification) · 0024 (immutable plans) · 0053 (capabilities, no sport branching) · 0055 (logistic vs competitive partitions) · 0059 (versioned axes) · 0065 (advancement facts, preview/commit) |

## 1. Purpose

ONCF-05E answers **who plays where and when**. It turns the immutable plan (05B), the scoring axes (05C) and committed advancement (05D) into:
- a private, validated schedule for each competition;
- a published, auditable schedule the public reads;
- the operational contest lifecycle (start, complete, cancel, void).

## 2. Scope

05E owns:
- **Resources:** competition-scoped resources and their availability.
- **SchedulingProfile:** expected duration, changeover, rest, start intervals, sessions and resource requirements, all as versioned data.
- **Conflicts:** typed hard and soft conflicts, computed by a pure engine.
- **Proposals:** a deterministic proposal engine with preview/commit.
- **Schedule lifecycle:** versions (private drafts, validated publication), locks and append-only history.
- **Operations:** manual moves with reasons, and the operational contest lifecycle commands over the API.
- **UI:** the organizer scheduling UI and the published public schedule.

## 3. Non-goals

**Never 05E:**
- scoring, winners, classification, qualification, advancement, eligibility;
- sporting authority or referee decisions;
- sport-specific scoring semantics.

**Future layers:**
- live scoring and live timing;
- referee assignment;
- check-in and notifications;
- payments and ticketing;
- spectators and broadcast;
- awards and sponsor operations;
- $BRT rewards, marketplace, gift cards and prize fulfilment.

**Not in v1:**
- optimisation or constraint solvers;
- AI/LLM scheduling;
- travel time between venues;
- conflicts across different competitions.

## 4. 05D → 05E boundary

| 05D answers *who plays whom* | 05E answers *where and when* |
|---|---|
| Official results, corrections, classification outcomes | Time, resource, availability |
| Advancement, slot resolution, provenance, staleness, overrides | Duration, changeover, rest, conflicts |
| Next-stage contest materialization | Proposals, versions, publication, moves, lifecycle commands |

**What 05E consumes, read-only:**
- the plan graph: stages, rounds, contests, slot sources, transitions;
- `v_contest_occupant`;
- target states (UNRESOLVED, RESOLVED, STALE…);
- frozen rosters and contest lineups;
- the 05D start guard.

05E **never** writes advancement state. Grouping ownership (ADR-0066 §4):
- intrinsic grouping (initial waves and heats, round-1 tee groups, bowling blocks, time-trial order) is 05B's;
- result-dependent grouping of a post-cut round is 05E's, but only from occupants 05D committed. 05E decides **when**, never **who**.

## 5. Scheduling pipeline

```
Competition ─▶ Events (each with a pinned SchedulingProfile)
   ─▶ contest requirements (resource type, units, duration, changeover)
   ─▶ resources ─▶ availability (expanded to UTC intervals)
   ─▶ constraints (dependencies, participants, rest, locks, windows)
   ─▶ deterministic proposal engine ─▶ proposal (canonical hash) + conflict report
   ─▶ organizer review ─▶ commit into DRAFT ─▶ validate (no hard conflicts; soft ones acknowledged)
   ─▶ PUBLISH (new version; previous SUPERSEDED) ─▶ public schedule (projection)
```

The whole pipeline is competition-scoped and deterministic. Sport is data: discipline → format → ruleset → SchedulingProfile → resource requirements → one generic scheduler.

## 6. Resource model (ADR-0067)

`Resource {competitionId, label, typeCode (catalog ResourceType), attributes (typed per type), capacity, exclusivityGroup?, venue? (organization + label), status ACTIVE|RETIRED}`

| Semantics | Meaning | Examples |
|---|---|---|
| Exclusive (`capacity 1`) | One contest at a time, plus changeover | Tennis or padel court, basketball court, bowling lane pair, a pool booked for a session |
| Shared capacity (`capacity N` units) | Concurrent use while the sum of declared units is ≤ N | Road course (entrants per wave window), golf course (tee starts per interval per starting tee) |
| Exclusivity group | Overlapping resources block each other | Basketball full court with its two half courts |

- **Occupancy is derived from the schedule, never stored** on the resource.
- Lanes inside a heat stay slots (05B seeding), not resources.

## 7. Availability model (ADR-0068)

Availability is layered per resource:
- recurring local operating hours (weekly windows, local times, IANA zone, validity range);
- date-specific exceptions (open or closed);
- blackouts and maintenance (with a reason);
- competition-wide restrictions.

**Precedence:** blackout/maintenance > exception > recurring.

It expands deterministically to UTC intervals for the competition window. Facts are append-only, and the current set is a projection. "Reserved" is never a stored state.

## 8. Time model (ADR-0068)

**Distinct concepts:**
- instant (UTC);
- local wall-clock time;
- IANA zone;
- recurring rule;
- schedule interval: start + expected end + duration + changeover + planning zone.

**Server-side conversion:**
- **Server ownership.** The server owns conversion; the web helper is presentation-only.
- **DST rules for recurring windows:**
  - a skipped local boundary moves forward by the gap;
  - a repeated one takes the earlier occurrence.
- **One-off local input:** a skipped time is refused (`LOCAL_TIME_SKIPPED`); a repeated time is refused (`LOCAL_TIME_AMBIGUOUS`) unless an offset is given.
- **Mandatory tests:** America/Costa_Rica (fixed offset), a spring-forward zone and a fall-back zone, and windows crossing midnight.

## 9. SchedulingProfile (ADR-0069)

A versioned, hashed catalog axis with a basis, pinned per event and frozen at field lock. Its spec is closed data with no sport identity (exact schema in 05E-B):

| Field | Content |
|---|---|
| Requirements | Per contest type / stage primitive / round type: `{resourceType, quantity or capacityUnits, expectedDuration, changeover}` |
| Rest | Minimum rest (value or table), each limit declared hard or soft |
| Start intervals | Time-trial, wave and tee intervals; starting tees |
| Sessions | Session or day grouping |
| Dependency spacing | Minimum gap after feeder contests |
| Grouping policy | For post-cut grouping |
| Limits | Optional soft limits (max contests per entrant per day, max wait) |

Templates cite their source or say COMMON_PRACTICE. No value is hard-coded in the scheduler.

## 10. Conflict model (ADR-0071)

- **HARD (blocks publication):**
  - `RESOURCE_OVERLAP`;
  - `EXCLUSIVITY_CONFLICT`;
  - `CAPACITY_EXCEEDED`;
  - `RESOURCE_TYPE_MISMATCH`;
  - `RESOURCE_UNAVAILABLE`;
  - `PARTICIPANT_OVERLAP`;
  - `TEAM_OVERLAP`;
  - `DEPENDENCY_ORDER`;
  - `LOCKED_ASSIGNMENT_VIOLATION`;
  - `OUTSIDE_EVENT_WINDOW`;
  - `STALE_OCCUPANT`.
- **SOFT (explicit acknowledgement):**
  - `SHORT_REST` (unless the profile makes rest hard);
  - `LONG_WAIT`;
  - `MAX_CONTESTS_PER_DAY`;
  - `UNDERUSED_RESOURCE`;
  - `SEQUENCING_INEFFICIENCY`.

The engine is pure (`@br/competition`), produces a canonical hashed report, and never branches on sport.

**Participant identity reuses existing facts, at competition scope:**
- the participant's athlete;
- the frozen team roster;
- contest lineups;
- the current 05D occupant.

An athlete entered in two events is one person.

## 11. Dependency scheduling

- **Graph source:** feeders come from the plan's slot sources and transitions (winner/loser of contest, rank of stage or group, best-ranked, qualifier, dynamic-round field).
- **Spacing:** a dependent contest must start no earlier than its feeders' expected end + changeover + profile spacing.
- **Provisional assignments:** unresolved contests may get one. Their participant checks use every possible occupant derivable from the graph, conservatively, and are re-checked when occupants change.
- **Staleness:** a STALE occupant is a hard conflict (`STALE_OCCUPANT`). The 05D start guard stays in force.
- **Result-ordered starts** (e.g. golf round 3 by score) use only committed 05D occupants and classifications. They are never anticipated.

## 12. Publication model (ADR-0070)

**Version statuses** (append-only):

| Status | Meaning |
|---|---|
| `DRAFT` | One open per competition, private, with a base version |
| `PUBLISHED` | The single public version |
| `SUPERSEDED` | Replaced by a later publication |
| `DISCARDED` | An abandoned draft |

- "Validated" is computed (no hard conflicts; report hash recorded at publish).
- **Locking** is per assignment, and implicit for started contests.
- **Publishing** atomically supersedes the previous version.
- **Public readers see only the published version.** `contest_schedule` becomes its projection, so existing public reads keep working.
- **Contest status:** a contest becomes `SCHEDULED` when published.
- **Changed route:** `POST /v1/contests/:id/schedule` will edit the draft (behaviour change in 05E-C). Existing rows are migrated into an initial PUBLISHED version, so nothing currently public disappears.

## 13. Audit and history (ADR-0070)

**Assignments are append-only facts.** Each records:
- version;
- contest;
- resource(s);
- start, expected end, changeover;
- zone;
- provisional and locked flags;
- actor;
- reason (mandatory for every manual move);
- the replaced assignment.

The history answers what, when, which resource, previous vs new time/resource/venue, who, why and in which version.

Every edit, commit, lock or unlock, publication and discard writes `platform.audit_event` plus an outbox event. Concurrency follows 05D: preview → hash → commit, rejected if stale, plus an advisory lock per competition schedule, base-version checks and idempotency keys.

## 14. Permissions (ADR-0070 §11)

| Action | Permission | Roles |
|---|---|---|
| Drafts, proposals, moves, locks, **publication**, start/complete | `COMP_MANAGE_SCHEDULE` | OWNER, ADMIN, SCHEDULER |
| Resources, availability, SchedulingProfile pin | `COMP_EDIT` | OWNER, ADMIN |
| Cancel / void contests | `COMP_CANCEL` | OWNER, ADMIN |

No new permission. A separate publish permission is added only if evidence shows SCHEDULER must not publish. No scheduling permission grants authority over scoring, results, advancement or referees.

**Surfaces:**
- **Organizer:** `/app/orgs/[slug]/tournaments/[competitionId]/schedule` — draft, proposals, conflicts, resources, availability, locks, history, publication.
- **Public:** the existing competition and event schedule surfaces, published version only.

## 15. Sport coverage proof

One architecture, eight sports. Only SchedulingProfile and resource data differ.

| Sport | Unit scheduled (from 05B/05D) | Resource (type · semantics) | Profile data used | Availability | Dependencies |
|---|---|---|---|---|---|
| Tennis | Match (MATCH contest) | TENNIS_COURT · exclusive | Match duration, changeover, rest (value or table) | Court hours, blackouts | Winner/loser feeders |
| Padel | Match | PADEL_COURT · exclusive | Same | Same | Same + group → knockout |
| Running / marathon | Wave start (logistic partition) or heat | ROAD_COURSE · shared capacity (entrants); TRACK · exclusive per heat | Wave interval, wave capacity units, course window | Course closure window | Usually none; heats → final via QUALIFIER |
| Swimming | Heat within a session | POOL · exclusive for the session (lanes are slots) | Heat duration, session length, changeover / warm-up | Pool sessions | Heats → final (QUALIFIER) |
| Cycling | Stage start; time-trial starts at intervals | CYCLING_COURSE · shared or exclusive per window | Stage duration, time-trial interval, one stage per day | Course per day | Stage order; finishers-only fields from 05D |
| **Ten-pin bowling** | Qualifying block; stepladder matches | BOWLING_LANE_PAIR · exclusive (k pairs per block) | Games per block → block duration, changeover | Lane-pair hours | Stepladder runs in strict sequence through WINNER_OF_CONTEST dependencies |
| Basketball | Game (5v5, wheelchair, 3x3) | BASKETBALL_COURT / BASKETBALL_HALF_COURT · exclusive + exclusivity group | Game duration, changeover, team rest | Court hours | Pools → knockout |
| Golf | Tee time per group (round-1 groups from 05B; post-cut groups from 05D's field) | GOLF_COURSE · shared capacity (tee starts per interval per starting tee) | Tee interval, starting tees, round duration, grouping policy | Course day | Post-cut rounds only after the 05D field is committed |

**Known upstream limitation, not a 05E concern:** a bowling stepladder match has no automatic winner (05D/ADR-0065). Scheduling the sequence still works through the dependency graph.

## 16. Implementation phases (frozen decomposition)

| Phase | Objective | Likely modules | Depends on | Migration | Key tests |
|---|---|---|---|---|---|
| **05E-0** | Architecture and ADRs | docs | — | No | — |
| **05E-A** Resources + availability | Resource store/API; layered availability; server-side time conversion with DST rules | `competition` (time + availability pure), `persistence`, `api` | 0 | Yes | DST gap/fold, Costa Rica, midnight windows; exclusivity groups; permissions |
| **05E-B** SchedulingProfile | Catalog axis, templates, provisioning, pin + compatibility | `competition` (vocabulary), `persistence` catalog store, `api`, catalog | 0 | Yes | Validation, hashing, pin compatibility, freeze at lock |
| **05E-C** Schedule model + publication | Versions, append-only assignments, locks, publication, `contest_schedule` as projection, route change, migration of existing rows | `persistence`, `api`, projection | A | Yes | Draft invisible to public; atomic publish; history; idempotency; concurrency |
| **05E-D** Conflict engine | Pure hard/soft conflict report at competition scope | `competition` | A, B, C | No | Every conflict type; cross-event athlete; provisional possible-occupants; properties |
| **05E-E** Proposal engine | Deterministic greedy proposal + preview/commit | `competition` + `persistence` | D | No | Determinism, locks never moved, no hard conflict in a committed proposal, unplaceable reported |
| **05E-F** Operations API | Start, complete, cancel, void routes; manual move with reason; unlock | `api`, `persistence` | C | No | Permissions, start guard, lifecycle |
| **05E-G** Organizer UI | Competition schedule page, resources, availability, conflicts, preview/commit/publish, history | `apps/web` | C–F | No | Helper unit tests; form validation |
| **05E-H** Public published schedule | Public surfaces read the published version only; schedule-change indicator | `persistence` reader, `apps/web` explorer | C | No | No draft leakage; version shown |

The decomposition changes only through a new ADR.

## 17. Risks

| Rank | Risk | Mitigation |
|---|---|---|
| P0 | Draft schedule leaking publicly; history lost | ADR-0070: versions, published-only projection, append-only assignments |
| P0 | Timezone/DST errors | ADR-0068: server-side conversion, explicit rules, mandatory tests |
| P0 | Scheduling mutating advancement, or anticipating results | ADR-0066/0071: read-only consumption, `STALE_OCCUPANT`, results-ordered starts only from committed facts |
| P1 | Resources as strings | ADR-0067 |
| P1 | Hidden cross-event participant conflicts | Competition-scoped engine over existing identity facts |
| P1 | Concurrent edits and proposals | 05D preview/hash pattern + lock + base-version check |
| P1 | Overfitting to bracket sports | Shared-capacity resources, sessions and intervals as profile data |
| P2 | Over-complex optimisation | Deterministic greedy v1 |
| P2 | Premature sport-specific templates | Templates are data with a cited basis |
| P2 | Guard collisions | No column names matching `rank`, `position`, `points`, `qualif`, `standing`; use `start_order`, `ordinal` |

## 18. Open decisions

These are to settle in the named phase, inside the frozen ADRs:

1. **05E-B:** the exact closed schema of the SchedulingProfile spec, and its first canonical templates (with sources or COMMON_PRACTICE labels).
2. **05E-A:** the recurring-rule granularity — weekly windows plus date exceptions are assumed sufficient; anything richer needs an ADR.
3. **05E-C:** whether a discarded draft may be reopened, or a new draft must always start from the published version.
4. **05E-D:** the conservative possible-occupant rule for deep dependency chains (bounded depth vs full transitive closure).
5. **05E-E:** whether the proposal places contests by competition-wide dependency depth or day by day.
6. **Product:** whether SCHEDULER may publish (frozen default: yes, via `COMP_MANAGE_SCHEDULE`).
7. **Existing gap carried in (05E-F):** contest lifecycle commands exist only in the store today; exposing them is in scope.
