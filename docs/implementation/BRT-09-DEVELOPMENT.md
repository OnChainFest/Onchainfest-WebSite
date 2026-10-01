# BRT-09 — Development

## Commands

```
pnpm db:up            # or: docker.exe compose up -d --wait postgres (WSL without Docker integration)
pnpm db:bootstrap     # roles incl. br_records, br_record_rules, br_record_operator_app, br_record_worker_app
pnpm db:migrate       # 0019–0022
export BR_VAULT_DEV_KEY=$(openssl rand -hex 32) BR_EVIDENCE_DEV_KEY=$(openssl rand -hex 32) BR_EVIDENCE_DEV_DIR=/abs/path
pnpm db:seed:identity && pnpm db:seed:competition && pnpm db:seed:evidence && pnpm db:seed:verification \
  && pnpm db:seed:achievements && pnpm db:seed:records     # idempotent; records: 0 marks (honest ceiling)
pnpm demo:records     # Part A canonical, Part B engine fixtures, Part C throwaway persistence fixture
pnpm vectors:generate:brt09 / pnpm vectors:check
```

## Logins / env

| Login | Module roles | Env |
|---|---|---|
| br_api | … + br_records (never br_record_rules) | BR_API_DATABASE_URL |
| br_record_operator_app | br_record_rules only | BR_RECORD_OPERATOR_DATABASE_URL (optional; 503 without) |
| br_record_worker_app | br_records, br_verification_reader | BR_RECORD_WORKER_DATABASE_URL (optional; worker skips records.evaluate) |
| br_achievement_worker_app | unchanged (br_achievements + reader; derives RECORD_SET on RecordMarkRatified) | |

## Migrations

| File | Tables (class) |
|---|---|
| 0019_record_categories | `record.category` (A), `category_version` (A), `category_version_status_change` (A), view `v_category_version_current` |
| 0020_record_marks | `record.record_mark` (A), `mark_member_credit` (A), `mark_supersession` (A), `mark_status_entry` (A), `mark_dependency` (A), `evaluation` (A), view `v_mark_status` |
| 0021_record_set_achievements | ALTER BRT-08 CHECKs (+RECORD_SET, +RECORD_CATEGORY scope), `achievement.record_basis` (A) |
| 0022_record_read_models | `record_read.category_card`, `mark_card`, `hall_of_fame_entry`, `athlete_record` (B), view `v_record_set_link` |

0001–0018 are unchanged (checksums enforced by the runner). No SECURITY DEFINER function was added (tested).

## Ledger / events

Record facts append to the existing `RECORD_CATEGORY` stream type (one stream per category). Events: RecordCategoryCreated, RecordCategoryVersionCreated / Published / Retired, RecordCandidateEvaluated, RecordMarkPendingRatification, RecordMarkRatified, RecordMarkCanonicalized, RecordMarkSuperseded, RecordMarkRestored, RecordMarkRescinded, CurrentRecordChanged. No ranking / qualification / prize / trophy event.

## Fixture lanes

`@br/records/fixtures` (engine, in memory). `@br/testkit/records` creates `br_recfx_<hex>` databases, applies `packages/testkit/sql/record-fixture-overlay.sql` + the achievement overlay (refuse any other DB name), drops them afterwards. Apps may not import fixture lanes (guard), except the demo CLI.

## Limitations

No canonical producer for FINAL / V3 / V4, holds, population / condition / venue / league / regional-eligibility facts or ratifications ⇒ production has zero marks. LEAGUE has no league entity; VENUE has no canonical venue fact. Historical federation-list import (CANONICAL from imports) is not implemented beyond the keeper semantics.
