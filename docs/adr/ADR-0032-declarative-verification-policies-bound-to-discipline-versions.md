# ADR-0032 — Declarative, versioned verification policies bound to exact DisciplineVersions

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-07 (ADR-0005; BRT-01 §6; BRT-02 verification §1)

## Context

BRT-02 describes a "content-addressed policy bundle… plus a hash of its code module". Executable policies are hard to audit and to reproduce; BRT-01 levels must be implemented exactly while competitions may only raise requirements.

## Decision

1. A policy is **data** (`br:verification-policy@1`): per level, a conjunctive list of criteria from a closed vocabulary with bounded parameters. No expressions, scripts, SQL, plugins or nested boolean trees. Unknown kinds / members are rejected.
2. Validation enforces an unbroken level chain from V0, BRT-01's mandatory criteria per defined level, parameter applicability and bounds. Policies may raise requirements, never lower them; structural invariants (E-4, platform recognition ceiling, rule-7 conflicts, non-witnessed V4 signatures, cumulative levels) live in the engine.
3. `VerificationPolicy` (stable code) → immutable `VerificationPolicyVersion` (spec + hash + target engine) → append-only lifecycle DRAFT → PUBLISHED → RETIRED.
4. Only PUBLISHED versions are bound, to an **exact DisciplineVersion**, by append-only bindings that are never backdated and take effect strictly after the previous one (no ambiguous overlap). No policy applies without a binding: `POLICY_UNAVAILABLE`, no fallback.
5. Policy mutation happens only on a dedicated operator login (`br_verification_operator_app` → `br_verification_policy`).

## Consequences

The "code" part of BRT-02's bundle is the engine semantic version (`verification-engine/N`) pinned on every run; the policy spec hash pins the data part. Costs: new criterion kinds require an engine version.

## Alternatives considered

- **Executable policy modules:** rejected (unauditable, non-reproducible, injection surface).
- **Binding to sports or mutable disciplines:** rejected (rules change with DisciplineVersions; BRT-01 O-1).
