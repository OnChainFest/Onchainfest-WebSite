# ADR-0026 — Declared lineups are operational; the credited lineup stays in Result content

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-05 (interprets BRT-01 result domain §5.6 and BRT-02 "Lineup drafts")

## Context

BRT-01 says a Lineup "records who actually played … It is part of the Result content because achievements credit athletes through it". BRT-02 places "Lineup drafts" in the Participation module. BRT-05 needs pre-contest lineups (e.g. which two padel players field a pair, which eleven of a squad play) before any Result exists.

## Decision

1. **BRT-05 lineups are declared, operational facts.** `competition.lineup` and `lineup_member` are append-only; the latest declaration per (contest, participant) is current, and replacements are audited.
   - Declarations are validated against the Participant: an individual fields exactly its athlete, a team fields ACTIVE members at submission time, and the size comes from the discipline.
   - They close when the contest starts.
2. **A declared lineup is not the credited lineup.** Achievements, records and statistics credit athletes only through the lineup inside Result content (BRT-01). A future result workflow may reference or reconcile the declaration, but never treat it as proof of participation.
3. **TeamMembership ≠ Lineup.** Membership is temporal team composition; a lineup is per-contest participation. Neither changes the other.

## Consequences

**Benefits:**

- Operations can plan and publish who fields, without implying sporting facts.
- The trust path for crediting stays in the Result/verification layers.

**Costs:**

- Two lineup notions exist and must be named distinctly (declared vs. credited) in APIs and UI.
- Reconciliation belongs to future result work.

## Alternatives considered

- **Treating the declared lineup as the credited lineup:** rejected. Operational declarations would become sporting truth without evidence or attestation.
- **No pre-contest lineups:** rejected. Team sports and pairs need operational fielding before results exist.
