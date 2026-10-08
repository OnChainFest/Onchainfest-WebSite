# ADR-0065 — Advancement: a pinned policy axis, append-only slot facts, provenance, staleness on read

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05D (executes the 05B stage graph; keeps ADR-0047 / ADR-0054)

## Context

05B's immutable plan already declares, as data, where every dependent slot's entrant comes from: winner or loser of a contest, rank r of a group, the k-th best rank-r entrant across groups, the k-th entrant selected by a typed transition (Q/q, cut with ties, finishers only), or a dynamic round's field. Nothing resolved those declarations.

## Decision

1. **AdvancementPolicy is the fifth axis.** It is a versioned, hashed catalog row with a basis (`sports.advancement_policy*`), pinned with the scoring axes and frozen at field lock. It declares the minimum result status (OFFICIAL by default), CONFIRM or AUTOMATIC commit, heat semantics (PLACE_THEN_TIME = competitive; OVERALL = logistic), boundary ties (HOLD or SEED), withdrawals (VACATE or NEXT_BEST) and a cross-group order over classification values.
   - **What it does not hold:** destinations. Those stay in the plan.
2. **One pure engine** (`advancement-engine/1`) resolves one unit at a time — CONTEST, RANK, BEST or FIELD — into assignments. Each carries a state (RESOLVED, VACANT, PENDING, HELD) and structured provenance: the family, the plan source, the result version with its hash, the classification hash and position, the heat place, the cross-group comparison and any tie candidates.
   - It never branches on sport and never applies a hidden tie-break.
   - A tie at a boundary is HELD for an explicit override, unless the policy says SEED.
3. **Decisions and facts are append-only** (`competition.advancement_decision`, `competition.slot_assignment`).
   - Each fact stores the canonical digest of its assignment (`br:advancement-assignment@1`); the decision stores `br:advancement-decision@1` and its hash. Both use the platform canonicalizer.
   - Contestant rows are never updated: occupancy is the latest fact (`v_contest_occupant`).
4. **Preview → confirm.** A commit carries the hash of the preview the organizer saw. It is refused if the preview or the unit's facts changed meanwhile, or if it would move an entrant into or out of a started contest.
   - **Only changed targets get new facts.** Re-running with unchanged evidence writes nothing.
5. **Staleness is computed on read, never stored.** A fact whose digest differs from the current preview is STALE; this happens after a correction, a withdrawal or a re-officialization. STALE propagates to contests fed by stale slots.
   - A contest with a stale occupant cannot start (the start guard is injected, so the structure store never reads results).
   - The history keeps every earlier fact, marked INVALIDATED (a different entrant replaced it) or REPLACED.
6. **Overrides** (`COMP_GENERATE_STRUCTURE`) are explicit, reasoned and audited. Each records what it replaces and is reversible by an explicit revocation. Automatic commits never overwrite an override. Reasons are organizer-only.
7. **Dynamic rounds.** After a CUT or ELIMINATE field is committed, the dynamic round gets its contests: one per field place for per-entrant (SERIES) contests, or a single field contest otherwise.
   - Materialization is additive; a place that later becomes vacant keeps its vacant contest. No time, venue or grouping is assigned (05E).
8. **Naming.** QUALIFIED remains an Achievement only (BRT-08/10). In-event progression is advancement: no qualification table, flag or column exists.

## Consequences

- **The chain is real:** official result → classification → policy → slot fact → next contest (start-guarded).
- **v1 events are untouched:** no policy can be pinned (no ruleset family), and their dependent slots stay unresolved exactly as before.
- **Known gap:** field-family rulesets (pinfall, time) yield RANKED outcomes, not WIN or LOSS. A two-entrant field contest used as a match (bowling stepladder) therefore has no automatic winner, and the slot needs an override until a head-to-head pinfall vocabulary exists.

## Alternatives considered

- **Updating contestant rows:** rejected. They are class-A plan facts (0008: "rows here are never updated").
- **Storing a STALE flag:** rejected. Stored staleness goes stale itself, and guards forbid it.
- **Resolving inside the ledger transaction:** rejected. `br_results` has no competition access, and advancement must stay an explicit, previewable organizer act.
