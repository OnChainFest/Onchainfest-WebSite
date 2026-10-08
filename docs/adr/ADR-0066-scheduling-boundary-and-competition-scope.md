# ADR-0066 — Scheduling boundary: 05E owns WHERE and WHEN, at competition scope

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (executes ONCF-05A §27; extends ADR-0055)

## Context

ONCF-05B–05D produce the immutable plan, scored and classified results, and committed advancement facts. Scheduling is the remaining operational layer.

Its boundary has to be frozen before code exists, for three reasons:
- the same athlete can enter several events of one competition;
- some groupings are intrinsic to a format while others depend on results;
- `contest_schedule` already exists as an immediately public, overwritten-in-place table.

## Decision

1. **Ownership.**
   - 05D answers "who plays against whom".
   - **05E answers "who plays where and when".**
   - 05E owns time, resource assignment, availability, expected duration, changeover, rest, scheduling conflicts, dependency-aware ordering, proposals, schedule versions, publication, operational changes and the operational contest lifecycle commands (start, complete, cancel, void).
2. **05E never decides** scores, winners, classification, qualification, advancement, eligibility or authority/referee matters. It **consumes** advancement state (`v_contest_occupant`, target states, the 05D start guard) and never writes it.
3. **Competition scope.** A schedule, its conflict check and its proposal cover a whole **competition**, not one event, because one athlete or team can occupy contests in several events. Events still pin their own SchedulingProfile (ADR-0069).
4. **Grouping ownership** (extends ADR-0055):
   - **Intrinsic grouping is 05B's**, fixed in the immutable plan: initial waves, initial heats, round-1 tee groups, bowling qualifying blocks, time-trial order and offsets.
   - **Result-dependent operational grouping may be done by 05E**, only from occupants 05D resolved. Example: grouping the entrants of a post-cut round, which 05D materialized without groups.
   - 05E may decide **when** a resolved group starts and how resolved entrants are grouped for start times. It never decides **who** belongs to the round.
   - Any grouping rule is generic, driven by SchedulingProfile data.
5. **Sport is data** (ADR-0053). No scheduler, resource engine, store, table or endpoint is per sport. The pipeline is generic:

   discipline → format → ruleset → **SchedulingProfile** → resource requirements → generic scheduler.

6. **Out of scope for 05E:** live scoring, live timing, referee assignment, sporting authority, check-in, notifications, payments, ticketing, spectators, broadcast, awards, sponsors, $BRT rewards, marketplace, gift cards and prize fulfilment.

## Consequences

- An event-scoped scheduler is a defect: it would hide cross-event participant conflicts.
- A post-cut round can be scheduled only after its field is committed (ADR-0065), and only from that field.
- **The ADR-0055 / 05D gap is closed by this decision.** Round-1 tee groups come from the plan, while post-cut grouping (which 05D left to 05E) is a 05E scheduling-grouping policy.

## Alternatives considered

- **Event-scoped scheduling:** rejected (misses cross-event conflicts).
- **05E re-deriving fields from classifications:** rejected (it would duplicate and contradict 05D).
