# ADR-0004 — Scoped authority grants with trust anchors and delegation

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

In every legacy prize or trophy contract, the deployer, owner or sponsor was the only authority, and it was unscoped and self-certifying (BRT-00 H-1). The target vision needs several things:

- federations, leagues, organizers, officials, timing providers and automated systems as authorities;
- **scoping:** a referee for tournament A must not be able to attest tournament B;
- delegation, expiry and revocation, including retroactive compromise;
- no dependence on federations alone, because many events have none.

## Decision

1. **Principals** have types `PLATFORM`, `ORGANIZATION`, `PERSON` and `SYSTEM`, and registered keys.
2. **TrustAnchors** are governance decisions that recognize a principal as a root authority within a *recognition scope* (sport, region, level). The platform is itself an anchor, but only at `level=PLATFORM`. It can never claim NATIONAL or WORLD scope.
3. **AuthorityGrants** carry the following:
   - grantor → grantee;
   - capabilities (e.g. `DECLARE_OFFICIAL`, `RATIFY_RECORD`, `GRANT_AUTHORITY`);
   - a scope that can only narrow down the chain (sport, discipline, region, level, competition, event, round, contest);
   - a validity window;
   - delegation limits (allowed, max depth, delegable capabilities);
   - constraints (default: must not be a participant).
4. **Authorization** is a chain check from an anchor to the issuer, evaluated at the attestation's time. The check includes key validity and a **conflict-of-interest rule**: a principal who is a participant in the subject scope counts only as a participant, whatever grants it holds.
5. **Revocation:**
   - ordinary revocation is prospective;
   - compromise revocation is retroactive to *t₀* and marks affected attestations SUSPECT;
   - revocations cascade to child grants.

## Consequences

**Benefits:**

- Organizer self-certification is structurally impossible for events the organizer competes in.
- Club events work without a federation (V2 via the platform anchor).
- Federations raise trust (V3) when present.
- Automated systems are first-class.

**Costs:**

- A governance process is needed for anchors: who approves a federation, and on what evidence (an open question).
- Chain evaluation must be efficient and cacheable.

## Alternatives considered

- **Role-based access control only (organizer or referee roles per event):** rejected. There is no delegation provenance and no root of trust, so an off-platform verifier cannot evaluate it.
- **Federation-only hierarchy:** rejected. It excludes most grassroots events and data providers.
- **Fully on-chain registry from day one:** not decided (data boundaries §4). The model is compatible with either.
