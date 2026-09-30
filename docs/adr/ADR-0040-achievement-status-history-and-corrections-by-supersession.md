# ADR-0040 — Current Achievement support is an append-only status history; corrections supersede, never rewrite

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-08 (BRT-01 §8.1 status / statusHistory, disputes §3 and §5.1, AC-3; ADR-0031)

## Context

BRT-01 gives an Achievement a status (ACTIVE / SUSPENDED / SUPERSEDED / REVOKED) and a status history, and says a changed basis leads to SUPERSEDED or REVOKED, never an edit (AC-3). Achievements must reflect key compromises, corrections and revocations without deleting history.

## Decision

1. The Achievement fact, its basis items and its member credits are immutable (append-only triggers, including for the owner).
2. Current support is an **append-only status history** (`achievement.status_entry`, class A). Each entry commits to the hash of the support facts it was assessed from (`br:achievement-support-facts@1`). The latest entry is projected into `achievement_read` (class B, rebuildable). The pure `assessSupport` decides:
   - a revoked basis → **REVOKED**;
   - replaced by a newer Achievement (same type / rule / holder / scope) → **SUPERSEDED**, with a supersession link;
   - a superseded basis whose successor no longer qualifies this holder → **REVOKED**;
   - a superseded basis still awaiting re-derivation → **SUSPENDED**;
   - a pinned run no longer CURRENT, or a current level below the rule's → **SUSPENDED**;
   - otherwise → **ACTIVE**.

   A later assessment may return a SUSPENDED Achievement to ACTIVE, as a new entry. An admitted hold only adds `UNDER_DISPUTE` (BRT-01 §1.3: holds block new consequences).
3. A correction that still qualifies creates a **new** Achievement: new basis, corrected memberCredits, and a supersession link to the old one. The old basis and credits are never edited.
4. Public views never present a non-ACTIVE Achievement as current. They say "Historical recognition — …", and an Achievement is "derived from a V2 Event Certified result", never "V2".

## Consequences

"BRT derived this under rule R from basis B at time T" stays true forever, and current trust stays honest. Costs:

- re-assessment must be triggered (worker reactions to canonical events, or a staff request);
- key compromises have no event of their own, so they are caught by reacting to key-status events or by the next re-assessment.
