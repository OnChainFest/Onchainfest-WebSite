# ADR-0002 — Separate Evidence, Attestation and Verification

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

The legacy oracle (`../Art-Tokenization`) reduced trust to a single boolean from one unauthenticated source. That boolean drove an on-chain release, with no stored artefact, no issuer identity and no scope (BRT-00 §17, C-8). The target vision requires answering *why* a result should be trusted, with inputs of very different kinds:

- files (scoresheets, video, sensor data);
- human assertions (a referee signs);
- automated sources (timing systems);
- institutional authority (federations).

## Decision

Three distinct concepts:

1. **Evidence**: immutable, content-addressed artefacts with source, provenance and integrity metadata. Evidence *asserts nothing*.
2. **Attestation**: a signed, typed claim (`claimType`, `polarity`) by an identified principal about a specific subject *hash*. It cites evidence and declares the authority context it relies on. Many attestations per subject, including contradicting ones.
3. **Verification**: an immutable assessment *computed* by a versioned policy over a result version's evidence, attestations and the authority state. It is never written by hand. It is recomputed (append-only) whenever inputs change, and the level can go down.

Authority is a fourth, supporting concept (ADR-0004) that gives attestations their weight.

## Consequences

**Benefits:**

- Every verification is explainable (`criteriaMet` / `criteriaMissing`) and reproducible from its `inputsDigest` and `policyVersion`.
- Machine, human and institutional sources plug in uniformly.
- A compromised attester or invalid evidence can be handled surgically.

**Costs:**

- More entities.
- Verification must be recomputed on events, which needs an efficient dependency index.

## Alternatives considered

- **"Verified" boolean or enum on the result:** rejected; the BRT-00 anti-pattern.
- **Treating signed evidence as attestation:** rejected. A device signature proves origin ("this file came from lane system L7"). It does not prove the claim ("Ana bowled 612"). A system that makes the claim issues a separate SYSTEM attestation.
