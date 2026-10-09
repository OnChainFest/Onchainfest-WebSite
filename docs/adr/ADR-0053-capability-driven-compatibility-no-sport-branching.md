# ADR-0053 — Capability-driven compatibility; no engine branches on sport identity

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §18.4 (approved design, ADR-A); implemented in ONCF-05B

## Context

ONCF-05A fixes eight canonical sports (tennis, padel, running, swimming, cycling, bowling, basketball, golf) and a 72-cell design matrix of modality × format. BRT-05 decided compatibility with one rule: a format's contest type must be allowed by the discipline. That rule cannot express:

- a wave start needing a logistic start method;
- timed finals needing a declared entry time;
- Stableford needing the Stableford ruleset family;
- a stage race needing multi-round classification.

The tempting alternative, `if (sport === 'golf')`, would spread sport identity through engines, stores and UI.

## Decision

1. **A DisciplineVersion provides capabilities.** v2 specs declare `capabilities`: ruleset families, partition kinds, start methods, multi-round and resource types. They also declare `entryAttributes`. Contest types and participant kinds come from the existing spec fields.
2. **v1 specs derive a conservative legacy set:**
   - their contest types and participant kinds;
   - COMPETITIVE partitions when they allow MATCH;
   - nothing else.

   Every BRT-05 / ONCF-03A event keeps its exact meaning.
3. **A format engine requires capabilities.** v2 engines declare `requires`, which is hashed into their FormatVersion spec. A v1 engine's requirement stays "its contest type".
4. **One generic function decides compatibility everywhere:** `capabilityIssues(providedCapabilities(dv), engineRequirements(engine))`. It is used by the catalog read (`compatibleFormatVersionIds`), by `createEvent` and by plan generation. A mismatch names the missing capability (`CAPABILITY_MISMATCH`), never the sport.
5. **Binding rule.** No engine, store or UI may branch on a sport or discipline code. Sport variation is versioned data:
   - DisciplineVersion;
   - Ruleset;
   - FormatVersion configuration;
   - classification templates;
   - draw and heat policy data.

## Consequences

- **The 72-cell matrix is an output.** It is computed from catalog data, and a unit test asserts it: 61 compatible and the 11 approved ✘ cells.
- **New sports are mostly data.** A new requirement kind is a vocabulary change with its own review.
- **Legacy derivation must stay stable.** Changing it would change the compatibility of historical disciplines.

## Alternatives considered

- **A per-sport compatibility table in code:** rejected. It is sport branching by another name and drifts from the catalog.
- **Requirements stored only on FormatTemplate rows:** rejected. Engines are code-versioned (ADR-0024), so requirements belong to the engine version and are hashed into its FormatVersion.
