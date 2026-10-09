# BRT-09 — RecordCategories

ADR: [0043](../adr/ADR-0043-record-category-versions-define-immutable-record-universes.md). Code: `packages/records/src/category.ts`, `packages/schemas/src/records.ts` (`br:record-category-version@1`, `br:record-category-universe@1`), `packages/persistence/src/record-category-store.ts`, `db/migrations/0019_record_categories.sql`.

## 1. Model

```
RecordCategory          { id, code, name, scopeType, createdBy, recordedAt }                         class A
RecordCategoryVersion   { id, categoryId, version, spec, specHash, universeHash, targetEngine,
                          scopeType, disciplineVersionId, metricKey, markMetricId, effectiveFrom }     class A, immutable
Lifecycle               DRAFT (no row) → PUBLISHED (once; effectiveFrom ≥ publication) → RETIRED   class A facts
```

No bindings exist: a PUBLISHED version applies to performances of its exact DisciplineVersion + metric whose sporting time is ≥ its effectiveFrom; the highest-numbered PUBLISHED version in force at the sporting time is used.

## 2. Spec (data, closed vocabulary)

```json
{
  "targetEngine": "record-engine/1",
  "displayName": "La Negrita tournament record",
  "scope": { "scopeType": "COMPETITION", "competitionIds": ["…2025", "…2026"] },
  "universe": { "disciplineVersionId": "…", "metric": { "key": "seriesPins", "markMetricId": "bowling.series.pins" },
                "resultScope": "CONTEST", "holderType": "ATHLETE" },
  "tiePolicy": "SHARED",
  "population": { "handicapMode": "SCRATCH" },
  "conditions": [ { "aspect": "EQUIPMENT", "requirement": "COMPLIANT" } ],
  "requirements": { "minimumVerificationLevel": "V3", "minimumResultStatus": "FINAL" },
  "recognition": { "level": "PLATFORM", "sport": ["bowling"] },
  "effectiveFrom": "2026-10-01T00:00:00.000Z"
}
```

Scope refs per type: COMPETITION `competitionIds`, VENUE `venueOrganizationId`, LEAGUE `leagueOrganizationId`, NATIONAL `region` (one ISO country), CONTINENTAL `region` (≥ 2 countries), PLATFORM / WORLD none. `platformReview` (PLATFORM only), `canonicalKeeper {principalId, registryRef}` (never PLATFORM).

## 3. Validation (before any row exists; again at publication)

Rejected: unknown members / scripts / SQL / caller booleans (`BRJ_*`), `PERSONAL_RECORDS_ARE_PERSONAL_BEST`, `BELOW_PLATFORM_FLOOR`, `PLATFORM_REVIEW_ONLY_FOR_PLATFORM_SCOPE`, `PLATFORM_REVIEW_CANNOT_UNDERCUT_RAISED_FLOOR`, scope-ref errors, `NATIONAL_SCOPE_NEEDS_ONE_COUNTRY`, `RECOGNITION_LEVEL_MUST_MATCH_SCOPE`, `RECOGNITION_REGION_MUST_MATCH_SCOPE`, `PLATFORM_SCOPE_RECOGNITION_ONLY`, `PLATFORM_CANNOT_BE_CANONICAL_KEEPER`, `DISPLAY_NAME_CLAIMS_RECOGNITION`, `PLATFORM_NAME_CANNOT_CLAIM_RECORD`, `METRIC_UNKNOWN`, `METRIC_NOT_COMPARABLE` (comparator must be HIGHER/LOWER_IS_BETTER), `RECOGNITION_SPORT_MUST_BE_DISCIPLINE_SPORT`, `HOLDER_TYPE_NOT_IN_DISCIPLINE`, `UNIVERSE_CHANGE_REQUIRES_NEW_CATEGORY`, `COMPETITION_SERIES_CANNOT_SHRINK`, `BACKDATING_REJECTED`.

## 4. Naming (BRT-01 §9.3)

`recordLabel(scope, displayName, region, status)`: NATIONAL / CONTINENTAL / WORLD get "National record (CR) — …" only when RATIFIED / CANONICAL / former; pending → "… (pending ratification — not a record)"; rescinded → "… (rescinded — not a record)"; PLATFORM → "Bragging Rights platform best — …"; other scopes → their universe name.

## 5. Operator isolation

`br_record_operator_app` → `br_record_rules`: INSERT only on the three category tables (+ outbox / idempotency / audit, and the category card projection of the category it changed). It can never write a mark, a status, a supersession or a ratification. Without `BR_RECORD_OPERATOR_DATABASE_URL`, INTERNAL routes return 503; public reads and evaluation keep working; there is no fallback to `br_api`.
