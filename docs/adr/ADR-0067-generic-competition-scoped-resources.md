# ADR-0067 — Generic, competition-scoped resources typed by catalog vocabulary

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (executes ONCF-05A §28 / planned ADR-L)

## Context

Today a contest's "where" is a venue organization plus free-text `location_label` / `court_label`. The catalog already has a generic `ResourceType` vocabulary declared per discipline as capability data (ONCF-05B), with the note "resources themselves arrive in ONCF-05E".

## Decision

1. **One generic, competition-scoped `Resource`:**
   - `{competitionId, label, typeCode, attributes, capacity, exclusivityGroup?, venue?}`;
   - lifecycle `ACTIVE | RETIRED` as append-only status changes;
   - `typeCode` must be a catalog `ResourceType`: TENNIS_COURT, PADEL_COURT, BASKETBALL_COURT, BASKETBALL_HALF_COURT, BOWLING_LANE_PAIR, POOL, TRACK, ROAD_COURSE, OPEN_WATER_COURSE, CYCLING_COURSE, GOLF_COURSE.
   - New types are catalog vocabulary changes, never code branches.
2. **Attributes are typed data per resource type**, validated against a closed per-type schema in the catalog. Examples: pool lanes and length; track lanes; course distance; golf holes and starting tees.
   - Course data that a ruleset reads (par, stroke index) is resource data, not a discipline rule (05A §28).
3. **Three occupancy semantics, all generic:**
   - **Exclusive** (`capacity = 1`): one contest at a time, plus changeover. Examples: a court, a lane pair, a pool booked for a session.
   - **Shared capacity** (`capacity = N` units): concurrent contests may share the resource while the sum of their declared units stays within capacity. Units are, for example, entrants on a course per wave window, or tee starts per interval per starting tee. The unit's meaning comes from the SchedulingProfile requirement, not from code.
   - **Exclusivity group:** resources that physically overlap share a group key. For example, a full basketball court with its two half courts, or a re-lined multi-purpose court. Occupying one blocks every overlapping sibling.
4. **The venue stays as it is:** an optional organization plus a label. There is no separate Facility entity until a need is proven.
5. **Never stored as resource state:** occupancy and reservation are derived from the schedule (ADR-0070). A resource is never marked "reserved".
6. **Contest requirements** (resource type, quantity or capacity units, duration) come from the pinned SchedulingProfile (ADR-0069), checked against the discipline's declared `resourceTypes`.

## Consequences

- `contest_schedule.court_label` becomes display text next to a resource reference (05E-C migration). Existing labels remain readable.
- Lanes inside a swimming or track heat stay **slots** (sporting seeding, 05B), not resources. The pool or track is the resource.

## Alternatives considered

- **Sport-specific resource classes or stores:** rejected (ADR-0053).
- **A Venue → Facility → Resource hierarchy now:** rejected as premature; the exclusivity group already expresses shared space.
- **Free-text courts:** rejected; they make conflict detection impossible.
