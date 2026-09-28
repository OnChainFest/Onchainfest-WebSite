# ADR-0005 — Criteria-based verification levels V0–V4

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

BRT-00 proposed the spectrum SELF_REPORTED, EVENT_VERIFIED, ORGANIZER_VERIFIED, FEDERATION_VERIFIED, DATA_PROVIDER_VERIFIED, MULTI_SOURCE_VERIFIED, MACHINE_VERIFIED, CANONICAL_RECORD. On analysis this mixes three dimensions:

- **issuer kind:** organizer, federation, provider, machine;
- **corroboration pattern:** multi-source;
- **consequence status:** canonical record.

It is not an ordinal scale. For example, MACHINE_VERIFIED is not "more" or "less" than FEDERATION_VERIFIED. The requirement also forbids vague labels without formal semantics.

## Decision

- **Five ordinal levels** with boolean criteria over evidence, attestation and authority. Each level includes all criteria of the levels below it:
  - **V0 CLAIMED:** the submitter only.
  - **V1 CORROBORATED:** an independent counterparty or official affirms; no counterparty denial.
  - **V2 EVENT_CERTIFIED:** primary evidence with integrity, plus an official declaration by a scoped, non-conflicted authority chained to any anchor (including the platform).
  - **V3 SANCTIONED:** V2, plus sanctioning by a non-platform anchor at REGIONAL level or higher, the full official evidence set, and identity confirmation.
  - **V4 RATIFIED:** V3, plus conditions compliance, at least two independent primary sources, and non-witnessed signatures. **Mandatory human ratification.**
- **Issuer kinds satisfy criteria; they are not levels.** Machine, provider and federation sources map onto criteria.
- **Generic AI-derived evidence** (`AI_DERIVED`) can never be the only primary evidence for V2 or above. This does not restrict machine-generated evidence from certified systems: registered `SYSTEM` principals with device-signed provenance, scoped grants, approved configuration, discipline-policy recognition and any required corroboration (verification model §2.6). The final machine-trust policy is deferred.
- **No numeric confidence at the level layer.** Machine attestations may carry a confidence, which criteria can threshold.
- **A downstream permission matrix** maps (status, level, hold) to allowed actions. It is a platform floor that competitions may raise, never lower. Status and level are independent requirements; meeting them *permits* an action and never *triggers* one. Prize payout in particular is executed only under explicit prize terms that declare the minimum level (platform floor V2), require FINAL status and require no active hold. No level by itself authorizes payment.

## Consequences

**Benefits:**

- Auditable ("missing: V3.sanction_attestation").
- The same model covers club, federation and record-grade events.
- Club events are not falsely inflated.

**Costs:**

- Policy versions must be governed, and per-discipline "primary evidence" and "official evidence set" definitions are required.

## Alternatives considered

- **BRT-00's 8-label spectrum as an enum:** rejected, because it is not ordinal (see Context).
- **Probabilistic trust score:** rejected. It is unauditable, gameable and legally awkward for prizes and records.
- **Per-consequence ad-hoc checks without levels:** rejected. That is inconsistent, and there is no shared vocabulary for display.
