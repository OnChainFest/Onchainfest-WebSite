# ADR-0022 — Athlete Passport as a rebuildable, provenance-labelled read model

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-04

## Context

The passport is the public face of an athlete. Two risks stand out:

- it could become a de-facto source of truth, for example by editing "achievements" into it;
- it could present self-declared or test data as verified.

Most of its eventual sections (results, records, trophies) have no source yet.

## Decision

1. **A class B projection.** The passport is a projection (schema `passport`) derived only from identity and organization facts.
   - It is maintained incrementally inside the owning command transactions.
   - It can be fully rebuilt by the maintenance login (`br_rebuild`) without PII access.
   - Rebuild equivalence is tested.
2. **A versioned DTO with provenance.** `AthletePassportV1` (`br:athlete-passport@1`) labels every fact with a provenance class: SELF_DECLARED, ORGANIZATION_CONFIRMED, PROOF_OF_CONTROL, TEST_PROOF, and later ACCOUNT_VERIFIED, AUTHORITY_VERIFIED and SYSTEM_DERIVED. `AUTHORITY_VERIFIED` is reserved for facts backed by the Authority Engine.
3. **Test proofs are fail-safe (BRT-04R).** `TEST_VERIFIED` wallets appear as `TEST_PROOF` only outside production. In production they are suppressed, never mapped to `PROOF_OF_CONTROL`, and this cannot be overridden.
4. **Honest sections.** Sections without a source are `NOT_AVAILABLE` (reason `SOURCE_NOT_IMPLEMENTED`), which is distinct from an available empty list. Nothing is fabricated.
5. **Public-safe by construction.**
   - The projection only receives public attributes.
   - Restricted (dependent) passports are not served.
   - The public role reads only the projection and public organization profiles.
   - Former slugs live in the projection, so redirects need no identity access.

## Consequences

**Benefits:**

- The public path cannot leak PII or private attributes even if a query is wrong.
- Future sources plug in as new sections without changing trust semantics.

**Costs:**

- Commands must remember to refresh the projection (centralized helpers).
- Organization commands need a narrow write grant on `passport.affiliation`.

## Alternatives considered

- **Live joins over identity tables on the public path:** rejected. The public role would need identity grants.
- **Materialized views:** rejected. Refresh granularity is coarse, and the per-athlete restriction logic is harder to express and test.
