# BRT-10 — Ranking Model

| Field | Value |
|---|---|
| Ticket | BRT-10 — Rankings & Qualification |
| Status | Engine (Step 3), persistence foundation (Step 5) and canonical loader / store / writer (Step 6) implemented. Sections still marked _Step N_ are completed by that step. |
| Implements | BRT-01 [result domain §5–6, R-6](../domain/BRT-01-RESULT-DOMAIN.md), [verification model §7, §8.2, §10](../domain/BRT-01-VERIFICATION-MODEL.md), [disputes §5.1–5.2](../domain/BRT-01-DISPUTES-AND-CORRECTIONS.md); BRT-02 [persistence §6](../architecture/BRT-02-PERSISTENCE-ARCHITECTURE.md#6-rankings-persistence); ADR-0003 §5, ADR-0008 |
| New ADRs | [0047](../adr/ADR-0047-classifications-are-derived-result-versions-submitted-through-the-ledger.md) · [0048](../adr/ADR-0048-ranking-systems-and-immutable-ranking-snapshots.md) · [0049](../adr/ADR-0049-explicit-comparator-aggregation-and-shared-ties.md) · [0050](../adr/ADR-0050-qualification-is-a-qualified-achievement.md) |

Companion documents: [classifications](./BRT-10-CLASSIFICATIONS.md) · [engine](./BRT-10-RANKING-ENGINE.md) · [qualification](./BRT-10-QUALIFICATION.md) · [history & corrections](./BRT-10-HISTORY-AND-CORRECTIONS.md) · [development](./BRT-10-DEVELOPMENT.md) · [threat review](../security/BRT-10-RANKING-THREAT-REVIEW.md).

## 1. Result ≠ Achievement ≠ Record ≠ Classification ≠ Ranking ≠ Qualification

| Concept | Says | Representation |
|---|---|---|
| Result | what happened in a contest | `results.result_version` (`@1` content) |
| **Classification** | the standing or final order of an in-competition scope (round, event, competition), derived from pinned inputs | `results.result_version` with `@2` content + `derivation` (ADR-0047) |
| Achievement | rule-derived recognition | `achievement.*` |
| Record | comparative historical mark in a category | `record.*` |
| **Ranking** | an immutable snapshot ordering holders in a declared cross-competition universe. It is a separate derived artefact and never a ResultVersion; it asserts no sporting outcome | `ranking.system` / `system_version` / `run` / `snapshot` / `snapshot_entry` (ADR-0048) |
| **Qualification** | recognition that a holder met a target competition's qualification rule | `QUALIFIED` Achievement (ADR-0050) |

No athlete, participant, entry or team row holds a mutable rank, position, points or `qualified` field. A leaderboard display is a projection and never the source of truth (Step 8: `ranking_read.leaderboard_entry`, rebuilt from `ranking.snapshot_entry`; there is no athlete / passport ranking projection).

## 2. Two modes

| Mode | Artefact | Consumes | Floor | Production today |
|---|---|---|---|---|
| Operational standings | Classification ResultVersion (PROVISIONAL) | current PROVISIONAL+ contest results in scope | PROVISIONAL, level per event policy (operational; ADR-0008) | Reachable, when submitted by a `SUBMIT_RESULT` holder |
| Platform ranking | RankingSnapshot, kind PLATFORM | verified Performance basis | FINAL · V2 · hold blocks | Blocked: no FINAL, V2 or hold state |
| Official ranking | RankingSnapshot, kind OFFICIAL | verified Performance basis + recognition coverage | FINAL · V3 · hold blocks + owner publication | Blocked: also `OWNER_PUBLICATION_UNAVAILABLE` |
| Cross-competition qualification | QUALIFIED Achievement | published snapshot entry or FINAL classification entry | FINAL · V3 · hold blocks + target authority | Blocked: also `TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE` |

## 3. Source and input model (ADR-0048 §4; ADR-0001 §4 clarification)

1. **Source-authority boundary.** Inputs are only facts whose trust the Result → Verification chain establishes at the floor. FINAL classifications feed placement-based consumption: points systems (deferred) and the `CLASSIFICATION_POSITION` basis of QUALIFIED. QUALIFIED is an Achievement whose basis re-pins the underlying verified result versions and runs.
2. **`BEST_MARK` basis.** The verified immutable Performance basis (ADR-0044): an exact Performance in an exact FINAL CONTEST ResultVersion, with a CURRENT run at the floor, governing recognition pinned from that run, an evidence commitment, the competition/event/contest, the sporting time, and hold state known and absent.
3. **Never raw submissions.** Anything else is an excluded candidate with a blocker.
4. **A RankingSnapshot is not a ResultVersion.** Classifications stay ResultVersions (ADR-0047).

## 4. Ranking universe

A ranking system version's universe (`br:ranking-universe@1`) contains the following, and nothing that the canonical domain cannot establish:

- DisciplineVersion, exact metric, holder type (ATHLETE | TEAM) and result scope (CONTEST);
- competition set or unrestricted, and a sporting-time window `[from, to)` (there is no season entity);
- declared population. Population facts have no producer, so a declared population fails closed.

_Step 2: final field list and validation codes._

## 5. Gates and blocker vocabulary

The candidate gates are: integrity, result status, currentness/supersession, verification (CURRENT run ≥ floor), governing recognition, scope/universe membership, population/eligibility, hold state and policy.

Existing BRT-08/09 codes are reused: `RESULT_STATUS_BELOW_REQUIRED`, `RESULT_SUPERSEDED`, `RESULT_REVOKED`, `VERIFICATION_*`, `HOLD_STATE_UNAVAILABLE`, `POPULATION_FACT_UNAVAILABLE`, `RECOGNITION_*_NOT_COVERED`.

New BRT-10 codes: `COMPARATOR_UNDEFINED`, `COMPARATOR_INPUT_MISSING`, `POLICY_UNSUPPORTED`, `ELIGIBILITY_UNKNOWN`, `OWNER_PUBLICATION_UNAVAILABLE`, `TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE`, `CLASSIFICATION_PROVENANCE_UNAVAILABLE`, `CLASSIFICATION_DERIVATION_MISMATCH`, `CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION`.

_Step 2–3: exhaustive table with precedence._

## 6. Platform vs official authority

- PLATFORM systems are only ever labelled "Bragging Rights platform ranking".
- OFFICIAL systems declare an anchored owner whose recognition covers the declared scope, and are never published by the platform (ADR-0048 §6–7).

Definitions (Step 6, `RankingDefinitionStore`, `br_ranking_operator_app` → `br_ranking_rules`):

- A version spec is validated before any row exists. It is checked against the exact PUBLISHED DisciplineVersion and, for OFFICIAL, against the owner's trust anchor loaded canonically **and currently valid** (effective, not expired, not REVOKED). A fake anchor gives `OWNER_ANCHOR_UNKNOWN`, another principal's anchor gives `OWNER_ANCHOR_MISMATCH`, and an uncovered scope gives `OWNER_RECOGNITION_NOT_COVERED`. A PLATFORM system with an owner gives `OWNER_NOT_ALLOWED_FOR_PLATFORM`.
- Free-text names never claim recognition (`DISPLAY_NAME_CLAIMS_RECOGNITION`), and a universe's competition set names real competitions.
- A backdated `effectiveFrom` is refused at creation and at publication (`BACKDATING_REJECTED`; BR174 in the database). Lifecycle is append-only DRAFT → PUBLISHED → RETIRED, and anything else is `INVALID_TRANSITION`. A published version is never mutated (BR001), and a new version keeps the universe, kind and owner (BR171).
- Publication authority: a PLATFORM snapshot is published by the validated writer under the platform's own label (`published_by_account_id` is optional and is never an owner). An OFFICIAL snapshot is refused by the writer with `OWNER_PUBLICATION_UNAVAILABLE`, even when a fixture owner act makes the run PUBLISHABLE. No `RANKING_PUBLISHED` authority or owner-publication fact is ever created.

## 7. Production vs fixture lane

- Canonical paths accept `CANONICAL_ASSEMBLY` provenance only.
- `REFERENCE_FIXTURE` exists only in in-memory engine fixtures and in throwaway `br_rkfx_<12hex>` overlay databases (ADR-0037 pattern).
- No upstream fact (FINAL, V2–V4, hold, eligibility, target authority, owner publication) is ever synthesized in a canonical database.

**Canonical run assembly (Step 6, `ranking-loader.ts`).** For one (system version, sporting cutoff ≤ now), the input contains:

- the exact version row + current lifecycle and the exact DisciplineVersion facts;
- as candidates, **every** Performance with the universe Mark metric in **every** ResultVersion (any status) of a CONTEST Result of an event of that DisciplineVersion. Raw submissions are included so that each is reported with its blocker; none is silently dropped (ADR-0048 §4.3);
- status from append-only transitions, supersession, the immutable competition path, the participant's durable holder (athlete / team), contest occurrence and BRT-07 verification (read under `br_verification_reader`).

HOLD_STATE, POPULATION and RANKING_PUBLICATION are not declared, so the engine fails them closed. The competition set and window are gated by the engine, not by a SQL filter.

**Writer (Step 6, `ranking-store.ts`).** Every write follows re-derive → compare → persist:

- A run stores the exact input digest, outcome + outcome hash, engine version, sporting `asOf`, publication state + reasons, candidate / entry counts and the trigger. The trigger is metadata and never hashed. BLOCKED runs are persisted with their blockers.
- The dependency index records SYSTEM_VERSION, every candidate RESULT_VERSION (content hash) and every pinned VERIFICATION_RUN (outcome hash). Step 7 reads it (`RankingHistoryReader.dependents`) and computes read-time snapshot STALE from the basis pins; see [history and corrections §3, §5](./BRT-10-HISTORY-AND-CORRECTIONS.md).
- A snapshot is published only from a PUBLISHABLE run (≥ 1 entry) of a currently PUBLISHED version whose stored outcome re-hashes and, for a canonical run, still equals the canonical assembly. Content is built from the run. Lineage: the first snapshot of a system is INITIAL; later ones FOLLOW the single head; CORRECTS only for REFERENCE_FIXTURE runs (no correction producer).

**Production ceiling today.** Canonical runs are evaluated and persisted, always BLOCKED (`NO_RANKED_ENTRIES`; every candidate carries `HOLD_STATE_UNAVAILABLE` and, today, `RESULT_STATUS_BELOW_REQUIRED` and verification blockers). The normal schema therefore holds **zero** snapshots. Positive snapshot persistence (INITIAL / FOLLOWS / CORRECTS, idempotent publication, immutability, retired / unpublished refusal, OFFICIAL refusal) is proven only in throwaway `br_rkfx_` databases. See [development § fixture lanes](./BRT-10-DEVELOPMENT.md#fixture-lanes).

## 8. Boundary

BRT-10 does not implement any of the following:

- prizes, Prize Rail, trophies, NFTs, settlement or new blockchain dependencies;
- points tables or decay;
- in-competition advancement, dependency-slot resolution or seeding;
- T5–T8 producers, dispute or hold producers, or eligibility or authority producers.
