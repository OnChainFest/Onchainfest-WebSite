# ADR-0071 — Hard/soft conflict semantics and a deterministic proposal engine

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (executes ONCF-05A §27.2)

## Context

A schedule is only trustworthy if every constraint is checked the same way for every sport. Proposals must be reproducible and reviewable, like 05D advancement previews.

## Decision

1. **Conflicts are typed, and every one is either HARD or SOFT.**
   - **Hard conflicts block publication:**
     - `RESOURCE_OVERLAP` (with changeover);
     - `EXCLUSIVITY_CONFLICT`;
     - `CAPACITY_EXCEEDED`;
     - `RESOURCE_TYPE_MISMATCH`;
     - `RESOURCE_UNAVAILABLE`;
     - `PARTICIPANT_OVERLAP`;
     - `TEAM_OVERLAP`;
     - `DEPENDENCY_ORDER` (a dependent contest starts before its feeders' expected end plus spacing);
     - `LOCKED_ASSIGNMENT_VIOLATION`;
     - `OUTSIDE_EVENT_WINDOW`;
     - `STALE_OCCUPANT` (a contest whose 05D occupant is STALE is scheduled as if resolved).
   - **Soft conflicts are warnings** an organizer may explicitly acknowledge:
     - `SHORT_REST` (when the profile marks rest as soft);
     - `LONG_WAIT`;
     - `MAX_CONTESTS_PER_DAY`;
     - `UNDERUSED_RESOURCE`;
     - `SEQUENCING_INEFFICIENCY`.

   A profile may promote a rest rule to hard. The list may grow in implementation, but the hard/soft split may not be removed.
2. **Participants are identified from existing facts, at competition scope:**
   - the participant's athlete (individuals);
   - the frozen team roster (team participants);
   - declared contest lineups;
   - the current 05D occupant of each place.

   No scheduling-specific copy of participant identity is kept. An athlete in two events is one person to the conflict check.
3. **Unresolved places:**
   - A contest whose places are unresolved can receive a **provisional** assignment.
   - Its participant conflicts are checked against every possible occupant derivable from the plan graph (e.g. both feeders' entrants), conservatively.
   - The schedule is re-checked whenever occupants change.
4. **The conflict engine is pure domain logic**, in `@br/competition`:
   - input: schedule content, resources, expanded availability, requirements, occupancy and dependency data;
   - output: a canonical, hashed conflict report.

   No database access, and no sport branches.
5. **The proposal engine is deterministic** (05A §27: greedy). Given the same competition state, plan, occupants, profiles, resources, availability, locked assignments and constraints, it produces the same proposal.
   - Contests are placed in a total order: stage and round order, dependency depth, contest sequence, then id.
   - Each gets the earliest feasible interval on the first compatible resource, in a stable resource order.
   - Locked assignments are never moved.
   - Anything it cannot place is reported with the blocking conflicts.
   - No randomness, no wall-clock time, no AI/LLM scheduling. An optimizer may come later behind the same proposal contract.
6. **Proposals are previews** with a canonical hash. Committing a proposal into the draft requires that hash (ADR-0070 §9).

## Consequences

- Every sport's scheduling is testable with the same property tests: determinism, no hard conflict in a committed proposal, locks respected, dependencies respected.

## Alternatives considered

- **Constraint solver or optimizer in v1:** deferred (complexity, explainability, determinism).
- **Free-form organizer edits without validation:** rejected; publication would be untrustworthy.
