# BRT-08 — AchievementRules

| Field | Value |
|---|---|
| ADR | [0038](../adr/ADR-0038-declarative-achievement-rules-bound-without-retroactivity.md) |
| Code | `packages/achievements/src/rule.ts` (model, validation, floors, reference rules), `packages/schemas/src/achievements.ts` (`br:achievement-rule@1`), `packages/persistence/src/achievement-rule-store.ts`, `db/migrations/0016_achievement_rules.sql` |

## 1. Model

```
AchievementRule         { id, code (^[a-z0-9][a-z0-9-]{1,63}$), name, achievementType, createdBy, recordedAt }     class A
AchievementRuleVersion  { id, ruleId, version, spec, specSchema, specHash, targetEngine, achievementType,
                          disciplineVersionId, recordedAt }                                                           class A, immutable
Lifecycle               DRAFT (no row) → PUBLISHED (once, re-validated) → RETIRED                                    class A facts (BR111)
RuleBinding             { ruleId, ruleVersionId, disciplineVersionId, competitionId?, eventId?, effectiveFrom ≥ recordedAt, seq }  class A
```

`specHash = H("achievement-rule", br:achievement-rule@1, JCS(spec))`. The same semantics with reordered members hash identically (vector `rule/reference-title-reordered`).

## 2. The spec is data

```json
{
  "targetEngine": "achievement-engine/1",
  "achievementType": "TITLE",
  "displayName": "Event Champion",
  "disciplineVersionId": "<exact DisciplineVersion>",
  "holder": "ENTRY_PARTICIPANT",
  "requirements": { "minimumVerificationLevel": "V2", "minimumResultStatus": "FINAL" },
  "criterion": { "kind": "CLASSIFICATION_POSITION", "resultScope": "EVENT_CLASSIFICATION", "rank": { "min": 1, "max": 1 } }
}
```

Threshold (sport-neutral; the constant is data, not code): `criterion: { kind: PERFORMANCE_THRESHOLD, resultScope: CONTEST, metric: { key: "score", markMetricId: "score" }, operator: "GTE", threshold: "300" }`.

Personal best: `criterion: { kind: PERSONAL_BEST, resultScope: CONTEST, metric: { key: "elapsedTimeMs", markMetricId: "running.elapsed_time_ms" }, firstEligibleEstablishesBest: true }`.

## 2a. Recognition-scoped names (AC-4, BRT-08R, BRT-08R-F)

A TITLE / PLACEMENT may declare the structural `criterion.recognitionClaim: {level, region?}`:

- `level` ∈ {REGIONAL, NATIONAL, CONTINENTAL, WORLD};
- `region` is a set of ISO 3166 codes: WORLD has none, NATIONAL exactly one country, REGIONAL exactly one region or subdivision, CONTINENTAL an explicit country set.

Example: `{level: "NATIONAL", region: ["CR"]}`.

The rule then:

- requires `minimumVerificationLevel ≥ V3` (BRT-01 §8.2);
- may use level words in its label up to the claim (regional ≤ national ≤ continental ≤ world). "National Champion" needs a NATIONAL (or higher) claim, and every other standing word stays forbidden;
- issues only when the engine gate `GOVERNING_RECOGNITION` passes. The claim, plus the event's sport and discipline, must be **contained** (BRT-03 `scopeContains`) in the pinned governing `recognitionScope`, which is the immutable, hash-verified anchor fact named by the pinned run trace (ADR-0041). Blockers:
  - `GOVERNING_RECOGNITION_UNAVAILABLE`;
  - `RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM`;
  - `GOVERNING_RECOGNITION_SCOPE_UNKNOWN` (fail closed);
  - `RECOGNITION_{LEVEL,SPORT,DISCIPLINE,REGION}_NOT_COVERED`;
  - `RECOGNITION_BELOW_CLAIMED_SCOPE`.

  For example, a NATIONAL(PE) authority never backs NATIONAL(CR), and a padel-only authority never backs a tennis title.

A platform-anchored (V2) event can therefore never produce "National Champion" or "World Champion", whatever a label says.

## 3. Bounded vocabulary

| Kind | Types | Params | Holder | Result scopes |
|---|---|---|---|---|
| CLASSIFICATION_COMPLETION | EVENT_COMPLETED | — | ENTRY_PARTICIPANT | EVENT_CLASSIFICATION |
| CONTEST_OUTCOME | CONTEST_WON | `outcomes ⊆ {WIN, WALKOVER_WIN}` | ENTRY_PARTICIPANT | CONTEST |
| CLASSIFICATION_POSITION | PLACEMENT (rank range ≤ 64), TITLE (rank exactly 1) | `rank {min,max}` | ENTRY_PARTICIPANT | ROUND/EVENT/COMPETITION_CLASSIFICATION (title: EVENT/COMPETITION) |
| PERFORMANCE_THRESHOLD | PERFORMANCE_THRESHOLD | `metric`, `operator ∈ {GTE,GT,LTE,LT,EQ}`, `threshold` (canonical decimal) | PERFORMER | CONTEST |
| PERSONAL_BEST | PERSONAL_BEST | `metric`, `firstEligibleEstablishesBest` | PERFORMER (ATHLETE only) | CONTEST |

The spec has no expression language, JavaScript, SQL, `eval`, plugin or boolean tree.

## 4. Validation (before a version row exists, and again at publication)

Rejected:

- **Structure:** unknown members, nulls, floats, duplicate set items, non-canonical decimals, oversize (> 8 KiB canonical), unknown types / kinds / levels (e.g. `RECORD_SET`, `WORLD_RECORD`, `V9`, `JAVASCRIPT`), unsupported engine.
- **Type shape:** type ↔ kind ↔ holder ↔ scope mismatches, parameters a kind does not take, missing parameters, impossible or negative ranks, a title not at rank 1.
- **Floors:** `BELOW_PLATFORM_FLOOR`, e.g. a V1 title or an OFFICIAL title.
- **Labels:** display names claiming recognition (`DISPLAY_NAME_CLAIMS_RECOGNITION`: national, world, official, record, federation…, AC-4).
- **Against the exact DisciplineVersion:** it must exist and be PUBLISHED. Also rejected: unknown metric (`METRIC_UNKNOWN`), a threshold of the wrong value type (`THRESHOLD_TYPE_MISMATCH`), an operator that contradicts the comparator order (`OPERATOR_CONTRADICTS_COMPARATOR`), and a PB metric with no comparator order (`PB_METRIC_ORDER_UNDEFINED`).

The API returns fixed issue codes and sanitized pointers, never echoed values.

**Duplicate JSON keys:** request bodies are parsed by the HTTP layer, where JavaScript keeps the last duplicate. The rule spec is then canonicalized under a closed schema, so a duplicate key can only replace a value with another *valid* value, and the resulting spec is exactly what is hashed, stored and shown. Strict duplicate-key rejection (`parseStrictJson`) remains available to text-based callers.

## 5. Platform floors (BRT-01 §7) — raise, never lower

| Type | Min status | Min level | Hold blocks |
|---|---|---|---|
| EVENT_COMPLETED | OFFICIAL | V1 | yes |
| CONTEST_WON / PLACEMENT / TITLE | FINAL | V2 | yes |
| PERFORMANCE_THRESHOLD | FINAL | V2 | yes |
| PERSONAL_BEST | OFFICIAL | V2 | yes |

Status and level are separate dimensions: V2 ≠ OFFICIAL and V3 ≠ FINAL. The engine applies the stricter of rule and floor again as defence in depth. Titles named after a sanctioning body (V3) are refused by the label rule, because no sanctioning facts exist.

## 6. Binding, applicability and history

- A binding names a PUBLISHED version of the rule, for **its exact DisciplineVersion**. It may narrow to a Competition or an Event of that DisciplineVersion (BR112 / BR114), never broaden.
- Bindings are never backdated: a CHECK plus the store enforce `effective_from ≥ recorded_at`, strictly increasing per (rule, scope), under an advisory lock (BR113).
- **Applicability:** for a ResultVersion, per rule, the most specific binding scope with a binding **in force at the version's submission** (`effective_from ≤ submittedAt` and `recorded_at ≤ submittedAt`). Its version must still be PUBLISHED, i.e. not RETIRED. There is no fallback and no retroactive derivation.
- Publishing rule v2 never rewrites v1 Achievements, which pin their version. New derivations use the version bound at the result's submission.

## 7. Operator isolation

Rule mutation runs only on the dedicated login `br_achievement_operator_app`, which can SET only `br_achievement_rules` (`BR_ACHIEVEMENT_OPERATOR_DATABASE_URL`). There is no fallback to `br_api`, which cannot SET that role.

- Without the login: INTERNAL rule routes answer `503 INTERNAL_CAPABILITY_UNAVAILABLE` (audited), while public reads and canonical derivation keep working.
- Non-operators get 403 (audited `achievement.rule-*-denied`).
- `br_achievement_rules` can create, publish, retire and bind, and can read exact DisciplineVersions and competition / event identities. It cannot derive, read results or verification, or write Achievements.

## 8. Fictional development reference rules (`pnpm db:seed:achievements`)

`br-dev-event-title`, `br-dev-match-winner`, `br-dev-two-sets` (threshold on `setsWon`), `br-dev-5k-personal-best`. Each sits exactly at the BRT-01 floor. They are fictional development rules, not universal standards.
