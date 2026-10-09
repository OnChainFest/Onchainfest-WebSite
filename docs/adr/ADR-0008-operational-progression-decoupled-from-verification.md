# ADR-0008 — Operational progression decoupled from verification

- **Status:** Proposed
- **Date:** 2026-09-28

## Context

- **BRT-00's framing.** The capability map states that consequences (including Qualification) derive from a Verified Achievement.
- **The problem with that framing.** Tournaments cannot wait for FINAL or V2+ before scheduling the next match. Padel quarter-final winners play the semi-final minutes later.
- **The risk of the opposite approach.** Treating operational advancement as "verified" would repeat the legacy error of acting on unverified declarations.

## Decision

1. **Operational consequences** consume **PROVISIONAL** results at the level set by event policy (typically V1). Examples: live standings, bracket advancement, heat seeding, next-round draws. These consequences are internal to the running competition and are labelled provisional.
2. **Recognition and value consequences** use the verification permission matrix. Examples: achievements, records, rankings, trophies, prizes, and **cross-competition qualification**.
3. **Protest windows are configurable competition policy** (duration and/or closing conditions); the domain prescribes no universal rule. A common bracket policy, used in the padel walkthrough, closes a contest's window when a dependent contest starts. Under such a policy, later changes that would alter advancement are LATE rulings requiring an authority-chosen sporting remedy.

## Consequences

**Benefits:**

- Real-time tournament operation is possible.
- Trust claims stay honest.
- Qualification *between* competitions stays verification-gated.

**Costs:**

- Two notions of "qualified" (in-competition advancement vs. cross-competition qualification) must be named distinctly in UI and APIs.
