# ADR-0051 — OnChainFest owns the sports domain; Bragging Rights is re-scoped to digital artifacts

- **Status:** Proposed (ONCF-00R, pending architectural review)
- **Date:** 2026-10-05
- **Origin:** ONCF-00 Option A (approved); ONCF-00R platform core consolidation

## Context

The sports-platform core was built in the `OnChainFest/bragging-rights` repository (BRT-00…BRT-10). It covers accounts, persons, athletes, guardians, organizations, the sport catalog, competitions, results, evidence, verification, achievements, records, rankings and classifications.

ONCF-00 found that about 95% of that code is OnChainFest sports-domain code, not Bragging Rights. The repository name, its README, the `@br/*` package scope and the `br_*` database roles all imply the opposite ownership. ADR-0006 and ADR-0019 already keep the domain core chain-agnostic, and no blockchain, token or minting code exists.

ONCF-00R consolidated that repository into `Onchainfest-WebSite`, with its full Git history, as the canonical OnChainFest platform repository.

## Decision

1. **OnChainFest owns the sports domain.** Every package under `apps/` and `packages/` in this repository is OnChainFest platform code. This applies whatever historical name it carries (`@br/*`, `br_*`, BRT-NN, "Bragging Rights"). OnChainFest is the system of record for:
   - tournament data;
   - athlete profiles and identity;
   - result verification;
   - achievements as sporting facts;
   - records;
   - rankings;
   - reward eligibility.
2. **Bragging Rights is a future, small bounded context for digital artifacts.** It is reserved as `packages/bragging-rights/`, which is not created yet. It may own only:
   - token metadata;
   - minting;
   - token identity;
   - the blockchain ownership read model;
   - chain adapters;
   - minting and signing integration.

   It consumes OnChainFest achievement references through the ADR-0019 ports. It never becomes a source of truth for any sporting fact.
3. **Historical names are not renamed in ONCF-00R.** Some names are hashed, signed or persisted:
   - the signature domain tag `bragging-rights/sig/v1:`;
   - the signature audiences `bragging-rights:<env>`;
   - the engine ids `bragging-rights-*-engine`;
   - the `bragging_rights` database names;
   - the `br_*` roles.

   Renaming any of these changes golden vectors, signatures or database identity, so each one needs its own decision. The `@br/*` package scope is pure naming debt; it is deferred to keep the consolidation free of behavior changes.

## Consequences

- New OnChainFest capabilities (for example ONCF-01 authentication) extend the existing packages in place. ONCF-01 extends `packages/identity` and the `AuthAdapter` seam in `apps/api/src/auth.ts`.
- Wallet proof-of-control (`packages/identity/src/wallet.ts`) stays in identity. It links a wallet to a person and holds no token state. Whether its chain-specific verifiers later move behind the Bragging Rights chain adapter is decided with ONCF-16 or ONCF-17.
- Documents written under the old framing (`README.md`, `docs/architecture/BRT-TARGET-CAPABILITY-MAP.md`) are read through this ADR.
