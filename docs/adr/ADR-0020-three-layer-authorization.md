# ADR-0020 — Three-layer authorization with a bitemporal domain authority engine

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02 (implements BRT-01 ADR-0004)

## Context

The legacy code relied on `isAdmin`-style checks, unsigned tokens and permissive RLS (BRT-00 C-3, C-4, H-2, H-5). BRT-01 defines authority as scoped, delegated, time-bounded grants from trust anchors, with conflict-of-interest rules. Authority must also be answerable historically: "was X authorized at T?".

## Decision

1. **Three layers with distinct purposes:**
   - **DB RLS and privileges:** defense in depth; deny-all; per-module roles; PII vault isolation.
   - **Application authorization:** account, session, org-membership RBAC, ownership and guardianship, for endpoints and screens.
   - **Domain Authority Engine:** `authorize(principal, keyId, capability, scopeRef, atTime, asOf)`, which returns a decision plus a proof chain.
2. **RBAC never substitutes for the Authority Engine** on any trust-layer action.
3. **The authority store is bitemporal.** It holds valid time and transaction time for grants, keys and anchors, and their status changes. The default evaluation is "as known now", so retroactive compromise takes effect. "As known then" is available for audit.
4. **Evaluation** walks grant chains to trust anchors, checking scope narrowing, delegable capabilities, depth, validity, key status and a participation-index conflict check. A disposable **closure cache** keeps it fast.
5. **Proofs.** Authorization proofs are persisted at acceptance. Verification always re-evaluates rather than trusting stored proofs.
6. **The engine is a pure package**, so it can be published for third-party verifiers. It is also exposed via `GET /v1/authorization:check`.

## Consequences

**Benefits:**

- Organizer self-certification and grant escalation are structurally prevented.
- Decisions are explainable and historical.

**Costs:**

- More complex than RBAC. The engine requires extensive property-based tests.
