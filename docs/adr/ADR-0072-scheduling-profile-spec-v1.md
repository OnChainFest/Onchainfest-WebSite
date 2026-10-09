# ADR-0072 — SchedulingProfile spec v1: generic vocabulary, scheduling unit, capacity units and selectors

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-B-0 readiness audit. Clarifies [ADR-0069](./ADR-0069-scheduling-profile-is-a-versioned-axis.md) within its latitude and does not change it. Builds on [ADR-0066](./ADR-0066-scheduling-boundary-and-competition-scope.md), [ADR-0067](./ADR-0067-generic-competition-scoped-resources.md), [ADR-0070](./ADR-0070-schedule-versions-publication-and-history.md) and [ADR-0071](./ADR-0071-conflict-semantics-and-deterministic-proposals.md).

## Context

ADR-0069 made SchedulingProfile a versioned catalog axis pinned per event, and left "the exact closed schema" to 05E-B. The readiness audit found that four semantic choices inside that latitude decide what every later engine computes, so they must be frozen before code exists:

1. what is scheduled as one unit;
2. which requirement applies to which contest;
3. what a resource's capacity counts;
4. what "duration" means.

It also found a product decision ADR-0069 left open: who may author profiles, and whether events may override them.

Repository evidence the decisions rest on:
- **Contest structure (05B):** the immutable plan already defines contest types (`MATCH`, `HEAT`, `SERIES`, `SESSION`), round types, stage primitives, and logistic partitions whose method may be `GROUPED_ENTRANTS` (golf tee groups, ten-pin bowling squads: per-entrant contests that start together).
- **Time conventions (05B):** format engines express within-contest timing in **seconds** (`intervalSeconds`, plan `startOffsetSeconds`); rulesets hold playing time (periods, minutes) as sporting rules.
- **Resources (05E-A):** generic, catalog-typed resources carry a capacity whose unit meaning is deferred to the profile (ADR-0067).
- **Catalog (05C/05D):** the generic catalog-kind infrastructure (versions, spec hash, basis, lookup-first provisioning, operator-only writes) and the per-event scoring pin, frozen at field lock, already serve three axes.

## Decision

1. **One generic SchedulingProfile, catalog data only.**
   - There is exactly one profile type, with no sport-specific profile classes, stores, tables, endpoints, fields or code branches.
   - Sport identity stays catalog data, and differences between sports are only differences in parameter *values*.
   - The profile reuses the existing catalog-kind infrastructure: versions, `spec_hash = catalogSpecHash('br:scheduling-profile-spec', spec)`, basis (GOVERNING_RULE with source, or COMMON_PRACTICE with note), and DRAFT → PUBLISHED → RETIRED.
   - The spec carries `specVersion: 1` (the shape of the spec), distinct from the catalog version number (the content). No second versioning system is introduced.

2. **Published catalog templates only (v1).** An event can pin only a **PUBLISHED** profile version provisioned by the platform operator (`br_catalog`). **Organizers cannot author, copy or edit profiles** in v1; organizer-authored or competition-scoped profiles would require a new ADR.

3. **No event-level profile overrides.**
   - **How a profile is pinned:** by version id, never copied, through the event's scoring pin (`COMP_EDIT`). Changing it before field lock is a new append-only pin. It is frozen at field lock (ADR-0069).
   - **No partial overrides:** there are no per-event parameter overrides. An event uses a profile version exactly as published.

4. **Operational adjustments happen at assignment level only.**
   - Real-world venue and timing constraints are handled in the schedule: an organizer moves, extends or shortens a concrete assignment's interval, with a mandatory reason, in a draft schedule version (ADR-0070). The adjustment is audited and append-only.
   - The profile supplies *expected* values to the proposal and conflict engines. It never constrains what an organizer may record for a specific assignment, except through conflicts (ADR-0071), which are judged on the concrete interval.

5. **The scheduling unit is a contest, or a grouped-entrant partition.**
   - The unit is normally one **contest**.
   - Where a stage's logistic partition method is **`GROUPED_ENTRANTS`**, all contests sharing a partition key within a round form **one unit** with one common start. Examples are golf tee groups and ten-pin bowling squads.
   - This is derived from 05B plan data, never from sport identity, and it is not a profile field.
   - Result-dependent groups (post-cut, ADR-0066 §4) become units in the same way once formed.

6. **Requirements and selectors.**
   - A spec holds one or more **requirements**.
   - Each requirement has a **selector** over 05B vocabulary only: `{contestType?, roundType?, stagePrimitive?}`. An empty selector is the default requirement, and exactly one default is required.
   - **Precedence:** a contest uses the matching requirement with the **most specified selector fields** (most specific wins).
   - **Equal-specificity overlap is invalid.** A spec in which any contest could match two requirements with the same number of specified fields is refused at validation (publication and pin time), never resolved by order.
   - Pin-time compatibility (ADR-0069 §4):
     - every requirement's `resourceType` must be one the discipline declares in its capabilities (05B), so a v1 discipline, which declares none, cannot pin a profile;
     - the default requirement covers every contest type the format produces.

7. **Requirement parameters** (closed, bounded data, all durations as **integer seconds**):

   | Parameter | Meaning |
   |---|---|
   | `resourceType` | Catalog `ResourceType` the unit needs (one resource per unit) |
   | `capacityUnit` | `CONTEST` or `ENTRANT` (see 8) |
   | `expectedDurationSeconds` | > 0. Time from **each start** to that start's finish |
   | `changeoverSeconds` | ≥ 0. Time after a unit before the next unit on the same resource |
   | `startSpacingSeconds` | Optional, > 0. Minimum gap between consecutive unit starts on a **shared-capacity** resource (tee, wave or heat intervals are this one concept) |
   | `concurrentStarts` | Optional, ≥ 1, default 1. Units allowed to start at the same instant on one resource (e.g. two starting tees) |
   | `rest` | Optional `{minimumSeconds ≥ 0, enforcement: HARD | SOFT}`. Minimum gap between an entrant's consecutive units, also applied across dependency edges |
   | `dependencyLeadSeconds` | Optional, ≥ 0. Minimum time after feeder units end (result and advancement processing) |
   | `maxUnitsPerEntrantPerDay` | Optional `{value ≥ 1, enforcement}` |

   Plus, at profile level, an optional `regrouping: {groupSize ≥ 1, order: FIELD_ORDINAL_ASC | FIELD_ORDINAL_DESC}`. It applies only to result-dependent fields that 05D committed without groups, and orders 05D's field ordinals; it never selects entrants.

   **Interpretation rules** (for 05E-D/E, frozen here so the meaning is unambiguous):
   - **Occupancy:** a unit occupies its resource from its first start until **its latest start offset (05B plan) + `expectedDurationSeconds`**, then for `changeoverSeconds` on an exclusive resource.
   - **Exclusive spacing:** `startSpacingSeconds` and `concurrentStarts` constrain shared-capacity resources. On an exclusive resource, spacing is occupancy plus changeover.
   - **Generic validation only** (signs, bounds, `concurrentStarts ≥ 1`, closed keys, selector uniqueness) belongs to the spec. Cross-entity feasibility (e.g. spacing versus capacity on a concrete resource) belongs to the conflict and proposal engines.

8. **Capacity units: `CONTEST` or `ENTRANT`.** The resource holds the capacity *value* (05E-A); the requirement declares what one unit consumes of it:

   | Unit | Consumption | Examples |
   |---|---|---|
   | `CONTEST` | 1 per scheduled contest | Courts, a pool booked for heats, a track, stepladder matches on a lane pair |
   | `ENTRANT` | 1 per entrant of the unit | A road course (runners on course), a golf course (players on course), a lane pair in qualifying blocks (bowlers per pair) |

   No `requiredCapacity` value exists in the profile. Lanes inside a heat stay slots, never capacity units or resources.

9. **Out of the profile, never duplicated:**
   - format structure and grouping (`waveCapacity`, `groupSize`, `intervalSeconds` / `startOffsetSeconds`);
   - ruleset playing time and games per block;
   - resource capacity values and attributes;
   - availability, sessions and timezones (availability windows and resource or competition zones, ADR-0068);
   - the dependency graph and occupants (05D);
   - concrete instants (the schedule).

10. **Deterministic interpretation.**
    - The spec contains only closed, typed, bounded values: no randomness, natural language, prompts, heuristics or executable content.
    - The same profile version, plan, occupants, resources and availability always yield the same requirements, units and constraints.
    - Proposals and conflict reports record the profile version id and spec hash they used.

## Consequences

- **One profile for all eight sports:** tennis, padel, running and marathon, swimming, cycling, ten-pin bowling, basketball (including wheelchair) and golf. Only template values differ, as shown in the ONCF-05E-B-0 audit's proof matrix.
- **Organizers get predictable, citable templates.** A venue reality is a reasoned adjustment of a concrete assignment, not a forked profile.
- **v1 events** (no declared resource types) cannot pin a profile, and remain manually schedulable.
- **05E-B scope:**
  - spec types and validation;
  - canonical templates (with a basis);
  - the catalog kind and migration;
  - the pin column on `event_scoring`;
  - pin-time compatibility;
  - the catalog and scoring read API.

  05E-B contains no conflict or proposal engine.

## Alternatives considered

- **Organizer-authored or competition-scoped profiles in v1:** deferred (new ADR). They add a second authoring path and governance for parameters without evidence they are needed.
- **Event-level parameter overrides:** rejected. They break the meaning of a published, hashed version and duplicate what assignment-level adjustments already express with a reason.
- **Durations derived from the ruleset:** rejected, as in ADR-0069. Playing time is not an operational slot length.
- **Separate `teeInterval`, `waveInterval` and `heatInterval` fields:** rejected. They are one concept, `startSpacingSeconds`.
- **A Session entity:** rejected for v1. Sessions are availability windows (ADR-0068), and "one stage or round per day" is `maxUnitsPerEntrantPerDay`.
- **Milliseconds:** rejected for scheduling parameters. The repository's operational timing (05B) is in seconds, and sub-second precision has no scheduling meaning.
- **Resolving equal-specificity overlaps by declaration order:** rejected. It is order-dependent and invisible.
