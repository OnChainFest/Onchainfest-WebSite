# ADR-0025 — Explicit competition hierarchy resolution for authority and results

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-05 (completes the BRT-03 scope algebra; ADR-0004, ADR-0020)

## Context

The BRT-03 scope algebra infers no ancestry: a grant scoped to a competition covers only requests that carry that competition. Until BRT-05 there was no hierarchy to resolve. Now that Competition → Event → Round → Contest exists, two risks follow:

- **implicit ancestry** (e.g. from id or slug prefixes), which would widen authority;
- **caller-claimed ancestry**, e.g. a referee claiming that a contest belongs to "their" competition.

## Decision

1. **A single resolver.** `competition.resolve_scope_path(kind, id)` resolves a target to its full path from database relationships.
   - It is SECURITY DEFINER with a fixed `search_path`, executable only by the competition, authority and results roles.
   - It returns ids and catalog codes (sport and discipline from the pinned DisciplineVersion; region from the competition profile), or NULL (fail closed).
2. **Callers pass the full resolved path** as singleton-set request scopes (`pathToScope`, `authorizeInHierarchy`). Exact BRT-03 semantics are unchanged; no global rule is weakened.
3. **Recognition level is never inferred** from structure. Callers supply it explicitly when a grant chain constrains it.
4. **Result linkage through an optional validator.** `ResultLedger` accepts a `ResultScopeValidator`:
   - the Result's scope target must exist in the hierarchy;
   - any authority scope used on it must state exactly the target's resolved hierarchy.
   - Without the validator, BRT-03 behaviour is unchanged.
5. **Ancestry is immutable.** It lives in append-only tables, so cancellation never changes it.

## Consequences

**Benefits:**

- Competition-scoped grants cover descendants and nothing else, even for competitions of the same organizer.
- Borrowed ancestry is refused.
- The mechanism is a single, auditable SQL definition.

**Costs:**

- The resolver owner must keep the function's grants narrow.
- Every authority check on competition targets needs a resolution query.
- Production compositions that expose result endpoints must configure the validator.

## Alternatives considered

- **Hierarchy-aware scope algebra** (a competition implicitly covering its events): rejected. It changes exact semantics globally and needs the engine to read the database.
- **Trusting caller-supplied paths:** rejected. It enables borrowed ancestry.
- **Granting table SELECT on competition tables to the authority/results roles:** rejected in favour of one function that returns only ids and catalog codes (minimal exposure).
