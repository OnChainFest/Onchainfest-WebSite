# BRT-07 — Authority Evaluation inside the Oracle

| Field | Value |
|---|---|
| Builds on | BRT-03 [authority engine §4](./BRT-03-FOUNDATION.md#4-authority-engine-behaviour) (unchanged), BRT-05 [authority hierarchy](./BRT-05-AUTHORITY-HIERARCHY.md), BRT-06 [attestation protocol §6–7](./BRT-06-ATTESTATION-PROTOCOL.md), BRT-02 [signatures §5.1](../architecture/BRT-02-SIGNATURES-AND-HASHING.md) |
| Code | `packages/verification/src/context.ts` (`EvaluationContext`), `packages/verification/src/assemble.ts` (`verifyStoredIntegrity`), `packages/authority` (unchanged) |

## 1. Four separate judgements

| Judgement | Where | Question |
|---|---|---|
| Signature validity | assembler (`verifyStoredIntegrity`) | Does the stored statement re-hash to its statement hash, and does the stored JWS proof verify with the stored public key material (and match the bundle's proof hash)? Any "no" is `VERIFICATION_INTEGRITY_FAILURE` — never a criterion failure. Retraction statements are re-verified the same way. |
| Key trust | engine (`EvaluationContext.keyTrust`) | Is the key the issuer's, valid at the platform-observed `issuedAt`, and not revoked/rotated (effective ≤ T) or compromised (t₀ ≤ T **or** t₀ ≤ `signedAt`) per the status facts known at the cutoff? → TRUSTED / SUSPECT / INVALID |
| Sporting authority | engine (BRT-03 `authorize` over snapshot facts) | Was the issuer authorized for capability C over the result's resolved hierarchy at T, as known at the cutoff, with a CLEAR conflict check? |
| Verification level | engine (criteria) | Do the criteria of each level hold? |

A cryptographically valid attestation by an issuer without authority contributes nothing to V2+ (it may still be a V1 counterparty corroboration, which needs no authority). Only signed facts that are ACTIVE **and** key-TRUSTED count at all.

## 2. Temporal semantics

- **Effective time T** = the fact's platform-observed `issuedAt` (attestations) or `recorded_at` (a T5 transition). `signedAt` never admits anything; it can only make a compromise apply.
- **Knowledge cutoff** = the snapshot's `asOf` (facts with `recordedAt ≤ asOf`). CURRENT evaluations use the transaction's database time, so every retroactive compromise or compromise-revocation recorded so far applies ("as known now"); a historical replay at T excludes facts recorded later ("as known then").
- **No back-authorization.** A grant's `effectiveFrom ≥ recordedAt` (BRT-03 strict no-backdating, unchanged); validity windows are checked at T, so a grant recorded after an attestation can never authorize it (`GRANT_NOT_VALID_AT_TIME`; tested in the engine and with real grants).
- **Revocation.** Ordinary revocation is prospective: an attestation issued before it stays authorized (the snapshot hash still changes, so the run becomes STALE and a re-run shows the same level). Compromise revocation is retroactive to its `effectiveFrom` (tested in both forms). Revocation of a parent grant breaks the chain at the same instant (BRT-03 chain re-walk).
- **Keys.** `compromisedSince` is carried explicitly in the snapshot; `KEY_COMPROMISED` makes the fact SUSPECT (flag `SUSPECT_ATTESTER`), `KEY_REVOKED` / `KEY_NOT_VALID_AT_ISSUANCE` make it INVALID. History is never rewritten: the stored attestation and every earlier run are unchanged; a new current run reflects the new key trust.

## 3. Scope and hierarchy

The request scope is the result's full resolved path from `competition.resolve_scope_path` (BRT-05; never inferred from ids, slugs or prefixes) as singleton sets, plus an explicit recognition level. BRT-03's exact containment applies unchanged: a grant scoped to competition C1 covers C1's events / rounds / contests and nothing in a sibling competition (`SCOPE_NOT_COVERED`; tested with real grants and in the demo).

**Recognition level is never inferred.** Every valid chain's root grant constrains `recognitionLevel` (the anchor's recognition scope requires it), so the engine asks explicitly:

| Criterion | Levels tried |
|---|---|
| V2 declaration / T5 actor, V2 authorized DENY, V3 identity, V4 conditions (V1 needs **no** authority: a registered official is a structural fact) | every level in fixed order CLUB → REGIONAL → NATIONAL → CONTINENTAL → WORLD → PLATFORM ("a chain from any anchor", BRT-01 V2); the first authorization is used |
| V3 sanction | exactly the recognition level the `COMPETITION_SANCTIONED` fact declares; must be ≥ policy minimum and never PLATFORM |
| V3 certification root | levels ≥ the sanction's level (non-platform), or the sanction's own anchor |
| V4 ratification | exactly the record category's recognition level |

The PLATFORM principal may only anchor the PLATFORM level and nobody else may claim it (BRT-03 `ANCHOR_LEVEL_FORBIDDEN`), so a platform-only chain can never impersonate NATIONAL / CONTINENTAL / WORLD recognition — a structural invariant no policy can override. `RecognitionLevel` ranks (CLUB < REGIONAL < NATIONAL < CONTINENTAL < WORLD; PLATFORM incomparable) are computed by `recognitionRank` and are never compared with `VerificationLevel`.

## 4. Conflict of interest

The engine supplies BRT-03 with a snapshot-backed `ConflictOfInterestChecker` (`verification-snapshot-participation/1`):

| Participation of the principal | Answer |
|---|---|
| not resolvable (e.g. a PERSON principal without Person mapping) | `UNAVAILABLE` → `CONFLICT_CHECK_UNAVAILABLE` (fail closed) |
| a prohibited relation (BRT-01 rule 7: SELF_PARTICIPANT, TEAM_MEMBER_OF_PARTICIPANT, LINEUP_MEMBER_OF_PARTICIPANT — plus the policy's `additionalProhibitedRelations`) | `CONFLICTED` → `CONFLICT_OF_INTEREST` |
| no side relation while some contest slot is unresolved (not PLATFORM/SYSTEM) | `UNAVAILABLE` |
| otherwise | `CLEAR` |

BRT-03R's rule is unchanged: every capability except `SUBMIT_RESULT` is conflict-sensitive. The difference from BRT-03–06 is that BRT-07 **supplies real participation data**, so conflict-sensitive authority is decided (CLEAR / CONFLICTED) instead of always failing closed. A participant who also holds a grant counts only as a participant (A-5).

## 5. Authority trace

Every authority-dependent criterion records, per decision: issuer principal, fact id, capability, requested recognition level, effective time, authorized, reason (BRT-03 vocabulary: `NO_GRANT_FOR_CAPABILITY`, `SCOPE_NOT_COVERED`, `GRANT_NOT_VALID_AT_TIME`, `GRANT_REVOKED`, `CHAIN_BROKEN`, `ANCHOR_*`, `CONFLICT_OF_INTEREST`, `CONFLICT_CHECK_UNAVAILABLE`, `KEY_*`), anchor id and its recognition levels, the grant chain (leaf → root), the conflict status and the BRT-03 proof digest. Criterion-level reasons add `RECOGNITION_TOO_LOW`, `RECOGNITION_PLATFORM_CEILING`, `CERTIFICATION_NOT_ROOTED`, `RATIFIER_NOT_HUMAN`. When no level authorizes, the trace keeps the most specific attempt per capability. The internal trace (grant and principal ids) is staff-only; public DTOs never contain authority topology.
