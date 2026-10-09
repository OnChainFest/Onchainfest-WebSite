# ADR-0056 — Declared entry attributes, frozen into the field at lock

- **Status:** Proposed
- **Date:** 2026-10-07
- **Origin:** ONCF-05A §17, §25 (ADR-D); implemented in ONCF-05B

## Context

Seeding, handicap and start lists need per-entrant values the platform does not own. Examples:

- swimming entry times;
- bowling averages;
- golf handicap indexes;
- bibs;
- 3x3 ranking points;
- wheelchair basketball classification points.

Participants carried none.

## Decision

1. **A v2 DisciplineVersion declares its entry attributes.** Each has a key, a value type (DURATION_MS, INTEGER, DECIMAL or TEXT), a scope (PARTICIPANT or MEMBER), a `required` flag and decimal bounds.
2. **The entrant or an organizer (COMP_MANAGE_REGISTRATIONS) declares values on the registration** before the field locks. They go into the append-only `registration_entry_attribute`; the latest value per key is current, and a NULL value clears it. MEMBER-scope values name an ACTIVE team member.
3. **The field lock freezes them.** Current values become `participant_entry_attribute` rows and are hashed into `br:competition-field@2`. Missing required attributes refuse the lock.
4. **Values are DECLARED, never verified.** This is the same honesty rule as `EligibilityBasis.DECLARED`. Audit records keys, never values. Values are not published by ONCF-05B; organizers read them through `GET /v1/events/:id/field`.

## Consequences

- Seeding can order by an entry attribute (ADR-0058).
- Handicap application and lineup constraints (wheelchair Σ classification points ≤ 14.0) can use frozen values. That arrives with rulesets and results; it is recorded but not validated in v1.

## Alternatives considered

- **Free-form JSON on the registration:** rejected. It is untyped, unbounded and unhashed.
- **Reading from the PII vault or identity data** (e.g. deriving an age band from date of birth): rejected. The competition context never reads the vault, and categories stay declared.
