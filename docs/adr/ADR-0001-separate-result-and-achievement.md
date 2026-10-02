# ADR-0001 — Separate Result from Achievement

- **Status:** Proposed
- **Date:** 2026-09-28
- **Deciders:** pending review

## Context

Every legacy system collapsed "what happened" into "what was awarded":

- winners were passed straight into prize payouts (`PrizeDistribution.distributePrizes`, `StrikeChain.submitWinners`);
- winners were passed straight into NFT mints (`SimplifiedBRTPoker.mintBRTsForWinners`, `PadelFlowNFTTrophy.mint`);
- a padelflow SQL trigger inserted achievements the moment a score row was written.

(BRT-00 §15–17.)

When a result changed, nothing could tell which awards depended on it. Duplicate awards were possible (BRT-00 M-4, M-5).

## Decision

1. A **Result** (versioned, lifecycle-bearing) records *what happened* in a Contest, Round or Event.
2. An **Achievement** is a *derived recognition*, produced by a versioned AchievementRule from one or more verified result versions.
3. An Achievement **references** its basis (result version ids and hashes, verification ids, performance ids). It does not copy raw result data. The only exception is a `qualifyingValue` when the achievement is *about* a value, and that value must equal the referenced performance.
4. Records, rankings, prizes and trophies derive from Achievements or FINAL classifications, never directly from raw submissions.
   - *Clarification (BRT-09, [ADR-0044](./ADR-0044-records-consume-verified-performance-basis.md)):* comparative records are computed over a **verified immutable Performance basis** (FINAL, CURRENT verification at the category floor, exact hashes) and recognized by the RECORD_SET Achievement after ratification — never from raw submissions.
   - *Clarification (BRT-10, [ADR-0048](./ADR-0048-ranking-systems-and-immutable-ranking-snapshots.md) §4):* this rule is a **source-authority boundary**. A ranking may consume only facts whose trust the Result → Verification chain establishes at the consequence floor, never raw submissions. A best-mark ranking is a RankingSnapshot, which is a separate derived artefact and never a ResultVersion. It is computed over the same verified immutable Performance basis as records (FINAL, CURRENT verification at the system floor, exact hashes, hold known and absent). Placement-based consumption uses FINAL classifications. QUALIFIED is still an Achievement whose basis pins the underlying verified result versions ([ADR-0050](./ADR-0050-qualification-is-a-qualified-achievement.md)).

## Consequences

**Benefits:**

- A correction can compute exactly which achievements, records, trophies and prizes are affected (downstream impact).
- Achievement rules can evolve through versioning without touching results.
- Idempotency is enforceable: `(type, ruleVersion, holder, scope, basis)` is unique.

**Costs:**

- An extra derivation step and an extra entity.
- Displays must join achievements to results for detail.

## Alternatives considered

- **Achievement as a flag or column on the result:** rejected. Correction impact becomes unanswerable, and multi-result achievements (streaks, season titles) are impossible.
- **Achievement containing a copy of the result:** rejected. Two sources of truth diverge on correction.
