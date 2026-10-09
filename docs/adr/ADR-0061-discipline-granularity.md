# ADR-0061 — Discipline granularity: modality = discipline + category (+ parameters)

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §14 (ADR-M); applied by the ONCF-05B canonical catalog

## Context

A "modality" means different things in different sports: singles, mixed doubles, a relay, a 5K, a 100 m freestyle. One discipline per event type would explode the catalog. A single discipline per sport would lose entrant structure.

## Decision

1. **A separate Discipline when the entrant structure, result schema or comparator differs.** Examples: `tennis.singles` vs `tennis.doubles`, `basketball.3x3`, `swimming.relay`.
2. **A Category when only eligibility differs:** MEN, WOMEN or MIXED, age band, skill class. Padel men's, women's and mixed doubles are therefore `padel.doubles` plus a category. Mixed composition is declared, never inferred.
3. **A parameter when only distance or stroke differs:** `running.road` covers 5K to marathon.
4. **The canonical catalog (ONCF-05B) has 21 disciplines for 24 modalities.** The dev-only `running.5k` keeps the pre-ONCF-05B shape.
5. **MODALITY and FORMAT are pinned independently by an Event.** Any compatible format may be chosen (ADR-0053).

## Consequences

- Ranking universes (ADR-0048) and authority scopes follow discipline codes. A distance-specific ranking is a universe parameter, not a discipline.

## Alternatives considered

- **One discipline per distance or stroke:** rejected (catalog explosion).
- **One discipline per sport:** rejected (entrant structure differs).
