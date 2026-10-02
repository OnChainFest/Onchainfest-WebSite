# ADR-0048 — Ranking systems define immutable universes; rankings are immutable snapshots with pinned bases; official publication fails closed

- **Status:** Proposed
- **Date:** 2026-10-01
- **Origin:** BRT-10 read-first decisions 1 and 3 (BRT-01 verification model §4.2, §7, §10; disputes §1.3, §5.2; result domain §10; BRT-02 persistence §6, system architecture L186; ADR-0043, ADR-0044, ADR-0046 patterns)
- **Clarifies:** ADR-0001 decision 4, BRT-01 result domain §10 ("Rankings (M11) | Achievements / FINAL classifications") and verification model §10, for best-mark rankings only. This follows the narrow pattern ADR-0044 used for records. See decision 4. The domain model is unchanged.

## Context

BRT-02 persistence §6 defines rankings as a separate module, not as Results:

- `ranking_system`: a versioned definition with points table, decay, eligibility and owner authority;
- `ranking_run`: inputs digest, as-of time, trigger;
- `ranking_snapshot` and `ranking_snapshot_entry`: immutable once published;
- corrections produce new runs and snapshots linked by `corrects_snapshot_id`;
- the as-published and as-corrected views are queries, not copies.

`results.result.scope_type` has no cross-competition scope, so treating cross-competition rankings as Results would change the Result model.

The permission matrix (BRT-01 §7) sets these floors:

| Row | Status | Level | Hold |
|---|---|---|---|
| Platform rankings | FINAL | V2 | blocks |
| Official rankings of a sanctioning body | FINAL | V3 | blocks; "Ranking owned by that authority" |

PLATFORM authority is recognized only at `level = PLATFORM` (§4.2, §6). No capability, attestation or fact lets an owner authority **publish** a ranking. `RECORD_RATIFIED` has no ranking equivalent.

## Decision

1. **Stable identity and immutable versions.** The module has these parts:
   - `ranking.system`: stable code, plus kind `PLATFORM | OFFICIAL`.
   - `ranking.system_version`: an immutable declarative `br:ranking-system-version@1` spec, its spec hash, and a **universe hash** `br:ranking-universe@1`.
   - **One universe per system.** It covers: DisciplineVersion, exact metric (`{key, markMetricId}`), holder type `ATHLETE | TEAM`, result scope `CONTEST`, competition set or unrestricted, sporting-time window `[from, to)`, and declared population. A different universe is a different system.
   - **Lifecycle** is DRAFT (no row) → PUBLISHED → RETIRED, with no backdating (`effectiveFrom` ≥ publication).

   This is the ADR-0043 pattern.
2. **Method `BEST_MARK` only (v1).** Each holder's entry is their best admissible Performance in the universe, under the DisciplineVersion metric order (ADR-0049). Points tables, decay and placement-points systems are refused with `POLICY_UNSUPPORTED`. There is no season entity, so a window is only the explicit `[from, to)` on sporting time and never a named season.
3. **Floors are raised, never lowered.**
   - PLATFORM: FINAL, V2, hold blocks.
   - OFFICIAL: FINAL, V3, hold blocks, and the governing recognition pinned from each basis run (`governingRecognitionFromRun` plus the re-hashed anchor fact, ADR-0041) must cover the owner's declared recognition scope: sport, discipline, region and level.
   - A spec may raise a floor (to V3/V4). Validation rejects any lower floor (`BELOW_PLATFORM_FLOOR`).
4. **Source and input model.** This decision reconciles ADR-0001 §4 with BRT-01 result domain §10 and verification model §10. It does not change the domain model and adds no Achievement type.
   1. **Source-authority boundary.** ADR-0001 §4 ("derive from Achievements or FINAL classifications, never directly from raw submissions") is a boundary on **where** a ranking's inputs may come from. A ranking may consume only facts whose trust the Result → Verification chain establishes at the consequence's floor. It never asserts or upgrades that trust itself. The consumers of each kind of fact are:
      - FINAL classifications (ADR-0047) are the source for **placement-based** consumption: points-table ranking systems (deferred) and the `CLASSIFICATION_POSITION` basis of QUALIFIED.
      - Achievements are the source for **recognition built on rankings**. QUALIFIED is itself an Achievement (ADR-0050), and its basis always re-pins the underlying verified result versions and runs (AC-1, ADR-0001 §2–3), even when the qualifying fact is a snapshot entry. `RANKING_MILESTONE` remains deferred.
   2. **BRT-10 v1 best-mark basis = the verified immutable Performance basis of ADR-0044.** A `BEST_MARK` system ranks marks, not placements. Each basis pins the following, which is the exact provenance to the governing verified result context:
      - the exact Performance (participant + ordinal + Mark), inside the exact CONTEST ResultVersion, with its content hash re-verified;
      - its FINAL status, from append-only transitions;
      - its CURRENT BRT-07 run at or above the system floor (hash freshness, read through `br_verification_reader`), and the governing recognition pinned from that run's trace;
      - the evidence-bundle commitment;
      - the competition / event / contest it belongs to, and the sporting time;
      - hold state, which must be known and absent.

      For comparative marks this is the same narrow reading ADR-0044 gave records. The rule's purpose is preserved: exact references, never unverified submissions, computable correction impact. Placements are not marks, so classification ResultVersions are **not** inputs to `BEST_MARK`.
   3. **Raw submissions are never ranking inputs.** The following never enters a snapshot: a version that is SUBMITTED, PROVISIONAL, OFFICIAL, REJECTED, SUPERSEDED or REVOKED; a version without a CURRENT run at the floor; a held or hold-unknown version; an invalid Performance. Each such candidate appears only as an excluded candidate in the run outcome, with its blocker.
   4. **A RankingSnapshot is not a ResultVersion.** It is a separate, versioned, derived artefact (BRT-01 verification model §10, "snapshots are separate, versioned artefacts"; BRT-02 persistence §6), and it asserts no sporting outcome. It has no lifecycle status, is never attested, verified or disputed as a Result, and is never an input to a classification. Its entries reference their basis and copy only the ranked Mark, byte-equal to the Performance. Conversely, an in-competition classification stays a ResultVersion with `derivedFrom` (ADR-0047) and is never a snapshot.
5. **Run, snapshot, entries.**
   - A `ranking.run` pins the system version + spec hash, the as-of sporting cutoff, the snapshot hash (inputs digest), the outcome hash, the engine version, the trigger, and the provenance (`CANONICAL_ASSEMBLY` only in the normal schema).
   - Run identity is UNIQUE on (system version, snapshot hash). Repeating the same inputs creates nothing.
   - A `ranking.snapshot` is published from a run only when every publication gate passes. A run that ranks no holder is `BLOCKED` with the run-level publication blocker `NO_RANKED_ENTRIES` (never a candidate reason), so a published snapshot always contains at least one ranked entry. Its `ranking.snapshot_entry` rows carry rank, `tied`, holder, value (byte-equal to the Performance Mark), comparator trace and basis pin.
   - Excluded candidates are recorded in the run outcome with machine-readable blockers. They are never silently dropped.
   - Every table is class A, append-only, with no UPDATE, DELETE or TRUNCATE. Only the validated application writer inserts, after re-running the pure engine and comparing hashes. There are no manual ranking writes.
6. **Official publication fails closed.**
   - An OFFICIAL system declares an `owner` (an anchored principal) and a recognition scope. Validation checks that the owner's trust anchor recognizes that scope. A PLATFORM anchor can never own an OFFICIAL system.
   - Publishing an OFFICIAL snapshot also requires an owner publication act. That is a typed fact kind `RANKING_PUBLICATION` with no producer.
   - Today such runs therefore end `BLOCKED` with `OWNER_PUBLICATION_UNAVAILABLE`. They are recorded as runs and produce no snapshot.
   - The platform never publishes on an owner's behalf.
7. **Naming is computed.**
   - A PLATFORM system is always labelled "Bragging Rights platform ranking".
   - Free-text names may not contain recognition words ("national", "world", "official", "federation", …).
   - Recognition wording is produced only from an OFFICIAL system's owner scope **and** a published snapshot.
8. **History: as-published vs as-corrected (disputes §5.2).**
   - A new snapshot either follows its predecessor (`previous_snapshot_id`, new admissible inputs) or **corrects** it (`corrects_snapshot_id`), when a pinned basis was superseded, revoked or lost its CURRENT support.
   - Published snapshots are never rewritten.
   - As-published is the chronological list. As-corrected is, at each point in time, the latest snapshot not itself corrected. Both are queries.
   - A snapshot whose pins are no longer current is reported STALE at read time. Staleness is never stored on the snapshot.
9. **Read models are projections.** `ranking_read.*` tables are class B. They are refreshed in the writer transaction, rebuildable by `br_rebuild`, and checked for equality between incremental and full rebuild (ADR-0046 pattern). Public surfaces read only these and the immutable facts. The web never reads the database.

## Consequences

- Production publishes **no** recognition snapshot today. There is no FINAL and no V2, and hold state has no producer, so every candidate is reported with its exact blockers.
- Official systems can be defined, validated and evaluated, but are never published until a publication producer exists.
- The full logic is exercised by engine fixtures and by throwaway `br_rkfx_<hex>` overlay databases (ADR-0037 pattern).

## Alternatives considered

- **Rankings as Results with a new scope.** Rejected: changes the Result model and contradicts BRT-02 §6.
- **Platform publishes official rankings.** Rejected: the platform would be acting outside PLATFORM scope.
- **Points tables in v1.** Deferred by decision.
- **Rank BRT-08 Achievements (e.g. PERSONAL_BEST) for best-mark rankings.** Rejected for the reason ADR-0044 gives. A personal best is athlete-local over the athlete's whole history, which is the wrong universe for a windowed, scoped ranking.
- **A new "RANKED_MARK" Achievement to make the wording fit.** Rejected: BRT-01 §8.2 has no such type (ADR-0044 rejected QUALIFYING_MARK for the same reason).
- **Rank only FINAL classification entries.** Rejected for best-mark rankings: placements are not marks, and a classification cannot pass V0 today (ADR-0047 §7). FINAL classifications remain the source for placement-based consumption.
- **Mutable "current ranking" rows.** Rejected: a projection must never be the source of truth.
