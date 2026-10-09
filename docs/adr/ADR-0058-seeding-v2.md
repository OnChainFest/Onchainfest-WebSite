# ADR-0058 — Seeding v2: ranked-then-drawn, by entry attribute, declared sources and audited overrides

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §25 (ADR-E); implemented in ONCF-05B; extends BRT-05 seeding

## Context

BRT-05 seeding is either a full manual permutation or a full random draw. Real draws need more:

- They fix the seeds and draw the rest at random, with ITF and FIP seeds 3–4 and 5–8 drawn within their bands.
- Swimming orders by entry time, with missing times last and ties drawn.
- Organizers move an entrant, for example a host wild card.

## Decision

1. **New methods.**
   - `RANKED_THEN_DRAWN`: the declared seeds, at most 64, in seed order. They are optionally banded ([1], [2], [3–4], [5–8], [9–12], …), and the unseeded entrants are drawn.
   - `BY_ENTRY_ATTRIBUTE`: orders by a frozen numeric PARTICIPANT attribute (ADR-0056), ASC or DESC. Missing values go last; ties and missing values are ordered by the draw.
2. **Optional declared source:** ORGANIZER, DECLARED_EXTERNAL (label, as-of date) or ENTRY_ATTRIBUTE. External rankings are **declared, recorded and hashed, never verified**. No ranking system is invented; ADR-0048's points tables remain deferred.
3. **Overrides** move one entrant to a position after the computed order. Each needs a reason, is part of the hashed `br:competition-seeding@2` document, and is audited individually (`event.seeding.override`).
4. **Every non-manual method draws from a persisted 32-byte CSPRNG seed** (`br-draw/1`). The draw is reproducible, not provably fair.
5. **Version selection.** v2 is used when a v2 feature is requested or the field is v2. Otherwise the BRT-05 v1 document and hash are produced unchanged. Seeding stays once per event and is immutable.

## Consequences

- `event_seeding` gains `seeding_version` and `seeding_document`, and its method and draw checks are relaxed in migration 0032.
- Banded draws and standard bracket placement together reproduce ITF and FIP seed-line behaviour without sport code.

## Alternatives considered

- **Seeding inside format engines:** rejected. Engines must stay free of randomness (ADR-0024).
