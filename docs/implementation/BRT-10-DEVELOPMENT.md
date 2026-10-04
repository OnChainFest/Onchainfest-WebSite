# BRT-10 — Development

Status: Steps 1–13 implemented (engine, vectors, persistence foundation, canonical loader / store / writer, staleness / dependency index / `ClassificationStale`, `ranking_read.*` read models, QUALIFIED Achievement, worker reaction `rankings.react`, `/v1` read API, public web surfaces, repository guards). Next: Step 14 (seed + demo). The commands section is filled in with Step 14.

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
| 11 | API routes (read surface + COMP_STAFF proposal + INTERNAL run read) + `0030_ranking_staff_reader` + API vectors — **implemented** ([API](#api-step-11)) |
| 12 | Web surfaces (public read pages over the Step 11 API) — **implemented** ([web](#web-step-12)) |
| 13 | Guards (`check-no-manual-ranking.mjs`; deliberate updates to record/achievement guards and demos) — **implemented** ([guards](#guards-step-13)) |
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
- `br_api` reaches neither ranking role. Since Step 11 it holds the SELECT-only `br_ranking_staff_reader` (`ranking_read.run_card` / `run_candidate` only, migration 0030) for the INTERNAL run read; snapshot staleness is read through the roles it already had (`br_achievements` + `br_verification_reader`, 0027), classification staleness through `br_results`.
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

- `0030_ranking_staff_reader` (Step 11): **grants only** — `USAGE ON SCHEMA ranking_read` and `SELECT ON ranking_read.run_card, ranking_read.run_candidate` to the new NOLOGIN role `br_ranking_staff_reader` (created by `roles.sql`, reachable only from `br_api` with `INHERIT FALSE, SET TRUE, ADMIN FALSE`). Nothing else: no canonical table, no definition table, no function (not even `platform.tx_time_ms()`: the staff read runs in a plain transaction), no INSERT / UPDATE / DELETE / TRUNCATE, no PUBLIC grant, no SECURITY DEFINER. 0001–0029 untouched.

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

## API (Step 11)

`apps/api/src/v1-rankings.ts` (routes) → `packages/persistence/src/ranking-api-reader.ts` (`RankingPublicReader`, `RankingStaffReader`) → `packages/rankings/src/public.ts` (pure DTO composition). The API exposes the read model and the Step 7 read semantics; it is not a second ranking model. It writes nothing.

### Route matrix

| Method | Path | Class | Response schema |
|---|---|---|---|
| GET | `/v1/ranking-systems` (`cursor`, `limit`) | PUBLIC | `br:public-ranking-system-list@1` |
| GET | `/v1/ranking-systems/:system` (uuid or code) | PUBLIC | `br:public-ranking-system@1` |
| GET | `/v1/ranking-systems/:system/snapshots` (`view=as-published\|as-corrected`, `cursor`, `limit`) | PUBLIC | `br:public-ranking-snapshot-history@1` |
| GET | `/v1/ranking-snapshots/:snapshotId` | PUBLIC | `br:public-ranking-snapshot@1` |
| GET | `/v1/ranking-snapshots/:snapshotId/leaderboard` (`cursor`, `limit`) | PUBLIC | `br:public-ranking-leaderboard@1` |
| GET | `/v1/result-versions/:resultVersionId/classification` | PUBLIC | `br:public-classification@1` |
| GET | `/v1/result-versions/:resultVersionId/classification/entries` (`cursor`, `limit`) | PUBLIC | `br:public-classification-entries@1` |
| POST | `/v1/result-versions/:resultVersionId/classification-proposals` (body `{}`, closed) | COMP_STAFF | `br:staff-classification-proposal@1` |
| GET | `/v1/internal/ranking-runs/:runId` | INTERNAL | `br:staff-ranking-run@1` |

There is no other BRT-10 route: no definition administration, run evaluation, snapshot publication, classification submission / replacement or QUALIFIED / qualification route. QUALIFIED stays visible only through the existing `br:public-achievement@1` (`typeLabel` "Qualified (cross-competition)", `context.competition` = the target).

### Public visibility

- **Systems:** a card whose latest version is a DRAFT is not public (the BRT-09 category rule); PUBLISHED and RETIRED are. The label is computed: PLATFORM → "Bragging Rights platform ranking"; OFFICIAL → no label and `ownerPublication: {status: NOT_AVAILABLE, reason: OWNER_PUBLICATION_UNAVAILABLE}` (ADR-0048 §6–7). No owner, anchor or account id.
- **Snapshots / history / leaderboards:** `CANONICAL_ASSEMBLY` provenance only (fixture rows are never public; production holds zero snapshots, so history is empty and snapshot ids are 404). Snapshot facts: id, hash, system (id, code, version id, version, spec hash), kind, label, method, engine version, `asOf`, `publishedAt`, lineage (kind, prior id / hash, reasons, `chainPosition`, `correctedBy`), `corrects` (as-corrected), `entryCount`. Never run ids / hashes, provenance or basis topology.
- **Leaderboard rows:** rank, tied, holder (TEAM: `teamId` + team name; ATHLETE: Passport display only — a private athlete is `PRIVATE_ENTRANT`, never identified, not even by id), exact Mark value + display, comparator trace, `basisCount`. Canonical order `(rank, holder type, holder id)`; the order inside a tie carries no meaning.
- **Classifications:** only `@2` versions (they alone have a card) whose latest status is PROVISIONAL / OFFICIAL / FINAL. SUBMITTED, REJECTED, REVOKED, SUPERSEDED, `@1` and CONTEST versions answer exactly like an unknown id (404 `classification not found`): the public API is not a ResultLedger inspection API. The card shows the derivation header (policy, DisciplineVersion, engine version, `inputsDigest`, `inputCount`), never the derivedFrom pins. Rows: participant id + BRT-05 entrant display, rank, tied, tie-break keys — copied, never re-ranked.

### Read-time staleness (never stored)

Every snapshot / classification response is `{stored facts…, readTime: {staleness: {state: CURRENT | STALE, reasons[]}}}`. It is computed per request, inside ONE `REPEATABLE READ` transaction that also reads the projection rows:

- snapshot: `snapshotStalenessIn` (Step 7, unchanged) under `br_achievements` (SELECT on `ranking.snapshot` since 0027) + `br_verification_reader`, over the canonical content re-hashed against its stored hash. Reasons: `BASIS_RESULT_NOT_CURRENT`, `BASIS_VERIFICATION_NOT_CURRENT`. The `affected` pins are dropped.
- classification: `readClassificationIn` (Step 7, unchanged) under `br_results`, with the **pinned** policy. Reasons: `PINNED_INPUT_NOT_CURRENT`, `ADMISSIBLE_INPUT_SET_CHANGED`, `ADMISSIBLE_INPUT_SET_UNKNOWN`. The staleness document (`notCurrent` / `added` / `removed`) and the staleDigest are dropped.

There is no second staleness implementation, no `isStale` / `isCurrent` anywhere, and no write.

### Projection drift

In the same transaction each served projection row is compared with the canonical fact: the snapshot card with the canonical snapshot (hash, system version, spec hash, provenance, lineage, entry count, times, kind, method, engine) and its re-hashed content; every leaderboard row with its canonical entry (rank, tied, value, trace, basis count) and the row count; the classification card with the canonical version (status, content hash, schema, scope, derivation header, pin count) and every row with the immutable content. Any difference is `RANKING_INTEGRITY_FAILURE` (500) with `reason: PROJECTION_MISMATCH` (the reason is now in `errorBody`'s fixed-vocabulary allow-list); a canonical snapshot whose content does not re-hash is `SNAPSHOT_HASH_MISMATCH`. Nothing else is disclosed. A rebuild (`br_rebuild`) restores the projection.

### Pagination

Opaque base64url cursors (≤ 400 characters) over the deterministic sort key; `limit` 1–50 (default 20). A cursor must be exactly the encoding of a key of the route's shape — otherwise **400 `INVALID_INPUT` `invalid cursor`**, never the first page (threat review). No offsets, no caller sort, no filter language: unknown query members are rejected by the closed schema.

### COMP_STAFF classification proposal

`POST …/classification-proposals` with a closed empty body. In one `br_results` transaction it resolves the version and its competition path through the SELECT-only `br_verification_reader` (`results.resolve_result_version`, `competition.resolve_scope_path`, `competition.account_competition_roles`), requires `COMP_VIEW_PRIVATE` on that competition (the BRT-07/08/09 staff rule, from database facts, never a caller-supplied competition id), then runs `proposeClassificationIn` (the body of `ResultLedger.proposeClassification`, unchanged) for the version's Result. Unknown and denied are the same 404. It writes nothing (no draft, version, event or audit row) and returns `{schema, resultVersionId, resultId, state, …}` — `PROPOSED` with the outcome and proposed content, `BLOCKED` with blockers, or `UNAVAILABLE` with a reason (e.g. `NOT_A_CLASSIFICATION_RESULT`). A proposal becomes a classification only through the unchanged T2 submission.

### INTERNAL run read

Operator flag at the edge (401 / 403). `RankingStaffReader.run` runs a plain `REPEATABLE READ` transaction under `SET LOCAL ROLE br_ranking_staff_reader` and reads only `run_card` / `run_candidate`: every candidate with its state and sorted blockers (excluded results are visible here, and only here). `cache-control: no-store`. It never evaluates, publishes, re-ranks or writes.

### API vectors

`packages/rankings/test-vectors/brt-10-api.vectors.json` (24 vectors; `pnpm vectors:generate:brt10-api`, checked by `pnpm vectors:check`): literal input → `src/public.ts` DTO → JCS → SHA-256 (no domain tag: a DTO is a response document). Coverage: PLATFORM / OFFICIAL / RETIRED systems, a system page, as-published, as-corrected, a paged and an empty history, CURRENT / STALE / correction-lineage snapshots, leaderboards with shared ties, a private athlete and a team, CURRENT / STALE classifications, classification rows, a staff run, and the exact error envelopes (unknown snapshot / system / classification / proposal, invalid cursor, malformed uuid, projection mismatch). The independent checker `reference/check_brt10_api_vectors.py` rebuilds each DTO from its input, re-derives JCS and the digest, enforces the coverage, and fails on any forbidden member or on any input topology (affected / notCurrent / added / removed ids, staleDigest, private holder id) found in a public DTO. The HTTP tests compare real error responses with these vectors.

### Tests

- `packages/rankings/src/public.test.ts` — composer determinism, corpus reproduction, staleness reduction, computed labels, private holders.
- `apps/api/src/rankings.int.test.ts` — canonical lane: route inventory; systems (code / uuid / draft hidden / pages); cursor and limit bounds; empty history; 404 / 400 envelopes; SUBMITTED / REJECTED / REVOKED / `@1` / CONTEST → 404; proposal (staff, stranger 404, closed body, canonical hash, zero writes); CURRENT → STALE classification with no topology and zero writes; projection drift for card, rows, snapshot and leaderboard; INTERNAL run (401 / 403 / 200 / 404, no-store); least privilege (no `br_rankings` / `br_ranking_rules`, staff reader exactly SELECT on two projections, no PUBLIC grant, no ranking INSERT for any `br_api` role); no qualification route; leak scan of bodies and logs. Fixture lane (`br_rkfx_`): fixture snapshots invisible through the production reader; as-published / as-corrected over a real INITIAL → FOLLOWS → CORRECTS → CORRECTS → FOLLOWS lineage; STALE snapshot detail without basis ids; leaderboard ties and paging; snapshot / leaderboard drift. The fixture reader (`rankingFixturePublicReader`) is exported only from `@br/persistence/ranking-lanes`.
- `packages/persistence/src/security.int.test.ts` — the role graph now includes `br_api → br_ranking_staff_reader`.

## Web (Step 12)

`apps/web` renders the PUBLIC Step 11 routes, and only those. Pages are server components (`force-dynamic`) that call the API through the existing `_lib/api.ts` `getPublic` helper, with no credentials. The web never connects to PostgreSQL and never imports a persistence, ranking or domain package. Dependency direction: web → public `/v1` → `RankingPublicReader` → `public.ts` composer → canonical facts + `ranking_read.*`. The presentation module is `apps/web/app/_lib/ranking.tsx`. Its types mirror the Step 11 DTOs field for field. No staff or INTERNAL route (proposal, run read) is called or linked, and the web has no form, button or mutation control.

### Route matrix

| Web route | API calls | Shows |
|---|---|---|
| `/ranking-systems` (`?cursor=`) | `GET /v1/ranking-systems?limit=50` | Public systems: display name, code, kind / label, lifecycle, method, holder type, metric, effective date |
| `/ranking-systems/[system]` (code; a uuid 308-redirects to the code) | `GET /v1/ranking-systems/:system` | Universe, requirements, version facts, spec hash, links to both history views |
| `/ranking-systems/[system]/snapshots` (`?view=as-published\|as-corrected`, `?cursor=`) | system + `GET …/snapshots?view=…&limit=50` | Chain position, `asOf`, lineage kind + prior link, `correctedBy` (as-published), `corrects` (as-corrected), reasons, entry count |
| `/ranking-snapshots/[id]` (`?cursor=`) | `GET /v1/ranking-snapshots/:id` + `GET …/leaderboard?limit=50` | Immutable facts, hashes, lineage, `readTime.staleness`, leaderboard page |
| `/result-versions/[id]/classification` (`?cursor=`) | `GET /v1/result-versions/:id/classification` + `GET …/classification/entries?limit=50` | `@2` card (status, version, derivation header, hashes), `readTime.staleness`, ranked rows |

The URLs follow the existing conventions. `/records/[id]` and `/record-categories/[code]` mirror their API resources, and slugs are canonicalized like `/competitions/[slug]`. A classification sits next to `/result-versions/[id]/verification` because a classification is a ResultVersion. The home page links `/ranking-systems`. The public DTOs do not map an event or competition to its classification version, so the web does not invent one: a classification is reached by its ResultVersion id.

### Presentation rules

- **Exactly as returned.** Rows are rendered in API order. The web never sorts, re-ranks, breaks a tie or adds a secondary key. A shared rank is shown as the rank plus a "(shared)" marker (1, 1, 3 stays 1, 1, 3), and the page states that the order inside a shared rank has no meaning (ADR-0049). Marks are the API's `value.display` string, and comparator / tie-break values are the trace strings. Nothing is parsed into a JavaScript number.
- **Snapshot ≠ Result.** The snapshot page says it is an immutable published table, not a sporting result: never attested, verified, disputed or edited. A corrected snapshot stays visible, labelled "corrected by …", with a link. Snapshots are never reached from a classification and never shown as a source for one.
- **Classification = ResultVersion.** The page is titled by scope type, shows the ledger status (PROVISIONAL / OFFICIAL / FINAL) and the derivation header the DTO carries (engine version, input count, policy spec hash, inputs digest, content hash). Any classification the API does not expose publicly answers 404, including `@1`, SUBMITTED, REJECTED, REVOKED, SUPERSEDED and CONTEST versions. That 404 is the site's normal not-found page; there is no fallback card.
- **Recognition.** PLATFORM shows the API's computed `label`. OFFICIAL shows "Official ranking system" and states that owner publication is not available (`ownerPublication`). It never shows a platform label or any other recognition claim.
- **Ids.** Snapshot, prior, corrected-by and corrects ids appear only as links. Hashes are shown because the DTO publishes them deliberately. `participantId` and `teamId` are React keys only and are never printed. A private athlete is "Private entrant" (the existing BRT-05 `Entrant` component).

### Read-time staleness

The web renders `readTime.staleness` as returned: "Current at read time", or "Stale at read time" with each fixed reason code and a fixed plain-language explanation. An unknown code is shown verbatim. The web stores nothing and infers nothing from clocks. It does not recompute staleness, never sees the `affected` / `notCurrent` / `added` / `removed` pins or the staleDigest (the DTO has none), and states that STALE does not mean the stored facts changed.

### Pagination

Forward-only "Next page" / "First page" links carry the API's opaque `nextCursor` unchanged. `limit` is fixed at 50. A malformed `cursor` (not `[A-Za-z0-9_-]{1,400}`, or repeated) is a 404 without an API call. A well-formed cursor the API rejects (400 `invalid cursor`) is also a 404: `getPublic(path, {badRequestIsNotFound: true})`, an opt-in flag, so every existing page still maps a 400 to "unavailable". An invalid cursor is never shown as the first page.

### Error and empty states

These follow the existing web conventions:

- A malformed route parameter (uuid / system ref / view) or an API 404 renders `notFound()`, the shared not-found page that says private, restricted and missing look the same.
- A network failure, any other non-2xx response, or `RANKING_INTEGRITY_FAILURE` / `PROJECTION_MISMATCH` renders the existing `<Unavailable />`. The error code is not shown, and drifted data is never rendered.
- Empty states are "No public ranking systems yet." and "No published snapshots yet.". Production holds zero snapshots, so a history page is empty and every snapshot id is a 404. No data is manufactured.
- Loading: like every existing page, the ranking pages are fully server-rendered per request with no client loading state (no `loading.tsx` exists in the app).

### Tests

`apps/web/app/_tests/rankings.test.tsx` (18 tests, `unit` project). It renders the real page components with `react-dom/server` against a stubbed `fetch` that serves the Step 11 API vector DTOs (`brt-10-api.vectors.json`) verbatim, matched on the exact path and query. Coverage:

- systems list / detail / OFFICIAL vs PLATFORM, uuid → code redirect, empty list;
- as-published / as-corrected / paged / empty history, invalid view;
- snapshot facts, CURRENT / STALE / correction lineage, corrected-by banner;
- leaderboard shared ties (1, 1, 3), private / team holders;
- cursor pass-through, next / first links, malformed and API-rejected cursors;
- a deliberately non-monotonic page with odd exact decimals (rendered in API order, byte for byte);
- classification card + shared-rank rows, STALE reasons, not-public 404;
- 404 / unavailable / projection-mismatch handling;
- a leak scan over every rendered surface: no `br_`, SQL, `pg_`, staleDigest, run / account / owner / anchor ids, topology member names, table names or `42501`, no `br:` schema tags, no staff run id, and no id or hash the composer received but dropped from that page's DTOs (e.g. the private athlete's holder id and the stale pins);
- `getPublic`'s default 400 behaviour unchanged.

To support this, the `unit` project of `vitest.config.ts` now includes `apps/web/app/**/*.test.tsx` and compiles JSX with the automatic runtime (`apps/web` keeps `jsx: preserve` for Next). `_tests` is a private App Router folder, so it is never a route. `_tests/react-dom-server.d.ts` types the one test-only import, because `@types/react-dom` is not a dependency.

### Live verification

Run `pnpm dev:api` against the development database, then `pnpm --filter @br/web build && pnpm --filter @br/web start`. Then check:

- `/ranking-systems` renders the empty state (no ranking system is seeded before Step 14).
- Unknown and malformed system / snapshot / classification URLs and bad cursors answer 404. A well-formed undecodable cursor reaches the API as 400 and renders 404.
- The existing pages still answer 200.
- The rendered HTML and the API / web logs contain none of the leak patterns above.

Populated snapshots and classifications are verified through the vector-driven tests, because production cannot produce a positive RankingSnapshot today (see [Limitations](#limitations)).

## Guards (Step 13)

`tooling/check-no-manual-ranking.mjs` makes the BRT-10 trust boundary mechanical, like the BRT-07/08/09 guards. It runs last in `pnpm lint` (after the key-material, ResultLedger-composition, verification, achievement and record guards). It scans `packages/`, `apps/` and `db/migrations/`. It skips comment lines and `*.test.ts(x)` / `*.int.test.ts` files, because tests prove these paths are refused. No source file is exempt as a whole: each exception is an explicit file (or directory prefix) per rule.

### What it forbids

| Class | Rule |
|---|---|
| Manual ranking / classification | Setters, forcers and publishers by name, declared or called (`setRanking`, `forceRanking`, `overrideRank`, `setStanding`, `updateStandings`, `forcePublish`, `makeOfficial`, `insertSnapshot`, `setSnapshotLineage`, `forceClassification`, …). |
| Shortcut fields | `isRanked`, `rankingPosition`, `currentRank`, `rankingPoints`, `currentRanking`, `isClassified` and `currentSnapshotId` (and their snake_case forms). Stored staleness or currentness (`isStale`, `isCurrentSnapshot`, … as members). `.ranking` / `.ranked` / `.qualified` members on Results, Performances, Verification, Achievements or holders. |
| Raw canonical writes | SQL or query-builder writes into `ranking.*`, `ranking_read.*` or `results.classification_*` outside the exact writer and table allowlist below. UPDATE, DELETE and TRUNCATE of class-A `ranking.*` tables are refused everywhere, the writers included. Application code also may not run `ALTER TABLE ranking…` or touch `session_replication_role`. |
| Publication / runtime bypass | Each writer entry point may be named only by its allowlisted files: `persistRankingRun` / `publishRankingSnapshot`, `RankingService`, `RankingDefinitionStore`, the `refresh*Card` / `rebuildRankingReadModels` projection functions, `emitStale`, `RANKING_FIXTURE_READ_LANE`, and the pure engines `evaluateRankingRun` / `deriveClassification`. Running an engine outside the writers is re-ranking. |
| Consequence leapfrogging | Ranking code must not reference QUALIFIED derivation (`deriveQualification`, `AchievementService`, `deriveAchievements`, `persistDerivation`, `QualificationGranted`), RecordMark writers, prizes, payouts, trophies, NFTs (`mintTrophy`, `mintNft`, …), `advancement` / seeding / slot resolution, or SQL writes into any non-ranking schema. "Ranking code" is `packages/rankings/src`, `packages/persistence/src/{ranking,classification}-*`, `apps/api/src/v1-rankings.ts` and the web ranking / classification pages. |
| Fixture-lane leakage | `@br/rankings/fixtures`, `@br/persistence/ranking-lanes` and `@br/testkit/rankings` (and the relative `./fixtures` / `./ranking-lanes` imports) are refused outside tests, `packages/testkit/` and `packages/rankings/scripts/` (vector generation). Naming a `br_rkfx_` database or the ranking fixture overlay is refused there too. No demo exception exists yet; `demo:rankings` is Step 14. |
| Write surfaces | Any non-GET API route whose path mentions a ranking or classification is refused, except the approved, write-free COMP_STAFF `POST /v1/result-versions/:resultVersionId/classification-proposals`. The web may not import `@br/persistence`, `@br/testkit`, `pg` or `kysely`, and web ranking pages may not send POST / PUT / PATCH / DELETE. |
| Migrations | No data writes (INSERT / UPDATE / DELETE / TRUNCATE) on ranking or classification tables. Write grants are checked per statement, including `format()`-built grants: `ranking.*` → only `br_ranking_rules` / `br_rankings`, INSERT only (never UPDATE / DELETE / TRUNCATE / ALL); `ranking_read.*` → only the projection writers (`br_ranking_rules`, `br_rankings`, `br_results`, `br_rebuild`); `results.classification_*` → only `br_results`. No rank / standing / qualification / leaderboard column or table outside the ranking schemas, and no `is_current` / `is_stale`-style stored state on ranking tables. No prize / payout / trophy / NFT / mint / settlement / entitlement / advancement / seeding vocabulary in 0023–0030. |

### Canonical writer exceptions (exact files)

| File | May |
|---|---|
| `packages/persistence/src/ranking-store.ts` | INSERT `ranking.run`, `run_dependency`, `snapshot`, `snapshot_entry`. Defines `persistRankingRun` / `publishRankingSnapshot` / `RankingService` and runs `evaluateRankingRun`. |
| `packages/persistence/src/ranking-definition-store.ts` | INSERT the six definition tables (`system`, `system_version`, `system_version_status_change`, `classification_policy`, `classification_policy_version`, `classification_policy_version_status_change`). |
| `packages/persistence/src/ranking-projection.ts` | Write and TRUNCATE `ranking_read.*`; defines the refresh / rebuild functions. The refresh functions are called only by the writer of the projected fact: `ranking-store.ts`, `ranking-definition-store.ts`, `result-ledger.ts`. |
| `packages/persistence/src/result-ledger.ts` | INSERT `results.classification_derivation` / `classification_input` (T2) and run `deriveClassification`. |
| `packages/persistence/src/ranking-worker.ts` | Use `RankingService` (evaluate only) and `emitStale`: the approved worker. `apps/worker` reaches it only through `RankingWorkerService`. |
| `packages/persistence/src/classification-staleness.ts` | Defines `emitStale`; re-runs `deriveClassification` for staleness. |
| `packages/persistence/src/ranking-lanes.ts`, `ranking-api-reader.ts`, `index.ts` | The lane re-exports, the fixture read lane, and the package-root exports. |
| `packages/rankings/src/`, `packages/rankings/scripts/` | The pure engines and the vector generators. |

### Relationship with the achievement and record guards

The ranking guard owns the ranking write boundary everywhere. The two older guards keep every BRT-08 / BRT-09 rule and add the BRT-10 direction for their own code:

- `check-no-manual-achievement.mjs`:
  - QUALIFIED is derived only through `AchievementService.deriveQualification`. Nothing else may call it, because its event-driven invocation is deferred.
  - Achievement / QUALIFIED code, including `qualification-loader.ts`, reads the canonical `ranking.*` / classification facts only. It never reads `ranking_read.*` projections (a hidden source of truth), never calls a ranking writer, refresh or `emitStale`, and never writes ranking / classification tables.
  - `QualificationGranted` and `RankingSnapshotPublished` join the shortcut / leapfrog vocabularies. The 0027 rules are unchanged.
- `check-no-manual-record.mjs`:
  - Record code never reads `ranking.*`, `ranking_read.*` or `achievement.qualification_basis` (a record rests on the verified Performance basis, ADR-0044).
  - It never calls a ranking writer or engine, and never derives QUALIFIED.
  - Its BRT-10 leapfrog vocabulary now also names `RankingSnapshotPublished`. The 0019–0022 migration rules are unchanged.
- Both scripts accept an optional root argument, so the guard tests can run them on throwaway trees.

### Demos

BRT-10 schemas exist, so "no ranking schema exists" stopped being evidence. The check also failed: `demo:records` asserted it, and `demo:achievements` / `demo:verification` counted every `Ranking*` event in the database. All three now compare `brt10ConsequenceFootprint` (`@br/testkit`, owner login) before and after Part A. The footprint counts:

- snapshots and their entries;
- `@2` classification derivations;
- QUALIFIED Achievements and their qualification links;
- `RankingSnapshotPublished`, qualification, prize, payout, trophy and mint events;
- prize, payout, trophy and NFT schemas (none may exist).

Ranking run evaluations are not counted. The approved worker may evaluate runs from any result event (always BLOCKED in production); a published snapshot is the ranking consequence. Each demo's other canonical-flow checks are unchanged.

### Tests

`tooling/guards.test.ts` (unit project; `vitest.config.ts` now includes `tooling/**/*.test.ts`) runs the guard scripts the way lint does:

- the ranking, achievement and record guards on the real repository;
- the real BRT-10 writers, entry points and migrations copied into a throwaway tree, proving none is flagged (comment lines and test files with forbidden text included);
- one planted violation per rule class: manual setters / publication, shortcut fields, raw / multi-line / query-builder / TRUNCATE / projection / classification writes, entry-point bypasses, re-ranking, fixture imports and fixture databases, ranking → QUALIFIED / prize / record leapfrogs, a write route, web database access, and the migration rules;
- the new achievement- and record-guard rules.

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
