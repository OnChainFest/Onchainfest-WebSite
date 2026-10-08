# ADR-0062 — Ruleset execution: score sheets normalize into canonical result content; stored content must re-derive exactly

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05C (executes ADR-0059; refines BRT-01 §6 for v2 events)

## Context

05B shipped the Ruleset vocabulary. 05C must validate real scores for the eight canonical sports and feed classification, without branching on sport and without changing the Result model or the golden vectors.

`br:result-version-content@1` carries entries (outcome, rank, primary mark) and per-ordinal Performances, but no discipline components.

## Decision

1. **One executor per ruleset family; none per sport.** A score sheet of the pinned family is validated against the ruleset parameters and the contest context. The context is the contest's resolved participants, the frozen rosters and the declared entry attributes. Validation fails closed with coded issues.
2. **Normalization produces the content the ResultLedger stores.** It also produces a normalized contest result (outcomes, integer metrics, per-unit series) that classification consumes.
3. **Each family fixes a documented Performance ordinal layout** for per-unit measurements: set games, tie-break points, periods, hole strokes, member games, par and stroke index, relay legs, and so on. The layout is part of the family's semantics; changing it is a new family version.
4. **Stored content is the canonical score representation.** To use it, the ruleset re-derives the sheet from the content, re-validates it, and requires the canonical hash of the re-normalized content to equal the stored content's hash, computed by the ledger's own canonicalizer. Anything else is `CONTENT_NOT_CANONICAL`. An invalid or hand-edited score therefore never classifies.
5. **Outcomes.** `NOT_PLACED` (finished but not placed, e.g. beyond a time limit) and `PULLED` (taken out of a lapped race) join `ResultOutcome`. DNF, DNS and DQ are reused. A status is never ordered implicitly: ClassificationPolicy declares the order (ADR-0063).
6. **Handicap.** Handicap is computed only from frozen declared values named by the ruleset: `handicapAverageAttribute` for bowling, and course handicaps on the scorecard for golf. A missing value refuses validation. It never defaults.
7. **Team derivation is ruleset data.** Relay team time (`teamTime`), Baker vs summed member games (`baker`) and golf `teamFormat` / `teamAllowancePercents` are ruleset parameters. Participant kind alone never implies a team scoring rule.

## Consequences

- **No new tables for results.** Validation is pure (`POST /v1/contests/:id/score-sheets/validate`). Submission stays the ResultLedger's, with authority, in 05D.
- **Hashes unchanged.** Existing hashes and vectors do not change (`pnpm vectors:check`). v1 events have no ruleset and are never reinterpreted.
- **Golf course data travels with the scorecard.** A shared course catalog and slope-based course handicap are deferred.

## Alternatives considered

- **A new `@3` content schema with `components`:** deferred. It would change the ledger's content schemas and the vectors for no 05C need.
- **Trust submitted content and only check bounds:** rejected. Impossible scores would classify.
