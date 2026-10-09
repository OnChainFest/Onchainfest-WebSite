# BRT-08 — Development Guide

Extends [BRT-07-DEVELOPMENT.md](./BRT-07-DEVELOPMENT.md) and, through it, BRT-03–06. All commands run from the repository root.

## 1. What changed for developers

| Area | BRT-08 addition |
|---|---|
| Packages | `@br/achievements` (pure): rule model, validation and floors; snapshot and hashing; the engine; exact metric arithmetic; current-support assessment; public wording. `@br/achievements/fixtures`: REFERENCE ENGINE FIXTURES (tests, vectors and demo only; never persisted) |
| Domain | `AchievementType`, `HolderType`, `MemberCreditRole`, `AchievementStatus`, `DerivationProvenance`, `DerivationFactKind`, `ACHIEVEMENT_PLATFORM_FLOOR`, error `ACHIEVEMENT_INTEGRITY_FAILURE`, events |
| Schemas | `br:achievement-rule@1`, `-derivation-snapshot@1`, `-derivation-outcome@1`, `-candidate@1`, `-identity@1`, `-support-facts@1`, `-credited-lineup@1`, `-comparison-set@1`, `-fact@1`, `-status-fact@1` |
| Persistence | `AchievementRuleStore` (operator), `AchievementService` (canonical lane), `AchievementPublicReader`, `dependencyIndex`, `rebuildAchievementReadModels`. `@br/persistence/achievement-lanes` (test harness only): `persistDerivation`, `recordSupportAssessment` |
| Migrations | `0016_achievement_rules.sql`, `0017_achievements.sql`, `0018_achievement_read_models.sql`. 0001–0015 are untouched |
| DB roles | `br_achievements` (via `br_api` and the new login `br_achievement_worker_app`), `br_achievement_rules` (only via the new login `br_achievement_operator_app`), `br_verification_reader` (SELECT-only Verification interface; via `br_api` and the achievement worker login — **never** `br_verification`) |
| API | `/v1/achievements/:id`, `/v1/athletes/:slug/achievements`, `/v1/achievement-rules/:code`, `/v1/result-versions/:id/achievement-derivations`, `…/achievement-dependents`, `/v1/achievements/:id/support-assessments`, INTERNAL rule routes; `/health` reports `phase: BRT-08` |
| Web | `/achievements/[id]`; Athlete Passport "Verified achievements" section |
| Worker | `achievements.derive` consumer (dedicated login; disabled and logged without it) |
| Vectors | `packages/achievements/test-vectors/brt-08.vectors.json` + independent Python checker |
| Guards | `tooling/check-no-manual-achievement.mjs` (in `pnpm lint`) |
| Testkit | `@br/testkit/achievements`: throwaway fixture databases + `packages/testkit/sql/achievement-fixture-overlay.sql` (**test-only, never a migration**) |

## 2. Environment

```bash
# BRT-08: optional AchievementRule operator login (→ br_achievement_rules only). Without it, INTERNAL rule
# mutation answers 503 and everything else keeps working.
export BR_ACHIEVEMENT_OPERATOR_DATABASE_URL=postgres://br_achievement_operator_app:br_achievement_operator_app_dev_only@localhost:55432/bragging_rights
# BRT-08: optional achievement worker login (→ br_achievements, br_verification_reader). Without it the worker skips
# achievement reactions (logged). Development tooling falls back to the local dev login.
export BR_ACHIEVEMENT_WORKER_DATABASE_URL=postgres://br_achievement_worker_app:br_achievement_worker_app_dev_only@localhost:55432/bragging_rights
# (the login can SET br_achievements and the SELECT-only br_verification_reader — never br_verification)
```

No environment variable, header, token claim or API flag enables fixture persistence (ADR-0037).

## 3. Setup and commands

```bash
pnpm db:bootstrap              # creates br_achievements, br_achievement_rules, br_achievement_operator_app, br_achievement_worker_app
pnpm db:migrate                # applies 0016–0018
pnpm db:seed:competition && pnpm db:seed:evidence && pnpm db:seed:verification
pnpm db:seed:achievements      # CANONICAL ONLY: fictional reference rules + one canonical derivation → 0 Achievements (honest)
pnpm demo:achievements         # Part A real flow · Part B in-memory fixtures · Part C throwaway fixture DB (created, then dropped)
pnpm vectors:generate:brt08    # regenerate BRT-08 vectors (review the diff)
pnpm vectors:check             # all vectors + the four independent Python checkers
```

## 4. Deriving by hand

```bash
BR_DEV_AUTH=1 BR_ACHIEVEMENT_OPERATOR_DATABASE_URL=… pnpm dev:api
ORG=$(BR_DEV_AUTH=1 pnpm -s --filter @br/api dev-token seed:comp-organizer)
curl -s -X POST localhost:4000/v1/result-versions/<rvId>/achievement-derivations -H "authorization: Bearer $ORG" -H 'content-type: application/json' -d '{}' | jq .
curl -s localhost:4000/v1/athletes/<slug>/achievements | jq .
pnpm dev:web   # http://localhost:3000/athletes/<slug> · /achievements/<id>
```

## 5. The three lanes in tests

| Suite | Lane | Database |
|---|---|---|
| `packages/achievements/src/*.test.ts` | REFERENCE ENGINE FIXTURE | none (pure) |
| `packages/persistence/src/achievement.int.test.ts`, `apps/api/src/achievements.int.test.ts` | CANONICAL PRODUCTION | the normal integration database (proves 0 Achievements and the DB rejection of fixtures) |
| `packages/persistence/src/achievement-fixture.int.test.ts` | REFERENCE PERSISTENCE FIXTURE | throwaway `br_achfx_<hex>` databases, dropped after the suite |
| `packages/persistence/src/achievement-roles.int.test.ts` | role graph / containment | normal integration database |

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `blockedBy: [RESULT_STATUS_BELOW_REQUIRED, VERIFICATION_LEVEL_BELOW_REQUIRED, HOLD_STATE_UNAVAILABLE]` | Expected today: there is no V2, OFFICIAL/FINAL or hold producer. |
| `noApplicableRule: true` | No PUBLISHED rule was bound to the event's DisciplineVersion **when the result was submitted**. Bindings never apply retroactively. |
| `23514 achievement_canonical_provenance_only` | A REFERENCE_FIXTURE derivation reached a normal database. This is the intended rejection. |
| `500 ACHIEVEMENT_INTEGRITY_FAILURE` + `reason` | A candidate or snapshot contradicts its basis (`CANONICAL_SNAPSHOT_MISMATCH`, `CANDIDATE_HASH_MISMATCH`, `BASIS_MISMATCH`, `MEMBER_CREDITS_MISMATCH`, `QUALIFYING_VALUE_MISMATCH`, `CONTENT_HASH_MISMATCH`, …). Nothing was written. |
| `KEY_NOT_VALID` / `UNKNOWN_PRINCIPAL` right after key or principal creation in tests | The WSL2 clock step documented in BRT-07 §5. Re-run (the test harness retries). |
| Leftover `br_achfx_*` databases after an aborted test run | `dropThrowawayDatabase(name)` from `@br/testkit/achievements` (it refuses any other name). |
