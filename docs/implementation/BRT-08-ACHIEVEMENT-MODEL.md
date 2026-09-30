# BRT-08 — Verified Achievement Model

| Field | Value |
|---|---|
| Ticket | BRT-08 — Verified Achievements |
| Implements | BRT-01 [verification model §7–8](../domain/BRT-01-VERIFICATION-MODEL.md) (permission matrix, Achievement, AC-1…AC-5), [disputes §3, §5.1](../domain/BRT-01-DISPUTES-AND-CORRECTIONS.md), [padel §6](../examples/BRT-01-PADEL-WALKTHROUGH.md), [bowling §8](../examples/BRT-01-BOWLING-WALKTHROUGH.md); ADR-0001 |
| New ADRs | [0037](../adr/ADR-0037-reference-achievement-persistence-fixtures-in-throwaway-databases.md) · [0038](../adr/ADR-0038-declarative-achievement-rules-bound-without-retroactivity.md) · [0039](../adr/ADR-0039-achievement-basis-pins-exact-current-verification.md) · [0040](../adr/ADR-0040-achievement-status-history-and-corrections-by-supersession.md) |
| Code | `packages/domain/src/achievements.ts`, `packages/schemas/src/achievements.ts`, `packages/achievements` (pure engine), `packages/persistence/src/achievement-*.ts`, `db/migrations/0016–0018`, `apps/api/src/v1-achievements.ts`, `apps/worker/src/main.ts`, `apps/web/app/achievements`, `apps/web/app/athletes/[slug]` |

Companion documents: [rules](./BRT-08-ACHIEVEMENT-RULES.md) · [derivation engine](./BRT-08-DERIVATION-ENGINE.md) · [holder crediting](./BRT-08-HOLDER-CREDITING.md) · [dependency & corrections](./BRT-08-DEPENDENCY-AND-CORRECTIONS.md) · [development](./BRT-08-DEVELOPMENT.md) · [threat review](../security/BRT-08-ACHIEVEMENT-THREAT-REVIEW.md).

## 1. Result ≠ Verification ≠ Achievement

| Concept | Says | Where |
|---|---|---|
| Result (ResultVersion) | what happened | `results.*` (BRT-03) |
| Verification (VerificationRun) | why that exact version satisfies a trust level under an exact policy / snapshot | `verification.*` (BRT-07) |
| **Achievement** | "according to AchievementRuleVersion X, these exact verified sporting facts qualify holder H for recognition Y" | `achievement.*` (BRT-08) |

There is no `result.achievement`, `result.is_winner`, `verification.achievement` or `participant.hasAchievement`. Neither Results nor Verification carry any achievement column. `tooling/check-no-manual-achievement.mjs` fails on such shortcuts and on manual award functions. An Achievement is never a manual award.

## 2. The Achievement fact

```
Achievement (achievement.achievement, class A, immutable)
  id                        persistence id (the engine never assigns ids)
  identityHash              H(achievement-identity, {type, ruleVersionId, holder, scope, basis})   UNIQUE — AC-2
  candidateHash / candidate the exact canonical br:achievement-candidate@1 document (columns bound by trigger)
  achievementType           EVENT_COMPLETED | CONTEST_WON | PLACEMENT | TITLE | PERFORMANCE_THRESHOLD | PERSONAL_BEST
  rule / ruleVersion        pinned forever (never re-interpreted by a newer version)
  engineVersion             achievement-engine/1
  holder                    { ATHLETE | TEAM, stable id }          (never Account, Person or Participant)
  memberCredits[]           TEAM only: immutable { athleteId, creditRole: LINEUP_MEMBER } — AC-5
  scope                     { CONTEST | ROUND | EVENT | COMPETITION | CAREER, id }
  context                   competition / event / contest / DisciplineVersion / sport / discipline codes
  basis[]                   { resultVersionId, contentHash, resultStatus, verificationRunId, verificationSnapshotHash,
                              verificationOutcomeHash, verificationLevel, participantId, performanceOrdinal?, creditedLineupHash? }
  basisLevel                min(level of basis items) — the level of the BASIS verification, not "the Achievement's level"
  qualifyingValue?          value achievements only; byte-equal to the source Performance mark
  comparisonSetHash?        PERSONAL_BEST: the exact eligible comparison set
  evidenceCommitment        H(achievement-evidence-commitment, basis → pinned runs' BRT-06 Evidence Bundles)  (ADR-0041)
  governingAuthority?       {recognitionLevel, anchorId, CERTIFICATION|SANCTION} from the pinned run's immutable trace
  snapshot_provenance       CANONICAL_ASSEMBLY (normal schema CHECK)
  derivationSnapshotHash / derivationOutcomeHash / recordedAt
```

Related tables:

- `achievement.basis_item` is the dependency index.
- `achievement.member_credit` holds the TEAM credits.
- `achievement.status_entry` is the BRT-01 statusHistory.
- `achievement.supersession` links a newer Achievement to the one it replaces.

Every one of these tables is append-only, including for the owner.

**BRT-01 §8.1 members (BRT-08R, [ADR-0041](../adr/ADR-0041-achievement-evidence-commitment-and-governing-recognition.md)):**

- **`evidenceCommitment` is explicit.** It is NOT the VerificationRun `snapshotHash`, which commits to a broader document: policy, authority, participation, keys and typed V2–V4 facts.

  | Document | Commits to |
  |---|---|
  | `snapshotHash` (`br:verification-snapshot@1`) | the whole Oracle input: policy spec, hierarchy, evidence, attestations, V2–V4 facts, supported kinds, keys, authority principals / anchors / grants (+ status), participation relations |
  | **Evidence Bundle** (`br:evidence-bundle@1`, stored as `run.evidence_bundle_hash`) | exactly the evidence / attestation basis: ResultVersion content hash; evidence ids + content / descriptor hashes + lineage + availability / privacy at asOf; attestation ids + statement hashes + proofs + retraction / supersession; signing keys. No verdict, policy, authority or participation |
  | **`evidenceCommitment`** | `H({basis: [{resultVersionId, contentHash, verificationRunId, evidenceBundleHash, evidenceBundleAsOf}]})`: the Evidence Bundle of every basis item, reproducible from immutable BRT-06 facts at its asOf (tested) |

- **`governingAuthority`** is pinned from the basis run's immutable, hash-bound outcome and trace (V3 sanction or V2 certification anchor + recognition level). It is never read from today's authority state.
  - Its `recognitionScope` (level, region, sport, discipline) and `anchorFactHash` come from the immutable BRT-03 anchor fact that the trace names. That fact is re-hashed and level-checked, and trigger BR133 re-checks it; anchor status is never read.
  - It enforces AC-4 through the structural `recognitionClaim {level, region?}` by BRT-03 scope containment.
  - The public DTO shows the level, region and sport only.
- **`period`** is the basis version's contest occurrence.

## 2a. Holder narrowing: ATHLETE / TEAM only (BRT-08R audit)

BRT-01 §8.1 lists `ATHLETE | TEAM | PARTICIPANT`. Every implemented type resolves its durable recognition holder to ATHLETE or TEAM **without semantic loss**:

- **Structural guarantee:** a Participant is an Event-scoped entry, and the database requires `INDIVIDUAL ⇒ athlete_id NOT NULL` and `TEAM ⇒ team_id NOT NULL` (CHECK on `competition.participant`). No Participant exists without a durable Athlete or Team behind it.
- **Per type:**

  | Types | Holder |
  |---|---|
  | EVENT_COMPLETED, CONTEST_WON, PLACEMENT, TITLE | the entry's Participant → its Athlete (INDIVIDUAL) or Team (TEAM) |
  | PERFORMANCE_THRESHOLD | the performer → the individual participant's Athlete; an athlete in the exact credited lineup of a team entry; or the Team for a team-level performance |
  | PERSONAL_BEST | always an Athlete (athlete-local) |

- **What the Participant would add** is event-scoped context: the entry in *this* event. That context is kept, because the scope (EVENT / CONTEST…) is pinned and the Participant id is pinned in every basis item. Nothing about the recognition is lost by holding it on the durable identity. A PARTICIPANT holder would be a non-durable, event-local identity for a durable recognition, which is what BRT-08 must avoid.
- **Conclusion:** no accepted BRT-01 case in BRT-08's types needs a PARTICIPANT holder, so the model is unchanged. A future entrant without Athlete / Team (e.g. an anonymous guest) would need a new ADR, not a silent PARTICIPANT holder.

## 3. Types implemented (BRT-01 §8.2)

| Type | Criterion | Holder | Floor (BRT-01 §7) |
|---|---|---|---|
| EVENT_COMPLETED | CLASSIFICATION_COMPLETION (non-DNS in an EVENT classification) | entry participant | OFFICIAL · V1 |
| CONTEST_WON | CONTEST_OUTCOME (WIN / WALKOVER_WIN, explicit) | entry participant | FINAL · V2 |
| PLACEMENT | CLASSIFICATION_POSITION (explicit rank range, ≤ 64) | entry participant | FINAL · V2 |
| TITLE | CLASSIFICATION_POSITION (rank exactly 1) | entry participant | FINAL · V2 |
| PERFORMANCE_THRESHOLD | metric + operator + threshold | performer | FINAL · V2 (bowling walkthrough §8) |
| PERSONAL_BEST | metric + DisciplineVersion comparator + eligible prior set | athlete performer | OFFICIAL · V2 (matrix "PERSONAL best") |

**Deferred** (rejected by validation): STREAK, SEASON_TITLE, RANKING_MILESTONE, RECORD_SET (BRT-09) and QUALIFIED. A personal best is athlete-local. It is **not** a record: there is no RecordCategory, RecordMark or WORLD / NATIONAL / VENUE vocabulary.

## 4. Three lanes — impossible to confuse

| Lane | Facts come from | Persists? | Where |
|---|---|---|---|
| **CANONICAL PRODUCTION ASSEMBLY** | real canonical facts only (`AchievementService`) | yes, into the normal database | API, worker, seeds |
| **REFERENCE ENGINE FIXTURE** | typed in-memory snapshots (`@br/achievements/fixtures`, `provenance: REFERENCE_FIXTURE`) | **never** | unit tests, vectors, demo Part B |
| **REFERENCE PERSISTENCE FIXTURE** | in-memory fixture snapshots → the same validated writer | only in a **throwaway** `br_achfx_<hex>` database given the test-only overlay, dropped after use | fixture integration tests, demo Part C |

The normal schema rejects `REFERENCE_FIXTURE` with a database CHECK. There is no flag, environment variable, header or API that changes this (ADR-0037).

## 5. Real production reachability today

| Blocker | Why |
|---|---|
| `VERIFICATION_LEVEL_BELOW_REQUIRED` | BRT-07's honest ceiling is V1 (no `RESULT_OFFICIAL` / T5 producer, ADR-0035). Every BRT-08 type except EVENT_COMPLETED needs V2. |
| `RESULT_STATUS_BELOW_REQUIRED` | T5 / T6 (OFFICIAL / FINAL) are not implemented. Versions are SUBMITTED / PROVISIONAL at most. |
| `HOLD_STATE_UNAVAILABLE` | There is no Dispute / hold producer. The absence of a hold is never assumed (fail closed). |
| `CREDITED_LINEUP_UNAVAILABLE` | Result content has no `lineups` (ADR-0026). The declared `competition.lineup` is never read as a credit. |
| classifications below V1 | BRT-07 `DERIVED_INPUT_LEVELS` → INPUT_NOT_SUPPORTED |

**Therefore production honestly derives zero Achievements.** The demo (Part A) and the API tests prove that the rule *matches* the real facts (`wouldQualify = 1`) while every floor is reported unmet.

## 6. Public presentation

`br:public-achievement@1` contains: type and label, holder (TEAM with name, or ATHLETE through the Passport privacy policy), TEAM member credits (`creditType: TEAM_MEMBER`, never presented as holders), sport and discipline codes, competition / event names, qualifying value (formatted in the read layer only), verification **at derivation** ("Derived from a V2 Event Certified result"), rule code and version, and current support (ACTIVE / SUSPENDED / SUPERSEDED / REVOKED with fixed wording).

It never contains Person, Account or Auth ids, evidence, attestation ids, grants, keys or storage references. A restricted or private athlete appears only as "Private entrant", with no id. The Athlete Passport `verifiedAchievements` section is `AVAILABLE` and presents the read model: HOLDER items and TEAM_MEMBER items that reference the canonical TEAM Achievement.

## 7. BRT-09 boundary

BRT-08 produces recognition facts only. It has no RecordCategory / RecordMark, rankings, qualification decisions, PrizeEntitlement, payout, Trophy / NFT or chain minting. The guard, tests and demo assert this. BRT-09+ consume the dependency index (§ [dependency & corrections](./BRT-08-DEPENDENCY-AND-CORRECTIONS.md)).
