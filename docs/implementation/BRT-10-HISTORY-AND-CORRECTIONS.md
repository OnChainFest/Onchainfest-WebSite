# BRT-10 — History, Staleness and Corrections

Status: staleness, correction impact, dependency indexes and as-published / as-corrected queries implemented (Step 7); QUALIFIED effects implemented (Step 9). Decision records: [ADR-0047](../adr/ADR-0047-classifications-are-derived-result-versions-submitted-through-the-ledger.md) §5–6, [ADR-0048](../adr/ADR-0048-ranking-systems-and-immutable-ranking-snapshots.md) §8, [ADR-0050](../adr/ADR-0050-qualification-is-a-qualified-achievement.md) §7; BRT-01 [disputes §5.1–5.2](../domain/BRT-01-DISPUTES-AND-CORRECTIONS.md).

## 1. Principles

- Nothing is rewritten.
- Classifications, runs, snapshots and entries are immutable.
- Currentness and staleness are computed at read time or by the worker, never stored on the fact.
- Every historical output is reproducible from its pins.

## 2. Classification staleness

A classification is STALE when a pinned input is no longer current or the admissible input set changed. Replacement is blocked until a T7 producer exists.

Implemented (Step 7) as **computed** state: `classificationStaleness` (`@br/rankings`, pure) over what `ClassificationStalenessService` (`@br/persistence`, role `br_results`) observes. Nothing is stored on the version: no flag, no UPDATE, no derived boolean.

- **A — pinned input not current.** For each `derivedFrom` pin: is it still the current version of its Result (latest append-only status PROVISIONAL / OFFICIAL / FINAL, not superseded, same content hash)? A pin whose state cannot be read is **unknown ⇒ affected**. This is exactly `classificationCorrectionImpact` (deduplicated, ordered by `resultVersionId`). A status upgrade of the same version is not impact.
- **B — admissible input set changed.** The scope is re-assembled with the current hierarchy and current contest versions under the classification's **pinned** policy version and DisciplineVersion (`assemblePinnedClassificationInput`). The engine's own admission rules decide which inputs are admissible. Rebinding the scope's policy is therefore not a stale condition. The difference with the pins is reported as `added` (admissible, not pinned) and `removed` (pinned, still current, no longer admissible, e.g. out of scope). A contest in scope that has no admissible result yet is not a change: there is nothing new to rank. When it is accepted, it appears in `added`.
- **Unknown set.** A scope that cannot be re-assembled under the pinned policy (scope gone, DisciplineVersion mismatch, no contest, policy version missing) gives `ADMISSIBLE_INPUT_SET_UNKNOWN`, which reads as STALE (fail closed).
- **Reasons:** `PINNED_INPUT_NOT_CURRENT`, `ADMISSIBLE_INPUT_SET_CHANGED`, `ADMISSIBLE_INPUT_SET_UNKNOWN` (`CLASSIFICATION_STALE_REASONS`). A STALE result carries the `br:classification-staleness@1` document (`notCurrent`, `added`, `removed`, the version id, content hash and inputs digest, but no input status). Its hash is the **staleDigest**.
- `@1` classification content has no provenance. It reads `PROVENANCE_UNAVAILABLE` (`CLASSIFICATION_PROVENANCE_UNAVAILABLE`) and is never treated as derived or stale.

**Production reachability.** With no T7 / T8 producer, a pinned contest input can never stop being current in the normal schema, so condition A is exercised by the pure unit tests only. Condition B is reachable canonically: a new contest result accepted into the scope (for example a new event of the competition) makes a competition classification STALE, while the classifications of other scopes stay CURRENT.

**As-corrected classification read.** `ClassificationStalenessService.read(version)` returns the immutable version (status, schema, content hash), its exact pins, and the staleness computed now, all in one REPEATABLE READ snapshot. It writes nothing. A classification has no correction producer, so "as-corrected" can only mean "the current version, visibly STALE when it is". No corrected ResultVersion is ever materialized.

**Replacement boundary (unchanged).** A re-derived proposal for a Result whose **current** (accepted) version is STALE is still refused by the ResultLedger: `CURRENT_VERSION_CONFLICT`, reason `CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION`. The stale version is never mutated or replaced. While a classification is only SUBMITTED (not yet current), a competing submission is ordinary ledger behaviour, exactly as for contest results.

### 2.1 `ClassificationStale`

- **Event:** `ClassificationStale`, aggregate `RESULT_VERSION` (the classification version), written through the transactional outbox.
- **Payload** (ids, hashes and codes only): `resultId`, `classificationVersionId`, `contentHash`, `inputsDigest`, `staleDigest`, `reasons`, `notCurrent[]`, `added[]`, `removed[]` (version ids).
- **Idempotency:** one event per (classification version, staleDigest). `ClassificationStalenessService.emitStale` runs under `br_results`. It takes a per-version advisory lock before any read (READ COMMITTED), recomputes staleness, and emits only when no `ClassificationStale` with that digest exists for the version. Repeated or concurrent calls in the same state emit one event. A new stale state (a new digest) emits a new event. A CURRENT or provenance-unavailable version emits nothing. No schema change was needed: the outbox's `(aggregate_type, aggregate_id)` index serves the lookup.
- **Not yet wired:** nothing calls `emitStale` automatically. The worker consumer that reacts to result events is Step 10.

## 3. Ranking snapshots: as-published vs as-corrected

- A new snapshot either follows its predecessor (`previous_snapshot_id`) or corrects it (`corrects_snapshot_id`), when a pinned basis was superseded, revoked or lost its CURRENT support.
- As-published is the chronological list. As-corrected is the latest snapshot that has not itself been corrected. Both are queries.
- Step 6 (writer): the first snapshot of a system is INITIAL and every later one FOLLOWS the single head (the snapshot nothing follows or corrects), decided under the per-system lock. A CORRECTS snapshot can only pin the current head, with reasons. It has no production producer and is accepted only for REFERENCE_FIXTURE runs in throwaway `br_rkfx_` databases. Snapshots are never updated or deleted (BR001).
- Step 7 (`RankingHistoryReader`, role `br_rankings` + `br_verification_reader`, the worker login). These are queries over the class-A facts only. They make no copies and no projections (`ranking_read.*` is Step 8).
  - `asPublished(system)` is the lineage in chain order (INITIAL → successors). A corrected snapshot names the snapshot that corrects it (`correctedBy`).
  - `asCorrected(system)` is the same chain with every corrected snapshot replaced by its final correction, which lists what it stands in for (`corrects`). The last item is the current as-corrected snapshot.
  - A fork or gap in the lineage is a `RANKING_INTEGRITY_FAILURE`, never a guess.
  - `read(snapshot)` re-hashes the stored content and computes read-time STALE (`rankingSnapshotStaleness`). A pinned basis ResultVersion must still be the current FINAL version with its pinned hash (`BASIS_RESULT_NOT_CURRENT`), and its pinned VerificationRun must still be the CURRENT run (`BASIS_VERIFICATION_NOT_CURRENT`). Unknown counts as affected. Hold state is not a pin: there is no hold producer, so no hold fact can appear after publication. It joins the pin set when a producer exists.
  - The normal schema holds zero snapshots (no FINAL producer). In the fixture lane every snapshot reads STALE, because its synthetic pins are unknown to the canonical tables. That is fail closed and honest.
- Step 8 (`ranking_read.snapshot_card`): the same two views over the projection. `chain_position` is derived from the immutable lineage and `corrected_by_snapshot_id` from `corrects_snapshot_id`; both are rebuildable. Neither is a "current" flag, and staleness is still never stored. Tests show the projected views equal the canonical queries above.

## 4. Revocation

A revoked basis is never presented as current. Its snapshot reads STALE and the next run corrects it. Historical provenance remains readable.

Step 7: a REVOKED (or superseded, or non-FINAL) basis version fails `BASIS_RESULT_NOT_CURRENT` at read time; a classification pin that is REVOKED / REJECTED / superseded fails `PINNED_INPUT_NOT_CURRENT`. There is no T8 producer, so this is exercised by the pure tests; the correcting run has no producer either.

## 5. Dependency index

`ranking.run_dependency` records which runs and snapshots depend on ResultVersion X, verification run Y and system version S. It is extended by the classification input index and by `achievement.qualification_basis`.

Step 7 consumes the two existing indexes. There is no second dependency system and no schema change:

- `results.classification_input` (0023, `classification_input_target_idx`). `ClassificationStalenessService.dependents(rv)` lists the classification versions pinning `rv`. `correctionImpact(rv)` returns, for each of them, every pin that is no longer current. Only indexed dependents are examined, never unrelated results. Every read asserts that the index equals the content pins and the derivation header (`CLASSIFICATION_INDEX_MISMATCH` otherwise). The index is class A, written by the ledger in the submitting transaction; it is not a projection, so there is nothing to rebuild.
- `ranking.run_dependency` (0025, `run_dependency_target_idx`). `RankingHistoryReader.dependents(type, id)` lists the runs (and their snapshot, if published) depending on a RESULT_VERSION / VERIFICATION_RUN / SYSTEM_VERSION. REFERENCE_FIXTURE runs index only their SYSTEM_VERSION (their pins are synthetic).
- `achievement.qualification_basis` (Step 9, migration 0027, class A, append-only): one row per QUALIFIED Achievement naming its snapshot (id + hash) or classification version (id + content hash + policy version); `qualificationIndex(ctx, {snapshotId | classificationVersionId})` lists the QUALIFIED Achievements resting on a source. It is the Achievement's own pin, never a projection, so there is nothing to rebuild.

## 6. Effect on QUALIFIED

Per disputes §5.1, against the as-corrected view (ADR-0050 §7). Details: [qualification §5](./BRT-10-QUALIFICATION.md#5-corrections).

- A QUALIFIED Achievement pins its exact source; a later snapshot or classification never mutates it, and a snapshot that merely FOLLOWS creates no second QUALIFIED for the same rule, holder and target.
- A correcting source (a snapshot that CORRECTS the pinned one; a classification version that supersedes the pinned one): still qualifies ⇒ a new QUALIFIED supersedes the old; no longer qualifies ⇒ REVOKED; not yet issuable ⇒ SUSPENDED (`AWAITING_REDERIVATION`). A corrected snapshot can no longer qualify anyone (`RANKING_SNAPSHOT_CORRECTED`), and a STALE one neither (`RANKING_SNAPSHOT_STALE`).
- Support below the floor (pinned run no longer CURRENT, lower level) ⇒ SUSPENDED; a revoked basis ⇒ REVOKED.
- Every superseded / revoked Achievement, its status history and its link stay readable unchanged.
- Production has no correction producer (no canonical CORRECTS snapshot, no T7/T8): the effect is exercised in the throwaway fixture lane (`qualified.int.test.ts`) and in the pure tests.
