# BRT-05 — Authority Hierarchy

Status: **implemented** · ADR: [0025](../adr/ADR-0025-explicit-competition-hierarchy-resolution.md) · Builds on: ADR-0004, ADR-0020, BRT-03 scope algebra · Code: `db/migrations/0008_competition_engine.sql` (`competition.resolve_scope_path`), `packages/competition/src/hierarchy.ts`, `packages/persistence/src/competition-hierarchy.ts`, `packages/persistence/src/result-ledger.ts`

## 1. Why

The BRT-03 scope algebra deliberately **infers no ancestry**. A grant constraining `competition` covers a request only if the request itself carries that competition.

BRT-03 had no competition hierarchy. BRT-05 supplies it explicitly: a target is resolved to its **full path from database relationships** (never from id or slug prefixes), and that path is the request scope. Exact scope semantics are unchanged globally.

## 2. Resolver

`competition.resolve_scope_path(kind, id) → jsonb | NULL`:

- `kind` is `COMPETITION`, `EVENT`, `ROUND` or `CONTEST`.
- It is `SECURITY DEFINER`, owned by `br_owner`, `STABLE`, with `search_path = pg_catalog, pg_temp`.
- EXECUTE is granted only to `br_competition`, `br_authority` and `br_results`. The public role cannot call it (tested).
- It returns public-safe ids and catalog codes only:
  `{ level, competitionId, region?, sport?, discipline?, eventId?, roundId?, contestId? }`
  - `sport` and `discipline` come from the event's **pinned** DisciplineVersion.
  - `region` comes from the competition profile, when declared.
  - A competition-level path has no sport, because a competition may span sports.
- Unknown, malformed (non-UUID) or mis-kinded ids (e.g. a contest id asked as an EVENT) return `NULL` / `undefined`, and callers **fail closed** (`NOT_FOUND`).
- **Ancestry is immutable** (append-only tables). Cancelling an event does not change its contests' paths (tested). Results are deterministic.

In TypeScript:
- `resolveHierarchy(ctx, level, id)` runs inside any transaction whose role has EXECUTE; `CompetitionHierarchyResolver` is the stand-alone form.
- `pathToScope(path, { recognitionLevel? })` produces singleton-set scopes.
- **Recognition level is not inferred.** It depends on sanctioning and policy, not structure, so callers supply it explicitly when the grant chain constrains it.

`authorizeInHierarchy(ctx, { principalId, capability, target, recognitionLevel?, atTime, asOf }, checker)` resolves and evaluates in the same transaction, using `authorizeIn` with the BRT-03 engine.

## 3. Scope containment (tested with real anchors and grants)

The fixture is built through the real commands:

```
C1 { E1 { A, B }, E2 { C } }     C2 { E3 { D } }    (same organizer)
```

| Grant scope (+ `recognitionLevel: PLATFORM`) | Covers | Does not cover |
|---|---|---|
| `competition: [C1]` | A, B, C, E2 | D, E3, C2 |
| `competition: [C1], event: [E1]` | A, B | C, C1 (competition-level request) |
| `…, contest: [A]` | A | B |
| `sport: [tennis…]` | D | C2 (competition-level request has no sport) |
| `sport: [padel]` | — | D |
| `discipline: [tennis….*], competition: [C2]` | D | A |

## 4. Result ↔ Contest linkage (no Result redesign)

`ResultLedger` gains an **optional** `ResultScopeValidator` port. Without it, BRT-03 behaviour is unchanged.

`competitionResultScopeValidator` does two things:
- **`assertTarget`** (on `createResult`): the scope target must exist at the matching level. The mapping is CONTEST → contest, ROUND_CLASSIFICATION → round, EVENT_CLASSIFICATION → event, COMPETITION_CLASSIFICATION → competition. Otherwise `NOT_FOUND`.
- **`assertScope`** (before `authorizeIn` in `submitDraft` and `transition`): the supplied authority scope must state **exactly** the target's resolved hierarchy (`scopeMatchesPath`). Only non-hierarchy extras such as `recognitionLevel` may be added. Otherwise `AUTHORITY_DENIED` (`SCOPE_HIERARCHY_MISMATCH`).
  - This stops "borrowed ancestry": a referee authorized for C2 cannot claim that a C1 contest sits in C2 (tested).

Guarantees:
- Contests **never** create Results.
- Nothing is auto-accepted or auto-verified. A correctly scoped submission is `SUBMITTED` and nothing more.
- The production composition must configure the validator when result endpoints are exposed. BRT-05 exposes none.

## 5. Operational permissions ≠ sports authority (proofs)

| Claim | Test |
|---|---|
| Competition operations (create, event, lock, seed, plan, staff, schedule) create **zero** grants and anchors | `competition-authority.int.test.ts` |
| The organizer's ORGANIZATION principal is not authorized for ACCEPT_RESULT, DECLARE_OFFICIAL, ATTEST_RESULT or RATIFY_RECORD | same; demo step 8 |
| A `FEDERATION` organizer has no authority either | same |
| A competition ADMIN (staff) can schedule but holds no capability; no OFFICIAL/REFEREE staff roles exist | same |
| An ACCEPT_RESULT grant to the organizer principal grants **no** `COMP_*` permission to members and does not change the owner's | same |
| Org MEMBER cannot create or publish competitions | `competition.int.test.ts` |
| `CompPermission` ∩ `Capability` = ∅ | compile-time guard + unit test |

## 6. Deferred

- The conflict-of-interest checker is still not participation-backed. Participants reference athletes and teams; persons and athletes have no Principal mapping yet. Conflict-sensitive capabilities therefore still require an explicit checker (fail-closed default).
- Advancement on provisional results (ADR-0008).
- Sanctioning (`COMPETITION_SANCTIONED`) and recognition-level policy.

## BRT-05R guardrail for BRT-06+ Result operations

`ResultLedger`'s `scopeValidator` stays optional **only** for BRT-03 backward compatibility. Any BRT-06+ application composition that exposes Result operations scoped to a COMPETITION, EVENT, ROUND or CONTEST **must** build its ledger with `createCompetitionResultLedger(db, { conflictChecker })` (`packages/persistence/src/competition-hierarchy.ts`), which always wires `competitionResultScopeValidator`.

Two checks enforce it:

- `tooling/check-result-ledger-composition.mjs`, run by `pnpm lint`, fails on any `new ResultLedger(` in application code (`apps/**`, tests excepted).
- `competition-authority.int.test.ts` verifies the factory rejects unknown targets.

BRT-05R adds no Result endpoints.
