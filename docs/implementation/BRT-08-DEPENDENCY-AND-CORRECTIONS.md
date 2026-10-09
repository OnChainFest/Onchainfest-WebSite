# BRT-08 — Dependency Index, Staleness and Corrections

| Field | Value |
|---|---|
| ADR | [0040](../adr/ADR-0040-achievement-status-history-and-corrections-by-supersession.md) |
| Accepted sources | BRT-01 disputes §3, §5.1 (achievement actions), §1.3 (holds), D-1, D-5; verification §8.1 status / statusHistory, AC-3 |
| Code | `packages/achievements/src/support.ts` (`assessSupport`), `packages/persistence/src/achievement-store.ts` (`appendStatus`, supersession, `dependencyIndex`, `canonicalSupportFacts`) |

## 1. Dependency index

`achievement.basis_item` is canonical, append-only and committed by the Achievement candidate itself. It is indexed by ResultVersion, by VerificationRun, and by (ResultVersion, participant, performance ordinal). It answers:

| Question | Query |
|---|---|
| Which Achievements depend on ResultVersion X? | `dependencyIndex({ resultVersionId: X })` |
| … on VerificationRun Y? | `dependencyIndex({ verificationRunId: Y })` |
| … on Performance Z = (X, participant, ordinal)? | `dependencyIndex({ resultVersionId, participantId, performanceOrdinal })` |
| … on classification version C? | `dependencyIndex({ resultVersionId: C })` (classifications are ResultVersions) |

It is exposed to staff at `GET /v1/result-versions/:id/achievement-dependents`. BRT-09+ (records, trophies, prizes) will consume it.

## 2. Current support: BRT-01 statuses as an append-only history

| Status | When (`assessSupport`, pure, hash-committed inputs) |
|---|---|
| ACTIVE | every basis version is current in status; the pinned VerificationRun is still the CURRENT run at or above the rule's level |
| SUSPENDED | verification STALE / NOT_EVALUATED / POLICY_UNAVAILABLE; pinned run no longer current; current level below the rule's level; or basis superseded and awaiting re-derivation |
| SUPERSEDED | a newer Achievement (same type / rule / holder / scope, new basis) replaced it — link in `achievement.supersession` |
| REVOKED | the basis ResultVersion is REVOKED, or it was superseded and the successor (gates passing) no longer qualifies this holder |

- **Terminal:** SUPERSEDED and REVOKED are terminal (BR124).
- **Reactivation:** SUSPENDED can return to ACTIVE, as a new entry (BRT-01: "automatically reactivated as a new status entry").
- **Holds:** an admitted hold adds the marker `UNDER_DISPUTE`. It changes no status, because BRT-01 §1.3 says a hold blocks *new* consequences.
- **Commitment:** each entry commits `support_facts_hash` to the canonical `br:achievement-support-facts@1` document it was assessed from, and is hash-chained on the ACHIEVEMENT ledger stream.

`AchievementCurrentStateChanged` is emitted when the status changes. It carries only ids and statuses, never PII.

"STALE", in the BRT-08 brief's sense, maps onto BRT-01's accepted vocabulary: SUSPENDED (temporarily unsupported), SUPERSEDED or REVOKED. No destructive lifecycle is introduced.

## 3. Behaviour by scenario (all tested)

| Scenario | Result |
|---|---|
| Correction still qualifies (fixture: rv2 supersedes rv1) | NEW Achievement with the rv2 basis; supersession link; old one SUPERSEDED; old row byte-identical |
| Correction changes the credited lineup | NEW TEAM Achievement with the corrected credits; old credits untouched; old one SUPERSEDED |
| Correction flips the winner | new holder gets a new Achievement; old one REVOKED (`HOLDER_NO_LONGER_QUALIFIES`) |
| Revocation of the basis | old one REVOKED (`BASIS_RESULT_REVOKED`); row kept; no replacement; terminal |
| Key compromise → current verification V1 | SUSPENDED (`VERIFICATION_RUN_NO_LONGER_CURRENT` / `…LEVEL_BELOW_REQUIRED`); no deletion; recovery appends ACTIVE |
| Verification upgrade V1 → V2 | V1: blocked, nothing issued; later CURRENT V2 derives the Achievement exactly once, pinning the new run; `recordedAt` is the real issuance time (never backdated) |
| New run on the same version, still qualifying | NEW Achievement pinning the new run; the previous one is SUPERSEDED (continuity) |
| Rule v2 published | v1 Achievements untouched; results submitted under the v2 binding derive under v2 |

## 3a. Staleness propagation (BRT-08R, [ADR-0042](../adr/ADR-0042-achievement-consumes-verification-read-only-and-live-current-support.md))

Rule: **if the pinned VerificationRun is no longer CURRENT, the Achievement is not presented as currently supported**, even before a replacement run exists. The historical fact is untouched. Two mechanisms enforce it; neither needs a manual request.

1. **Live at read time:** public detail and the Passport re-assess every non-terminal canonical Achievement from live canonical facts (BRT-07 hash-based freshness of the pinned run). A failure to assess is presented as not current.
2. **Event-driven recording:** the worker re-assesses on every staleness-causing canonical event:
   - key status change (compromise);
   - grant issued / revoked;
   - anchor recognized / changed;
   - evidence added / attached / derived / availability / privacy;
   - attestation issued / retracted / superseded;
   - policy bound;
   - verification evaluated;
   - result submitted (supersession).

   It appends a status entry only on change, so replay is idempotent.

Tested (fixture persistence lane, pinned run made STALE with no new run):

| Step | Status |
|---|---|
| live view | SUSPENDED |
| sweep | SUSPENDED (`VERIFICATION_STALE`); replay: no change |
| rebuild | still SUSPENDED; row byte-identical |
| same run CURRENT again | ACTIVE |
| new CURRENT V2 run | SUSPENDED until re-derivation creates the replacement, which SUPERSEDES it |
| new CURRENT V1 | stays SUSPENDED; nothing issued |

On real data, the canonical test shows the worker login seeing its pinned run turn STALE right after a new attestation.

## 4. Canonical triggers

- **Correction:** re-derivation of a version re-assesses the Achievements whose basis is that version or its predecessor (`supersedes_version_id`).
- **Worker:** re-assesses on verification, key, grant, anchor, attestation, evidence and policy events.
- **Staff:** can request a re-assessment (`POST /v1/achievements/:id/support-assessments`).
- **Canonical facts:** canonical support facts are recomputed from live data and BRT-07 freshness. A CANONICAL_ASSEMBLY support-facts document supplied by a caller is refused unless it equals that recomputation.

## 5. What is not possible today (honestly)

T7 / T8 (SUPERSEDED / REVOKED transitions) have no general producer.

- **Supersession** is visible canonically through `result_version.supersedes_version_id` when a correcting version exists.
- **Revocation** has no canonical representation yet.
- **Fixture overlay:** both are therefore exercised through typed REFERENCE_FIXTURE support facts in the throwaway fixture database (ADR-0037). Nothing is ever written to the Result ledger.
