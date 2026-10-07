# ADR-0060 — ClassificationPolicy v2 vocabulary (standings and metric families)

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §23–§24 (ADR-H); vocabulary in ONCF-05B, `classification-engine/2` in ONCF-05C; will supersede ADR-0049 §1 for in-event classifications

## Context

`classification-engine/1` orders only by the DisciplineVersion comparator keys, with SUM, MAX or MIN aggregation. Real tables differ by **competition** and need more:

- head-to-head among tied entrants;
- tied-subset differences (FIP three-way ties);
- differences and ratios;
- averages capped per game (3x3);
- count-back (golf);
- status order (DNF, DQ);
- category subsets;
- team scores derived from individuals.

## Decision

1. **Two policy families:**
   - STANDINGS: match points plus ordered criteria;
   - METRIC: aggregation plus keys plus tie-breaks, with status order and subsets.

   Both use a closed criteria vocabulary: no floats, no scripting. Every policy must end with an explicit terminal rule (SEED, ORGANIZER_LOT or SHARED).
2. **Templates are data citing their source:** `itf_rr`, `fip_groups`, `fiba_5x5`, `fiba_3x3`, `ibf_bowling_rr`, `road_race`, `swim_time`, `golf_stroke`, `golf_stableford`, `bowling_pinfall`, `cycling_gc`.
3. **ADR-0047 is unchanged.** A classification is a derived ResultVersion; the engine proposes and an authority submits. No standings column is written anywhere.
4. **Phasing.** ONCF-05B ships the vocabulary and validation only (`@br/rankings`). The engine, and the relaxation of ADR-0049's "keys equal the DisciplineVersion comparator" rule for in-event classifications, are ONCF-05C.

## Consequences

- `classification-engine/1` and its policies stay valid. Golden vectors will cover both engines.

## Alternatives considered

- **Hard-code each sport's tie-break chain:** rejected. That is sport branching (ADR-0053).
