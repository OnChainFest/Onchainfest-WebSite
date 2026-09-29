# ADR-0024 — Deterministic, versioned format engines and immutable event plans

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-05 (implements BRT-01 FormatTemplate §4.3 and Event/Round/Contest §5)

## Context

A bracket or schedule is future evidence of how a competition was run. It must be reproducible from its inputs. Three things must never happen:

- a later code change silently reshaping a historical bracket;
- a changed registration silently regenerating it;
- an engine's output depending on the clock or on hidden randomness.

## Decision

1. **Pure engines.** Formats are implemented as pure `CompetitionFormatEngine`s: (locked field, seed order, validated config, allowed contest types) → logical plan, with no database, clock or randomness.
   - Each engine has an id and an integer version (`single-elimination/1`, `round-robin/1`).
   - Any change to generated structure requires a new version.
   - A FormatVersion pins one exact engine version and its BR-JSON configuration schema.
2. **Hashed inputs and output.** Field, seeding, plan input and plan output are hashed as registered BR-JSON documents (`br:competition-field`, `-seeding`, `-plan-input`, `-plan`).
   - A deterministic draw persists its CSPRNG seed (`br-draw/1`), so the seed order is reproducible.
3. **One immutable plan per event** (`event_plan`, append-only): input hash, plan hash and the full plan document.
   - Rounds, contests and contestants are materialized in the same transaction.
   - A repeat with the same input returns the stored plan; a different input is refused. There is no overwrite and no amendment after the field locks.
4. **Historical plans are never regenerated from engine code**, including during projection rebuilds.
5. **Dependency slots stay unresolved.** Slots such as WINNER_OF are recorded, and resolution requires a trustworthy outcome (future work, ADR-0008).
   - Byes in single elimination place top seeds directly into round 2, as a structural consequence rather than a contest.

## Consequences

**Benefits:**

- Brackets are reproducible and tamper-evident against stored facts.
- Engine upgrades cannot rewrite history.
- The model generalizes across formats through adapters.

**Costs:**

- Field or plan corrections need an explicit amendment workflow, which does not exist yet (cancel instead).
- Old engine versions must stay registered for events that pin them.
- The draw is reproducible but not provably fair (commit–reveal deferred).

## Alternatives considered

- **Enum of formats with in-place SQL generation:** rejected. It is not extensible, and generation is not testable as a pure function.
- **Regenerating the structure on demand from current code:** rejected. Historical semantics would drift with code changes.
- **Mutable plans updated when registrations change:** rejected. The bracket would change silently after the field was frozen.
