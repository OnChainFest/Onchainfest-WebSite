# ADR-0047 — Classifications are derived ResultVersions, proposed by a pure engine and submitted only through the ResultLedger

- **Status:** Proposed
- **Date:** 2026-10-01
- **Origin:** BRT-10 read-first decisions 1 and 2 (BRT-01 result domain §5.2–5.3, §6.1, R-6, R-7; disputes §2.3.5; ADR-0003 §5; ADR-0008; BRT-02 persistence L113)

## Context

BRT-01 makes standings and final classifications **Results**: *"a classification is a ResultVersion whose `derivedFrom` pins the exact contest result versions it was computed from"* (§6.1). It is *"itself a claim that needs authority, attestation and dispute handling"*, and it becomes stale when an input is superseded (ADR-0003 §5, R-6). The legacy anti-pattern it replaces is standings computed by a trigger with no provenance (`update_player_standings`).

The code already supports some of this and is missing the rest:

- `results.result.scope_type` already admits `ROUND_CLASSIFICATION | EVENT_CLASSIFICATION | COMPETITION_CLASSIFICATION`, and the hierarchy validator maps each scope to its target.
- `br:result-version-content@1` is closed to `entries` and `performances`. It has no `derivedFrom` or `derivationRuleId`.
- Only T2/T3/T4 exist. There is no producer for T5 (OFFICIAL), T6 (FINAL), T7 (SUPERSEDED by correction) or T8 (REVOKED). A second PROVISIONAL version for the same Result is refused with `CURRENT_VERSION_CONFLICT` ("supersession requires a correction").
- BRT-07's `DERIVED_INPUT_LEVELS` criterion is `INPUT_NOT_SUPPORTED`, so a classification never passes V1.

## Decision

1. **A classification is a ResultVersion and nothing else.** BRT-10 adds no `standing`, `rank` or `position` field to any athlete, participant, entry or team row. It adds no standings table that could act as truth, and no trigger that computes standings.
2. **Provenance lives in the content.** A new closed content schema, `br:result-version-content@2`, is `@1` plus a required `derivation` member:
   - `derivedFrom[]`: `{resultVersionId, contentHash, status}` for every input version;
   - `policy`: `{policyId, policyVersionId, specHash}` (the ClassificationPolicy, ADR-0049);
   - `disciplineVersionId`;
   - `engineVersion`;
   - `inputsDigest`.

   `@1` is unchanged, and CONTEST results keep using it. `derivedFrom` is a set; the canonicalizer sorts it, so input order cannot change the hash. Raw input content is never copied; only the ranked values the comparator used appear, as `tieBreakKeys` on each entry (BRT-01 §6.2).
3. **The engine proposes, an authority submits.** The pure function `deriveClassification(snapshot)` (in `@br/rankings`) returns the proposed `@2` content, its hash and blockers. It is **never** written by the platform on its own authority. The only way in is the existing ResultLedger T2 (`submitDraft`):
   - The submitter must hold `SUBMIT_RESULT` for the classification's scope. This is the existing authority check, unchanged.
   - For `@2` content the ledger **re-assembles the canonical inputs and re-runs the engine** inside the submitting transaction, and refuses any byte difference (`CLASSIFICATION_DERIVATION_MISMATCH`). A client therefore cannot submit an arbitrary ranking dressed up as a derivation.
   - Acceptance (T3) still requires `ACCEPT_RESULT`. BRT-10 adds no lifecycle transition.
4. **Inputs are admitted only by declared policy.**
   - The inputs are the **current** versions of the Results in the classification's scope, as resolved by the explicit competition hierarchy (ADR-0025), at or above the policy's declared minimum status.
   - The platform minimum is PROVISIONAL, because standings are operational (ADR-0008, permission matrix row "Live standings").
   - SUPERSEDED, REVOKED, REJECTED and SUBMITTED inputs are never admitted.
   - A missing required input blocks the whole derivation. The engine never produces a partial table.
5. **Staleness is computed, never assumed.** A submitted classification version is **STALE** when either of these holds:
   - any pinned input is no longer the current version of its Result (superseded, revoked, or replaced);
   - the scope's current admissible input set differs from the pinned set, for example because a new contest result was accepted.

   Staleness is evaluated at read time and by the worker, which emits `ClassificationStale` (BRT-02 system architecture §11). It is idempotent per (classification version, stale-reason digest). It is never written into the classification version, because R-1 makes that immutable.

   Clarified in Step 7 (by decision): the admissible set is evaluated under the classification's **pinned** policy version and DisciplineVersion, so rebinding the scope's policy is not a stale condition. Unknown state is affected: an unreadable pin, or a scope that cannot be re-assembled, reads STALE (`ADMISSIBLE_INPUT_SET_UNKNOWN`).
6. **Replacement stays blocked.** Superseding a current classification version is a T7 correction (disputes §2.3.5), which has no producer. A re-derived proposal for a Result that already has a current version is refused, with the existing `CURRENT_VERSION_CONFLICT` reported as `CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION`. The stale version stays current and is visibly flagged STALE. BRT-10 does not add a narrow T7 or a new correction type.
7. **No change to verification semantics.** `DERIVED_INPUT_LEVELS` stays `INPUT_NOT_SUPPORTED`. A classification is never more verified than BRT-07 says, so today it tops out at V0. Recognition consequences that require a classification at V2 or above are therefore reachable only in throwaway fixture databases.
8. **Operational only, and no progression.**
   - A classification is not a qualification (ADR-0050).
   - It never writes `ResultEntry.advancement`.
   - It never resolves dependency slots (`WINNER_OF`, `RANK_FROM_STAGE`) or seeds the next round. That work stays deferred with BRT-05 progression (ADR-0024).

## Consequences

- Every standing can answer which inputs, which policy, which comparator and which hash produced it, and whether it is still current.
- Production can hold real PROVISIONAL standings, provided someone with `SUBMIT_RESULT` submits them. It cannot hold OFFICIAL or FINAL classifications until T5/T6 producers exist.
- A stale classification cannot be replaced until a correction producer exists. This is visible and honest; nothing is silently rewritten.
- `@1` classification versions that predate BRT-10 carry no `derivation`. Consumers report `CLASSIFICATION_PROVENANCE_UNAVAILABLE` for them and never treat them as derived.

## Alternatives considered

- **Platform worker submits classifications as itself.** Rejected: the platform would be asserting a result claim.
- **Live standings projection only.** Rejected: weaker than ADR-0003 §5, and not a claim that can be disputed.
- **Narrow T7 for classifications.** Rejected for BRT-10 by decision. It would touch the BRT-03 lifecycle and need a correction type BRT-01 does not list.
- **Storing `stale` on the version.** Rejected: it would break R-1.
