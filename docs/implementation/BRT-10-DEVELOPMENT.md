# BRT-10 — Development

Status: Steps 1–10 implemented (engine, vectors, persistence foundation, canonical loader / store / writer, staleness / dependency index / `ClassificationStale`, `ranking_read.*` read models, QUALIFIED Achievement, worker reaction `rankings.react`). Commands, worker, API and web sections are filled in as the corresponding steps land.

Numbering note: the table below counts migrations / roles as Step 5, so the writer layer is Step 6 here; the execution checkpoints call the same work "BRT-10 Step 5 (writer)".

## Implementation steps

| Step | Scope |
|---|---|
| 1 | ADRs 0047–0050 + documentation skeleton (this file) |
| 2 | Domain types, schemas (`@2` content, policy, system version, universe), domain tags |
| 3 | Pure engine `@br/rankings` + unit tests |
| 4 | BRT-10 vectors + independent Python checker (delivered with the engine, Step 3) |
| 5 | Migrations 0023–0025 + roles (delivered as the "persistence foundation" step) |
| 6 | Loader, store and validated writers (classification submission check, ranking runs/snapshots) + `0026_ranking_writers` grants — **implemented** |
| 7 | Dependency index, staleness, `ClassificationStale` — **implemented** (no migration, no grant; worker wiring in Step 10) |
| 8 | Read-model projections + rebuild equality — **implemented** (`0028_ranking_read_models`; no CLI, no API, no worker) |
| 9 | QUALIFIED (`achievement-engine/3`) + `0027_qualified_achievements` — **implemented** ([qualification](./BRT-10-QUALIFICATION.md); no worker wiring, no API) |
| 10 | Worker reaction `rankings.react` (emits `ClassificationStale`, evaluates canonical runs) + `0029_ranking_worker_round_read` — **implemented** ([worker](#worker-step-10)) |
| 11 | API routes |
| 12 | Web surfaces |
| 13 | Guards (`check-no-manual-ranking.mjs`; deliberate updates to record/achievement guards and demos) |
| 14 | Seed + demo (`db:seed:rankings`, `demo:rankings`) |
| 15 | Integration tests |
| 16 | Acceptance gates |

## Commands

_Step 14._

## Logins / env

Implemented with the persistence foundation (`db/bootstrap/roles.sql`, `database.sql`, `packages/persistence/src/config.ts`):

| Login | Module roles (`INHERIT FALSE, SET TRUE`) | Env (production) |
|---|---|---|
| `br_ranking_operator_app` | `br_ranking_rules` (RankingSystem / ClassificationPolicy definitions only) | `BR_RANKING_OPERATOR_DATABASE_URL` |
| `br_ranking_worker_app` | `br_rankings`, `br_verification_reader` | `BR_RANKING_WORKER_DATABASE_URL` |

- `br_rankings` writes only `ranking.run`, `run_dependency`, `snapshot` and `snapshot_entry`, plus outbox events and audit rows (0026). Since Step 10 it also computes classification staleness and emits `ClassificationStale` (an outbox row; nothing else) for the worker, which can never become `br_results`. It reads the exact result, verification and definition facts it binds to, and the competition path / participants / contest occurrence / DisciplineVersion a run re-assembly needs (0026, mirroring `br_records`). It has no command-idempotency grant: runs and snapshots are idempotent on their natural keys.
- `br_ranking_rules` writes only the definition tables, plus outbox, command idempotency and audit (0026). It reads catalog facts, the trust-anchor scope, the anchor's validity window and REVOKED facts (an OFFICIAL owner must be currently anchored), and competition ids.
- `br_results` (the ResultLedger) is the only writer of `results.classification_derivation` / `classification_input`. 0026 gives it column-level read access to the contest → round → event → competition ids and the DisciplineVersion (id, spec, spec hash), so it can re-derive a classification inside T2.
- `br_api` reaches neither ranking role yet (API: a later step).
- Development passwords: `BR_RANKING_OPERATOR_PASSWORD` / `BR_RANKING_WORKER_PASSWORD`; dev-only defaults otherwise.

## Migrations

Implemented (persistence foundation):

- `0023_classification_derivation`: schema `ranking`; ClassificationPolicy identity / versions / lifecycle; `results.classification_derivation` + `results.classification_input` (the derivedFrom index, written only by the ledger role). `@2` content is admitted only on classification Results and only with its provenance (BR160–BR168).
- `0024_ranking_systems`: `ranking.system` / `system_version` / `system_version_status_change`. One universe and owner per system, raise-only floors per kind, no backdating (BR170–BR174).
- `0025_ranking_runs_snapshots`: `ranking.run` (UNIQUE system version + inputs digest), `run_dependency`, `snapshot` (INITIAL / FOLLOWS `previous_snapshot_id` / CORRECTS `corrects_snapshot_id`, at least one entry, published only from a PUBLISHABLE run of a PUBLISHED version) and `snapshot_entry` (canonical FINAL basis binding) (BR175–BR182).

- `0026_ranking_writers` (Step 6): **grants only** — no table, constraint, trigger, function or view. Writer plumbing for `br_ranking_rules` / `br_rankings` (outbox, audit, and idempotency for the operator) and the read-only structural facts `br_results` and `br_rankings` need for re-derivation. No ledger stream is added: rankings are class-A, hash-pinned tables (the 0001 `stream_type` vocabulary is unchanged). No PUBLIC grant, no SECURITY DEFINER, no UPDATE / DELETE / TRUNCATE.

- `0028_ranking_read_models` (Step 8): schema `ranking_read`, **class B** projections only (see [Read models](#read-models-step-8)). No function, trigger or SECURITY DEFINER; no PUBLIC grant.

Every table of 0023–0025 is class A (append-only); provenance is `CANONICAL_ASSEMBLY` only. 0023–0025 are applied (checksum-locked) and never edited. The gap is deliberate (by decision): fresh databases apply 0027 before 0028, while an existing database applies it after, so **0027 references no `ranking_read` object** (an integration test migrates a fresh database through 0027 without 0028, then applies 0028; the achievement guard scans 0027). The runner applies files in order and tolerates the gap.

- `0029_ranking_worker_round_read` (Step 10): **grants only** — `SELECT (id, event_id) ON competition.round TO br_rankings`, the exact column grant `br_results` holds (0026), so the worker login can re-assemble a ROUND_CLASSIFICATION scope when computing its staleness. No table, function, trigger, SECURITY DEFINER, PUBLIC or write grant; independent of 0027 / 0028. 0001–0028 are untouched (the Step 9 migration-boundary test now bounds its 0027 ↔ 0028 check below 0029).

- `0027_qualified_achievements` (Step 9): ALTER of the BRT-08 type CHECKs (`QUALIFIED`) + `achievement_qualified_shape`; the append-only link `achievement.qualification_basis` (rank ≤ N CHECK, kind coherence, BR183 binding to the candidate pin and to the stored snapshot entry, BR184 refusal of every canonical QUALIFIED — no target-authority producer —, BR185 completeness and one non-terminal QUALIFIED per rule / holder / target); SELECT-only qualification inputs for `br_achievements` and reference reads for `br_achievement_rules`. 0016–0026 untouched. See [qualification §7](./BRT-10-QUALIFICATION.md#7-persistence-migration-0027).

Because the normal schema has no FINAL producer, it can hold zero ranking snapshots today (the honest ceiling). The throwaway `br_rkfx_<12hex>` overlay (`packages/testkit/sql/ranking-fixture-overlay.sql`) relaxes only the run / snapshot provenance CHECKs, so that tests can exercise snapshot persistence mechanics.

## Canonical writer path (Step 6)

Every BRT-10 write follows **DERIVE → LOAD CANONICAL FACTS → RE-DERIVE → COMPARE → PERSIST**. No API, worker, web surface or seed has another write path.

| Writer | Login → role | Module | Re-derive and compare |
|---|---|---|---|
| Classification (`@2` ResultVersion) | `br_api` → `br_results` | `ResultLedger.submitDraft` (T2) + `classification-loader.ts` | The ledger re-assembles the canonical derivation input in the submitting transaction, re-runs `deriveClassification` and refuses any difference (`CLASSIFICATION_DERIVATION_MISMATCH`). `proposeClassification` is the read-only draft helper. |
| Definitions | `br_ranking_operator_app` → `br_ranking_rules` | `RankingDefinitionStore` | Specs are validated against the exact PUBLISHED DisciplineVersion and, for OFFICIAL systems, the owner's currently valid trust anchor, before any row exists; publication re-validates against the stored hash. |
| Ranking runs | `br_ranking_worker_app` → `br_rankings` (+ `br_verification_reader`) | `RankingService.evaluate` / lane `persistRankingRun` + `ranking-loader.ts` | A CANONICAL_ASSEMBLY input must equal the canonical re-assembly of its (system version, asOf); the outcome is always re-evaluated, and a claimed outcome / hash is only compared. |
| Snapshots | `br_ranking_worker_app` → `br_rankings` | `RankingService.publish` / lane `publishRankingSnapshot` | Content is built from the run (claimed content / hash only compared); the stored outcome must re-hash; a canonical run must still equal the canonical assembly of its cutoff. |

Idempotency: classification submissions reuse the ledger's command idempotency (same draft + key ⇒ replay) and its content dedupe on the Result stream (identical content ⇒ the existing version). Runs are unique on (system version, input hash) and snapshots on run id and snapshot hash; identical concurrent writes collapse via a writer-local retry on those natural-key races (`ranking_run_identity_key`, `snapshot_run_key`, `snapshot_hash_key`; the global `tx.ts` retry list is unchanged, so raw inserts still see the plain unique violation). Snapshot lineage is serialized by the per-system advisory lock in a READ COMMITTED transaction. Definition commands use the platform command idempotency.

## Ledger / events

Implemented (Step 6), all through the transactional outbox (`emitEvent`):

- classifications: the normal `ResultSubmitted` / `ResultProvisional` events; `ResultSubmitted` of a `@2` version adds `contentSchema` and `classification: {policyVersionId, inputsDigest, inputCount}`;
- `ClassificationPolicyCreated`, `ClassificationPolicyVersionCreated` / `Published` / `Retired`;
- `RankingSystemCreated`, `RankingSystemVersionCreated` / `Published` / `Retired`;
- `RankingRunEvaluated` (blocked runs too), `RankingSnapshotPublished`.

Audit rows (`platform.audit_event`) are written for every definition mutation (`ranking.*-created`, `*-published`, `*-retired`) and for every snapshot publication (`ranking.snapshot-published`). Run evaluations are not audited (they mutate no definition and publish nothing). There is no ledger stream for rankings.

- `ClassificationStale` (Step 7): aggregate `RESULT_VERSION`, emitted by `ClassificationStalenessService.emitStale`, at most once per (classification version, staleDigest). Called automatically by the Step 10 worker under `br_rankings` (the service still defaults to `br_results` for the API login).

QUALIFIED reuses BRT-08 achievement events (`AchievementDerived`, `AchievementCurrentStateChanged`, the ACHIEVEMENT ledger stream) and audits `achievement.qualification-requested`. There are no prize, trophy, payout, entry or registration events.

## Read models (Step 8)

`ranking_read.*` (migration 0028; ADR-0048 §9, ADR-0046 pattern) are projections, **never a source of truth**. Every row derives from the immutable class-A facts (0023–0025) and the ResultLedger's append-only status transitions. Hashes are copied, never recomputed. Nothing in a projection is read back by any writer.

| Projection | Key | Source | Refreshed by (same transaction) | Readable by |
|---|---|---|---|---|
| `system_card` | system | `ranking.system`, latest `system_version`, lifecycle view | `br_ranking_rules`: version create, status change | `br_public_read` |
| `run_card` | run | `ranking.run` (+ version number) | `br_rankings`: run persistence | staff only (`br_rankings`) |
| `run_candidate` | run, version, participant, ordinal | `ranking.run.outcome.candidates` (state + sorted blockers) | `br_rankings`: run persistence | staff only |
| `snapshot_card` | snapshot | `ranking.snapshot` + lineage (`chain_position` = ancestors + 1; `corrected_by_snapshot_id`) | `br_rankings`: publication (the new card and its prior's) | `br_public_read` |
| `leaderboard_entry` | snapshot, holder | `ranking.snapshot_entry` (rank, tied, value, trace, basis count) — no basis topology | `br_rankings`: publication | `br_public_read` |
| `classification_card` | `@2` classification version | `classification_derivation` + `classification_input` + version + latest transition | `br_results`: T2 (`@2` submission) and every transition | `br_public_read` |
| `classification_entry` | version, participant | the immutable `@2` content (rank, tied, tieBreakKeys copied) | `br_results`: with the card | `br_public_read` |

- **History** is a query on the projection (`RankingReadModelReader.snapshots`, pure `snapshotHistory`):
  - as-published is `ORDER BY chain_position`, with every snapshot kept;
  - as-corrected replaces each corrected snapshot by its final correction, which lists what it `corrects`;
  - a correction keeps its own publication time and position, so it never appears to have always existed;
  - tests prove both views equal the Step 7 canonical queries.
- **Not stored:** staleness, any `is_current` / "current ranking" flag, basis topology (result / verification-run ids, evidence commitments, hold), owner principal / anchor ids, `requested_by` account ids. Staleness is composed at read time from the Step 7 readers (the API, Step 11). OFFICIAL systems carry `label = NULL`: recognition wording needs a published snapshot, which has no producer (ADR-0048 §7). `@1` classifications get no card (provenance unavailable).
- **Rebuild:** `rebuildRankingReadModels(maintenanceDb)` (login `br_maintenance` → `br_rebuild`) truncates only `ranking_read.*` and re-runs the same refresh functions in canonical order. It writes no canonical row, event, audit row, classification, run, snapshot or index. `snapshotRankingReadModels` gives the deterministic comparison. Tests prove incremental == full rebuild == second rebuild, in both lanes. Concurrent rebuilds serialize on the TRUNCATE lock and converge. A hand-edited projection row is reverted by the next rebuild, and the canonical fact never changes.
- **No CLI** (none is required by the step). **No public DTO schema and no vectors:** projection rows are not hashed documents, and integrity is proven by rebuild equality and by comparison with the canonical rows. Public DTOs, their schema tags and their vectors come with the API (Step 11).

## Worker (Step 10)

Consumer `rankings.react` in `apps/worker` → `RankingWorkerService` (`packages/persistence/src/ranking-worker.ts`), on the dedicated login `br_ranking_worker_app` (`br_rankings` + SELECT-only `br_verification_reader`). Without that login the consumer is skipped and logged, like `records.evaluate`. It orchestrates only: every decision stays in the pure engines and the existing validated services.

| Input event | Identity (validated) | Effect |
|---|---|---|
| `ResultProvisional`, `ResultRejected` | aggregate `RESULT_VERSION` | `ClassificationStalenessService.affectedBy(rv)`: for a CONTEST version, every `@2` classification of its round / event / competition plus the derivedFrom dependents; for a classification version, itself. Only versions that are not superseded and whose latest status is SUBMITTED or live. Then `emitStale` on each. |
| `ResultSubmitted`, `ResultProvisional`, `ResultRejected`, `CurrentVerificationChanged` | aggregate `RESULT_VERSION` (a `payload.resultVersionId`, if present, must equal it) | `RankingService.evaluate` (trigger `UPSTREAM_FACT_CHANGED`, cutoff `asOf` = the event's `occurredAt`) for each PUBLISHED system version whose universe can contain the version: CONTEST scope, same DisciplineVersion, a Performance with the universe Mark metric, `effective_from ≤ asOf`. |
| `VerificationEvaluated` | aggregate `VERIFICATION_RUN`, `payload.resultVersionId` | same as above |

- **Output:** only `ClassificationStale` outbox events, and canonical runs with their dependency rows, `run_card` / `run_candidate` refresh and `RankingRunEvaluated`, all written by the existing writers. Under the pinned policy, staleness is computed and never stored.
- **Not consumed:** `ClassificationStale`, `Ranking*`, `ClassificationPolicy*`, `Achievement*`, `Record*` and every other event. A ranking handler never reacts to ranking events, so no loop exists.
- **Deliberately not done:**
  - no classification re-derivation, submission or replacement (ADR-0047 §3, §6);
  - no snapshot publication;
  - no QUALIFIED derivation or revocation (event-driven qualification stays unwired);
  - no record, prize, trophy, entry, seeding or advancement write;
  - no verification, hold, eligibility or authority fact.
- **Idempotency:** delivery is at least once (`consumeOutbox`: the receipt and the handler's own transaction commit separately). Logical effects are exactly once through natural keys:
  - one `ClassificationStale` per (version, staleDigest), under a per-version advisory lock;
  - one run per (system version, input hash). The cutoff is the event's own `occurredAt` and is part of the hashed input, so a redelivered event reproduces the same input while the facts are unchanged.
  - A later fact change is a new event and a new cutoff, and so produces a new honest run.
- **Retry and failure:**
  - A consumed event type with an invalid identity (wrong aggregate type, non-UUID, mismatched payload, invalid time) is acknowledged as `INVALID_EVENT_IDENTITY` and has no effect: retrying cannot fix it.
  - Any other error propagates. The round rolls back its receipts, and the event is redelivered on the next polling round (every 1 s), exactly like the BRT-08 / BRT-09 consumers.
  - A partial attempt is safe to repeat, because every effect is idempotent.
- **Fail closed:** unknown ids resolve to nothing. An unknown admissible set reads STALE (`ADMISSIBLE_INPUT_SET_UNKNOWN`). In production every run is BLOCKED (no FINAL, V2+ or hold producer), and nothing becomes publishable.

Run locally (after `pnpm db:up && pnpm db:bootstrap && pnpm db:migrate`):

```sh
pnpm dev:worker                              # polls every second; logs "[rankings.react] …" per reaction
pnpm --filter @br/worker start -- --once     # one polling round, then exit
```

Production requires `BR_RANKING_WORKER_DATABASE_URL`; development falls back to the local `br_ranking_worker_app` login.

Test: `pnpm vitest run --project integration packages/persistence/src/rankings-worker.int.test.ts`. It covers:

- scope resolution, pinned-policy staleness and immutable history;
- redelivery, concurrent consumers and retry after a failed receipt;
- unrelated and malformed events;
- the side-effect footprint;
- canonical runs, re-assembly equality and no publication;
- read-model rebuild equality;
- least privilege and the 0029 grant.

Demonstrate: submit and accept a contest result in a competition that already has a submitted `@2` competition classification, then run the worker once. The log shows `stale checked=1 emitted=1`, and the outbox holds one `ClassificationStale` for that classification version. A second `--once` emits nothing more. A seeded demo command is Step 14.

## Fixture lanes

`@br/rankings/fixtures` (in memory; exported for tests only) and `@br/testkit/rankings` (throwaway `br_rkfx_<12hex>` databases, created dynamically, migrated with the normal migrations, given the provenance-only overlay, dropped afterwards; the API, worker and seeds never connect to them).

The validated writer is the same code in both lanes. The lane entry points (`persistRankingRun`, `publishRankingSnapshot`) are exported only from `@br/persistence/ranking-lanes`, not from the package root. A REFERENCE_FIXTURE run is accepted without canonical re-assembly (its synthetic FINAL / V2+ / hold facts cannot be re-assembled), but its outcome is still re-evaluated, and the normal schema's provenance CHECKs refuse it. Only the overlay database accepts it. Fixture runs index only their SYSTEM_VERSION dependency, because their candidate pins are synthetic and BR176 would refuse them. A CORRECTS lineage is accepted only for REFERENCE_FIXTURE runs: there is no correction producer.

**Why positive recognition snapshots need fixtures today:** a PLATFORM snapshot needs FINAL (no T5 / T6 producer), V2+ (no `RESULT_OFFICIAL` producer, so production tops out at V1) and a known, absent hold (no hold producer). An OFFICIAL snapshot additionally needs an owner publication act (no producer), so the writer always refuses it with `OWNER_PUBLICATION_UNAVAILABLE`, even in the fixture lane.

Tests: `packages/persistence/src/rankings-writer.int.test.ts` (canonical lane on the normal schema + the `br_rkfx_` lane) and `packages/persistence/src/rankings-staleness.int.test.ts` (Step 7: staleness, indexes, `ClassificationStale`, as-published / as-corrected).

**QUALIFIED lane (Step 9).** `createQualifiedFixtureDatabase` (`@br/testkit/rankings`) creates a `br_rkfx_` database with the ranking overlay AND the achievement overlay (whose name guard now also admits `br_rkfx_`; it relaxes the provenance CHECK of `achievement.qualification_basis` too). Fixture QUALIFIED snapshots are built from real stored fixture snapshots (`storedSnapshot`, `qualificationFixtureSnapshot`) with labelled synthetic staleness CURRENT, hold and target adoption. Tests: `packages/persistence/src/qualified.int.test.ts` (migration boundary, canonical fail-closed, privileges, fixture-lane mechanics) and `packages/achievements/src/qualified.test.ts` (engine).

## Limitations

In production there is no FINAL, V2, V3, V4, hold, eligibility, population, target-authority, owner-publication or correction producer. As a result:

- only operational standings are reachable;
- recognition rankings and QUALIFIED are reported with exact blockers.
