# ADR-0057 — The team roster is frozen at field lock; roster ≠ lineup ≠ on court

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §13.3, §29 (ADR-F); implemented in ONCF-05B; refines ADR-0026

## Context

A team's lineup was validated against ACTIVE memberships **at submission time**. A squad could therefore change after the lock, and "the roster this entrant entered with" was never recorded. One `lineupSize` also stood for three things: the roster, the declared lineup and the players on court.

## Decision

1. **v2 participation separates three counts:**
   - `roster` {min, max}, frozen at lock;
   - `lineupSize`, the declared lineup (ADR-0026);
   - `onCourt` {count, minToContinue}, which is rule data only and never stored per contest.

   It adds `lineupOrdered` (relay legs, Baker frame order), `substitution`, `composition` (declared, never inferred) and `lineupConstraint` (a sum over a declared MEMBER attribute, recorded but not validated in v1).
2. **`lockField` snapshots each TEAM participant's ACTIVE members** into the append-only `participant_roster_member`, hashed into `br:competition-field@2`. A team outside the roster bounds refuses the lock (`FIELD_INCOMPLETE`); nothing is silently dropped.
3. **On a v2 field, lineups validate against the frozen roster**; a member added later is refused. Ordered lineups store each member's `ordinal`. v1 fields keep the BRT-05 rule.
4. **A v2 discipline's team registration requires `roster.min` ACTIVE members.**

## Consequences

- Roster amendments after the lock (late registrations, injury replacements) need an explicit, audited amendment command. It is not built yet.
- The declared lineup remains operational. The credited lineup stays in Result content (ADR-0026).

## Alternatives considered

- **Keep validating against live membership:** rejected. Roster drift during an event was the risk ONCF-05A identified.
