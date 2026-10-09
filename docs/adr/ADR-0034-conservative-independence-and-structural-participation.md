# ADR-0034 — Conservative, principal- and provenance-based independence over a structural participation resolver

- **Status:** Proposed
- **Date:** 2026-09-29
- **Origin:** BRT-07 (BRT-01 §4.5 rule 7, A-5, V1, V4; BRT-03R fail-closed conflicts)

## Context

Until BRT-07 no participation index existed, so every conflict-sensitive authority action failed closed and V1 independence was undecidable.

## Decision

1. A deterministic **participation resolver** recomputes structural relations inside every snapshot from class-A facts (participants, contest slots, athletes → persons, team memberships, managers, lineups, guardians, explicit Person ↔ PERSON and Organization ↔ ORGANIZATION principal mappings, organizer admins, staff). It is not a second source of truth and reads no PII.
2. Relations are facts. BRT-01 rule 7 relations always conflict; a policy may add relations. Unresolvable participation is never "conflict-free".
3. **Issuer independence** is principal-based. Keys and attestations of one principal are one issuer. The submitter's side never corroborates. Non-participants count only as **registered officials**, a structural `REGISTERED_OFFICIAL` fact that is not an ATTEST_RESULT grant and has no producer yet (BRT-07R). Unknown never counts.
4. **Source independence** is provenance-based: lineage roots identified by their stable source principal (side-collapsed); unknown provenance and generic machine derivation never add a source.
5. Relations are **time-sliced at the contest occurrence window** using only facts known at the cutoff (BRT-07R). Direct participants, exact-lineup members and organization labels are structural. Memberships, managers, guardians, organizer admins and staff count only when their interval certainly overlaps the window. An undecidable overlap makes the principal `TEMPORALLY_UNDETERMINED`, which is never independent and never cleared.

## Consequences

V1 is reachable with real data through counterparties. Conflict-sensitive authority is decided instead of always denied. A former team member whose membership ended before play is no longer treated as a teammate. The remaining cost: when the occurrence start is unknown, ended relations are UNDETERMINED rather than assumed either way.

## Alternatives considered

- **Key- or account-based independence:** rejected (Sybil-prone).
- **Stored participation projection:** deferred (not needed for determinism; could be added as a class-B cache later).
