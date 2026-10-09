# ADR-0063 — classification-engine/2: on-read, explainable stage classifications

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05C (executes ADR-0060; keeps ADR-0047)

## Context

05B published the ClassificationPolicy v2 vocabulary. 05C must order groups, heat rounds and multi-round stages from contest results, deterministically and explainably. ADR-0047 forbids a standings table as truth.

## Decision

1. **`classifyStage` is pure.**
   - Input: a policy version, a scope (stage, optional group, rounds through k), the participants, the normalized contest results, the pending contests, the seed order and the declared attributes the policy names.
   - Output: a `br:stage-classification@1` document and its canonical hash.
2. **STANDINGS.**
   - Match points by outcome. Walkover and retirement fall back to win or loss unless a points rule is declared for them.
   - Ordered criteria: wins, win ratio, matches played, difference, exact ratio, sum with per-contest cap, average excluding forfeits, head-to-head mini-table (optionally only between two), tied subset (at least *n*), seed, organizer lot.
   - Restart-on-separation and walkover / completed-all exclusions are policy flags.
3. **METRIC.**
   - Aggregate SUM, MIN, MAX or BEST_N over the rounds in scope.
   - Ordered keys, then tie-breaks: count-back over the final round's units, finer precision, place sum (the stage's own finish positions when recorded), last round place, highest single.
   - Non-finishers follow finishers in the declared status order: PULLED by laps down, then pull order; NOT_PLACED by time.
   - Subsets group by a **declared entry attribute** (`subsetsByAttribute`), never by inferred gender or age. This replaces 05B's category-based subset field, which nothing had used.
   - Team scores are derived from individuals (best N places or times; ties go to the team whose last scorer placed better).
4. **No hidden tie-break.** Entrants equal on every declared criterion share a position (1, 1, 3). ORGANIZER_LOT separates them only with an explicit lot order; lots as recorded facts arrive with 05D. Every separation is recorded with the criterion, its kind and the compared values. Arithmetic is exact (BigInt; ratios by cross-multiplication).
5. **Computed on read.**
   - `GET /v1/events/:id/stages/:stage/classification` assembles current contest results at the policy's minimum status (as `br_results`), re-validates each under its pinned ruleset (ADR-0062), and classifies.
   - It is never persisted or published; it is a proposal (ADR-0047). The document references the exact result versions and content hashes it read, so 05D can submit it as a derived ResultVersion.
   - Contests without an admissible result make the document `complete: false`. Entrants not yet reported are `PENDING`, not DNS.
6. **Catalog.** ClassificationPolicy v2 versions are catalogued as `sports.classification_template*` (versioned, hashed, with a basis), separate from BRT-10's authority-owned `ranking.classification_policy` (v1). Events pin them per stage (`competition.event_scoring`), frozen at field lock.

## Consequences

- **Groups → knockout.** Group standings needed by 05D's advancement are available without any qualification or advancement logic in 05C.
- **`classification-engine/1` is unchanged.** It still serves BRT-10 classification submissions.

## Alternatives considered

- **Persist standings snapshots:** rejected (ADR-0047).
- **Extend `classification-engine/1`:** rejected. Its "DisciplineVersion comparator keys only" rule (ADR-0049) is exactly what v2 replaces for in-event tables.
