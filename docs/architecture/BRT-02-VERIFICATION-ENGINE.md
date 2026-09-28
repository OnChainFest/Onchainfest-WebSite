# BRT-02 — Verification Engine

| Field | Value |
|---|---|
| Ticket | BRT-02 |
| Status | Proposed — for review |
| Implements | BRT-01 [Verification model §5–7](../domain/BRT-01-VERIFICATION-MODEL.md), [Disputes §4–5](../domain/BRT-01-DISPUTES-AND-CORRECTIONS.md) |
| Related | [Identity & authority §5](./BRT-02-IDENTITY-AND-AUTHORITY.md#5-authorization-engine), [Persistence §4.5](./BRT-02-PERSISTENCE-ARCHITECTURE.md#45-verification) |

This document is a design only. The engine is not implemented here.

---

## 1. Shape

```
evaluate(policy: VerificationPolicyVersion, inputs: VerificationInputs, evaluatedAt) → VerificationOutcome
```

- **A pure, deterministic function.** It does no I/O and reads no clock except the `evaluatedAt` parameter, which is used only to stamp the output. All time-dependent criteria use times *inside* the inputs (attestation `issuedAt`/`signedAt`, grant validity), never "now".
- **Policy pinning.** Each policy is a **versioned, content-addressed bundle**: a declarative criteria definition plus a hash of its code module. `policyHash` goes into every Verification row.
- **Deployment.** The engine runs in the worker. As a library it can also be packaged for external verifiers (federations, auditors), who recompute a level from exported inputs and compare it with the stored `inputsDigest`.

### 1.1 Inputs snapshot

```
VerificationInputs {
  resultVersion: { id, contentHash, status, disciplineVersionId, scopePath, derivedFrom[] }
  discipline:    { primaryEvidenceTypes[], officialEvidenceSet, ruleHooks, machineEvidencePolicy }   -- from DisciplineVersion
  evidence[]:    { id, type, blobHash, sourceKind, sourcePrincipalId, deviceId, configHash,
                   integrity { hashVerified, sourceSignatureVerified, capturedAtAssurance },
                   currentAssessment (AUTHENTIC | INTEGRITY_FAILED | MANIPULATED | …), role (PRIMARY | SUPPORTING),
                   availability (AVAILABLE | ARCHIVED | RESTRICTED | EXPIRED | DELETED_BY_RETENTION | DELETED_BY_ERASURE) }
  attestations[]:{ id, claimType, polarity, issuerPrincipalId, actingRole (declared), status (ACTIVE | REVOKED | SUSPECT | EXPIRED),
                   assurance, issuedAt, signedAt,
                   authority: AuthorizationDecision (re-evaluated "as known now") }
  sanctions[]:   COMPETITION_SANCTIONED attestations applicable to the event (+ authority)
  identity[]:    IDENTITY_CONFIRMED / ELIGIBILITY_CONFIRMED for relevant athletes
  conditions[]:  CONDITIONS_COMPLIANT (incl. device/system approvals keyed by configHash)
  holds:         active holds (informational; holds do not change level — BRT-01 disputes §1.3)
  derivedInputs[]: for classifications — the current level + status of each derivedFrom version
}
inputsDigest = H("verification-inputs", "verification-inputs@1", JCS(canonical projection of the above))
```

**What the digest covers.** The canonical projection for `inputsDigest` includes ids, hashes, statuses, and the authority decision *outcome and chain*. It does not include timestamps of the evaluation itself. Identical inputs therefore always produce the same digest, and recomputation with an unchanged digest is a no-op ([Persistence §7](./BRT-02-PERSISTENCE-ARCHITECTURE.md#7-idempotency-model)).

### 1.2 Output

```
VerificationOutcome {
  level: V0..V4
  criteriaMet[]:     e.g. ["V1.independent_affirm", "V2.primary_evidence", "V2.integrity", "V2.official_declaration", "V2.authority_chain"]
  criteriaMissing[]: e.g. ["V3.sanction_attestation", "V3.identity_confirmed:ath_…"]
  flags[]:           CONTRADICTING_ATTESTATION | AI_ONLY_EVIDENCE | LATE_EVIDENCE | SUSPECT_ATTESTER | OUTLIER_VALUE | MACHINE_UNAPPROVED_CONFIG
                     | EVIDENCE_UNAVAILABLE
  requiresHumanReview: boolean     -- V4 always; lower levels when flags demand
  explanation:       structured tree (criterion → inputs used) for UI and audits
}
```

The worker persists a `verification` row with `policyId`, `policyVersion`, `policyHash`, `inputsDigest`, `evaluatedAt`, `method = AUTOMATED`, and a `supersedes` link to the previous assessment. It then updates `result_version_state.current_verification_id` and `current_level`, and emits `VerificationChanged { from, to }` **only if the level or criteria changed**.

---

## 2. Criteria evaluation

Levels are evaluated bottom-up. The highest level whose criteria (and all lower levels' criteria) are met wins. Each criterion is a named predicate. Examples:

| Criterion id | Predicate (simplified) |
|---|---|
| `V1.independent_affirm` | ∃ attestation ACTIVE, AFFIRM, `RESULT_ACCURATE`, issuer ≠ submitter and issuer not on the submitter's side |
| `V1.no_counterparty_deny` | ¬∃ ACTIVE DENY from an opponent or participant |
| `V2.primary_evidence` | ∃ evidence with role PRIMARY, type ∈ discipline primary types, assessment ∉ {INTEGRITY_FAILED, MANIPULATED, WRONG_SUBJECT}, and **not all** such evidence is `AI_DERIVED` (E-4) |
| `V2.integrity` | For every PRIMARY evidence: `hashVerified` (at ingestion or a later integrity sweep), and `sourceSignatureVerified` if a signature is present |
| `E.availability` (policy parameter) | Per level and evidence role, the policy declares whether evidence must currently be `AVAILABLE`/`ARCHIVED` for the criterion to count. Unavailable evidence always raises `EVIDENCE_UNAVAILABLE`. See [Ingestion §2.4](./BRT-02-INGESTION-AND-ADAPTERS.md#24-evidence-availability-model). |
| `V2.official_declaration` | ∃ ACTIVE `RESULT_OFFICIAL` (or `RESULT_ACCURATE` + T5) whose authority decision is ALLOW for `DECLARE_OFFICIAL` or `ATTEST_RESULT` with no conflict |
| `V2.no_authorized_deny` | ¬∃ ACTIVE DENY with ALLOW authority of equal or higher precedence |
| `V3.sanctioned` | ∃ `COMPETITION_SANCTIONED` whose chain roots in an anchor with level ≥ REGIONAL (not PLATFORM) covering sport, region and event |
| `V3.chain_roots_in_sanctioning_anchor` | The certifying chain roots in the sanctioning anchor, or in one with equal or higher recognition |
| `V3.official_evidence_set` / `V3.identity_confirmed` | As BRT-01 §6 |
| `V4.conditions` / `V4.two_independent_sources` / `V4.non_witnessed_signatures` / `V4.ratification` | As BRT-01 §6. Human review is required (method becomes `HUMAN_REVIEWED` once `REVIEW_COMPLETED` or `RECORD_RATIFIED` exists). |
| `M.certified_system_evidence` (policy-optional) | Evidence from a SYSTEM principal with: registered device; `DEVICE_KEY` signature verified; ALLOW grant for the scope; ACTIVE `CONDITIONS_COMPLIANT` over the same `configHash` valid at `capturedAt`; type recognized by `machineEvidencePolicy` (BRT-01 §2.6) |

**Classifications** (BRT-01 R-6) have one additional criterion at every level ≥ V1: `derivedInputs.minLevel ≥ level`. A classification is never more verified than its weakest input.

---

## 3. Dependency index and targeted recomputation

### 3.1 Index

`verification_dependency(input_type, input_id, result_version_id)` is written whenever a Verification is computed, one row per input used:

| `input_type` | Examples of `input_id` |
|---|---|
| `EVIDENCE` | evidence item id |
| `ATTESTATION` | attestation id |
| `PRINCIPAL_KEY` | key id used by any counted attestation or evidence signature |
| `AUTHORITY_GRANT` | every grant in every counted authority chain |
| `TRUST_ANCHOR` | the anchors at the chain roots |
| `SYSTEM_CONFIGURATION` | `configHash` / approval attestation |
| `POLICY` | policy id (for opt-in policy upgrades) |
| `RESULT_VERSION` | `derivedFrom` inputs (for classifications) |
| `PARTICIPATION` | the participation-index entries used in conflict checks |

### 3.2 Triggers

| Domain event | Lookup | Effect |
|---|---|---|
| `AttestationIssued` | subject result version | recompute that version (and the index gains a row) |
| `AttestationRevoked` / `AttestationSuspect` | `(ATTESTATION, id)` | recompute dependents |
| `EvidenceAdded` / `EvidenceAssessed` / `EvidenceAvailabilityChanged` | subject links / `(EVIDENCE, id)` | recompute (historical assessments are untouched; a new one is appended) |
| `PrincipalKeyCompromised` | `(PRINCIPAL_KEY, id)` → attestations signed after t₀ are marked SUSPECT first | recompute dependents |
| `AuthorityGrantRevoked` (incl. cascade) | `(AUTHORITY_GRANT, id)` for each revoked grant | recompute dependents; the closure cache is invalidated first |
| `TrustAnchorChanged` | `(TRUST_ANCHOR, id)` | recompute dependents (potentially large; batched) |
| `ResultSuperseded` / `ResultRevoked` | `(RESULT_VERSION, id)` | recompute dependent classifications (which become stale) |
| `SystemConfigurationApprovalRevoked` | `(SYSTEM_CONFIGURATION, hash)` | recompute |
| `PolicyPublished` | competitions that opted in | batch recompute |

**Fan-out control.** Recompute jobs are deduplicated by `(result_version_id)` within a debounce window, and processed in **topological order**: contest results before their classifications. Large fan-outs (an anchor change) run as batched background jobs with progress tracking.

### 3.3 Moving down

When a recomputation lowers the level, the engine does not act on consequences itself. It emits `VerificationChanged { direction: DOWN, from, to, criteriaLost[] }`. The consequence modules then react per BRT-01 disputes §4–5:

- **Achievements** below their minimum become **SUSPENDED** (not revoked).
- **Record ratifications** in progress become blocked.
- **Prize entitlements** not yet paid become `HELD`.
- **Trophies**: issuance is blocked if still pending; issued trophies display via the achievement status.
- **Rankings** are recomputed in the next run.

Recovery works the same way. A later `VerificationChanged { direction: UP }` re-activates suspended artefacts by appending a status entry.

---

## 4. Human review

- **When review is needed.** When `requiresHumanReview` is true, the engine creates a `ReviewTask`: for V4, or when flags such as `SUSPECT_ATTESTER`, `OUTLIER_VALUE` or `MACHINE_UNAPPROVED_CONFIG` appear under policy.
- **Who reviews.** Reviewers are principals holding the relevant capability: `RATIFY_RECORD`, or a platform review capability for PLATFORM scope.
- **How the outcome enters the system.** The reviewer issues an attestation (`REVIEW_COMPLETED` / `RECORD_RATIFIED`). That attestation is an input like any other. **Reviews never set a level directly**, which keeps the engine the single writer of verification.

---

## 5. Determinism and reproducibility

| Risk | Mitigation |
|---|---|
| Non-deterministic ordering | All input collections are canonicalized (sorted) before evaluation and digesting |
| Clock dependence | No `now()` in predicates; time criteria use input timestamps |
| Policy code drift | The policy bundle is content-hashed; historical verifications are re-runnable with the pinned bundle |
| Authority "as known now" vs stored proof | The engine always re-evaluates authority from the bitemporal store; the stored `authorization_proof` is kept for audit comparison |
| External lookups | None inside `evaluate`; the loader gathers inputs beforehand, and the snapshot is what gets digested |

**Replay test.** For any stored `verification`, re-running `evaluate(policyBundle@policyHash, loadInputs(asOf = evaluatedAt))` must reproduce `inputsDigest` and `level`. This is run nightly on a sample as an integrity check.

---

## 6. Consequence engines (the same pattern)

Achievement derivation, record recognition, prize eligibility and trophy issuance follow the same design: pure rule functions over snapshots, content-hashed rule versions, idempotent natural keys, and triggering by `VerificationChanged`, `ResultFinalized` and hold changes. Each consequence checks the **BRT-01 permission matrix** (status, level, hold) at execution time, not only at scheduling time. Prize payout additionally requires the explicit PrizeTerms policy (BRT-01 verification model §7).
