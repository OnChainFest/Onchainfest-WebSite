# BRT-10 — Qualification (QUALIFIED Achievement)

Status: implemented (Step 9: `achievement-engine/3`, migration `0027_qualified_achievements`). Production fails closed; the full path is exercised in throwaway fixture databases only. Decision record: [ADR-0050](../adr/ADR-0050-qualification-is-a-qualified-achievement.md) (with its Step 9 addendum).

## 1. Two notions of "qualified" (ADR-0008)

| Notion | Owner | BRT-10 |
|---|---|---|
| In-competition advancement (next round, bracket, heat, seeding) | Competition engine (operational, deferred) | Not implemented; never called "qualification" |
| **Cross-competition qualification** | QUALIFIED Achievement (recognition consequence) | Implemented (engine/3); fails closed in production |

QUALIFIED is a derived recognition fact only. Nothing in Step 9 registers an athlete, creates an entry, contestant, seeding or advancement, awards a prize, or writes any ranking, classification, result or verification row (proven by the fixture-lane test "no side effects").

## 2. Rule

A QUALIFIED rule (`br:achievement-rule@1`, `targetEngine: achievement-engine/3`, criterion `QUALIFYING_POSITION`, holder strategy `ENTRY_PARTICIPANT`) declares `criterion.qualification`:

| Member | Meaning |
|---|---|
| `targetCompetitionId` | the competition qualified for; the Achievement's scope is `COMPETITION:target` |
| `qualifyingRanks` (N, 1–10 000) | every holder whose canonical (shared) rank is ≤ N qualifies (ADR-0049 §5); no other tie rule |
| `source.kind = RANKING_SNAPSHOT_POSITION` | `rankingSystemId` + the exact `rankingSystemVersionId` (never "the latest"); `resultScope = CONTEST` (the basis pins the snapshot entries' CONTEST results) |
| `source.kind = CLASSIFICATION_POSITION` | `scopeType` (EVENT / COMPETITION classification), `scopeId` and the exact classification `policyVersionId`; `resultScope = scopeType` |

Validation (`validateAchievementRuleSpec`): QUALIFIED only on engine/3 (`QUALIFIED_REQUIRES_ACHIEVEMENT_ENGINE_3`); the source carries exactly the members of its kind (`PARAM_REQUIRED` / `PARAM_NOT_ALLOWED`); the BRT-01 floor FINAL · V3 can be raised to V4, never lowered (`BELOW_PLATFORM_FLOOR`); N is an integer in range (closed schema). The rule store also checks, before a version row exists and again at publication, that the target competition exists (`COMPETITION_UNKNOWN`) and that the system version / classification policy version / scope are real rows of the declared system, scope type and the rule's DisciplineVersion (`QUALIFYING_SOURCE_MISMATCH`).

Binding: the existing rule binding (no retroactivity). A ranking-source rule applies when bound DisciplineVersion-wide and in force at the snapshot's publication instant; a classification-source rule may be narrowed to the source competition / event and must be in force at the classification's submission instant. v1 rules declare no population / eligibility constraints (nothing is manufactured for them).

## 3. Gates and blockers

The engine (`packages/achievements/src/qualified.ts`) evaluates issuance gates separately from the per-holder question. Any FAIL ⇒ BLOCKED, no candidate.

| Gate | Fails with |
|---|---|
| `RULE_APPLICABILITY` | `RULE_DISCIPLINE_VERSION_MISMATCH` (rule / classification DV), `RESULT_SCOPE_MISMATCH` |
| `QUALIFYING_SOURCE` | `QUALIFYING_SOURCE_MISMATCH` (other system version, scope or policy version, or the other source kind), `RANKING_SNAPSHOT_NOT_PUBLISHED` (a run never published), `RANKING_SNAPSHOT_CORRECTED`, `RANKING_SNAPSHOT_STALE` + `BASIS_RESULT_NOT_CURRENT` / `BASIS_VERIFICATION_NOT_CURRENT`, the classification stale reasons (`PINNED_INPUT_NOT_CURRENT`, `ADMISSIBLE_INPUT_SET_CHANGED`, `ADMISSIBLE_INPUT_SET_UNKNOWN`), `CLASSIFICATION_PROVENANCE_UNAVAILABLE` (`@1` content) |
| `RESULT_STATUS` | classification: `RESULT_SUPERSEDED`, `RESULT_REVOKED`, `RESULT_REJECTED`, `RESULT_STATUS_BELOW_REQUIRED` (not FINAL); `RESULT_STATUS_UNAVAILABLE` |
| `VERIFICATION` | classification: `VERIFICATION_STALE` / `_NOT_EVALUATED` / `_POLICY_UNAVAILABLE` / `_RUN_INCOMPLETE` / `_LEVEL_BELOW_REQUIRED`; `VERIFICATION_UNAVAILABLE` |
| `HOLD_STATE` | `HOLD_STATE_UNAVAILABLE` (unknown is never "no hold"), `HOLD_ACTIVE` |
| `TARGET_AUTHORITY` | `TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE`, `TARGET_QUALIFICATION_AUTHORITY_INVALID` (withdrawn, or adopts another rule version / spec hash), `TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE` (another target) |

Per holder (subject reasons): `POSITION_OUTSIDE_QUALIFYING_RANKS` (rank N+1 and beyond), `RANK_MISSING`, `VERIFICATION_LEVEL_BELOW_REQUIRED` (a ranking holder any of whose pinned bases is below the floor — no silent filtering of equal marks), `PARTICIPANT_UNKNOWN` / `HOLDER_UNRESOLVED`. A malformed rank (0, non-integer, string) is a non-canonical snapshot: integrity failure, never a guess. The four codes new in Step 9 (`QUALIFYING_SOURCE_MISMATCH`, `RANKING_SNAPSHOT_CORRECTED`, `TARGET_QUALIFICATION_AUTHORITY_INVALID`, `TARGET_QUALIFICATION_AUTHORITY_OUT_OF_SCOPE`) and the two gate names were added by decision; every other code is reused.

**Verification floor.** V3 (or the rule's raised V4). V0 / V1 / V2 never qualify; nothing upgrades a level or creates a verification run. Ranking path: each pinned basis run is CURRENT exactly when the snapshot reads CURRENT (Step 7 staleness), and its level is the pinned level. Classification path: the classification version's own BRT-07 run, CURRENT, at the floor. Even a V2 PLATFORM snapshot's rank 1 does not qualify.

**Determinism.** Identical snapshot ⇒ identical outcome, candidates, hashes and identities (set members are order-independent; tests and vectors prove it). No clock, randomness or environment.

## 4. Pins and identity

The candidate (`br:achievement-candidate@1`, member `qualification`) pins: kind, target, N, the position — `ranking {systemId, systemVersionId, snapshotId, snapshotHash, rank, tied}` or `classification {resultId, resultVersionId, contentHash, scopeType, policyVersionId, participantId, rank, tied}` — the `basisHash` (hash of the Step 2 `br:qualification-basis@1` document: position + holder + every underlying FINAL basis with its run, level and outcome hash) and the target adoption `{adoptionId, adoptionHash}`. The basis items are the snapshot entry's pinned verified bases (one per ResultVersion / participant) or the classification version and its run. `evidenceCommitment` is the usual BRT-08 commitment over them.

Identity (AC-2) additionally names the qualifying source (`qualificationSource {kind, sourceId, sourceHash}`), as ADR-0050 §6 requires ("the pins are part of the candidate hash and therefore of its identity"): the same underlying basis under another snapshot or classification version is another qualification fact. The member is absent for every other type, so no existing identity or vector changes.

**One per (rule, holder, target)** (decision): at most one non-terminal QUALIFIED exists per rule, holder and target competition. The first qualifying source issues it; a later snapshot that merely FOLLOWS (or another classification) creates nothing and never touches the earlier Achievement. Only a correction of the pinned source issues a new one (§5). The writer enforces this under a lock; the database re-checks it at commit (BR185).

The append-only link `achievement.qualification_basis` (one row per QUALIFIED, equal to the candidate pin, BR183) is also the dependency index: which QUALIFIED Achievements rest on snapshot S or classification version C (`qualificationIndex`).

## 5. Corrections

Re-assessment follows disputes §5.1 against the as-corrected view (ADR-0050 §7); nothing is overwritten and no history is hidden:

| Situation | Effect |
|---|---|
| A snapshot CORRECTS the pinned one, or a classification version supersedes the pinned one, and the holder still qualifies under it | new QUALIFIED (new identity), old one SUPERSEDED with a supersession link |
| … and the holder no longer qualifies under the correcting source (derived with every gate passing) | `REVOKED` (`HOLDER_NO_LONGER_QUALIFIES` + `RANKING_SNAPSHOT_CORRECTED` / `BASIS_RESULT_SUPERSEDED`) |
| … and the correcting source is not (yet) issuable | `SUSPENDED` (`AWAITING_REDERIVATION`), never revoked |
| a pinned basis ResultVersion revoked | `REVOKED` (`BASIS_RESULT_REVOKED`) |
| support temporarily below the floor (pinned run no longer CURRENT, lower level, stale verification) | `SUSPENDED`, reactivated by a later entry |

`assessSupport` gains one optional fact (`qualifyingSnapshotCorrected`); the canonical support source computes it (and the successor derivation) from `ranking.snapshot.corrects_snapshot_id` and the classification's supersession. There is no production correction producer (no CORRECTS snapshot outside the fixture lane, no T7/T8), so corrections are exercised in the fixture lane only; the semantics are in place and fail closed.

## 6. Canonical vs fixture

| Lane | Facts | Result |
|---|---|---|
| Canonical (`AchievementService.deriveQualification`, `qualification-loader.ts`) | the exact run / published snapshot (content re-hashed), its lineage, whether a correction replaces it and its Step 7 staleness; or the `@2` classification (content re-hashed), derivation header, status, supersession, BRT-07 verification and Step 7 staleness. Declares only the production-supported kinds. Never reads `ranking_read.*`; refuses REFERENCE_FIXTURE rows (`FIXTURE_SOURCE_REFUSED`) | always BLOCKED: `HOLD_STATE_UNAVAILABLE` + `TARGET_QUALIFICATION_AUTHORITY_UNAVAILABLE` (+ no FINAL / V3 / published snapshot today). Zero QUALIFIED Achievements |
| Reference engine fixture (`@br/achievements/fixtures`: `qualifiedRankingFixture`, `qualifiedClassificationFixture`) | in memory, synthetic FINAL / V3 / hold / adoption | unit tests and vectors |
| Reference persistence fixture (`@br/testkit/rankings`: `createQualifiedFixtureDatabase`, `qualificationFixtureSnapshot`) | a throwaway `br_rkfx_<hex>` database with the ranking AND achievement overlays; real stored fixture snapshots, real rules, a real target competition; synthetic staleness CURRENT, hold and adoption | integration tests |

`TARGET_QUALIFICATION_AUTHORITY` is a `DerivationFactKind` with no producer. Its fixture representation (`qualification.targetAuthority {targetCompetitionId, ruleVersionId, ruleSpecHash, adoptionId, adoptionHash, status}`) is accepted only in REFERENCE_FIXTURE snapshots: a CANONICAL_ASSEMBLY snapshot cannot declare the kind (the engine filters canonical kinds to the production-supported set), the canonical re-assembly never carries it, the provenance CHECK refuses fixture rows in the normal schema, and the binding trigger refuses every canonical QUALIFIED (BR184) — whatever a caller writes.

Ranking sources are INTERNAL-only (no competition owns a cross-competition ranking); a classification source needs staff rights on its competition. The event-driven invocation (snapshot published, classification submitted) is the Step 10 worker and is not wired.

## 7. Persistence (migration 0027)

- `achievement.rule` / `achievement.achievement` type CHECKs admit `QUALIFIED`; `achievement_qualified_shape`: scope `COMPETITION` = context competition, no event, no qualifying value / comparison set, engine `achievement-engine/3`, `basis_level` V3 or V4 (no downgrade).
- `achievement.qualification_basis` (class A): kind-coherent position columns, `rank ≤ qualifying_ranks` (CHECK), basis hash, adoption pin, provenance (`CANONICAL_ASSEMBLY` only; relaxed only by the test overlay). Triggers: BR183 (link = candidate pin; target, N and pinned source = the rule version's own declaration, so a threshold cannot be lowered nor a system / policy version substituted; a ranking position names an existing snapshot of the same provenance where the holder holds exactly that rank and tie), BR184 (no canonical target-authority producer), BR185 (a QUALIFIED commits with exactly one link; only QUALIFIED carries a pin; one non-terminal per rule / holder / target). Append-only, no TRUNCATE, recorded-at bound.
- Grants: `br_achievements` SELECT, INSERT on the link; SELECT only on `ranking.system / system_version / run / snapshot / snapshot_entry / classification_policy_version`, `results.classification_derivation / classification_input`, `competition.round`. `br_achievement_rules` reads the referenced ids (column grants). No PUBLIC grant, no SECURITY DEFINER, no UPDATE / DELETE.
- **Boundary:** 0027 references no `ranking_read` object; a fresh database migrates 0001…0027 without 0028 (integration test) and then applies 0028. 0001–0026 and 0028 are unchanged.

## 8. Vectors

The BRT-10 corpus gains 35 QUALIFIED vectors (snapshot, outcome, candidates, identities, qualification-basis documents; ranking top-N with a shared rank, classification top-N, V2 below the floor, corrected snapshot, production shape). The independent Python checker recomputes the semantics from the snapshot, the identity (with source), the evidence commitment and the basis hash, and detects mutations of rank, threshold, source identity, policy version, verification level, authority and basis hash.

## 9. Not available in production

No FINAL (T5/T6), no V2+ beyond V1, no hold producer, no target-authority producer, no snapshot / classification correction producer, no population or eligibility facts. QUALIFIED is therefore reported with exact blockers and never issued canonically.
