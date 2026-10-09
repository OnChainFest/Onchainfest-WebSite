# ADR-0021 — Explicit Account→Person control; person-keyed memberships

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-04 (refines BRT-02 `BRT-02-IDENTITY-AND-AUTHORITY.md` §1–2)

## Context

BRT-02 models `Account.person_id` and `OrganizationMembership(account_id, dashboard roles)`. BRT-04 needs three more things:

- a guardian (an account) must act for a dependent person who has no account;
- memberships must also describe athlete affiliations (ATHLETE, COACH, …) shown on passports;
- a guardian must be able to accept invitations on a dependent's behalf.

Keying memberships on accounts would make a dependent's club affiliation belong to the parent's account.

## Decision

1. **Control is an explicit relation.**
   - `identity.account_person_control(account_id, person_id, control_kind)`. BRT-04 implements only `SELF`: at most one per account and one per person.
   - **Guardian control is derived, never stored.** It requires an ACTIVE guardian relationship plus the guardian account's SELF control.
   - A single policy function (`canOperateOnPerson`) decides every person operation. Guardians cannot see private data or link wallets.
2. **Guardian relationships are asserted, then confirmed.** PENDING grants nothing. ACTIVE requires a recorded confirmation basis.
3. **Memberships are keyed on the person.**
   - The role set is OWNER, ADMIN, MEMBER, ATHLETE, COACH, OFFICIAL, STAFF, and the role is immutable per membership row.
   - Lifecycle: INVITED → ACTIVE ↔ SUSPENDED → ENDED, plus DECLINED.
   - Application permissions resolve through the caller's SELF person.
   - The permission vocabulary (`ORG_*`) is disjoint from BRT capabilities (ADR-0020 unchanged).

4. **Every athlete has a Person (BRT-04R).** `athlete.person_id` is NOT NULL. Imported or unclaimed athletes will need an explicit origin/claim model and migration when ingestion exists; null never carries hidden meaning.

## Consequences

**Benefits:**

- A dependent's affiliations are the dependent's own.
- An account can later gain other control kinds (e.g. delegated operators) without schema churn.
- Accounts and persons are independently creatable: sign-in does not force a person.

**Costs:**

- Permission checks join through `account_person_control`.
- An account with no SELF person has no organization permissions.
- BRT-02's VIEWER role is represented by MEMBER.

## Alternatives considered

- **`account.person_id` column:** rejected. It makes a sign-in without a person awkward and conflates control kinds.
- **Account-keyed membership:** rejected. A minor's affiliation would be attributed to the guardian.
- **Stored GUARDIAN control rows:** rejected. They would duplicate, and could drift from, the guardian relationship lifecycle.
