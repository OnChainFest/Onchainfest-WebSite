# ADR-0059 — The Ruleset (scoring model) is a separate versioned axis

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §22 (ADR-G); vocabulary in ONCF-05B, validators and pinning in ONCF-05C

## Context

How one contest is decided or measured is neither a sport rule nor a bracket rule. Examples:

- best of 3 with Star Point;
- 10 minutes or first to 21;
- gun time rounded up to the second;
- 10 frames, at most 300;
- Stableford points.

The same discipline legitimately runs several rulesets, and the group stage and the knockout of one event may differ.

## Decision

1. **A closed vocabulary of ten sport-neutral families**, each with a closed, bounded parameter set:
   - SETS_OF_GAMES
   - TIMED_PERIODS
   - TIMED_OR_TARGET
   - ELAPSED_TIME
   - FINISH_ORDER_WITH_TIME
   - LAPS_AND_TIME
   - FRAMES_PINFALL
   - STROKES
   - STABLEFORD
   - MATCH_PLAY_HOLES
2. **Rulesets are published as templates.** Each carries its basis: a GOVERNING_RULE with its source, or COMMON_PRACTICE.
3. **A v2 DisciplineVersion declares its allowed families** (a capability, ADR-0053). Engines may require a family; Stableford requires STABLEFORD.
4. **Phasing.** ONCF-05B ships the vocabulary and validation only. Catalog persistence, Event pinning (with per-stage override) and score validation and normalization are ONCF-05C.

## Consequences

- Results keep the BRT-01 ResultEntry shape. Rulesets validate and normalize into it.
- New sport-specific needs become new family parameters (new versions), never sport code.

## Alternatives considered

- **Encode scoring in the DisciplineVersion:** rejected. It means one version per scoring combination.
- **Encode scoring in the FormatVersion:** rejected. Stages of one format use different scoring.
