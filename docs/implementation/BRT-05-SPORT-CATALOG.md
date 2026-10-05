# BRT-05 — Sport Catalog

Status: **implemented (foundation)** · Phase: BRT-05 · Builds on: BRT-01 result domain §4 (ontology layer), ADR-0014 (BR-JSON) · Migration: `0007_sports_catalog.sql` · Code: `packages/competition/src/catalog.ts`, `packages/persistence/src/catalog-store.ts`

Sports, disciplines and formats are **data, never columns**. No table has a `padel_sets`, `bowling_pins` or `running_time` column: sport semantics live in versioned specifications.

## 1. Entities

| Entity | Table (class) | Identity / key | Notes |
|---|---|---|---|
| Sport | `sports.sport` (A) | `code` UNIQUE, e.g. `padel` | The code format equals the authority `sport` scope dimension (`^[a-z0-9]+(?:[-_][a-z0-9]+)*$`). |
| Discipline | `sports.discipline` (A) | `code` UNIQUE, dotted and sport-namespaced, e.g. `padel.doubles` | The code format equals the authority `discipline` dimension, so grants such as `padel.*` work. A trigger (`BR005`) enforces that the code starts with `<sport code>.`. |
| DisciplineVersion | `sports.discipline_version` (A) + `discipline_version_status_change` (A) | `(discipline_id, version)` UNIQUE | Holds the full `spec` (jsonb) and its `spec_hash`. |
| FormatTemplate | `sports.format_template` (A) | `code` UNIQUE, e.g. `single-elimination` | Competition *structure*, separate from sporting rules. |
| FormatVersion | `sports.format_version` (A) + `format_version_status_change` (A) | `(template_id, version)` UNIQUE | Pins an exact engine (`engine_id`, `engine_version`) and that engine's BR-JSON `configuration_schema`. |

All tables are append-only: `reject_mutation` and `assert_recorded_at` triggers apply, so even the owner cannot UPDATE, DELETE or TRUNCATE. **Retiring sports or disciplines is not implemented**; only versions carry a lifecycle.

## 2. DisciplineVersion specification

`DisciplineVersionSpec` is a bounded declarative model, not a DSL. It is validated by `validateDisciplineVersionSpec` when a version is created.

| Field | Meaning | Validation |
|---|---|---|
| `resultSchema` | BR-JSON object schema for `ResultEntry.components`: the accepted schema mechanism (closed JSON Schema subset, ADR-0014) | Registered with a throwaway canonicalizer; invalid schemas are refused. |
| `metrics[]` | `{ key, valueType: INTEGER \| DECIMAL \| DURATION_MS, unit }` | Each key must be a `resultSchema` property of the matching type (DECIMAL = string with `x-br-type: decimal`). At most 32; unique. |
| `comparator` | `{ outcomeModel, primary, keys[] }` | See §3. |
| `validation.bounds[]` | `{ metric, min?, max? }` | Decimal strings (no floats); `min ≤ max`; the metric must exist. |
| `allowedContestTypes` | Non-empty subset of `MATCH, HEAT, SERIES, ATTEMPT_SET, ROUTINE, SESSION` | |
| `participation` | `{ participantKinds: INDIVIDUAL/TEAM, lineupSize: {min, max} }` | `1 ≤ min ≤ max ≤ 100`; individual-only disciplines field exactly 1. |
| `evidenceExpectations?` | Evidence-type codes that the verification policy may treat as primary | **Hints only**; BRT-05 verifies nothing. |

Every spec must be **BR-JSON safe**:
- no `null`, floats or unsafe integers;
- no unknown fields;
- nesting depth ≤ 12;
- serialized JCS size ≤ 64 KiB (the database also CHECKs `octet_length`).

## 3. Comparator model (bounded)

| `primary` | Meaning | Constraints |
|---|---|---|
| `HEAD_TO_HEAD_WINNER` | The contest outcome decides. Keys, if any, only break ties in derived tables. | Requires `outcomeModel = WIN_LOSS_DRAW` and contest type `MATCH`. |
| `METRICS` | Ordered keys decide; later keys only break ties (**LEXICOGRAPHIC_TIEBREAK**). | At least one key. |

Keys are `{ metric, order: HIGHER_IS_BETTER | LOWER_IS_BETTER | ORDINAL }`:
- at most 8 keys, with no duplicate metrics;
- `ORDINAL` applies to INTEGER metrics only;
- there is no scripting and no expressions.

Examples, as implemented in the seed and tests:
- **Running 5K:** `METRICS`, `elapsedTimeMs LOWER_IS_BETTER`.
- **Padel/tennis:** `HEAD_TO_HEAD_WINNER`, tie-break `setsWon`, then `gamesWon`, both `HIGHER_IS_BETTER`.

Comparators are stored and hashed. **BRT-05 does not execute them**: there are no standings or rankings.

## 4. Hashing and immutability

- `spec_hash = catalogSpecHash('br:discipline-version-spec' | 'br:format-version-spec', spec)`. This is SHA-256 over a `ledger-fact` preimage of the JCS serialization. Key order is irrelevant; the hash is content-sensitive (unit-tested).
- **Content is immutable from creation.** A "draft that is wrong" is retired and replaced by a new version number; the old number is never reused.
- The version lifecycle is `DRAFT → PUBLISHED → RETIRED` (and `DRAFT → RETIRED`), append-only.
  - **Only PUBLISHED versions can be pinned** by a new Event.
  - Retiring a published version stops *new* pins; events that already pin it are unaffected.
- An Event stores `discipline_version_id` and `format_version_id` (A). Publishing or retiring later versions never changes what a historical event was played under (tested).

## 5. FormatVersion

`createFormatVersion(engineId, engineVersion)` succeeds only if that exact engine version is registered (`packages/competition/src/format/registry.ts`).
- The engine's `configurationSchema` is copied into the version.
- The hashed spec is `{ engineId, engineVersion, configurationSchema, contestType }`.
- Unknown engines or versions (e.g. `stepladder/1`, `single-elimination/2`) are refused.

See [BRT-05-FORMAT-ENGINE.md](./BRT-05-FORMAT-ENGINE.md).

## 6. Who can change the catalog

- Writes go through module role **`br_catalog`** only, and `br_catalog` is reachable **only** from the dedicated login **`br_operator_app`** (BRT-05R). The normal API login `br_api` cannot `SET ROLE br_catalog`, so a compromise of normal API traffic cannot rewrite sport semantics even if application authorization failed.
- **Two layers.** INTERNAL catalog endpoints require the operator flag (application layer) **and** run on the operator connection (database layer). The API enables that connection only when `BR_OPERATOR_DATABASE_URL` is set explicitly. Without it, catalog mutation answers **503 `INTERNAL_CAPABILITY_UNAVAILABLE`** — it never falls back to `br_api`. Production never substitutes a development credential.
- **Reads need no operator credential.** `GET /v1/catalog` runs as `br_public_read`. Creating an event that pins published versions runs as `br_competition`. Both work without the operator connection (tested).
- Organizers (`br_competition`) can **read** the catalog but cannot insert, update or publish anything in `sports.*` (tested in `competition-roles.int.test.ts`). This prevents every organizer from redefining "tennis" or "5K".
- The public read path lists published versions (`GET /v1/catalog`).

## 7. Seeded catalog (fictional development data)

`pnpm db:seed:competition` publishes `padel.doubles@1` (TEAM, lineup 2), `tennis.singles@1` (INDIVIDUAL) and `running.5k@1` (HEAT contests).

BRT-05 has **no heat format engine**, so no running event exists. The 5K discipline is published to show the model's generality, and creating a running event with a MATCH format is refused (`CONTEST_TYPE` mismatch; tested). **Nothing is faked.**
