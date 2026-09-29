# ADR-0028 — The deterministic Evidence Bundle is the BRT-07 input identity

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-06 (ADR-0002, ADR-0005, ADR-0014; BRT-02 verification engine `inputsDigest`)

## Context

Verification (BRT-07) must be reproducible from its inputs. Evidence, attestations, retractions, availability and key facts accumulate over time and some facts are retroactive (key compromise). Without a canonical input object, "the same verification" could silently depend on load order, display names or the clock.

## Decision

1. `br:evidence-bundle@1` is a canonical BR-JSON document for one exact ResultVersion and a transaction-time horizon `asOf`. It contains only immutable facts and references: the version and its resolved hierarchy; attached, cited and lineage evidence (hashes, sources, times, availability and privacy class as of `asOf`); attestations about that version (issuer, key, proof, claim, evidence refs, supersession, retraction); the keys' validity windows and status changes with `recordedAt`; lineage edges.
2. It contains **no** verdict, level, score, confidence or authority decision.
3. Determinism: pure builder; every collection is a set with a declared sort key; `asOf` is an explicit input (future values refused); only stable ids, codes, hashes and platform timestamps.
4. `bundleHash = H("evidence-bundle", "br:evidence-bundle@1", JCS(bundle))` identifies the exact input set. It is not a verification proof, a truth hash or a blockchain proof.
5. Access is restricted (competition staff with `COMP_VIEW_PRIVATE`, INTERNAL); it is not a public artefact.

## Consequences

- BRT-07 can record `bundleHash` alongside its policy version and recompute "as known then" and "as known now".
- Changing the bundle shape requires a new schema version.
- Authority facts (grants, anchors) are loaded by BRT-07 separately; they are not evidence.

## Alternatives considered

- **Hash the database rows directly:** rejected (column/driver representation is not canonical).
- **Embed a provisional trust level:** rejected (would smuggle verification into BRT-06).
