# ADR-0038 — AchievementRules are immutable, declarative derivation policy; bindings never apply retroactively

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-08 (ADR-0001; BRT-01 §7–8; mirrors ADR-0032)

## Context

ADR-0001 requires Achievements to come from a versioned AchievementRule. A rule must never be code. It must never lower the BRT-01 permission matrix, and it must not reinterpret history when it changes. BRT-05 catalog metric keys (`setsWon`) and BRT-01 Result `Mark.metricId` (`padel.match.sets`) are separate vocabularies, and no accepted mapping exists between them.

## Decision

1. `br:achievement-rule@1` is data: one criterion from a closed vocabulary (`CLASSIFICATION_POSITION`, `CLASSIFICATION_COMPLETION`, `CONTEST_OUTCOME`, `PERFORMANCE_THRESHOLD`, `PERSONAL_BEST`) with bounded parameters, a fixed type ↔ criterion ↔ holder-strategy ↔ result-scope table, and an exact `disciplineVersionId`. It contains no expressions, scripts, SQL or plugins.
2. **Platform floors** (BRT-01 §7) are enforced at version creation and again at publication:
   - completion: OFFICIAL · V1;
   - contest win, placement, title and threshold: FINAL · V2;
   - personal best: OFFICIAL · V2.

   A rule may raise these floors, never lower them. The engine also applies the stricter of rule and floor.
3. **Metric binding** is explicit in the rule: `metric: { key, markMetricId }`. `key` must be a metric of the exact PUBLISHED DisciplineVersion, which supplies the value type, unit and comparator order. `markMetricId` names the Result Mark it applies to. The engine requires unit and precision compatibility, never converts units, and compares decimals exactly.
4. The lifecycle is `AchievementRule` → immutable `AchievementRuleVersion` → DRAFT → PUBLISHED (once, re-validated) → RETIRED, all append-only. Retirement stops new use and never touches issued Achievements, which pin their version.
5. A **binding** attaches a PUBLISHED version to its exact DisciplineVersion, optionally narrowed to a Competition or Event (narrowing only). It is append-only, never backdated, and strictly increasing per (rule, scope). The binding that applies to a ResultVersion is the one in force **at that version's submission**, with the most specific scope winning. A rule published today therefore never manufactures an Achievement for a result submitted before it. Retrospective derivation is not supported.
6. Title labels may not claim recognition that no authority grants (AC-4). The words national / world / official / record / federation and similar are refused.

## Consequences

Rules are auditable and reproducible, and history is never reinterpreted. The costs: a new criterion kind requires a new engine version; seeded results that predate a rule never gain it.
