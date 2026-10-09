# ADR-0069 — SchedulingProfile is a versioned catalog axis pinned per event

- **Status:** Proposed
- **Date:** 2026-10-08
- **Origin:** ONCF-05E-0 (executes ONCF-05A §27 / planned ADR-L; follows ADR-0059 and ADR-0065)

## Context

How long a contest takes, the changeover, the rest an entrant needs, start intervals and which resources a contest needs are all operational parameters. They differ by discipline, format and governing practice.

Hard-coding them would put sport identity into scheduler code.

## Decision

1. **SchedulingProfile is the fifth pinned axis**, next to Ruleset, ClassificationPolicy and AdvancementPolicy:
   - a catalog row with immutable, hashed versions (`DRAFT → PUBLISHED → RETIRED`);
   - a basis (GOVERNING_RULE with source, or COMMON_PRACTICE with note);
   - provisioned lookup-first by the operator;
   - pinned with the event's scoring pin;
   - frozen once the field locks.
2. **Its spec is closed, bounded data with no sport identity.** Candidate fields (the exact closed schema is set in 05E-B):

   | Field | Content |
   |---|---|
   | Requirements | Per contest type / stage primitive / round type: `{resourceType, quantity | capacityUnits, expectedDuration, changeover}` |
   | Rest | Minimum rest between an entrant's contests, as a value or a table keyed by the previous contest's duration or round |
   | Start intervals | Time-trial, wave and tee intervals; starting tees |
   | Sessions | Session or day grouping (e.g. one stage per day, swimming sessions) |
   | Dependency spacing | Minimum gap after feeder contests |
   | Grouping policy | For result-dependent post-cut grouping (ADR-0066 §4) |
   | Limits | Optional soft limits (max contests per entrant per day, max wait) |

3. **Values come only from the pinned profile.** Each limit is declared hard or soft (ADR-0071). Templates cite their source or are labelled COMMON_PRACTICE. There are no universal constants ("15 minutes of rest" exists only as profile data).
4. **Compatibility is checked at pin time:** the profile's resource types must be ones the discipline declares, and its requirements must cover the format's contest types.

## Consequences

- **The same scheduler handles all eight proof sports.** Only profile data differs.
- **v1 events stay unschedulable by the proposal engine** unless a compatible profile is pinned. Manual scheduling remains available.

## Alternatives considered

- **Durations on the Ruleset:** rejected. A ruleset's playing time (basketball periods) is not an operational slot length (warm-up, stoppages, changeover).
- **Organizer-only free values:** rejected as the default, because they give no provenance or reuse. Organizer overrides live in the schedule itself (ADR-0070).
