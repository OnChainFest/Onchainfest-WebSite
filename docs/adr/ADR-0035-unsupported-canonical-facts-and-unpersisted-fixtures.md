# ADR-0035 — Typed canonical facts without producers are INPUT_NOT_SUPPORTED; synthetic fixtures are never persisted

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-07 stop-condition decision (BRT-01 V2–V4 depend on facts with no producer yet)

## Context

V2–V4 require RESULT_OFFICIAL, T5, COMPETITION_SANCTIONED, IDENTITY_CONFIRMED, official evidence sets, evidence assessments, record categories and ratifications — none of which the platform produces. Weakening the criteria would reinterpret BRT-01; manufacturing the facts would fabricate sporting truth.

## Decision

1. The engine's typed vocabulary represents every BRT-01 fact kind (`CanonicalFactKind`). A snapshot declares `supportedFactKinds`; a criterion needing an unsupported kind reports `INPUT_NOT_SUPPORTED` — an ordinary insufficiency, never an integrity failure, never a pass.
2. The production assembler emits only kinds with real producers (today: `RESULT_ACCURATE` and `CONDITIONS_COMPLIANT` attestations). It never defaults, infers (e.g. RESULT_OFFICIAL from RESULT_ACCURATE, sanction from organization type, ratification from naming) or synthesizes facts. The honest production ceiling is therefore V1.
3. V2–V4 are proven exhaustively with typed **REFERENCE ENGINE FIXTURES** (`@br/verification/fixtures`, `provenance: REFERENCE_FIXTURE`), in memory only. No API or store accepts a snapshot; the database refuses any run whose provenance is not `CANONICAL_ASSEMBLY`.
4. Future producers are added as new supported kinds (new assembler version); BRT-07 does not design their storage or APIs.

## Consequences

"Complete" means the accepted semantics are implemented and proven, not that every level is reachable today. Public pages explain blocked levels as "fact not currently available", not as engine failures.

## Alternatives considered

- **Simplify V2 to RESULT_ACCURATE + ATTEST_RESULT:** rejected (reinterprets BRT-01).
- **Persist demonstration runs:** rejected (would be mistaken for real sporting truth).
