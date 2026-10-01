# ADR-0043 — RecordCategory versions define immutable record universes

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-09 (BRT-01 verification model §7, §9.1; ADR-0038 pattern)

## Context

BRT-01 §9.1 defines a RecordCategory conceptually (metric, discipline, comparator + tie policy, population, conditions, recognizing authority, minimum verification level, effectiveFrom, naming policy) but does not say how a category evolves. Several of those members can legitimately change over time (naming, a raised floor, a new recognizing authority, a new competition edition). If a category were a single mutable row, a change would silently reinterpret every historical RecordMark. If anything could change, marks of one "category" could stop being comparable.

## Decision

1. **Stable identity + immutable versions.** `record.category` is a stable identity (code, structural scope type). `record.category_version` holds an immutable, declarative `br:record-category-version@1` spec, its spec hash and its **comparison-universe hash** (`br:record-category-universe@1`: scope type and structural scope refs except the competition series, DisciplineVersion, exact metric, holder type, tie policy, population, conditions).
2. **One universe per category.** Every version of a category must have the same universe hash (database trigger BR141; validator `versionContinues`). A COMPETITION series may only grow (a new edition), never drop an edition. A different universe is a different category. Therefore every mark of a category stays comparable, and no version can reinterpret a historical mark.
3. **Lifecycle** DRAFT (no row) → PUBLISHED (once, re-validated) → RETIRED, as append-only facts. Only a PUBLISHED version establishes new records. Retirement prevents new evaluation under that version; it never touches a mark.
4. **No backdating.** `effectiveFrom` must be ≥ the publication instant (BR142; `BACKDATING_REJECTED`). A performance whose sporting time precedes `effectiveFrom` is `INELIGIBLE` (`PERFORMANCE_BEFORE_CATEGORY_EFFECTIVE_FROM`). A category created today never declares a past performance a record; there is no retroactive scan.
5. **Version selection.** A performance is evaluated under the highest-numbered PUBLISHED (never RETIRED) version whose `effectiveFrom` ≤ its sporting time. Every RecordMark pins the exact version id and spec hash.
6. **Declarative only.** The spec is a closed vocabulary: scope refs, metric reference, bounded population dimensions (handicap mode, gender category, age group, weight class, equipment class), bounded conditions (aspect + COMPLIANT / MAXIMUM / MINIMUM + decimal limit). No JavaScript, SQL, eval, JSONPath, plugins or caller-supplied booleans.
7. **Floors are raised, never lowered** (BRT-01 §7): VENUE / COMPETITION / LEAGUE / PLATFORM ≥ V3, NATIONAL / CONTINENTAL / WORLD ≥ V4, all FINAL. The PLATFORM "V2 + platform review" alternative is a PLATFORM-only flag that cannot undercut a raised floor.
8. **Naming is computed by the model** (BRT-01 §9.3): the free-text name may not contain recognition words; "National record (CR)", "World record" … are produced only from the structural scope and a ratified status; PLATFORM is always "Bragging Rights platform best".
9. **PERSONAL scope is not a category in BRT-09 v1.** Personal bests remain the BRT-08 PERSONAL_BEST Achievement (no second PB engine, no invented PERSONAL ratifier).

## Consequences

- Historical marks are never reinterpreted; replay and comparison are always over one universe.
- Category administration runs on its own login (`br_record_operator_app` → `br_record_rules`), which can never write a mark or a status.
- Changing a universe (e.g. adding a SCRATCH restriction) requires a new category, which is explicit and visible.

## Alternatives considered

- **Single mutable category row:** rejected (silent reinterpretation).
- **Versions with arbitrary universe changes plus "lineage" rules:** rejected for v1 (comparability becomes ambiguous; a new category is clearer).
