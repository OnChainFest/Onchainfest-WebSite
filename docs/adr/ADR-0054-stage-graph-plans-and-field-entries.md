# ADR-0054 — Stage-graph plans, unresolved transitions and field entries beyond 64 slots

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §18.2, §19–§20, §26 (ADR-B); implemented in ONCF-05B; extends ADR-0024

## Context

BRT-05 plans are single-stage, and `contestant.slot` is CHECK-capped at 64. This has three consequences:

- Groups → knockout, heats → final, qualifying → stepladder and multi-round play with a cut cannot be represented.
- A road race with thousands of entrants cannot be one contest.
- `RANK_FROM_STAGE` exists but names no stage or group.

## Decision

1. **Plan v2 (`br:competition-plan@2`) is a stage graph.** It contains:
   - stages: one of the primitives KNOCKOUT, ROUND_ROBIN, FIELD or HEATS, with an optional partition;
   - transitions: RANK_FROM_GROUP, QUALIFY_BY_PLACE_AND_TIME, CUT, ELIMINATE_NON_FINISHERS, STEPLADDER or RANK_TO_BRACKET;
   - rounds that carry their stage, group and optional `dynamicEntry`.

   v1 plans keep `br:competition-plan@1` and their hashes.
2. **Dependent slots name their source.**
   - `RANK_FROM_STAGE` carries the stage and group;
   - `BEST_RANKED_FROM_STAGE` carries the stage, rank and ordinal;
   - `QUALIFIER` carries the transition and ordinal.

   All stay UNRESOLVED; resolution is advancement (ONCF-05D).
3. **Field entries live in `contest_entry`**, with no 64-slot ceiling (up to 20,000 per plan): position plus an optional start offset. Slots remain for head-to-head and lane contests (lane = slot).
4. **Dynamic rounds.** A round whose field is set by a transition (a golf cut "top N and ties", or the elimination of non-finishers) is materialized with zero contests. Advancement materializes it later as resolution facts.
5. **One immutable plan per event still holds** (ADR-0024). Nothing is regenerated.
6. **Format engines are compositions of the four primitives.** `groups-knockout/1`, `heats-final/1`, `multi-round/1`, … They are pure, versioned and capability-declaring (ADR-0053).

## Consequences

- **Schema.** New tables `stage`, `stage_transition` and `contest_entry`. `round`, `contest` and `contestant` gain nullable columns. The migration is additive (0032).
- **Read models.** They carry stage, group, partition and entries. A rebuild remains identical (tested).
- **Contest start.** Entries do not block a contest's start; a withdrawn entrant in a mass field is a non-starter, not a structural blocker.

## Alternatives considered

- **A second plan per stage:** rejected. It breaks "one immutable plan per event".
- **Placeholder participants for unknown fields:** rejected. They fabricate entrants.
- **Raising the slot cap to 20,000:** rejected. Slots are positional head-to-head semantics; fields are entries.
