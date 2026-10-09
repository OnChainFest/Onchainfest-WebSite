# ADR-0027 — Explicit Person ↔ PERSON Principal mapping and account → issuer representation

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-06 (BRT-02 identity & authority §1–3; ADR-0021)

## Context

Attestations are signed by Principals, but people authenticate as Accounts. Organizations already had an explicit ORGANIZATION principal (BRT-04); persons had none. Collapsing Account, Person and Principal (e.g. `Person.id = Principal.id`) would leak identity, break erasure and let application roles masquerade as signing identities. Guardians control dependents for some operations, which must not extend to cryptographic signing.

## Decision

1. **`identity.person_principal`** maps a Person to exactly one PERSON principal (composite FK enforces the type; never the same id; append-only). It is created only by `identity.ensure_person_principal(account, person)`: SECURITY DEFINER, fixed `search_path`, EXECUTE for `br_identity` only, SELF control by an ACTIVE account required, idempotent, returns the principal id or NULL. `br_identity` receives no authority-table grant. The principal label is the non-PII constant `person-principal`; its fact hash is computed in SQL and tested equal to the TypeScript canonicalizer.
2. **`authority.account_principal_representation(account, principal)`** is the single representation decision: `PERSON_SELF` (own PERSON principal) or `ORGANIZATION_ADMIN` (ACTIVE OWNER/ADMIN of the ACTIVE organization), else NULL. It takes shared advisory locks with account disabling and roster changes, and is evaluated inside the command transaction at prepare and again at submit.
3. **Guardians never represent a dependent's principal.** A guardian signs, if at all, as their own principal. No agency/delegation model exists in BRT-06.
4. **Representation is an application permission, not sporting authority.** It never implies `ATTEST_RESULT` or any Capability; the Authority Engine alone decides that (BRT-07).

## Consequences

- Clear separation Account ≠ Person ≠ Principal; person principals appear publicly only as an opaque "Individual signer".
- A future delegation model (e.g. "signs on behalf of") must be a new, explicit decision.
- SYSTEM/PLATFORM principals remain unrepresentable by accounts until adapters exist.

## Alternatives considered

- **Reuse Person.id as Principal.id:** rejected (identity leakage, erasure).
- **Grant `br_identity` INSERT on `authority.principal`:** rejected (broad cross-context write; BRT-04/05 precedent is narrow functions).
- **Guardian signs as dependent:** rejected (impersonation; no consent/delegation model).
