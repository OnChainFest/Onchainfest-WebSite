# BRT-07 — Verification Policy

| Field | Value |
|---|---|
| ADR | [0032](../adr/ADR-0032-declarative-verification-policies-bound-to-discipline-versions.md) |
| Code | `packages/verification/src/policy.ts` (model, validation, reference policy), `packages/schemas/src/verification.ts` (`br:verification-policy@1`), `packages/persistence/src/verification-store.ts` (`VerificationPolicyStore`), `db/migrations/0013_verification_policy.sql` |

## 1. Model

```
VerificationPolicy        { id, code (stable, ^[a-z0-9][a-z0-9-]{1,63}$), name, createdBy, recordedAt }       class A
VerificationPolicyVersion { id, policyId, version (1, 2, …), spec, specSchema, specHash, targetEngine, recordedAt } class A, immutable from creation
PolicyVersion lifecycle   DRAFT (no status fact) → PUBLISHED (once) → RETIRED                                class A facts
PolicyBinding             { disciplineVersionId, policyVersionId, effectiveFrom ≥ recordedAt, seq }           class A, append-only
```

`specHash = H("verification-policy", br:verification-policy@1, JCS(spec))` — same semantic policy (any member / set order) ⇒ same canonical bytes ⇒ same hash (vector `policy/reference-keys-and-sets-reordered`).

## 2. The spec is data, never code

```json
{
  "targetEngine": "verification-engine/1",
  "levels": [
    { "level": "V0", "requiresPreviousLevel": false, "criteria": [{ "id": "v0.claim-bound", "kind": "CLAIM_BOUND" }] },
    { "level": "V1", "requiresPreviousLevel": true, "criteria": [
        { "id": "v1.independent-corroboration", "kind": "INDEPENDENT_CORROBORATION", "params": { "minIssuers": 1 } },
        { "id": "v1.no-counterparty-deny", "kind": "NO_COUNTERPARTY_DENY" } ] }
  ],
  "conflict": { "additionalProhibitedRelations": ["TEAM_MANAGER_OF_PARTICIPANT"] }
}
```

- Closed BR-JSON schema: unknown members, nulls, floats, non-canonical strings and unknown enum values (criterion kinds, capabilities, recognition levels, relations) are rejected. There is no expression, script, SQL, plugin, `eval` or nested boolean tree; "at least N of X" is a bounded parameter of one criterion.
- Bounds: ≤ 5 levels, ≤ 16 criteria per level, ≤ 4 capabilities, bounded integers (`minIssuers` 1–16, `minItems` 1–16, `minSources` 2–16), criterion ids `^[a-z0-9][a-z0-9._-]{0,63}$`, canonical text ≤ 16 KiB, stored JSON ≤ 32 KiB.
- All criteria of a level are **conjunctive**.

## 3. Criterion vocabulary (closed)

| Level | Mandatory (BRT-01 floor) | Parameters |
|---|---|---|
| V0 | `CLAIM_BOUND` | — |
| V1 | `INDEPENDENT_CORROBORATION`, `NO_COUNTERPARTY_DENY` | `minIssuers` |
| V2 | `PRIMARY_EVIDENCE`, `PRIMARY_EVIDENCE_INTEGRITY`, `NO_INVALIDATING_ASSESSMENT`, `OFFICIAL_DECLARATION`, `NO_AUTHORIZED_DENY` | `minItems`, `availability` ⊆ {AVAILABLE, ARCHIVED}; `capabilities` ⊆ {ATTEST_RESULT, DECLARE_OFFICIAL} |
| V3 | `COMPETITION_SANCTIONED`, `CERTIFICATION_ROOTED_IN_SANCTION`, `OFFICIAL_EVIDENCE_SET`, `IDENTITY_CONFIRMED` | `minRecognitionLevel` ∈ {REGIONAL, NATIONAL, CONTINENTAL, WORLD} |
| V4 | `CONDITIONS_COMPLIANT`, `INDEPENDENT_PRIMARY_SOURCES`, `NON_WITNESSED_SIGNATURES`, `RECORD_RATIFIED` | `minSources` ≥ 2 |
| V1–V4 (optional, stricter) | `NO_ACTIVE_DISPUTE` | — |

The prompt's illustrative primitives map as follows: `RESULT_CLAIM_PRESENT` → `CLAIM_BOUND`; `MIN_ACTIVE_CONFIRMATIONS` / `MIN_INDEPENDENT_CONFIRMING_ISSUERS` → `INDEPENDENT_CORROBORATION(minIssuers)`; `MIN_EVIDENCE_ITEMS` / `EVIDENCE_AVAILABILITY` / `EVIDENCE_TYPE_PRESENT` / `REQUIRE_NON_AI_SUPPORT` → `PRIMARY_EVIDENCE(minItems, availability)` with the discipline's primary types and the non-bypassable E-4 rule; `AUTHORIZED_ATTESTATION` / `MIN_AUTHORIZED_ISSUERS` → `OFFICIAL_DECLARATION`, `CONDITIONS_COMPLIANT`, `IDENTITY_CONFIRMED`, `RECORD_RATIFIED`; `MIN_AUTHORITY_RECOGNITION` → `COMPETITION_SANCTIONED(minRecognitionLevel)` + `CERTIFICATION_ROOTED_IN_SANCTION`; `CANONICAL_FACT_PRESENT` → the fact-kind support rule (`INPUT_NOT_SUPPORTED`); `NO_ACTIVE_DISPUTE` kept; `NO_PROHIBITED_CONFLICT` → the conflict rule applied inside every authority evaluation (`conflict.additionalProhibitedRelations`), because BRT-01 attaches conflicts to authority (§4.5 rule 7), not to a free-standing criterion. `RESULT_STATUS_ALLOWED` is deliberately **absent**: status and level are independent (BRT-01 §7).

## 4. Validation (before a version row can exist, and again at publication)

Rejected: missing V0 (`LEVEL_V0_MISSING`); a gap (`LEVEL_ANCESTRY_BROKEN`); `requiresPreviousLevel` false above V0 (`ANCESTRY_REQUIRED`); duplicate levels (`BRJ_SET_DUPLICATE[_KEY]`); duplicate criterion ids or kinds; a criterion at the wrong level (`CRITERION_NOT_ALLOWED_AT_LEVEL`); a missing mandatory criterion (`MANDATORY_CRITERION_MISSING:<KIND>`); a parameter a kind does not take (`PARAM_NOT_ALLOWED`); an out-of-set capability (`CAPABILITY_NOT_ALLOWED`); impossible counts (`BRJ_SCHEMA_CONSTRAINT`); an unsupported `targetEngine`; oversize. The API returns fixed issue codes and sanitized JSON pointers — never echoed values.

A policy may **raise** requirements (higher counts, narrower capabilities or availability, `NO_ACTIVE_DISPUTE`, extra conflict relations, a prefix V0…Vn) but never lower BRT-01: every defined level carries its mandatory criteria and structural invariants (E-4, platform recognition ceiling, rule-7 conflicts, non-witnessed V4 signatures, cumulative levels) live in the engine.

## 5. Lifecycle, binding and history

- Versions are immutable from creation (append-only triggers, including the owner). Publication is a status fact (`BR090` refuses anything but DRAFT → PUBLISHED → RETIRED; `UNIQUE(policy_version_id, status)`). The stored spec is re-validated and re-hashed at publication.
- A binding ties a **PUBLISHED** version (`BR091`) to an **exact DisciplineVersion** — never a sport, a mutable discipline or a name. `effective_from ≥ recorded_at` (CHECK; strict, no skew → `BACKDATING_REJECTED`) and strictly after the previous binding of that DisciplineVersion (`BR092`, under an advisory lock) — so two bindings can never apply at the same instant, even under concurrency (tested with 10 concurrent binds).
- The policy applicable at T = the latest binding with `effective_from ≤ T` and `recorded_at ≤ T`, whose version is PUBLISHED and not RETIRED at T. **No fallback**: no binding → `POLICY_UNAVAILABLE`.
- Old runs stay pinned to the version they were evaluated under; a new binding makes the latest run STALE for current presentation while it remains valid history ("evaluation under policy X vN").

## 6. Operator isolation

Policy mutation runs only on the dedicated login `br_verification_operator_app` → `br_verification_policy` (`BR_VERIFICATION_OPERATOR_DATABASE_URL`, opt-in; no fallback to `br_api`, which cannot assume that role). Without it: INTERNAL policy routes answer `503 INTERNAL_CAPABILITY_UNAVAILABLE` (audited), while reads and evaluations keep working. Non-operators get 403 (audited `verification.policy-*-denied`). `br_verification_policy` can create/publish/retire/bind and read exact DisciplineVersions — it cannot create runs or read results, evidence, attestations, authority, competition or PII. The BRT-05 catalog operator is not a policy operator.

## 7. The fictional development reference policy (`br-dev-reference`)

Seeded by `pnpm db:seed:verification` and used by the demo. It is **not** a universal truth standard. It states BRT-01's floor for V0–V4 plus two documented stricter choices:

1. `NO_ACTIVE_DISPUTE` at V2, V3 and V4 — any active dispute claim blocks certification-grade levels (BRT-01 alone would let a certified result reach V2 despite a participant's DENY);
2. `TEAM_MANAGER_OF_PARTICIPANT`, `GUARDIAN_OF_PARTICIPANT` and `TEAM_AFFILIATED_ORGANIZATION` are conflicts in addition to BRT-01 rule 7.

With real data it reaches V1 at most (see [model §4](./BRT-07-VERIFICATION-MODEL.md#4-real-production-ceiling-today)).
