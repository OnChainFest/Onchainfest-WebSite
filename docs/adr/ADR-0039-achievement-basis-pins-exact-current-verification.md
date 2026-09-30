# ADR-0039 — An Achievement pins its exact basis and is issued only on CURRENT verification

- **Status:** Proposed
- **Date:** 2026-09-30
- **Origin:** BRT-08 (ADR-0001, ADR-0031, ADR-0033; BRT-01 §8.1 AC-1/AC-2/AC-5)

## Context

An Achievement must say exactly which verified facts qualified whom under which rule. It must be idempotent, and it must never be awarded by hand.

## Decision

1. The pure engine derives a canonical **candidate** (`br:achievement-candidate@1`) from a sealed **AchievementDerivationSnapshot** (`br:achievement-derivation-snapshot@1`; the cutoff is metadata, not a member). The candidate's basis pins:
   - the exact ResultVersion id and content hash, and its lifecycle status;
   - the exact VerificationRun id, snapshot hash, outcome hash and level;
   - the participant, the Performance ordinal where relevant, and the credited-lineup hash.

   The candidate never copies raw result content. `qualifyingValue` exists only for value achievements and equals the source Performance mark byte for byte.
2. Issuance gates are separate from the sporting question. Rule applicability, lifecycle status, a **CURRENT** BRT-07 VerificationRun at the rule's level (hash-based freshness), and known hold state must all pass. A STALE, NOT_EVALUATED or lower-level run issues nothing. The engine never re-runs verification.
3. **Natural identity (AC-2)** is `H("achievement-identity", {type, ruleVersionId, holder, scope, basis})`, enforced by a UNIQUE constraint. Twenty concurrent derivations produce one row, with no raw constraint error surfaced.
4. **TEAM holders (AC-5):** a team recognition is ONE Achievement whose immutable `memberCredits` are exactly the credited lineup of the basis ResultVersion. It is never one Achievement per athlete, and never current roster, managers or registration state. Without a credited lineup, the TEAM Achievement carries no credits (`CREDITED_LINEUP_UNAVAILABLE`), so athlete credit fails closed.
5. The only writer re-derives the candidate from its snapshot, re-checks every element, and lets the database re-check upstream canonical facts (ADR-0037). No route, method or input accepts a holder, a type, a value, a level, a force flag or an override.

## Consequences

Correction impact is computable (the basis items are the dependency index), and duplicates are structurally impossible. The cost: every new VerificationRun that still qualifies yields a new Achievement that supersedes the previous one.
