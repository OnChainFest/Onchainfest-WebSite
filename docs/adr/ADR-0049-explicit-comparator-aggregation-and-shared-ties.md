# ADR-0049 — Ordering comes only from the DisciplineVersion comparator plus an explicit aggregation policy; exhausted ties are shared, never broken

- **Status:** Proposed
- **Date:** 2026-10-01
- **Origin:** BRT-10 read-first section E, resolved narrowly (BRT-01 result domain §2.1, §4.1–4.2, §6.2, §9; RC-1 tie policy; ADR-0032 pattern)

## Context

BRT-01 defines the Comparator as *"an ordered list of tie-break keys"* in the DisciplineVersion (e.g. bowling `average desc, total pins desc, highest series desc`). The stored shape (`packages/competition/src/catalog.ts`) is:

```
{ outcomeModel, primary: HEAD_TO_HEAD_WINNER | METRICS,
  keys: [{ metric, order: HIGHER_IS_BETTER | LOWER_IS_BETTER | ORDINAL }] }
```

BRT-05 stores and hashes comparators but never executes them. BRT-08 and BRT-09 use only one key's order.

The stored shape declares **no aggregation** (how values from several contests combine into one standing value) and **no outcome points** for head-to-head tables. A standings engine that guessed either would be hiding sport-specific behaviour. Direction lives on comparator keys; `MetricSpec` has no direction of its own.

## Decision

1. **Keys come only from the DisciplineVersion.**
   - A classification orders participants by the pinned DisciplineVersion's comparator keys, **in declared order and with declared direction**.
   - A policy may not add, remove, reorder or re-direct keys.
   - An `ORDINAL` key, or a metric with no declared order, cannot be ranked (`COMPARATOR_UNDEFINED` / `METRIC_NOT_COMPARABLE`).
   - The core never hard-codes a sport.
2. **Aggregation is declared by a versioned ClassificationPolicy.** `br:classification-policy@1` is immutable, hashed, published and retired like other BRT rule specs. It declares, for each comparator key:
   - the source: `ENTRY_PRIMARY_MARK` or `PERFORMANCE`;
   - the aggregation, from a **closed** vocabulary: `SUM | MAX | MIN`.

   `AVERAGE` and any other division are refused with `POLICY_UNSUPPORTED`, because rounding would be a hidden rule. Arithmetic is exact over canonical decimal strings at the metric precision. Floats never enter.
3. **Head-to-head needs declared points.** When `primary = HEAD_TO_HEAD_WINNER`, the policy must declare integer points for every `ResultOutcome` the discipline can produce. The leading key is then `points SUM, HIGHER_IS_BETTER`, followed by the DisciplineVersion keys. An outcome without declared points blocks the derivation (`POLICY_UNSUPPORTED`). Head-to-head records between tied participants are **not** an implicit key; a future policy version may declare them.
4. **Missing values block the derivation.** A participant in scope with no value for a key aggregated by `MAX`/`MIN` blocks the derivation with `COMPARATOR_INPUT_MISSING`. `SUM` over zero inputs is defined as 0 at metric precision. Missing values are never treated as 0 or as worst.
5. **Exhausted ties are shared and stay visible.**
   - Participants equal on every key share a rank, numbered competition-style: 1, 1, 3.
   - Each such entry carries `tied: true` and its comparator trace (`tieBreakKeys`: metric, order, value).
   - No further tie-break exists: not identifier, name, insertion order, timestamp or database order.
   - The serialized order inside a tie group is a canonical set order. It carries **no** meaning and is never displayed as a ranking.
6. **Best-mark rankings rank on one metric.** A `BEST_MARK` ranking compares a single Performance Mark under its metric's DisciplineVersion order. The other comparator keys refer to other metrics a single mark does not carry, so they do not apply. Equal best marks are shared ties.
7. **Determinism is part of the contract.**
   - Identical snapshots produce byte-identical canonical output and identical hashes.
   - Each output pins the comparator, by DisciplineVersion id and spec hash, and the policy spec hash.
   - Historical outputs are reproduced from their pins, never from today's catalog.

## Consequences

- Bowling-style "average" standings need a future policy version that defines rounding explicitly. Until then they are refused, not approximated.
- Ties are honest. Any qualification cut-off at rank N includes everyone sharing a rank ≤ N (ADR-0050).

## Alternatives considered

- **Implicit SUM for every key.** Rejected: a hidden rule (fails for best-of disciplines).
- **Identifier or registration-order tie-break.** Rejected: the brief and BRT-01 forbid hidden tie-breaks.
- **Open aggregation expressions.** Rejected: rule specs use closed vocabularies only (ADR-0032, ADR-0038, ADR-0043).

## Clarifications (BRT-10 Step 3, engine implementation)

These narrow the decisions above. They do not change them, and BRT-01 is unchanged.

1. **Tie-break trace representation.** Each comparator trace item is `{key, order, value}` (BRT-01 §6.2 `tieBreakKeys`), with `value` a canonical decimal. The trace is explanatory provenance, not a new metric.
   - Head-to-head points are policy-derived values, not sporting Marks. They are **never** encoded as a `Mark`, and no platform metric id is reserved for them.
   - The points item uses the trace key `outcomePoints`. Its meaning is positional: it is the first item iff the policy's `primary` is `HEAD_TO_HEAD_WINNER`.
   - Classification entries carry no `primaryMark`.
2. **Declared points (§3).** A policy may declare points for a subset of outcomes. Every outcome the engine actually encounters must have declared points; otherwise the derivation blocks with `POLICY_UNSUPPORTED`. No default points exist.
3. **MAX / MIN (§2).** They select the numerically largest / smallest value by exact decimal comparison. The key's declared order then decides which aggregated value ranks better. For example, the best heat time under `LOWER_IS_BETTER` is `MIN`.
4. **Missing values (§4).** Participants are the entries of the admitted inputs, and every contest a participant appears in must supply a value for every key. So "SUM over zero inputs" cannot arise in `classification-engine/1`, and a missing value always blocks with `COMPARATOR_INPUT_MISSING`, whatever the aggregation.
5. **No re-scaling.** All values of one key must share one precision, admissible for the DV value type, and the DV unit. Otherwise the derivation blocks (`METRIC_PRECISION_MISMATCH`, `METRIC_UNIT_MISMATCH`). This is why SUM needs no rounding rule.
